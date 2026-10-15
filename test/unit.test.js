'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { decodeWav, encodeWav, int16ToFloat } = require('../src/audio');
const { openDatabase, getSetting, setSetting } = require('../src/db');
const { Auth, hashPassword, verifyPassword, parseCookies } = require('../src/auth');
const { VoiceManager } = require('../src/voices');
const { TranscriptionSession, splitWords } = require('../src/transcriber');
const { SpeechEngine, l2normalize } = require('../src/speech/engine');

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

test('settings are stored as JSON', () => {
  const db = openDatabase(tmp());
  assert.strictEqual(getSetting(db, 'x', 0.4), 0.4);
  setSetting(db, 'x', 0.55);
  assert.strictEqual(getSetting(db, 'x', 0.4), 0.55);
  db.close();
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
