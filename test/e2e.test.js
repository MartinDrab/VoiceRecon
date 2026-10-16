'use strict';

/**
 * End-to-end test: starts the real server on a free port with an empty data directory, creates
 * the administrator, enrolls two synthetic Czech voices, streams a recorded conversation over the
 * WebSocket like the browser does and checks who said what.
 *
 * Needs the speech models and the test fixtures:
 *   npm run models -- --test && node scripts/make-test-audio.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');
const config = require('../src/config');
const { parseReference } = require('../src/evaluation');

const FIXTURES = path.join(__dirname, 'fixtures');
// Skipped without models and test audio, unless VOICERECON_REQUIRE_MODELS=1 (nightly CI): then it fails.
const haveModels = process.env.VOICERECON_REQUIRE_MODELS === '1'
  || (config.modelFiles.every((f) => fs.existsSync(f)) && fs.existsSync(path.join(FIXTURES, 'reference.txt')));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('net').AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
}

/** Share of reference words found in the hypothesis (order-insensitive, accent-insensitive). */
function wordRecall(ref, hyp) {
  const h = normalize(hyp);
  const r = normalize(ref);
  return r.filter((w) => h.includes(w)).length / r.length;
}

test('live transcription with speaker recognition', { skip: !haveModels && 'models or fixtures missing', timeout: 180000 }, async () => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicerecon-e2e-'));
  const server = spawn(process.execPath, [path.join(config.root, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, TLS_CERT: '', TLS_KEY: '' }, // over any .env
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;

  try {
    // wait until the models are loaded
    for (let i = 0; !log.includes('Speech models ready'); i++) {
      if (i > 600 || server.exitCode !== null || log.includes('models failed to load')) {
        throw new Error(`Server did not start:\n${log}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    let cookie = '';
    const call = async (method, url, body, type = 'application/json') => {
      const res = await fetch(base + url, {
        method,
        headers: { cookie, ...(body !== undefined ? { 'content-type': type } : {}) },
        body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const data = /** @type {any} */ (await res.json());
      if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${data.error}`);
      return data;
    };

    assert.strictEqual((await fetch(`${base}/api/voices`)).status, 401, 'API requires login');
    // a request without a JSON body gets a validation error, not a server error
    assert.strictEqual((await fetch(`${base}/api/login`, { method: 'POST' })).status, 401);
    // Behind a reverse proxy on the same computer, the client the proxy names decides, not the socket.
    const viaProxy = { 'x-forwarded-for': '203.0.113.7', 'content-type': 'application/json' };
    assert.deepStrictEqual(await (await fetch(`${base}/api/setup`, { headers: viaProxy })).json(), { needed: true, allowed: false });
    const remoteSetup = await fetch(`${base}/api/setup`, { method: 'POST', headers: viaProxy, body: JSON.stringify({ username: 'intruder', password: 'intruder-pass' }) });
    assert.strictEqual(remoteSetup.status, 403);
    assert.deepStrictEqual(await call('GET', '/api/setup'), { needed: true, allowed: true });
    await call('POST', '/api/setup', { username: 'admin', password: 'admin-password' });
    await assert.rejects(call('POST', '/api/setup', { username: 'admin2', password: 'admin-password' }), /409/);

    const ids = {};
    for (const [name, color] of [['jirka', '#e5484d'], ['coqui', '#3e63dd']]) {
      ids[name] = (await call('POST', '/api/voices', { name, color })).id;
      const wav = fs.readFileSync(path.join(FIXTURES, 'voices', `${name}.wav`));
      const s = await call('POST', `/api/voices/${ids[name]}/samples?label=enroll`, wav, 'audio/wav');
      assert.ok(s.speechDuration > 5);
    }
    const names = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));

    const ident = await call('POST', '/api/identify', fs.readFileSync(path.join(FIXTURES, 'voices', 'coqui.wav')), 'audio/wav');
    assert.strictEqual(ident.voiceId, ids.coqui);
    assert.strictEqual((await fetch(`${base}/api/voices`, { method: 'POST', headers: { cookie } })).status, 400);

    // malformed upgrade requests are refused instead of crashing the server
    const upgrade = (headers) => new Promise((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}/ws/transcribe`, { headers });
      w.on('open', () => resolve('open'));
      w.on('error', (e) => resolve(e.message));
      setTimeout(() => reject(new Error('no answer')), 5000);
    });
    assert.match(await upgrade({ cookie: 'other=50%; vr_session=%zz' }), /401/);
    assert.strictEqual((await fetch(`${base}/api/setup`, { headers: { cookie: 'other=50%' } })).status, 200);

    // stream the conversation as 100 ms PCM frames, 4x faster than real time
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/transcribe`, { headers: { cookie, origin: base } });
    const finals = [];
    let partials = 0;
    let clearedBeforeFinal = 0; // interim text must stay until its final result replaces it
    let shown = false;
    const errors = [];
    let transcriptId = null;
    const waiting = new Map(); // message type -> resolve
    // Every wait has a time limit, so a missing message fails the test instead of hanging it.
    const within = (promise, what, ms = 15000) => Promise.race([promise, new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms).unref();
    })]);
    const next = (type) => within(new Promise((resolve) => waiting.set(type, resolve)), `a "${type}" message`);
    const stopped = new Promise((resolve, reject) => {
      ws.on('message', (data) => {
        const m = JSON.parse(String(data));
        if (waiting.has(m.type)) {
          waiting.get(m.type)(m);
          waiting.delete(m.type);
        }
        if (m.type === 'final') {
          finals.push(m);
          shown = false;
        }
        if (m.type === 'partial' && m.text) {
          partials++;
          shown = true;
        }
        if (m.type === 'partial' && !m.text && shown) clearedBeforeFinal++;
        if (m.type === 'error') errors.push(m.message);
        if (m.type === 'transcript' && m.id) transcriptId = m.id;
        if (m.type === 'stopped') resolve();
      });
      ws.on('error', reject);
    });
    await new Promise((r) => ws.on('open', r));
    ws.send('null'); // invalid messages are answered with an error and must not stop the server
    ws.send(JSON.stringify({ type: 'start' }));
    const wav = fs.readFileSync(path.join(FIXTURES, 'conversation.wav'));
    const pcm = wav.subarray(44);
    for (let o = 0; o < pcm.length; o += 3200) {
      ws.send(pcm.subarray(o, o + 3200));
      await new Promise((r) => setTimeout(r, 25));
    }
    ws.send(JSON.stringify({ type: 'stop' }));
    await stopped;
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'conversation.json'), 'utf8'));

    // correcting a line teaches the chosen voice how it sounded
    const corrected = next('corrected');
    ws.send(JSON.stringify({ type: 'correct', ids: [finals[0].id], voiceId: ids.coqui }));
    assert.deepStrictEqual(await corrected, { type: 'corrected', ids: [finals[0].id], voiceId: ids.coqui, learned: 1 });
    const learnedOf = async (name) => (await call('GET', '/api/voices')).voices.find((v) => v.id === ids[name]).learned;
    assert.deepStrictEqual(await learnedOf('coqui'), { live: 0, correction: 1 });
    await call('DELETE', `/api/voices/${ids.coqui}/learned`);
    assert.deepStrictEqual(await learnedOf('coqui'), { live: 0, correction: 0 });
    const rejected = next('error');
    ws.send(JSON.stringify({ type: 'correct', ids: [finals[0].id], voiceId: 999999 }));
    assert.match((await rejected).message, /Voice not found/);

    // the session was saved as a transcript, including the correction
    assert.ok(transcriptId, 'a transcript was created');
    let saved = await call('GET', `/api/transcripts/${transcriptId}`);
    assert.strictEqual(saved.lines.length, expected.length);
    assert.deepStrictEqual(saved.lines.map((l) => l.text), finals.map((f) => f.text));
    assert.strictEqual(saved.lines[0].speaker.voiceId, ids.coqui, 'the live correction reached the saved line');
    assert.deepStrictEqual(saved.lines.slice(1).map((l) => names[l.speaker.voiceId]), expected.slice(1).map((e) => e.voice));
    assert.ok(Math.abs(saved.lines[1].start - finals[1].start) < 0.01);
    const progress = await call('GET', `/api/transcripts/${transcriptId}?lines=0`);
    assert.deepStrictEqual([progress.transcript.id, progress.lines], [transcriptId, undefined], 'without its lines');
    assert.strictEqual((await call('GET', '/api/transcripts?q=dovolene')).total, 1, 'search ignores diacritics');
    const srt = await (await fetch(`${base}/api/transcripts/${transcriptId}/export?format=srt`, { headers: { cookie } })).text();
    assert.strictEqual(srt.match(/-->/g).length, expected.length);

    // its audio was kept: a clip is exactly what was streamed at those times
    assert.strictEqual(saved.transcript.audio, true);
    const clip = async (tid, from, to) => {
      const res = await fetch(`${base}/api/transcripts/${tid}/audio?start=${from}&end=${to}`, { headers: { cookie } });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'audio/wav');
      return Buffer.from(await res.arrayBuffer()).subarray(44);
    };
    assert.ok((await clip(transcriptId, 2, 4)).equals(pcm.subarray(2 * 32000, 4 * 32000)), 'the kept audio, at its times');
    const audioSettings = await call('GET', '/api/settings/audio');
    assert.deepStrictEqual([audioSettings.keep, audioSettings.limitGb], [true, 10]);
    assert.ok(audioSettings.usedBytes >= pcm.length);

    // an administrator downloads everything as one file, the transcript's audio included
    const backupRes = await fetch(`${base}/api/backup`, { headers: { cookie } });
    assert.strictEqual(backupRes.headers.get('content-type'), 'application/x-tar');
    assert.match(backupRes.headers.get('content-disposition'), /^attachment; filename="voicerecon-backup-[\d-]+\.tar"$/);
    const backup = Buffer.from(await backupRes.arrayBuffer());
    assert.strictEqual(backup.length, Number(backupRes.headers.get('content-length')));
    const entries = [];
    for (let at = 0; backup[at];) {
      const size = parseInt(backup.toString('latin1', at + 124, at + 135), 8);
      entries.push(backup.toString('utf8', at, at + 100).replace(/\0.*$/s, ''));
      at += 512 + Math.ceil(size / 512) * 512;
    }
    assert.deepStrictEqual(entries.slice(0, 2), ['backup.json', 'voicerecon.db']);
    assert.ok(entries.some((n) => n.startsWith('audio/')) && entries.some((n) => n.startsWith('recordings/')));

    // a reconnecting page continues the same transcript; "New transcript" starts another
    const fresh = next('transcript');
    ws.send(JSON.stringify({ type: 'newTranscript' }));
    assert.strictEqual((await fresh).id, null);
    ws.close();
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws/transcribe`, { headers: { cookie, origin: base } });
    const announced = new Promise((resolve) => ws2.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'transcript') resolve(m.id);
    }));
    await within(new Promise((r) => ws2.on('open', r)), 'the second connection');
    ws2.send(JSON.stringify({ type: 'start', transcriptId }));
    assert.strictEqual(await within(announced, 'the resumed transcript'), transcriptId);
    ws2.close();

    // its speakers were decided per speaker when the session ended; again from History, nothing moves
    for (let i = 0; i < 50 && (await call('GET', `/api/transcripts/${transcriptId}?lines=0`)).transcript.recording; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepStrictEqual(await call('POST', `/api/transcripts/${transcriptId}/regroup`), { moved: 0 });
    assert.deepStrictEqual((await call('GET', `/api/transcripts/${transcriptId}`)).lines.map((l) => l.speaker.voiceId),
      saved.lines.map((l) => l.speaker.voiceId), 'enrolled speakers and the correction stay');

    // editing in History: move a line to a typed name, fix its text, then delete the transcript
    await call('POST', `/api/transcripts/${transcriptId}/speaker`, { lineIds: [saved.lines[1].id], speaker: { label: 'Host' } });
    await call('PATCH', `/api/transcripts/${transcriptId}/lines/${saved.lines[1].id}`, { text: 'Opravený text.' });
    saved = await call('GET', `/api/transcripts/${transcriptId}`);
    assert.deepStrictEqual([saved.lines[1].speaker.name, saved.lines[1].text, saved.lines[1].edited], ['Host', 'Opravený text.', true]);
    for (const pagePath of ['/history', `/history/${transcriptId}`]) {
      const page = await fetch(base + pagePath, { headers: { cookie } });
      assert.strictEqual(page.status, 200, pagePath);
    }
    await call('DELETE', `/api/transcripts/${transcriptId}`);
    assert.strictEqual((await fetch(`${base}/api/transcripts/${transcriptId}`, { headers: { cookie } })).status, 404);
    assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'audio')), [], 'its audio went with it');

    assert.strictEqual((await call('GET', '/api/voices')).learnFromSpeech, false);
    await call('PUT', '/api/settings/learn', { enabled: true });
    assert.strictEqual((await call('GET', '/api/voices')).learnFromSpeech, true);
    await call('PUT', '/api/settings/vocabulary', { words: ['Kyjev', ' Starlink '] });
    assert.deepStrictEqual((await call('GET', '/api/voices')).vocabulary, ['Kyjev', 'Starlink']);
    await assert.rejects(call('PUT', '/api/settings/vocabulary', { words: ['a/b'] }), /400/);
    await call('PUT', '/api/settings/vocabulary', { words: [] });

    // an uploaded recording is transcribed in the background into a new transcript, like live audio
    const recording = fs.readFileSync(path.join(FIXTURES, 'conversation.wav'));
    const recordedAt = Date.now() - 24 * 3600 * 1000;
    const learnedBefore = await learnedOf('jirka');
    const uploadFile = (query) => call('POST', `/api/transcripts/upload?${new URLSearchParams(query)}`, recording, 'audio/wav');
    const untilDone = async (tid) => {
      for (let i = 0; ; i++) {
        const t = await call('GET', `/api/transcripts/${tid}`);
        if (!t.transcript.recording) return t;
        assert.ok(t.transcript.processing, 'progress is reported while the file is transcribed');
        if (i > 1200) throw new Error('the uploaded recording was not transcribed in time');
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    // Uploaded as a part that starts 90 s into a longer recording: line times are the recording's.
    const offset = 90;
    const fileId = (await uploadFile({ name: 'Porada.m4a', startedAt: String(recordedAt), offset: String(offset) })).id;
    const file = await untilDone(fileId);
    const fileGot = file.lines.map((l) => `${l.start.toFixed(1)} <${names[l.speaker.voiceId] || l.speaker.name}> ${l.text}`).join('\n');
    assert.deepStrictEqual(file.lines.map((l) => names[l.speaker.voiceId]), expected.map((e) => e.voice), fileGot);
    const fileRecall = expected.reduce((n, e, i) => n + wordRecall(e.text, file.lines[i].text), 0) / expected.length;
    assert.ok(fileRecall > 0.8, `word recall ${fileRecall.toFixed(2)}\n${fileGot}`);
    assert.strictEqual(file.transcript.processing, null);
    assert.strictEqual(file.transcript.title, 'Porada');
    assert.strictEqual(file.transcript.startedAt, recordedAt);
    assert.ok(Math.abs(file.transcript.duration - offset - (recording.length - 44) / 32000) < 0.01, 'the transcript ends where the part ends');
    assert.ok(file.lines.every((l, i) => Math.abs(l.start - offset - expected[i].start) < 0.5), 'line times count from the start of the recording');
    assert.ok(Math.abs(file.lines[1].spokenAt - (recordedAt + file.lines[1].start * 1000)) < 2, 'line times follow the recording');
    assert.strictEqual((await fetch(`${base}/api/transcripts/upload?offset=-5`, { method: 'POST', headers: { cookie, 'content-type': 'audio/wav' }, body: recording })).status, 400);
    assert.deepStrictEqual(await learnedOf('jirka'), learnedBefore, 'uploaded recordings do not teach the voices');
    assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'uploads')), [], 'the uploaded file is removed');
    // ... and kept as the transcript's audio, from where the part starts
    assert.strictEqual(file.transcript.audio, true);
    assert.ok((await clip(fileId, offset + 2, offset + 4)).equals(recording.subarray(44 + 2 * 32000, 44 + 4 * 32000)));
    const whole = await fetch(`${base}/api/transcripts/${fileId}/audio?download=1`, { headers: { cookie } });
    assert.match(whole.headers.get('content-disposition'), /^attachment; filename="transcript-\d+-[\d-]+\.wav"$/);
    assert.strictEqual((await whole.arrayBuffer()).byteLength, recording.length, 'the whole recording, from the part\'s start');
    // ... and becomes a test case for npm run evaluate, as corrected in History
    const caseDir = path.join(dataDir, 'test-case');
    execFileSync(process.execPath, [path.join(config.root, 'scripts', 'export-test.js'), String(fileId), caseDir],
      { env: { ...process.env, DATA_DIR: dataDir }, stdio: 'pipe' });
    const reference = parseReference(fs.readFileSync(path.join(caseDir, 'reference.txt'), 'utf8'));
    const turnsOf = (speakers) => speakers.filter((name, i) => name !== speakers[i - 1]);
    assert.deepStrictEqual(reference.map((r) => r.speaker), turnsOf(expected.map((e) => e.voice)));
    assert.strictEqual(fs.statSync(path.join(caseDir, 'conversation.wav')).size, recording.length);
    assert.deepStrictEqual(fs.readdirSync(path.join(caseDir, 'voices')).sort(), ['coqui', 'jirka']);
    // transcribing it again from its audio replaces the lines (a correction is gone), keeping their times
    const fixedLine = file.lines[2];
    await call('PATCH', `/api/transcripts/${fileId}/lines/${fixedLine.id}`, { text: 'Ruční oprava.' });
    assert.deepStrictEqual(await call('POST', `/api/transcripts/${fileId}/again`), { queued: true });
    await assert.rejects(call('POST', `/api/transcripts/${fileId}/again`), /409/);
    const again = await untilDone(fileId);
    assert.deepStrictEqual(again.lines.map((l) => names[l.speaker.voiceId]), expected.map((e) => e.voice));
    assert.ok(again.lines.every((l) => !l.edited && l.text !== 'Ruční oprava.'), 'the lines are new');
    assert.ok(again.lines.every((l, i) => Math.abs(l.start - file.lines[i].start) < 0.01), 'at the same times');
    assert.ok(Math.abs(again.lines[1].spokenAt - file.lines[1].spokenAt) < 50, 'and the same wall-clock times');
    assert.ok(Math.abs(again.transcript.duration - file.transcript.duration) < 0.01);
    assert.deepStrictEqual(await call('DELETE', `/api/transcripts/${fileId}/audio`), { deleted: true });
    assert.strictEqual((await call('GET', `/api/transcripts/${fileId}`)).transcript.audio, false);
    assert.strictEqual((await fetch(`${base}/api/transcripts/${fileId}/audio`, { headers: { cookie } })).status, 404);

    // stopping keeps what was transcribed so far; other WAV formats are refused without a transcript
    const stopId = (await uploadFile({ name: 'stop.wav' })).id;
    assert.deepStrictEqual(await call('POST', `/api/transcripts/${stopId}/stop`), { stopped: true });
    assert.ok((await untilDone(stopId)).lines.length < expected.length);
    await call('DELETE', `/api/transcripts/${stopId}`);
    const count = (await call('GET', '/api/transcripts')).total;
    const wrongRate = Buffer.from(recording);
    wrongRate.writeUInt32LE(44100, 24);
    await assert.rejects(call('POST', '/api/transcripts/upload', wrongRate, 'audio/wav'), /400 Send the recording as a 16 kHz/);
    assert.strictEqual((await call('GET', '/api/transcripts')).total, count);

    const got = finals.map((f) => `${f.start.toFixed(1)}-${f.end.toFixed(1)} <${names[f.speaker.id] || f.speaker.label}> ${f.text}`);
    assert.strictEqual(finals.length, expected.length, `turns:\n${got.join('\n')}`);
    for (let i = 0; i < expected.length; i++) {
      assert.strictEqual(finals[i].speaker.kind, 'voice', got[i]);
      assert.strictEqual(names[finals[i].speaker.id], expected[i].voice, got[i]);
      assert.ok(Math.abs(finals[i].start - expected[i].start) < 0.5, `start of ${got[i]}`);
    }
    const recall = expected.reduce((n, e, i) => n + wordRecall(e.text, finals[i].text), 0) / expected.length;
    assert.ok(recall > 0.8, `word recall ${recall.toFixed(2)}\n${got.join('\n')}`);
    assert.ok(partials > 0, 'interim results were sent');
    assert.strictEqual(clearedBeforeFinal, 0, 'interim text was removed before its final result arrived');
    assert.deepStrictEqual(errors, ['Invalid message.', 'Voice not found.']);

    // a WebSocket from another origin is refused
    const foreign = new WebSocket(`ws://127.0.0.1:${port}/ws/transcribe`, { headers: { cookie, origin: 'http://evil.example' } });
    await assert.rejects(new Promise((resolve, reject) => {
      foreign.on('open', resolve);
      foreign.on('error', reject);
    }), /403/);
  } finally {
    // Stop the server first: Windows keeps its database open, and so undeletable, until it exits.
    if (server.exitCode === null && server.signalCode === null) {
      await new Promise((resolve) => {
        server.once('exit', resolve);
        server.kill();
      });
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
