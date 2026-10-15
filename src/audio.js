'use strict';

const { HttpError } = require('./errors');

/** Minimal WAV (RIFF) reader/writer for PCM 8/16/24/32-bit and IEEE float 32/64-bit. */

function decodeWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new HttpError(400, 'Not a WAV file.');
  }
  let fmt = null;
  let data = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (start + size > buf.length) size = buf.length - start; // tolerate truncated/streamed files
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(start);
      const channels = buf.readUInt16LE(start + 2);
      const sampleRate = buf.readUInt32LE(start + 4);
      const bits = buf.readUInt16LE(start + 14);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(start + 24); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') {
      data = buf.subarray(start, start + size);
    }
    pos = start + size + (size & 1);
  }
  if (!fmt || !data) throw new HttpError(400, 'WAV file is missing its fmt or data chunk.');
  const { format, channels, sampleRate, bits } = fmt;
  if (!channels || !sampleRate || !bits) throw new HttpError(400, 'Invalid WAV header.');

  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const read = sampleReader(format, bits);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(data, (i * channels + c) * bytes);
    samples[i] = sum / channels;
  }
  return { samples, sampleRate };
}

function sampleReader(format, bits) {
  if (format === 1) {
    if (bits === 8) return (b, o) => (b[o] - 128) / 128;
    if (bits === 16) return (b, o) => b.readInt16LE(o) / 32768;
    if (bits === 24) return (b, o) => b.readIntLE(o, 3) / 8388608;
    if (bits === 32) return (b, o) => b.readInt32LE(o) / 2147483648;
  } else if (format === 3) {
    if (bits === 32) return (b, o) => b.readFloatLE(o);
    if (bits === 64) return (b, o) => b.readDoubleLE(o);
  }
  throw new HttpError(400, 'Unsupported WAV encoding (format {format}, {bits} bits).', { format, bits });
}

/** Encodes mono float samples as 16-bit PCM WAV. */
function encodeWav(samples, sampleRate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), 44 + i * 2);
  }
  return buf;
}

/** Converts little-endian 16-bit PCM bytes to float samples. */
function int16ToFloat(bytes) {
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

const RESAMPLE_PHASES = 256;
const RESAMPLE_ZERO_CROSSINGS = 8;

/**
 * Resamples a whole recording with a windowed-sinc low-pass filter (Blackman window, kernel
 * precomputed for 256 fractional phases), the same design as the browser's pcm-worklet.js, so
 * that recordings at 44.1/48 kHz are converted without aliasing.
 */
function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const fc = 0.45 / Math.max(1, ratio); // cutoff in cycles per input sample
  const half = Math.ceil(RESAMPLE_ZERO_CROSSINGS / (2 * fc));
  const taps = 2 * half;
  const table = [];
  for (let p = 0; p <= RESAMPLE_PHASES; p++) {
    const phase = p / RESAMPLE_PHASES;
    const k = new Float32Array(taps);
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const x = j - half + 1 - phase;
      const s = x === 0 ? 1 : Math.sin(2 * Math.PI * fc * x) / (2 * Math.PI * fc * x);
      const w = (x + half) / (2 * half);
      k[j] = s * (0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w));
      sum += k[j];
    }
    for (let j = 0; j < taps; j++) k[j] /= sum;
    table.push(k);
  }
  const out = new Float32Array(Math.floor(samples.length / ratio));
  const last = samples.length - 1;
  for (let o = 0; o < out.length; o++) {
    const pos = o * ratio;
    const i0 = Math.floor(pos);
    const k = table[Math.round((pos - i0) * RESAMPLE_PHASES)];
    const base = i0 - half + 1;
    let acc = 0;
    if (base >= 0 && base + taps - 1 <= last) {
      for (let j = 0; j < taps; j++) acc += samples[base + j] * k[j];
    } else {
      for (let j = 0; j < taps; j++) {
        const n = base + j;
        if (n >= 0 && n <= last) acc += samples[n] * k[j];
      }
    }
    out[o] = acc;
  }
  return out;
}

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

module.exports = { decodeWav, encodeWav, int16ToFloat, resample, concat };
