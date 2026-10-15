'use strict';

const { WebSocketServer } = require('ws');
const { int16ToFloat } = require('./audio');
const { TranscriptionSession } = require('./transcriber');
const { LANGUAGES, translate, languageOf } = require('./i18n');

const MAX_FRAME_BYTES = 1 << 20;

const isId = (v) => Number.isInteger(v) && v > 0;

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * WebSocket endpoint /ws/transcribe. The browser streams 16 kHz mono 16-bit PCM as binary
 * frames and receives transcript events as JSON text frames.
 *
 * Client -> server (JSON): { type: 'start', transcriptId? } | { type: 'stop' } |
 *                          { type: 'newTranscript' } |
 *                          { type: 'saveUnknown', speakerId, name, color } |
 *                          { type: 'assignUnknown', speakerId, voiceId } |
 *                          { type: 'correct', ids: [final ids], voiceId }
 * Server -> client (JSON): hello, status, voices, transcript, partial, final, relabel, stopped,
 *                          saved, corrected, error
 *
 * Final lines are saved to a transcript (see transcripts.js): 'start' may name the transcript to
 * continue (after a reconnect or page reload); otherwise one is created with the first line and
 * announced with { type: 'transcript', id }. 'newTranscript' starts a fresh one.
 */
function attachWebSocket(server, { auth, engine, voices, transcripts }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const clients = new Map(); // open connection -> () => its language

  const voicesMessage = () => JSON.stringify({ type: 'voices', voices: voices.summary(), threshold: voices.threshold });
  const broadcast = (text) => {
    for (const ws of clients.keys()) if (ws.readyState === ws.OPEN) ws.send(text);
  };
  voices.on('changed', () => broadcast(voicesMessage()));

  server.on('upgrade', (req, socket, head) => {
    const reject = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    // An exception here would be uncaught and stop the server, so malformed requests are refused.
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname !== '/ws/transcribe') return reject(404, 'Not Found');
      if (!sameOrigin(req)) return reject(403, 'Forbidden');
      const token = auth.tokenFromRequest(req);
      const user = auth.userFromToken(token);
      if (!user) return reject(401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user, token, languageOf(req)));
    } catch (err) {
      console.error('WebSocket upgrade failed:', err.message);
      if (!socket.destroyed) reject(400, 'Bad Request');
    }
  });

  function onConnection(ws, user, token, initialLang) {
    let lang = initialLang; // follows the page's language ({ type: 'language' }) for messages
    /** A user-facing message in the connection's language. */
    const tr = (err) => translate(lang, err.template || err.message || String(err), err.params);
    clients.set(ws, () => lang);
    let session = null;
    let alive = true;
    const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
    const fail = (err) => {
      console.error('Transcription error:', err);
      send({ type: 'error', message: tr(err) });
    };

    // The saved transcript this connection writes to. offset maps session times to transcript times.
    const live = { transcriptId: null, offset: 0, sessionNo: 1, lineIds: new Map() };

    const setTranscript = (id) => {
      transcripts.setRecording(live.transcriptId, false);
      live.transcriptId = id;
      transcripts.setRecording(id, true);
    };

    const attach = (transcriptId) => {
      if (live.transcriptId || !isId(transcriptId)) return;
      const t = transcripts.resume(transcriptId, user);
      if (!t) return;
      setTranscript(t.id);
      live.sessionNo = t.sessions;
      live.offset = t.duration + 1 - (session ? session.audioSeconds : 0);
      live.lineIds.clear();
      send({ type: 'transcript', id: t.id });
    };

    const startNew = () => {
      const t = transcripts.create(user.id);
      setTranscript(t.id);
      live.sessionNo = 1;
      live.lineIds.clear();
      send({ type: 'transcript', id: t.id });
    };

    const saveFinal = (m) => {
      const recent = session.recent.get(m.id) || {};
      const line = {
        start: m.start + live.offset,
        end: m.end + live.offset,
        spokenAt: Date.now() - Math.max(0, session.audioSeconds - m.start) * 1000,
        speaker: transcripts.speakerFields(m.speaker, live.sessionNo),
        text: m.text,
        seconds: recent.seconds,
        embedding: recent.embedding,
        model: engine.speakerModelName,
      };
      if (!live.transcriptId) startNew();
      try {
        live.lineIds.set(m.id, transcripts.appendLine(live.transcriptId, line));
      } catch (err) {
        // Most likely the transcript was deleted while recording: continue in a new one.
        console.warn(`Transcript ${live.transcriptId}: ${err.message}; starting a new one.`);
        startNew();
        live.lineIds.set(m.id, transcripts.appendLine(live.transcriptId, line));
      }
    };

    const ignoreMissing = (fn) => {
      try {
        fn();
      } catch (err) {
        if (err.status !== 404) console.error('Could not update the saved transcript:', err.message);
      }
    };

    // Saving must never interrupt the live transcript, so errors are only logged.
    const record = (m) => {
      try {
        if (m.type === 'final') saveFinal(m);
        else if (m.type === 'relabel' && live.transcriptId && m.from.kind === 'unknown') {
          ignoreMissing(() => transcripts.setSpeaker(live.transcriptId, { key: `u:${live.sessionNo}:${m.from.id}` }, { voiceId: m.to.id }));
        }
      } catch (err) {
        console.error('Could not save the transcript:', err.message);
      }
    };

    const ensureSession = () => {
      if (session) return session;
      if (!engine.ready) {
        send({ type: 'error', message: tr({ message: 'Speech models are still loading. Try again in a moment.' }) });
        return null;
      }
      session = new TranscriptionSession(engine, voices);
      session.on('message', (m) => {
        record(m);
        send(m);
      });
      session.on('error', fail);
      return session;
    };

    send({ type: 'hello', user, ready: engine.ready, error: engine.loadError && tr(engine.loadError) });
    ws.send(voicesMessage());

    // Exceptions thrown from this listener would be uncaught and stop the server.
    ws.on('message', (data, isBinary) => {
      try {
        onMessage(data, isBinary);
      } catch (err) {
        fail(err);
      }
    });

    function onMessage(data, isBinary) {
      if (isBinary) {
        const s = ensureSession();
        if (s) s.push(int16ToFloat(data));
        return;
      }
      let msg = null;
      try {
        msg = JSON.parse(String(data));
      } catch { /* handled below */ }
      if (!msg || typeof msg !== 'object') return send({ type: 'error', message: tr(new Error('Invalid message.')) });
      if (msg.type === 'language') {
        if (LANGUAGES.includes(msg.lang)) lang = msg.lang;
        return;
      }
      if (msg.type === 'start') {
        if (ensureSession()) attach(msg.transcriptId);
      } else if (msg.type === 'newTranscript') {
        setTranscript(null);
        live.offset = -(session ? session.audioSeconds : 0);
        live.lineIds.clear();
        send({ type: 'transcript', id: null });
      } else if (msg.type === 'stop') {
        if (!session) return send({ type: 'stopped' });
        session.finish().then(() => send({ type: 'stopped' }), fail);
      } else if (msg.type === 'saveUnknown') {
        if (!session) return send({ type: 'error', message: tr(new Error('No transcription is running.')) });
        session.saveUnknown(msg.speakerId, { name: msg.name, color: msg.color }).then(
          (voiceId) => send({ type: 'saved', speakerId: msg.speakerId, voiceId }),
          (err) => send({ type: 'error', message: tr(err) }),
        );
      } else if (msg.type === 'assignUnknown' || msg.type === 'correct') {
        try {
          if (!session) throw new Error('No transcription is running.');
          if (!isId(msg.voiceId)) throw new Error('Choose a voice.');
          if (msg.type === 'assignUnknown') {
            session.assignUnknown(msg.speakerId, msg.voiceId);
            send({ type: 'corrected', speakerId: msg.speakerId, voiceId: msg.voiceId, learned: 1 });
          } else {
            if (!Array.isArray(msg.ids) || !msg.ids.length || msg.ids.length > 1000 || !msg.ids.every(isId)) {
              throw new Error('Invalid lines.');
            }
            const learned = session.correct(msg.ids, msg.voiceId);
            for (const finalId of msg.ids) {
              const lineId = live.lineIds.get(finalId);
              if (lineId && live.transcriptId) {
                ignoreMissing(() => transcripts.setSpeaker(live.transcriptId, { lineIds: [lineId] }, { voiceId: msg.voiceId }));
              }
            }
            send({ type: 'corrected', ids: msg.ids, voiceId: msg.voiceId, learned });
          }
        } catch (err) {
          send({ type: 'error', message: tr(err) });
        }
      }
    }

    ws.on('pong', () => {
      alive = true;
    });

    // Keep-alive, and drop the connection if the user logged out or was deleted meanwhile.
    const timer = setInterval(() => {
      if (!alive || !auth.userFromToken(token)) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30000);

    ws.on('close', () => {
      clearInterval(timer);
      clients.delete(ws);
      setTranscript(null);
      if (session) session.close();
    });
  }

  return {
    notifyStatus() {
      const err = engine.loadError;
      for (const [ws, langOf] of clients) {
        if (ws.readyState !== ws.OPEN) continue;
        const error = err ? translate(langOf(), err.template || err.message, err.params) : null;
        ws.send(JSON.stringify({ type: 'status', ready: engine.ready, error }));
      }
    },
  };
}

module.exports = { attachWebSocket };
