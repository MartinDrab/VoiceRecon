'use strict';

// Ogg Opus files of the kept audio (src/opus.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OpusWriter, opusSamples, opusDecode, crc } = require('../src/opus');

const folders = [];
test.after(() => {
  for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicerecon-opus-'));
  folders.push(dir);
  return dir;
};

/** Speech-like test audio: a few tones that glide, `seconds` long. */
const signal = (seconds) => Int16Array.from({ length: Math.round(seconds * 16000) }, (_, i) => {
  const t = i / 16000;
  return Math.round(6000 * Math.sin(2 * Math.PI * (180 + 40 * Math.sin(t * 3)) * t) + 3000 * Math.sin(2 * Math.PI * 720 * t + Math.sin(t * 7)));
});

/** Normalized correlation of two equally long stretches (1: the same waveform). */
const similarity = (a, b) => {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / Math.sqrt(aa * bb);
};

/** Root mean square loudness of a stretch. */
const rms = (a) => Math.sqrt(a.reduce((n, x) => n + x * x, 0) / a.length);

const collect = (chunks) => {
  const all = Buffer.concat([...chunks]);
  return new Int16Array(all.buffer, all.byteOffset, all.length / 2);
};

function encode(file, pcm, { end = true, pieces = 7 } = {}) {
  const chunks = [];
  const writer = new OpusWriter((c) => chunks.push(c));
  // In uneven pieces, as audio arrives.
  const step = Math.ceil(pcm.length / pieces);
  for (let i = 0; i < pcm.length; i += step) writer.write(Buffer.from(pcm.slice(i, i + step).buffer));
  if (end) writer.end();
  fs.writeFileSync(file, Buffer.concat(chunks));
}

test('audio round-trips through Ogg Opus: exact length, same waveform, at the right times', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.opus');
  const pcm = signal(3.53);
  encode(file, pcm);
  const bytes = fs.statSync(file).size;
  assert.ok(bytes < pcm.length * 2 / 7, `about 12 MB per hour: ${bytes} bytes for ${pcm.length * 2} of WAV`);
  assert.strictEqual(opusSamples(file), pcm.length, 'the last page says where the audio ends');

  const whole = collect(opusDecode(file, 0, Infinity));
  assert.strictEqual(whole.length, pcm.length);
  // Opus keeps how speech sounds, not its exact waveform; but it must match best where it belongs.
  const lagged = (lag) => similarity(whole.subarray(800 + lag, 40000 + lag), pcm.subarray(800, 40000));
  const best = [-3, -2, -1, 0, 1, 2, 3].reduce((a, b) => (lagged(b) > lagged(a) ? b : a));
  assert.deepStrictEqual([best, lagged(0) > 0.7], [0, true], 'not shifted');
  // Up to its very end (as loud there as the original; the waveform's phase varies with the codec).
  const endRatio = rms(whole.subarray(pcm.length - 1000)) / rms(pcm.subarray(pcm.length - 1000));
  assert.ok(endRatio > 0.7 && endRatio < 1.3, `the end is there: ${endRatio}`);
  // A stretch from the middle (decoding starts a page early) matches the same stretch of the whole.
  const part = collect(opusDecode(file, 25000, 41000));
  assert.strictEqual(part.length, 16000);
  assert.ok(similarity(part, pcm.subarray(25000, 41000)) > 0.7);

  // Valid Ogg: every page's checksum, the Opus header first, the last page marked as the end.
  const data = fs.readFileSync(file);
  assert.strictEqual(data.toString('latin1', 28, 36), 'OpusHead');
  let pages = 0;
  for (let at = 0; at < data.length; pages++) {
    assert.strictEqual(data.toString('latin1', at, at + 4), 'OggS');
    const segments = data[at + 26];
    let size = 27 + segments;
    for (let i = 0; i < segments; i++) size += data[at + 27 + i];
    const p = Buffer.from(data.subarray(at, at + size));
    const sum = p.readUInt32LE(22);
    p.writeUInt32LE(0, 22);
    assert.strictEqual(crc(p), sum, `page ${pages}`);
    if (at + size === data.length) assert.strictEqual(data[at + 5] & 4, 4, 'end of stream');
    at += size;
  }
  assert.strictEqual(pages, 2 + Math.ceil((Math.ceil(pcm.length / 320) + 1) / 50), 'headers, then a page a second');

  // A whole number of frames still ends with its last samples (the encoder's delay is brought out).
  const exact = signal(2);
  encode(file, exact);
  const back = collect(opusDecode(file, 0, Infinity));
  assert.strictEqual(back.length, exact.length);
  const ratio = rms(back.subarray(31000)) / rms(exact.subarray(31000));
  assert.ok(ratio > 0.7 && ratio < 1.3, `the end is there: ${ratio}`);
});

test('a file still being written reads up to its last whole page', () => {
  const dir = tmp();
  const file = path.join(dir, 'live.opus');
  encode(file, signal(2.5), { end: false });
  // Two full pages of a second, less the encoder's delay (103 samples), which the next packets bring.
  assert.strictEqual(opusSamples(file), 2 * 16000 - 103);
  assert.strictEqual(collect(opusDecode(file, 0, Infinity)).length, 2 * 16000 - 103);
});
