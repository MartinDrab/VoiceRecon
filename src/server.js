'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { pipeline } = require('stream/promises');
const express = require('express');

const config = require('./config');
const { openDatabase } = require('./db');
const { Auth, isLoopback, verifyPassword } = require('./auth');
const { HttpError } = require('./errors');
const { translate, languageOf } = require('./i18n');
const { SpeechEngine } = require('./speech/engine');
const { VoiceManager } = require('./voices');
const { TranscriptStore } = require('./transcripts');
const { UploadQueue } = require('./uploads');
const { AudioStore } = require('./audio-store');
const {
  prepareBackup, applyPendingRestore, pendingRestore, setPendingRestore, cancelPendingRestore, restoreResult, dismissRestoreResult,
} = require('./backup');
const { attachWebSocket } = require('./ws');
const { RESTART_CODE, supervised } = require('./restart');

const PUBLIC = path.join(config.root, 'public');
const tls = Boolean(config.tlsCert && config.tlsKey);

// A backup uploaded on the Users page replaces the data before anything opens them.
const restored = applyPendingRestore(config.dataDir);
if (restored && restored.ok) {
  console.log(`Restored the uploaded backup of ${restored.createdAt}.`
    + (restored.previous ? ` The previous data are in ${restored.previous}; delete that folder once everything works.` : ''));
} else if (restored) {
  console.error(`Restoring the uploaded backup failed: ${restored.error} The data stay as they were.`);
}
const db = openDatabase(config.dataDir);
const auth = new Auth(db, { sessionTtlHours: config.sessionTtlHours, secureCookies: tls });
const engine = new SpeechEngine(config);
const voices = new VoiceManager(db, engine, { dataDir: config.dataDir, defaultThreshold: config.speakerThreshold });
const transcripts = new TranscriptStore(db, voices);
const audio = new AudioStore(db, config.dataDir);
audio.init();
const uploads = new UploadQueue({ dataDir: config.dataDir, engine, voices, transcripts, audio });
// The recognizer prefers the voices' names and the vocabulary from the Voices page.
const syncHotwords = () => engine.ready && engine.setHotwords(voices.hotwords());
voices.on('changed', syncHotwords);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use((req, res, next) => {
  // Older browsers do not treat same-host WebSockets as 'self', so list them explicitly.
  const host = /^[\w.:[\]-]+$/.test(req.headers.host || '') ? req.headers.host : '';
  const wsSrc = host ? ` ${tls ? 'wss' : 'ws'}://${host}` : '';
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      `media-src 'self' blob:; connect-src 'self'${wsSrc}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  });
  next();
});
app.use(auth.attach());
app.use('/static', express.static(path.join(PUBLIC, 'static'))); // revalidated via ETag

// ---- pages ----

const page = (name) => (_req, res) => res.sendFile(path.join(PUBLIC, `${name}.html`));
app.get('/', (_req, res) => res.redirect('/transcript'));
app.get('/login', (req, res, next) => (req.user ? res.redirect('/transcript') : next()), page('login'));
app.get('/transcript', auth.requirePageUser(), page('transcript'));
app.get('/voices', auth.requirePageUser(), page('voices'));
app.get('/users', auth.requirePageUser(), page('users'));
app.get('/history', auth.requirePageUser(), page('history'));
app.get('/history/:id', auth.requirePageUser(), page('history-view'));

// ---- API ----

const api = express.Router();
// Express 5 leaves req.body undefined when no JSON was sent; validation then reports a clear 400.
const json = [express.json({ limit: '100kb' }), (req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
}];
const wav = express.raw({ type: ['audio/wav', 'audio/x-wav', 'audio/wave', 'application/octet-stream'], limit: '60mb' });
const user = auth.requireUser();
const admin = auth.requireAdmin();
const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.');
  return n;
};
/** The requested transcript if the user wrote it or is an administrator (who may delete it), else null. */
const ownTranscript = (req) => {
  const t = transcripts.get(id(req.params.id));
  return t.user_id === req.user.id || req.user.role === 'admin' ? t : null;
};
/** The uploaded WAV file; it is decoded with the voice print, off the main thread. */
const wavBody = (req) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Send the recording as a WAV file (Content-Type: audio/wav).');
  return req.body;
};

// "From this computer": req.ip, not the socket's address. Behind a reverse proxy on the same
// computer every connection comes from 127.0.0.1; req.ip is the client the proxy names in
// X-Forwarded-For ('trust proxy' above trusts that header only from loopback addresses).
const fromThisComputer = (req) => isLoopback(req.ip);

api.get('/setup', (req, res) => {
  res.json({ needed: auth.countUsers() === 0, allowed: fromThisComputer(req) });
});

api.post('/setup', json, async (req, res) => {
  if (auth.countUsers() > 0) throw new HttpError(409, 'The application is already set up.');
  if (!fromThisComputer(req)) {
    throw new HttpError(403, 'The first administrator can only be created from the computer running VoiceRecon.');
  }
  const u = await auth.createUser(
    { username: req.body.username, password: req.body.password, role: 'admin' },
    { onlyIfNoUsers: true },
  );
  auth.setCookie(res, auth.createSession(u.id));
  res.json({ user: u });
});

api.post('/login', json, async (req, res) => {
  const { user: u, token } = await auth.login(req.body.username, req.body.password, req.ip);
  auth.setCookie(res, token);
  res.json({ user: auth.publicUser(u) });
});

api.post('/logout', (req, res) => {
  auth.destroySession(auth.tokenFromRequest(req));
  auth.clearCookie(res);
  res.json({ ok: true });
});

api.get('/me', user, (req, res) => res.json({ user: req.user }));

api.post('/me/password', user, json, async (req, res) => {
  const row = auth.getUser(req.user.id);
  if (typeof req.body.currentPassword !== 'string' || !(await verifyPassword(req.body.currentPassword, row.password_hash))) {
    throw new HttpError(400, 'The current password is not correct.');
  }
  await auth.updateUser(req.user.id, { password: req.body.newPassword }, { keepToken: auth.tokenFromRequest(req) });
  res.json({ ok: true });
});

api.get('/status', user, (_req, res) => {
  res.json({
    ready: engine.ready,
    error: engine.loadError && engine.loadError.message,
    threshold: voices.threshold,
    threads: config.threads,
    provider: engine.provider, // 'cpu' also when PROVIDER=cuda could not be used (the log says why)
    speakerModel: path.basename(config.speakerModel),
  });
});

// users (administrators only)
api.get('/users', admin, (_req, res) => res.json({ users: auth.listUsers() }));
api.post('/users', admin, json, async (req, res) => {
  const { username, password, role = 'user' } = req.body;
  res.status(201).json({ user: await auth.createUser({ username, password, role }) });
});
api.patch('/users/:id', admin, json, async (req, res) => {
  const uid = id(req.params.id);
  const keepToken = uid === req.user.id ? auth.tokenFromRequest(req) : undefined;
  res.json({ user: await auth.updateUser(uid, { password: req.body.password, role: req.body.role }, { keepToken }) });
});
api.delete('/users/:id', admin, (req, res) => {
  const uid = id(req.params.id);
  if (uid === req.user.id) throw new HttpError(400, 'You cannot delete your own account.');
  auth.deleteUser(uid);
  res.json({ ok: true });
});

// voices
api.get('/voices', user, (_req, res) => res.json({
  voices: voices.list(),
  threshold: voices.threshold,
  learnFromSpeech: voices.learnFromSpeech,
  vocabulary: voices.vocabulary,
  ready: engine.ready,
}));
api.post('/voices', user, json, (req, res) => {
  res.status(201).json({ id: voices.create({ name: req.body.name, color: req.body.color }) });
});
api.patch('/voices/:id', user, json, (req, res) => {
  voices.update(id(req.params.id), { name: req.body.name, color: req.body.color });
  res.json({ ok: true });
});
api.delete('/voices/:id', user, (req, res) => {
  voices.remove(id(req.params.id));
  res.json({ ok: true });
});
api.post('/voices/:id/samples', user, wav, async (req, res) => {
  const label = typeof req.query.label === 'string' ? req.query.label : '';
  res.status(201).json(await voices.addSample(id(req.params.id), { wav: wavBody(req), label }));
});
api.get('/voices/:id/samples/:sid/audio', user, (req, res) => {
  res.type('audio/wav').sendFile(voices.samplePath(id(req.params.id), id(req.params.sid)));
});
api.delete('/voices/:id/samples/:sid', user, (req, res) => {
  voices.removeSample(id(req.params.id), id(req.params.sid));
  res.json({ ok: true });
});
api.delete('/voices/:id/learned', user, (req, res) => {
  voices.forgetLearned(id(req.params.id));
  res.json({ ok: true });
});
api.post('/identify', user, wav, async (req, res) => {
  if (!engine.ready) throw new HttpError(503, 'Speech models are still loading. Try again in a moment.');
  const { embedding, speechSeconds } = await engine.analyzeRecording({ wav: wavBody(req) });
  if (!embedding) throw new HttpError(400, 'Not enough speech in the recording.');
  const m = voices.identify(embedding);
  res.json({ voiceId: m.voiceId, scores: m.scores, threshold: voices.threshold, speechSeconds });
});
api.put('/settings/threshold', admin, json, (req, res) => {
  voices.setThreshold(req.body.value);
  res.json({ threshold: voices.threshold });
});
api.put('/settings/learn', admin, json, (req, res) => {
  voices.setLearnFromSpeech(req.body.enabled);
  res.json({ learnFromSpeech: voices.learnFromSpeech });
});
api.put('/settings/vocabulary', admin, json, (req, res) => {
  voices.setVocabulary(req.body.words);
  res.json({ vocabulary: voices.vocabulary });
});
// Restarting VoiceRecon (restart.js), e.g. to restore an uploaded backup now: possible only when
// what started the server starts it again; who would be interrupted.
api.get('/restart', admin, (_req, res) => {
  const transcribing = [...transcripts.processing.values()].filter((s) => s.state !== 'failed').length;
  const listening = [...transcripts.recording.keys()].filter((id) => !transcripts.processing.has(id)).length;
  res.json({ available: supervised(), listening, transcribing });
});
api.post('/restart', admin, (req, res) => {
  if (!supervised()) throw new HttpError(409, 'VoiceRecon was not started with start.cmd or start.sh, so it cannot restart itself. Restart it the way it was started.');
  console.log(`Restarting: asked by ${req.user.username} on the Users page.`);
  res.on('finish', () => setTimeout(() => shutdown(RESTART_CODE), 100));
  res.json({ restarting: true });
});
// A backup uploaded here is restored when VoiceRecon starts next (applyPendingRestore() above).
api.get('/backup/restore', admin, (_req, res) => {
  res.json({ pending: pendingRestore(config.dataDir), result: restoreResult(config.dataDir) });
});
api.post('/backup/restore', admin, async (req, res) => {
  const part = path.join(config.dataDir, `restore-upload-${crypto.randomUUID()}.part`);
  try {
    await pipeline(req, fs.createWriteStream(part));
    let pending;
    try {
      pending = setPendingRestore(config.dataDir, part);
    } catch {
      throw new HttpError(400, 'This file is not a VoiceRecon backup, or it is damaged or from a newer version.');
    }
    res.json({ pending });
  } finally {
    fs.rmSync(part, { force: true });
  }
});
api.delete('/backup/restore', admin, (_req, res) => {
  cancelPendingRestore(config.dataDir);
  res.json({ ok: true });
});
api.delete('/backup/restore/result', admin, (_req, res) => {
  dismissRestoreResult(config.dataDir);
  res.json({ ok: true });
});
// Everything VoiceRecon keeps as one file (backup.js); restored with npm run restore or from the Users page.
api.get('/backup', admin, async (_req, res) => {
  const backup = prepareBackup(db, config.dataDir);
  res.set({
    'Content-Type': 'application/x-tar',
    'Content-Length': String(backup.bytes),
    'Content-Disposition': `attachment; filename="${backup.filename}"`,
    'Cache-Control': 'no-store',
  });
  try {
    await backup.write(res);
  } catch (err) {
    if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn('Sending a backup failed:', err.message);
  } finally {
    backup.cleanup();
  }
});
// Whether the audio of transcripts is kept (to play lines in History), and at most how much.
api.get('/settings/audio', admin, (_req, res) => res.json(audio.settings()));
api.put('/settings/audio', admin, json, (req, res) => {
  res.json(audio.setSettings({ keep: req.body.keep, limitGb: req.body.limitGb }));
});

// saved transcripts (everyone can read and edit; deleting is for the author and administrators)
api.get('/transcripts', user, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  // Filters: ?voice=<voice id>, ?from= and ?to= (ms; started at or after from, before to).
  const number = (v) => (v === undefined || v === '' ? null : Number(v));
  const voiceId = number(req.query.voice);
  const from = number(req.query.from);
  const to = number(req.query.to);
  if ((voiceId !== null && !Number.isInteger(voiceId)) || [from, to].some((x) => x !== null && !Number.isFinite(x))) {
    throw new HttpError(400, 'Invalid filter.');
  }
  res.json(transcripts.list({ q, voiceId, from, to, limit: Number(req.query.limit), offset: Number(req.query.offset) }));
});
// An uploaded recording becomes a transcript in the background. The browser converts any audio file
// to 16 kHz mono 16-bit WAV; ?name= is the file name (the title), ?startedAt= when it was recorded (ms),
// ?offset= where in the recording the uploaded part starts (seconds; line times count from the start).
api.post('/transcripts/upload', user, async (req, res) => {
  if (!req.is(['audio/wav', 'audio/x-wav', 'audio/wave'])) {
    throw new HttpError(400, 'Send the recording as a WAV file (Content-Type: audio/wav).');
  }
  const name = typeof req.query.name === 'string' ? req.query.name : '';
  const transcriptId = await uploads.add(req, req.user, {
    name, startedAt: Number(req.query.startedAt), offset: Number(req.query.offset || 0),
  });
  res.status(201).json({ id: transcriptId });
});
api.post('/transcripts/:id/stop', user, async (req, res) => {
  const t = ownTranscript(req);
  if (!t) throw new HttpError(403, 'Only the author or an administrator can stop this transcription.');
  res.json({ stopped: await uploads.cancel(t.id) });
});
// ?lines=0: the transcript without its lines (the History page polls the progress of uploads).
api.get('/transcripts/:id', user, (req, res) => {
  const tid = id(req.params.id);
  const transcript = transcripts.summary(tid);
  res.json(req.query.lines === '0' ? { transcript } : { transcript, lines: transcripts.lines(tid) });
});
api.patch('/transcripts/:id', user, json, (req, res) => {
  transcripts.rename(id(req.params.id), req.body.title);
  res.json({ ok: true });
});
api.delete('/transcripts/:id', user, async (req, res) => {
  const t = ownTranscript(req);
  if (!t) throw new HttpError(403, 'Only the author or an administrator can delete this transcript.');
  await uploads.cancel(t.id);
  audio.remove(t.id);
  transcripts.remove(t.id);
  res.json({ ok: true });
});
// The transcript's audio as a WAV file: ?start=&end= (seconds) for a part of it, e.g. one line;
// ?download=1 to save it as a file.
api.get('/transcripts/:id/audio', user, async (req, res) => {
  const tid = id(req.params.id);
  const time = (v) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Invalid time.');
    return n;
  };
  const from = time(req.query.start);
  const to = time(req.query.end);
  if (req.query.format === 'opus') {
    // The whole transcript, about 10 times smaller than WAV (to save it).
    await audio.sendOpus(res, tid, { filename: req.query.download ? `${transcripts.fileBase(tid)}.opus` : undefined });
    return;
  }
  const filename = req.query.download ? `${transcripts.fileBase(tid)}.wav` : undefined;
  await audio.send(res, tid, { from, to, filename });
});
// Transcribes the transcript again from its audio with the current models and voices (replacing its lines).
api.post('/transcripts/:id/again', user, (req, res) => {
  const t = ownTranscript(req);
  if (!t) throw new HttpError(403, 'Only the author or an administrator can transcribe this again.');
  if (uploads.busy(t.id)) throw new HttpError(409, 'Wait until the transcript is finished.');
  uploads.again(t.id);
  res.status(202).json({ queued: true });
});
api.delete('/transcripts/:id/audio', user, (req, res) => {
  const t = ownTranscript(req);
  if (!t) throw new HttpError(403, 'Only the author or an administrator can delete this audio.');
  if (uploads.busy(t.id)) throw new HttpError(409, 'Wait until the transcript is finished.');
  res.json({ deleted: audio.remove(t.id) });
});
// Decides the transcript's speakers again per speaker, e.g. after someone in it was enrolled.
api.post('/transcripts/:id/regroup', user, (req, res) => {
  const tid = id(req.params.id);
  if (transcripts.recording.has(tid)) throw new HttpError(409, 'Wait until the transcript is finished.');
  if (!engine.ready) throw new HttpError(503, 'Speech models are still loading. Try again in a moment.');
  res.json({ moved: transcripts.regroup(tid, engine.speakerModelName) });
});
api.patch('/transcripts/:id/lines/:lineId', user, json, (req, res) => {
  transcripts.updateText(id(req.params.id), id(req.params.lineId), req.body.text);
  res.json({ ok: true });
});
// Moves lines ({ lineIds }) or all lines of a speaker ({ key }) to { speaker: { voiceId } | { label } }.
// Moving lines to a voice also teaches the voice how they sounded.
api.post('/transcripts/:id/speaker', user, json, (req, res) => {
  const tid = id(req.params.id);
  const { lineIds, key, speaker } = req.body;
  if (!speaker || typeof speaker !== 'object') throw new HttpError(400, 'Choose a voice or type a name.');
  const target = Array.isArray(lineIds) ? { lineIds: lineIds.map(id) } : { key };
  const rows = transcripts.setSpeaker(tid, target, speaker);
  let learned = 0;
  if (Number.isInteger(speaker.voiceId) && engine.ready) {
    learned = transcripts.learnFrom(rows.filter((r) => r.voice_id !== speaker.voiceId), speaker.voiceId, engine.speakerModelName);
  }
  res.json({ ok: true, lines: rows.length, learned });
});
api.delete('/transcripts/:id/lines/:lineId', user, (req, res) => {
  transcripts.deleteLine(id(req.params.id), id(req.params.lineId));
  res.json({ ok: true });
});
api.get('/transcripts/:id/export', user, (req, res) => {
  const out = transcripts.export(id(req.params.id), req.query.format, languageOf(req));
  res.set('Content-Disposition', `attachment; filename="${out.filename}"`).type(out.type).send(out.body);
});

api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));
app.use('/api', api);

app.use((req, res) => res.status(404).type('text').send('Not found'));

app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  const lang = languageOf(req);
  const message = status >= 500 && !(err instanceof HttpError)
    ? translate(lang, 'Internal server error.')
    : translate(lang, err.template || err.message, err.params);
  if (req.path.startsWith('/api/')) res.status(status).json({ error: message });
  else res.status(status).type('text').send(message);
});

// ---- start ----

const server = tls
  ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, app)
  : http.createServer(app);
const ws = attachWebSocket(server, { auth, engine, voices, transcripts, audio });

server.listen(config.port, config.host, () => {
  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  console.log(`VoiceRecon listening on ${tls ? 'https' : 'http'}://${shownHost}:${config.port}/`);
  if (auth.countUsers() === 0) {
    console.log('No users yet: open the address above on this computer to create the first administrator.');
  }
});

console.log(`Data directory: ${config.dataDir}`);
console.log(`Loading speech models (${config.threads} threads${config.provider === 'cuda' ? ', CUDA' : ''})...`);
const t0 = Date.now();
engine.load()
  .then(() => {
    voices.init();
    syncHotwords();
    console.log(`Speech models ready in ${((Date.now() - t0) / 1000).toFixed(1)} s${engine.provider === 'cuda' ? ' on the GPU' : ''}.`);
  })
  .catch((err) => console.error(`Speech models failed to load: ${err.message}`))
  .finally(() => ws.notifyStatus());

function shutdown(code = 0) {
  server.close();
  db.close();
  process.exit(code);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
