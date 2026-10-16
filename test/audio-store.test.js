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

const folders = [];
test.after(() => {
  for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicerecon-audio-'));
  folders.push(dataDir);
  const db = openDatabase(dataDir);
  const transcript = (startedAt) => Number(db.prepare('INSERT INTO transcripts (started_at, updated_at) VALUES (?, ?)')
    .run(startedAt, startedAt).lastInsertRowid);
  return { dataDir, db, store: new AudioStore(db, dataDir), transcript };
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
  new AudioStore(db, dataDir).init();
  assert.strictEqual(fs.readdirSync(store.dir).length, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM transcript_audio').get().n, 1);
  db.close();
});
