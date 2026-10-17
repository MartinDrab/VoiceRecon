'use strict';

// The audio kept with transcripts (src/audio-store.js): pieces, clips across gaps, the size limit.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');
const { openDatabase, setSetting } = require('../src/db');
const { AudioStore, wavHeader } = require('../src/audio-store');
const { opusSamples, opusDecode } = require('../src/opus');

const folders = [];
test.after(() => {
  for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** compress: false keeps raw PCM and WAV pieces, whose samples come back exactly. */
function setup({ compress = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicerecon-audio-'));
  folders.push(dataDir);
  const db = openDatabase(dataDir);
  const transcript = (startedAt) => Number(db.prepare('INSERT INTO transcripts (started_at, updated_at) VALUES (?, ?)')
    .run(startedAt, startedAt).lastInsertRowid);
  return { dataDir, db, store: new AudioStore(db, dataDir, { compress }), transcript };
}

/** `seconds` of 16 kHz samples, all `value`. */
const pcm = (seconds, value) => {
  const b = Buffer.alloc(Math.round(seconds * 16000) * 2);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(value, i);
  return b;
};

/** What send() writes, as { headers, samples }. */
async function fetchAudio(store, transcriptId, options) {
  const chunks = [];
  const headers = {};
  const res = new Writable({
    write(chunk, _enc, done) {
      chunks.push(chunk);
      done();
    },
  });
  /** @type {any} */ (res).set = (h) => Object.assign(headers, h);
  await store.send(/** @type {any} */ (res), transcriptId, options);
  const body = Buffer.concat(chunks);
  assert.strictEqual(body.readUInt32LE(40), body.length - 44, 'the WAV header gives the data size');
  assert.strictEqual(Number(headers['Content-Length']), body.length);
  const samples = [];
  for (let i = 44; i < body.length; i += 2) samples.push(body.readInt16LE(i));
  return { headers, samples };
}

/** [[value, count], ...] runs of equal samples, counts rounded to 10 ms. */
const runs = (samples) => {
  const out = [];
  for (const v of samples) {
    const last = out[out.length - 1];
    if (last && last[0] === v) last[1]++;
    else out.push([v, 1]);
  }
  return out.map(([v, n]) => [v, Math.round(n / 160) / 100]);
};

test('a transcript plays from its pieces, with silence between them', async () => {
  const { dataDir, db, store, transcript } = setup();
  const tid = transcript(1);
  // A live piece from 0 s (raw samples) and an uploaded WAV piece from 2 s.
  const live = store.startLive();
  live.write(pcm(1, 1000));
  store.add(tid, live.name, { start: 0 });
  const wav = path.join(dataDir, 'upload.wav');
  fs.writeFileSync(wav, Buffer.concat([wavHeader(32000), pcm(1, 2000)]));
  store.add(tid, wav, { start: 2, dataStart: 44, move: true });
  await new Promise((resolve) => setTimeout(resolve, 50)); // the live file is written meanwhile

  const clip = await fetchAudio(store, tid, { from: 0.5, to: 2.5 });
  assert.deepStrictEqual(runs(clip.samples), [[1000, 0.5], [0, 1], [2000, 0.5]]);
  const whole = await fetchAudio(store, tid, { filename: 'x.wav' });
  assert.deepStrictEqual(runs(whole.samples), [[1000, 1], [0, 1], [2000, 1]]);
  assert.match(whole.headers['Content-Disposition'], /attachment; filename="x.wav"/);
  assert.ok(!fs.existsSync(wav), 'the uploaded file was moved into the audio folder');

  live.end();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(store.remove(tid), true);
  assert.deepStrictEqual(fs.readdirSync(store.dir), []);
  await assert.rejects(fetchAudio(store, tid), /no audio/);
  db.close();
});

test('kept audio is Ogg Opus: live audio as it comes, an uploaded WAV file once it was transcribed', async () => {
  const { dataDir, db, store, transcript } = setup({ compress: true });
  const tid = transcript(1);
  const tone = (seconds) => {
    const b = Buffer.alloc(Math.round(seconds * 16000) * 2);
    for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 9)), 2 * i);
    return b;
  };
  const loudness = (samples) => Math.sqrt(samples.reduce((n, x) => n + x * x, 0) / samples.length);

  const live = store.startLive();
  assert.match(live.name, /\.opus$/);
  for (let i = 0; i < 25; i++) live.write(tone(0.1)); // 2.5 s in 100 ms frames
  store.add(tid, live.name, { start: 0 });
  live.end();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const wav = path.join(dataDir, 'upload.wav');
  fs.writeFileSync(wav, Buffer.concat([wavHeader(4 * 32000), tone(4)]));
  store.add(tid, wav, { start: 10, dataStart: 44, move: true }); // kept as WAV until converted
  await store.converted();
  const files = fs.readdirSync(store.dir).sort();
  assert.ok(files.every((f) => f.endsWith('.opus')) && files.length === 2, `converted and the WAV gone: ${files}`);
  assert.deepStrictEqual(store.pieces(tid).map((p) => [p.start, p.seconds]), [[0, 2.5], [10, 4]]);
  const used = store.usedBytes();
  assert.ok(used < (2.5 + 4) * 32000 / 7, `${used} bytes for 6.5 s`);

  // Played back: tone where there was audio, silence between, at the right times.
  const { samples } = await fetchAudio(store, tid, { from: 1, to: 12 });
  assert.strictEqual(samples.length, 11 * 16000);
  assert.ok(loudness(samples.slice(0, 16000)) > 4000, 'the live piece');
  assert.strictEqual(loudness(samples.slice(1.6 * 16000, 8.9 * 16000)), 0, 'silence between');
  assert.ok(loudness(samples.slice(9.1 * 16000, 11 * 16000)) > 4000, 'the uploaded piece');
  // Read whole for transcribing again.
  const pcm = [];
  for await (const chunk of store.pcm(store.pieces(tid)[1])) pcm.push(chunk);
  assert.strictEqual(Buffer.concat(pcm).length, 4 * 32000);
  db.close();
});

for (const compress of [true, false]) {
  test(`the whole audio downloads as one Ogg Opus file, from ${compress ? 'Opus pieces (copied)' : 'raw pieces (encoded now)'}`, async () => {
    const { dataDir, db, store, transcript } = setup({ compress });
    const tid = transcript(1);
    const tone = (seconds) => {
      const b = Buffer.alloc(Math.round(seconds * 16000) * 2);
      for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 9)), 2 * i);
      return b;
    };
    const live = store.startLive();
    live.write(tone(2.5));
    store.add(tid, live.name, { start: 3 });
    live.end();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const wav = path.join(dataDir, 'upload.wav');
    fs.writeFileSync(wav, Buffer.concat([wavHeader(4 * 32000), tone(4)]));
    store.add(tid, wav, { start: 13, dataStart: 44, move: true });
    await store.converted();
    assert.deepStrictEqual(store.pieces(tid).map((p) => p.opus), [compress, compress]);

    const chunks = [];
    for await (const chunk of store.opus(tid).chunks) chunks.push(chunk);
    const file = path.join(dataDir, 'download.opus');
    fs.writeFileSync(file, Buffer.concat(chunks));
    // From the first piece's start (3 s) to the end of the last (17 s), to within two frames.
    const seconds = opusSamples(file) / 16000;
    assert.ok(Math.abs(seconds - 14) <= 0.04, `${seconds} s`);
    assert.ok(fs.statSync(file).size < (14 * 32000) / 7, 'much smaller than WAV');
    const all = Buffer.concat([...opusDecode(file, 0, Infinity)]);
    const loudness = (from, to) => {
      let e = 0;
      for (let i = Math.round(from * 16000); i < Math.round(to * 16000); i++) e += all.readInt16LE(2 * i) ** 2;
      return Math.sqrt(e / ((to - from) * 16000));
    };
    assert.ok(loudness(0.1, 2.4) > 4000, 'the first piece');
    assert.ok(loudness(2.6, 9.9) < 50, 'silence between');
    assert.ok(loudness(10.1, 13.9) > 4000, 'the second piece, at its time');
    assert.throws(() => store.opus(transcript(2)), /no audio/);
    db.close();
  });
}

test('a piece being downloaded is held: not deleted for the limit, nor converted; a download cut short releases it', async () => {
  const { dataDir, db, store, transcript } = setup({ compress: true });
  const tid = transcript(1);
  const wav = path.join(dataDir, 'upload.wav');
  fs.writeFileSync(wav, Buffer.concat([wavHeader(2 * 32000), pcm(2, 3000)]));
  store.add(tid, wav, { start: 0, dataStart: 44, move: true }); // a WAV piece, converted in the background
  const [piece] = store.pieces(tid);
  assert.ok(!piece.opus);
  const gone = Object.assign(new Error('gone'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });

  // A WAV download that takes the first chunk and then waits. A client that goes away is nothing
  // to warn about (and nothing to misreport: the file streams are left with a return, not a throw).
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  let stalled = null;
  const slow = new Writable({ write(_chunk, _enc, done) { stalled = done; } });
  /** @type {any} */ (slow).set = () => {};
  const sending = store.send(/** @type {any} */ (slow), tid);
  while (!stalled) await new Promise((resolve) => setTimeout(resolve, 10));
  await store.converted();
  assert.ok(fs.existsSync(piece.file), 'not converted while it is read');
  setSetting(db, 'audioLimitGb', 1 / 1024 ** 3); // 1 byte: everything is over the limit
  store.enforceLimit();
  assert.ok(fs.existsSync(piece.file), 'not deleted while it is read');
  slow.destroy(gone); // the client went away
  await sending;
  assert.deepStrictEqual(store.pieces(tid), [], 'released: over the limit, so deleted');
  assert.strictEqual(store.held.size, 0);

  // An Opus download cut short releases its pieces too (and frees its encoder).
  setSetting(db, 'audioLimitGb', 10);
  fs.writeFileSync(wav, Buffer.concat([wavHeader(2 * 32000), pcm(2, 3000)]));
  store.add(tid, wav, { start: 0, dataStart: 44, move: true });
  await store.converted();
  const cut = new Writable({ write(_chunk, _enc, done) { done(gone); } });
  /** @type {any} */ (cut).set = () => {};
  await store.sendOpus(/** @type {any} */ (cut), tid);
  console.warn = warn;
  assert.deepStrictEqual(warned, []);
  assert.strictEqual(store.held.size, 0);
  assert.strictEqual(store.pieces(tid).length, 1);
  db.close();
});

test('a piece queued just as the converter finishes is converted too', async () => {
  const { dataDir, db, store, transcript } = setup({ compress: true });
  const tid = transcript(1);
  // A conversion that ends at once (its piece is gone), and a piece queued in the turn right after
  // its loop ended: it used to wait for the next convertLater() call.
  store.convertLater('gone.wav');
  await Promise.resolve();
  const wav = path.join(dataDir, 'upload.wav');
  fs.writeFileSync(wav, Buffer.concat([wavHeader(32000), pcm(1, 1000)]));
  store.add(tid, wav, { start: 0, dataStart: 44, move: true });
  await store.converted();
  assert.deepStrictEqual(store.pieces(tid).map((p) => p.opus), [true]);
  db.close();
});

test('live audio that never got a transcript is deleted when it ends', async () => {
  const { db, store } = setup();
  const live = store.startLive();
  live.write(pcm(0.5, 5));
  live.end();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepStrictEqual(fs.readdirSync(store.dir), []);
  db.close();
});

test('beyond the size limit the oldest transcripts lose their audio first', async () => {
  const { dataDir, db, store, transcript } = setup();
  const older = transcript(1000);
  const newer = transcript(2000);
  for (const [tid, n] of [[newer, 1], [older, 2]]) {
    const f = path.join(dataDir, `t${n}.pcm`);
    fs.writeFileSync(f, pcm(2, 7)); // 64 KB
    store.add(tid, f, { start: 0, move: true });
  }
  setSetting(db, 'audioLimitGb', 100000 / 1024 ** 3); // about 98 KB: room for one of them
  store.enforceLimit();
  assert.deepStrictEqual([store.pieces(older).length, store.pieces(newer).length], [0, 1]);
  assert.throws(() => store.setSettings({ limitGb: 0 }), /limit/);
  assert.deepStrictEqual(store.setSettings({ keep: false, limitGb: 5 }), { keep: false, limitGb: 5, usedBytes: 64000 });
  db.close();
});

test('at startup, files without a piece and pieces without a file are cleaned up', () => {
  const { dataDir, db, store, transcript } = setup();
  const tid = transcript(1);
  fs.writeFileSync(path.join(store.dir, 'stray.pcm'), pcm(1, 1)); // e.g. from a crash
  const f = path.join(dataDir, 'kept.pcm');
  fs.writeFileSync(f, pcm(1, 1));
  store.add(tid, f, { start: 0, move: true });
  db.prepare("INSERT INTO transcript_audio (transcript_id, file, data_start, start_sec, created_at) VALUES (?, 'gone.pcm', 0, 5, 0)").run(tid);
  new AudioStore(db, dataDir, { compress: false }).init();
  assert.strictEqual(fs.readdirSync(store.dir).length, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM transcript_audio').get().n, 1);
  db.close();
});
