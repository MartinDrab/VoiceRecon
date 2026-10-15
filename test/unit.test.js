'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { decodeWav, encodeWav, int16ToFloat } = require('../src/audio');
const { openDatabase, getSetting, setSetting } = require('../src/db');
const { Auth, hashPassword, verifyPassword, parseCookies } = require('../src/auth');
const { VoiceManager } = require('../src/voices');
const { TranscriptionSession, splitWords, dropLead, sentenceLines, wordsOf } = require('../src/transcriber');
const { SpeechEngine, l2normalize, spellable, analyze } = require('../src/speech/engine');
const { readHeader, titleFromName } = require('../src/uploads');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'voicerecon-test-'));

test('WAV encode/decode round trip', () => {
  const samples = Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 10) * 0.5);
  const out = decodeWav(encodeWav(samples, 16000));
  assert.strictEqual(out.sampleRate, 16000);
  assert.strictEqual(out.samples.length, samples.length);
  for (let i = 0; i < samples.length; i++) assert.ok(Math.abs(out.samples[i] - samples[i]) < 1e-4);
});

test('WAV decoder downmixes stereo float files', () => {
  const frames = 4;
  const buf = Buffer.alloc(44 + frames * 2 * 4);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + frames * 8, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(44100, 24);
  buf.writeUInt32LE(44100 * 8, 28);
  buf.writeUInt16LE(8, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(frames * 8, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeFloatLE(0.5, 44 + i * 8);
    buf.writeFloatLE(-0.1, 48 + i * 8);
  }
  const out = decodeWav(buf);
  assert.strictEqual(out.sampleRate, 44100);
  assert.deepStrictEqual([...out.samples].map((x) => x.toFixed(2)), ['0.20', '0.20', '0.20', '0.20']);
  assert.throws(() => decodeWav(Buffer.from('not a wav file at all')), /Not a WAV/);
});

test('int16ToFloat handles unaligned buffers', () => {
  const bytes = Buffer.alloc(5);
  bytes.writeInt16LE(-32768, 1);
  bytes.writeInt16LE(16384, 3);
  const f = int16ToFloat(bytes.subarray(1));
  assert.deepStrictEqual([...f], [-1, 0.5]);
});

test('password hashing', async () => {
  const hash = await hashPassword('correct horse');
  assert.ok(hash.startsWith('scrypt$'));
  assert.strictEqual(await verifyPassword('correct horse', hash), true);
  assert.strictEqual(await verifyPassword('wrong', hash), false);
  assert.notStrictEqual(await hashPassword('correct horse'), hash, 'salted');
});

test('cookie parsing', () => {
  assert.deepStrictEqual(parseCookies('a=1; vr_session=abc%3D; b'), { a: '1', vr_session: 'abc=' });
  // malformed percent-encoding (e.g. a cookie from another app on localhost) must not throw
  assert.deepStrictEqual(parseCookies('other=50%; vr_session=x%zz'), { other: '50%', vr_session: 'x%zz' });
});

test('users, sessions and administrator safeguards', async () => {
  const db = openDatabase(tmp());
  const auth = new Auth(db, { sessionTtlHours: 1, secureCookies: false });
  const admin = await auth.createUser({ username: 'boss', password: 'password1', role: 'admin' });
  await assert.rejects(auth.createUser({ username: 'BOSS', password: 'password1', role: 'user' }), /already exists/);
  await assert.rejects(auth.createUser({ username: 'x', password: 'password1', role: 'user' }), /Username/);
  await assert.rejects(auth.createUser({ username: 'shorty', password: 'short', role: 'user' }), /Password/);

  const { token } = await auth.login('boss', 'password1', '1.2.3.4');
  assert.strictEqual(auth.userFromToken(token).username, 'boss');
  await assert.rejects(auth.login('boss', 'nope', '1.2.3.4'), /Wrong username or password/);

  await assert.rejects(auth.updateUser(admin.id, { role: 'user' }), /last administrator/);
  assert.throws(() => auth.deleteUser(admin.id), /last administrator/);

  const other = await auth.createUser({ username: 'pat', password: 'password2', role: 'user' });
  await assert.rejects(auth.updateUser(other.id, { role: 'admin', password: 'short' }), /Password/);
  assert.strictEqual(auth.getUser(other.id).role, 'user', 'a rejected change changes nothing');
  const s1 = (await auth.login('pat', 'password2', '1.2.3.4')).token;
  const s2 = (await auth.login('pat', 'password2', '1.2.3.4')).token;
  await auth.updateUser(other.id, { password: 'password3' }, { keepToken: s1 });
  assert.ok(auth.userFromToken(s1), 'current session kept');
  assert.strictEqual(auth.userFromToken(s2), null, 'other sessions signed out');

  auth.deleteUser(other.id);
  assert.strictEqual(auth.userFromToken(s1), null);
  auth.destroySession(token);
  assert.strictEqual(auth.userFromToken(token), null);
  db.close();
});

test('login throttling after repeated failures', async () => {
  const db = openDatabase(tmp());
  const auth = new Auth(db, { sessionTtlHours: 1, secureCookies: false });
  await auth.createUser({ username: 'boss', password: 'password1', role: 'admin' });
  for (let i = 0; i < 10; i++) await assert.rejects(auth.login('boss', 'bad', '9.9.9.9'));
  await assert.rejects(auth.login('boss', 'password1', '9.9.9.9'), /Too many/);
  assert.ok(await auth.login('boss', 'password1', '8.8.8.8'), 'other addresses unaffected');
  db.close();
});

test('login throttling also holds for parallel attempts', async () => {
  const db = openDatabase(tmp());
  const auth = new Auth(db, { sessionTtlHours: 1, secureCookies: false });
  await auth.createUser({ username: 'boss', password: 'password1', role: 'admin' });
  const results = await Promise.allSettled(Array.from({ length: 25 }, () => auth.login('boss', 'bad', '7.7.7.7')));
  const throttled = results.filter((r) => r.status === 'rejected' && /Too many/.test(r.reason.message)).length;
  assert.strictEqual(throttled, 15, 'only 10 attempts may reach the password check');
  db.close();
});

test('unknown usernames are rejected like wrong passwords', async () => {
  const db = openDatabase(tmp());
  const auth = new Auth(db, { sessionTtlHours: 1, secureCookies: false });
  await auth.createUser({ username: 'boss', password: 'password1', role: 'admin' });
  await assert.rejects(auth.login('nobody', 'password1', '1.1.1.1'), /Wrong username or password/);
  await assert.rejects(auth.login(undefined, undefined, '1.1.1.1'), /Wrong username or password/);
  db.close();
});

test('first-run setup cannot create two administrators concurrently', async () => {
  const db = openDatabase(tmp());
  const auth = new Auth(db, { sessionTtlHours: 1, secureCookies: false });
  const results = await Promise.allSettled([
    auth.createUser({ username: 'first', password: 'password1', role: 'admin' }, { onlyIfNoUsers: true }),
    auth.createUser({ username: 'second', password: 'password1', role: 'admin' }, { onlyIfNoUsers: true }),
  ]);
  assert.deepStrictEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.strictEqual(auth.countUsers(), 1);
  db.close();
});

test('speech engine queue: finals before interims, cancel drops queued jobs', async () => {
  const engine = new SpeechEngine({});
  const order = [];
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  const gate = new Promise((r) => {
    release = r;
  });
  engine.recognizer = {
    createStream: () => ({ acceptWaveform() {}, samples: null }),
    decodeAsync: async () => {
      await gate;
      return { text: 'x' };
    },
  };
  const a = {};
  const b = {};
  const track = (name, p) => p.then((r) => order.push(`${name}:${r.text}`));
  const jobs = [
    track('running', engine.transcribe(new Float32Array(1), { owner: a })),
    track('a-interim', engine.transcribe(new Float32Array(1), { owner: a, interim: true })),
    track('b-final', engine.transcribe(new Float32Array(1), { owner: b })),
    track('a-final', engine.transcribe(new Float32Array(1), { owner: a })),
  ];
  engine.cancel(a, { interimOnly: true }); // drops a-interim only
  engine.cancel(b); // drops b-final
  release();
  await Promise.all(jobs);
  assert.deepStrictEqual(order, ['a-interim:', 'b-final:', 'running:x', 'a-final:x']);
  assert.ok(engine.idle);
});

test('speech engine queue: uploaded files wait behind live work and do not block interim results', async () => {
  const engine = new SpeechEngine({});
  const order = [];
  const gates = [];
  engine.recognizer = {
    createStream: () => ({ acceptWaveform() {} }),
    decodeAsync: () => new Promise((resolve) => gates.push(() => resolve({ text: 'x' }))),
  };
  const track = (name, p) => p.then(() => order.push(name));
  const jobs = [track('file-1', engine.transcribe(new Float32Array(1), { background: true }))];
  assert.ok(engine.idle, 'a running file job leaves room for interim results');
  jobs.push(
    track('file-2', engine.transcribe(new Float32Array(1), { background: true })),
    track('interim', engine.transcribe(new Float32Array(1), { interim: true })),
    track('final', engine.transcribe(new Float32Array(1))),
  );
  assert.ok(!engine.idle);
  while (order.length < 4) {
    await new Promise((r) => setImmediate(r));
    if (gates.length) gates.shift()();
  }
  await Promise.all(jobs);
  assert.deepStrictEqual(order, ['file-1', 'final', 'interim', 'file-2']);
});

test('uploaded recordings: only 16 kHz mono 16-bit WAV, data size from the file when streamed', async () => {
  const dir = tmp();
  const write = (name, buf) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, buf);
    return file;
  };
  const wav = encodeWav(new Float32Array(16000), 16000); // 1 s
  assert.deepStrictEqual(await readHeader(write('ok.wav', wav)), { dataStart: 44, dataBytes: 32000 });
  const streamed = Buffer.from(wav);
  streamed.writeUInt32LE(0xffffffff, 40); // size unknown when the file was written
  assert.deepStrictEqual(await readHeader(write('streamed.wav', streamed)), { dataStart: 44, dataBytes: 32000 });
  const other = Buffer.from(wav);
  other.writeUInt32LE(44100, 24);
  await assert.rejects(readHeader(write('rate.wav', other)), /16 kHz mono 16-bit/);
  await assert.rejects(readHeader(write('text.wav', Buffer.from('hello world, not audio'))), /Not a WAV file/);
  await assert.rejects(readHeader(write('empty.wav', wav.subarray(0, 44))), /empty/);
  assert.strictEqual(titleFromName('C:\\Rec\\Porada 1. 10..m4a'), 'Porada 1. 10.');
  assert.strictEqual(titleFromName('meeting'), 'meeting');
  assert.strictEqual(titleFromName('.hidden'), '.hidden');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcription session never throws errors after it is closed', async () => {
  const fakeEngine = {
    createVad: () => ({}),
    cancel() {},
    transcribe: () => Promise.reject(new Error('decoder failed')),
  };
  const session = new TranscriptionSession(fakeEngine, {});
  const errors = [];
  session.on('error', (e) => errors.push(e.message));
  // An ASR failure while the session is open is reported, not left as an unhandled rejection.
  session.enqueueFinal(new Float32Array(10), 0, new Float32Array(10), 0, 1);
  await session.chain;
  assert.deepStrictEqual(errors, ['decoder failed']);
  // After close() there are no listeners; a failure must be logged instead of thrown.
  session.enqueueFinal(new Float32Array(10), 0, new Float32Array(10), 0, 2);
  const origError = console.error;
  console.error = () => {};
  try {
    session.close();
    await session.chain;
  } finally {
    console.error = origError;
  }
});

test('relative paths in the settings count from the project folder', () => {
  const root = path.join(__dirname, '..');
  const script = `const c = require(${JSON.stringify(path.join(root, 'src', 'config.js'))}); console.log(JSON.stringify([c.dataDir, c.tlsCert]));`;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: os.tmpdir(),
    env: { ...process.env, DATA_DIR: 'some-data', TLS_CERT: 'certs/cert.pem' },
    encoding: 'utf8',
  });
  assert.deepStrictEqual(JSON.parse(out), [path.join(root, 'some-data'), path.join(root, 'certs', 'cert.pem')]);
});

test('settings are stored as JSON', () => {
  const db = openDatabase(tmp());
  assert.strictEqual(getSetting(db, 'x', 0.4), 0.4);
  setSetting(db, 'x', 0.55);
  assert.strictEqual(getSetting(db, 'x', 0.4), 0.55);
  db.close();
});

test('names and terms: validated, listed with their boost, and only what the model can spell', () => {
  const dataDir = tmp();
  const db = openDatabase(dataDir);
  const vm = new VoiceManager(db, { ready: true, speakerModelName: 'm' }, { dataDir, defaultThreshold: 0.5 });
  vm.init();
  vm.create({ name: 'jirka', color: '#ff0000' });
  vm.setVocabulary(['  Kyjev ', 'Kyjev', '', 'Andrew  Sharp']);
  assert.deepStrictEqual(vm.vocabulary, ['Kyjev', 'Andrew Sharp']);
  assert.throws(() => vm.setVocabulary(['a/b']), /may not contain/);
  assert.throws(() => vm.setVocabulary(['x'.repeat(61)]), /too long/);
  assert.throws(() => vm.setVocabulary('Kyjev'), /list/);
  assert.deepStrictEqual(vm.hotwords(), [
    { text: 'jirka', score: 1 }, { text: 'Jirka', score: 1 }, // voice names: lighter, also capitalized
    { text: 'Kyjev', score: 2 }, { text: 'Kyjev', score: 2 },
    { text: 'Andrew Sharp', score: 2 }, { text: 'Andrew Sharp', score: 2 },
  ]);

  const engine = new SpeechEngine({});
  const pieces = new Set(['▁', '▁J', '▁j', 'ir', 'ka', 'K', 'y', 'jev', '▁Andrew', '▁Sh', 'arp']);
  assert.ok(spellable('Jirka', pieces) && spellable('Andrew Sharp', pieces));
  assert.ok(!spellable('Jiřka', pieces), 'a letter the model does not know');
  engine.vocabulary = { pieces, file: 'bpe.vocab' };
  const used = engine.setHotwords([...vm.hotwords(), { text: 'Jiřka', score: 1 }, { text: 'Kyjev', score: 1 }, { text: 'a/b:c', score: 1 }]);
  assert.deepStrictEqual(used, ['jirka', 'Jirka', 'Kyjev', 'Andrew Sharp']);
  assert.strictEqual(engine.hotwords, 'jirka :1/Jirka :1/Kyjev :2/Andrew Sharp :2', 'a phrase listed twice keeps its higher boost');
  engine.vocabulary = { pieces, file: '' };
  assert.deepStrictEqual(engine.setHotwords(vm.hotwords()), [], 'without a vocabulary file no words can be given');
  assert.strictEqual(engine.hotwords, '');
  db.close();
});

test('long stretches of one speaker become lines at sentence ends', () => {
  // words: [text, start, end] in seconds
  const result = (words) => ({
    text: words.map((w) => w[0]).join(''),
    tokens: words.map((w) => w[0]),
    timestamps: words.map((w) => w[1]),
    durations: words.map((w) => w[2] - w[1]),
  });
  const lines = (words) => sentenceLines(wordsOf(result(words))).map((l) => l.map((w) => w.text).join('').trim());
  assert.deepStrictEqual(lines([
    [' Dobrý', 0, 0.5], [' den', 0.6, 1], [' všem', 1.1, 2], [' tady.', 2.1, 3.5],
    [' Dnes', 4, 4.5], [' je', 4.6, 5], [' 32.', 5.1, 5.6], [' epizoda', 5.7, 6.5], [' show.', 6.6, 7.5],
    [' Ano.', 7.6, 8], [' Konec', 8.1, 9], [' a', 9.1, 9.3], [' tečka.', 9.4, 11],
  ]), ['Dobrý den všem tady.', 'Dnes je 32. epizoda show.', 'Ano. Konec a tečka.'], 'not after "32." (an ordinal)');
  // too short on one side, or no capital after the full stop: one line
  assert.deepStrictEqual(lines([[' Ano.', 0, 0.5], [' Dobře', 0.6, 2], [' tak', 2.1, 3], [' jo.', 3.1, 4]]), ['Ano. Dobře tak jo.']);
  assert.deepStrictEqual(lines([[' Je', 0, 1], [' to', 1.1, 2], [' tak.', 2.1, 3.2], [' a', 3.3, 4], [' dál', 4.1, 5], [' to', 5.1, 6], [' jde.', 6.1, 7]]),
    ['Je to tak. a dál to jde.']);
  assert.deepStrictEqual(wordsOf({ text: 'x', tokens: ['x'], timestamps: [], durations: [] }), null, 'no word times');
});

test('splitting between speakers keeps every word when the next speaker was not recognized', () => {
  const r = { text: '', tokens: [' A', ' b', ' c', ' d'], timestamps: [0, 1, 2, 3], durations: [0.5, 0.5, 0.5, 0.5] };
  assert.deepStrictEqual(splitWords(r, [9]), ['A b c d', ''], 'the change lies after the last word');
  assert.deepStrictEqual(splitWords(r, [2.05]), ['A b', 'C d']);
});

test('enrolled voices taking turns are cut where one clearly takes over from another', () => {
  // Each "embedding" names the voice it matches clearly ('A', 'B') or no voice clearly (null).
  const voices = {
    identify: (e) => (e.v ? { voiceId: e.v, scores: [{ voiceId: e.v, score: 0.8 }, { voiceId: 'x', score: e.close ? 0.75 : 0.3 }] }
      : { voiceId: null, scores: [] }),
  };
  const session = new TranscriptionSession({ createVad: () => ({}) }, voices);
  const w = (v, close = false) => ({ v, close });
  assert.deepStrictEqual(session.voiceChanges([w('A'), w('A'), w('A'), w('B'), w('B')]), [3]);
  assert.deepStrictEqual(session.voiceChanges([w('A'), w('A'), w(null), w(null), w('B'), w('B')]), [3], 'midway between the voices');
  assert.deepStrictEqual(session.voiceChanges([w('A'), w('A'), w('B', true), w('A')]), [], 'an unclear window is no change');
  assert.deepStrictEqual(session.voiceChanges([w('A'), w('B'), w('A'), w('A')]), [1, 2], 'one clear window is enough');
  assert.deepStrictEqual(session.voiceChanges([w(null), w(null)]), []);
});

test('a recording is decoded, measured, voice-printed and re-encoded in one step (the job of the worker)', () => {
  const calls = [];
  const engine = {
    resample: (samples, rate) => {
      calls.push(`resample ${rate}`);
      return samples;
    },
    speechOnly: (audio) => audio.subarray(0, 8000), // half a second of "speech"
    embedLong: (speech) => Float32Array.of(speech.length),
  };
  const samples = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 20) / 2);
  const r = analyze(/** @type {any} */ (engine), { wav: encodeWav(samples, 16000), keepWav: true });
  assert.deepStrictEqual([r.duration, r.speechSeconds, [...r.embedding]], [1, 0.5, [8000]]);
  assert.strictEqual(decodeWav(Buffer.from(r.wav)).samples.length, 16000, 'the stored file has the whole recording');
  assert.ok(r.wav.byteOffset === 0 && r.wav.byteLength === r.wav.buffer.byteLength, 'its own buffer, so it can be handed over');
  const silent = analyze(/** @type {any} */ ({ ...engine, speechOnly: () => new Float32Array(0) }), { samples, sampleRate: 48000 });
  assert.deepStrictEqual([silent.embedding, silent.wav], [null, null]);
  assert.deepStrictEqual(calls, ['resample 16000', 'resample 48000']);
  assert.throws(() => analyze(/** @type {any} */ (engine), { wav: Buffer.from('not a wav file') }), /Not a WAV file/);
});

test('saving an unknown speaker waits for its voice print, once, and undoes the voice on failure', async () => {
  const created = [];
  const removed = [];
  let fail = true;
  const voices = {
    create: () => created.push(created.length + 1) && created.length,
    remove: (id) => removed.push(id),
    addSample: async () => {
      await new Promise((r) => setTimeout(r, 10));
      if (fail) throw new Error('Not enough speech in the recording.');
    },
  };
  const session = new TranscriptionSession({ createVad: () => ({}) }, voices);
  session.unknown = [{ id: 'u1', label: 'Speaker 1', centroid: null, count: 1, audio: [new Float32Array(10)], audioLen: 10 }];
  const messages = [];
  session.on('message', (m) => messages.push(m));

  await assert.rejects(session.saveUnknown('u1', { name: 'Eva', color: '#ff0000' }), /Not enough speech/);
  assert.deepStrictEqual(removed, [1], 'the new voice is removed again');
  fail = false;
  const saving = session.saveUnknown('u1', { name: 'Eva', color: '#ff0000' });
  await assert.rejects(session.saveUnknown('u1', { name: 'Eva', color: '#ff0000' }), /no longer available/, 'a second click while saving');
  assert.throws(() => session.assignUnknown('u1', 7), /being saved/, 'no second voice for the same person');
  assert.strictEqual(await saving, 2);
  assert.deepStrictEqual(session.unknown, []);
  assert.deepStrictEqual(messages, [{ type: 'relabel', from: { kind: 'unknown', id: 'u1', label: 'Speaker 1' }, to: { kind: 'voice', id: 2, score: 1 } }]);
});

test('voice manager validation and matching', () => {
  const dataDir = tmp();
  const db = openDatabase(dataDir);
  const engine = { ready: true, speakerModelName: 'test-model' };
  const vm = new VoiceManager(db, engine, { dataDir, defaultThreshold: 0.5 });
  vm.init();
  let changes = 0;
  vm.on('changed', () => changes++);

  const a = vm.create({ name: ' Alice ', color: '#FF0000' });
  const b = vm.create({ name: 'Bob', color: '#00ff00' });
  assert.throws(() => vm.create({ name: '', color: '#ff0000' }), /Name/);
  assert.throws(() => vm.create({ name: 'X', color: 'red' }), /Color/);
  vm.update(a, { name: 'Alicia' });
  assert.deepStrictEqual(vm.summary().map((v) => [v.name, v.color]), [['Alicia', '#ff0000'], ['Bob', '#00ff00']]);
  assert.strictEqual(changes, 3);

  vm.prints.set(a, { enrolled: [l2normalize(Float32Array.of(1, 0, 0))], learned: null });
  vm.prints.set(b, { enrolled: [l2normalize(Float32Array.of(0, 1, 0))], learned: null });
  assert.strictEqual(vm.identify(l2normalize(Float32Array.of(0.9, 0.2, 0))).voiceId, a);
  assert.strictEqual(vm.identify(l2normalize(Float32Array.of(0.1, 1, 0.1))).voiceId, b);
  assert.strictEqual(vm.identify(l2normalize(Float32Array.of(0, 0, 1))).voiceId, null, 'below threshold');

  vm.setThreshold(0.2);
  assert.strictEqual(vm.threshold, 0.2);
  assert.throws(() => vm.setThreshold(2), /Threshold/);

  vm.remove(b);
  assert.strictEqual(vm.summary().length, 1);
  assert.ok(!vm.prints.has(b));
  db.close();
});

test('voices match their best recording, and learn only from clear matches', () => {
  const dataDir = tmp();
  const db = openDatabase(dataDir);
  const vm = new VoiceManager(db, { ready: true, speakerModelName: 'm' }, { dataDir, defaultThreshold: 0.5 });
  vm.init();
  const v = (...xs) => l2normalize(Float32Array.from(xs));
  const blob = (e) => Buffer.from(e.buffer);
  const addSample = (voiceId, e) => {
    db.prepare("INSERT INTO voice_samples (voice_id, file, duration, speech_duration, embedding, model) VALUES (?, 'x.wav', 10, 10, ?, 'm')")
      .run(voiceId, blob(e));
    vm.refreshPrints(voiceId);
  };
  const anna = vm.create({ name: 'Anna', color: '#ff0000' });
  const ben = vm.create({ name: 'Ben', color: '#00ff00' });
  addSample(anna, v(1, 0, 0, 0)); // recorded in one room...
  addSample(anna, v(0, 1, 0, 0)); // ...and in another
  addSample(ben, v(0, 0, 1, 0));

  // The averaged print would score only 0.71; the matching recording scores 1.
  const m = vm.identify(v(0, 1, 0, 0));
  assert.strictEqual(m.voiceId, anna);
  assert.ok(Math.abs(m.score - 1) < 1e-6);

  // Learning is off by default, and then gated.
  const clear = v(0.9, 0.1, 0.1, 0);
  assert.strictEqual(vm.considerLearning(anna, clear, 3), false, 'off by default');
  vm.setLearnFromSpeech(true);
  assert.strictEqual(vm.considerLearning(anna, clear, 1), false, 'too short');
  assert.strictEqual(vm.considerLearning(anna, v(0.5, 0, 0.5, 0), 3), false, 'Anna and Ben are equally likely');
  assert.strictEqual(vm.considerLearning(anna, v(0, 0, 1, 0.2), 3), false, 'that is Ben');
  assert.strictEqual(vm.considerLearning(anna, v(0.55, 0, 0, 0.835), 3), false, 'not clearly above the threshold');
  assert.strictEqual(vm.considerLearning(anna, clear, 3), true);
  assert.strictEqual(vm.prints.get(anna).learned, null, 'one live line does not count yet');
  vm.considerLearning(anna, clear, 3);
  vm.considerLearning(anna, clear, 3);
  assert.ok(vm.prints.get(anna).learned, 'three live lines do');
  for (let i = 0; i < 40; i++) vm.considerLearning(anna, clear, 3);
  assert.deepStrictEqual(vm.list().find((x) => x.id === anna).learned, { live: 30, correction: 0 });

  // Corrections count immediately and are always learned.
  vm.setLearnFromSpeech(false);
  let changed = 0;
  vm.on('changed', () => changed++);
  assert.strictEqual(vm.learnCorrections(ben, [{ embedding: v(0, 0, 0.6, 0.8), seconds: 2 }, { embedding: v(0, 0, 1, 0), seconds: 0.5 }]), 1);
  assert.ok(vm.prints.get(ben).learned);
  assert.strictEqual(changed, 1);
  assert.ok(vm.identify(v(0, 0, 0.6, 0.8)).score > 0.99, 'the corrected sound now matches Ben');
  assert.throws(() => vm.learnCorrections(999, []), /Voice not found/);

  // Learned lines alone never make a voice recognizable.
  const cleo = vm.create({ name: 'Cleo', color: '#0000ff' });
  vm.learnCorrections(cleo, [{ embedding: v(0, 0, 0, 1), seconds: 5 }]);
  assert.ok(!vm.prints.has(cleo));

  vm.forgetLearned(anna);
  assert.deepStrictEqual(vm.list().find((x) => x.id === anna).learned, { live: 0, correction: 0 });
  assert.strictEqual(vm.prints.get(anna).learned, null);
  vm.forgetLearned();
  assert.deepStrictEqual(vm.list().find((x) => x.id === ben).learned, { live: 0, correction: 0 });
  db.close();
});

test('short utterances are recognized after the speech before them, keeping only their own words', async () => {
  const calls = [];
  // The recognizer "hears" 4 s of context, 0.5 s of silence, then the utterance (from 4.5 s).
  const heard = {
    text: ' Co se stalo minule. Ukrajincům.',
    tokens: [' Co', ' se', ' sta', 'lo', ' minule', '.', ' Ukra', 'jin', 'cům', '.'],
    timestamps: [0.2, 0.6, 1.0, 1.3, 2.0, 4.3, 4.6, 4.9, 5.1, 5.4],
    durations: [0.1, 0.1, 0.1, 0.1, 0.4, 0.1, 0.1, 0.1, 0.1, 0.1],
    lang: '',
  };
  const engine = {
    createVad: () => ({}),
    cancel() {},
    transcribe: async (samples) => {
      calls.push(samples.length);
      return calls.length === 1 ? heard : { text: 'Alone.', tokens: [], timestamps: [], durations: [], lang: '' };
    },
  };
  const session = new TranscriptionSession(engine, {});
  const context = new Float32Array(4 * 16000);
  const audio = new Float32Array(1.2 * 16000);
  const r = await session.recognize(audio, context, {});
  assert.deepStrictEqual(calls, [context.length + 0.5 * 16000 + audio.length]);
  assert.strictEqual(r.text, 'Ukrajincům.', 'the late "." of the context and the context words are dropped');
  assert.deepStrictEqual(r.timestamps.map((t) => Math.round(t * 10) / 10), [0.1, 0.4, 0.6, 0.9], 'times count from the utterance');
  assert.strictEqual((await session.recognize(audio, null, {})).text, 'Alone.', 'no context: the utterance alone');
  assert.strictEqual(calls[1], audio.length);

  // Without token times the context cannot be cut off, so the utterance is recognized alone.
  assert.strictEqual(dropLead({ ...heard, timestamps: [] }, 4.5, 0.25), null);
  calls.length = 0;
  engine.transcribe = async (samples) => {
    calls.push(samples.length);
    return calls.length === 1 ? { ...heard, timestamps: [] } : { ...heard, text: 'Alone again.' };
  };
  assert.strictEqual((await session.recognize(audio, context, {})).text, 'Alone again.');
  assert.deepStrictEqual(calls, [context.length + 0.5 * 16000 + audio.length, audio.length]);
  assert.strictEqual(dropLead({ ...heard, tokens: [], timestamps: [] }, 4.5, 0.25).text, '', 'silence stays silence');
});

test('splitWords cuts between words, preferring sentence ends', () => {
  const r = {
    text: 'To je skvělé, kam jste jeli. Byli jsme v Itálii.',
    tokens: [' To', ' je', ' skvě', 'lé', ',', ' kam', ' jste', ' j', 'eli', '.', ' By', 'li', ' jsme', ' v', ' Itá', 'lii', '.'],
    timestamps: [0, 0.2, 0.4, 0.6, 0.7, 0.9, 1.1, 1.3, 1.4, 1.6, 1.7, 1.85, 2.0, 2.2, 2.3, 2.5, 2.7],
    durations: [0.15, 0.15, 0.15, 0.1, 0.1, 0.15, 0.15, 0.1, 0.15, 0.08, 0.1, 0.1, 0.15, 0.08, 0.15, 0.15, 0.1],
  };
  // The estimated change time (1.6 s) falls inside "jeli."; the cut lands after the full stop.
  assert.deepStrictEqual(splitWords(r, [1.6]), ['To je skvělé, kam jste jeli.', 'Byli jsme v Itálii.']);
  assert.deepStrictEqual(splitWords({ ...r, tokens: [], timestamps: [] }, [1.6]), [r.text]);
});
