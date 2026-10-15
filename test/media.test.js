'use strict';

// The browser's piece-by-piece file reading (public/static/js/media.js) rests on two modules
// without imports, run here in Node: the MP4/WAV header readers and the streaming resampler.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { resample } = require('../src/audio');

/** A browser module without imports, loaded into a sandbox; returns its exports. */
function load(name, exported) {
  const sandbox = {};
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'static', 'js', name), 'utf8');
  vm.runInNewContext(`${source.replace(/^export /gm, '')}\n${exported.map((n) => `this.${n} = ${n};`).join('\n')}`, sandbox);
  return sandbox;
}
const { parseMp4Audio, parseWavHeader } = load('containers.js', ['parseMp4Audio', 'parseWavHeader']);
const { Resampler } = load('resample.js', ['Resampler']);

// ---------- building MP4 boxes ----------
const u8 = (...v) => Buffer.from(v);
const u16 = (...v) => Buffer.concat(v.map((x) => Buffer.from([x >> 8, x & 255])));
const u32 = (...v) => {
  const b = Buffer.alloc(4 * v.length);
  v.forEach((x, i) => b.writeUInt32BE(x, 4 * i));
  return b;
};
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
};
/** An MPEG-4 descriptor; its size written in four bytes, as many encoders do. */
const descriptor = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u8(tag, 0x80, 0x80, 0x80, body.length), body]);
};

function audioTrack({ wide = false } = {}) {
  const esds = box('esds', u32(0),
    descriptor(0x03, u16(1), u8(0), // ES_ID, no optional fields
      descriptor(0x04, u8(0x40, 0x15, 0, 0, 0), u32(128000, 128000), descriptor(0x05, u8(0x12, 0x10))),
      descriptor(0x06, u8(0x02))));
  const mp4a = box('mp4a', Buffer.alloc(6), u16(1), u16(0, 0), u32(0), u16(2, 16, 0, 0), u32(44100 * 65536), esds);
  const stbl = box('stbl',
    box('stsd', u32(0, 1), mp4a),
    box('stts', u32(0, 1, 5, 1024)),
    box('stsc', u32(0, 2, 1, 2, 1, 3, 1, 1)), // chunks 1-2: two frames each; chunk 3: one
    box('stsz', u32(0, 0, 5, 10, 20, 30, 40, 50)),
    wide ? box('co64', u32(0, 3, 0, 1000, 1, 0, 1, 1000)) : box('stco', u32(0, 3, 1000, 2000, 3000)));
  return box('trak', box('mdia',
    box('mdhd', u32(0, 0, 0, 44100, 5 * 1024), u16(0, 0)),
    box('hdlr', u32(0, 0), Buffer.from('soun'), Buffer.alloc(13)),
    box('minf', stbl)));
}
const videoTrack = box('trak', box('mdia', box('hdlr', u32(0, 0), Buffer.from('vide'), Buffer.alloc(13))));
const payload = (moov) => new Uint8Array(moov.subarray(8));

test('the audio track of an MP4/M4A file: AAC settings and where every frame is', () => {
  const t = parseMp4Audio(payload(box('moov', box('mvhd', Buffer.alloc(100)), videoTrack, audioTrack())));
  assert.strictEqual(t.codec, 'mp4a.40.2');
  assert.deepStrictEqual([...t.description], [0x12, 0x10]);
  assert.deepStrictEqual([t.sampleRate, t.channels], [44100, 2]);
  assert.ok(Math.abs(t.duration - (5 * 1024) / 44100) < 1e-9);
  assert.deepStrictEqual([...t.sizes], [10, 20, 30, 40, 50]);
  assert.deepStrictEqual([...t.offsets], [1000, 1010, 2000, 2030, 3000], 'frames follow each other within a chunk');
  assert.deepStrictEqual([...t.starts].map((s) => Math.round(s * 44100)), [0, 1024, 2048, 3072, 4096]);

  // co64 chunk offsets (files over 4 GB): 1000, 2^32 and 2^32 + 1000
  const wide = parseMp4Audio(payload(box('moov', audioTrack({ wide: true }))));
  assert.deepStrictEqual([...wide.offsets], [1000, 1010, 2 ** 32, 2 ** 32 + 30, 2 ** 32 + 1000]);

  assert.strictEqual(parseMp4Audio(payload(box('moov', videoTrack))), null, 'no audio track');
});

test('WAV headers: where the samples are, for the encodings that are read piece by piece', () => {
  const wav = ({ format = 1, channels = 2, rate = 44100, bits = 16, dataSize = 400, extensible = false } = {}) => {
    const fmt = Buffer.alloc(extensible ? 40 : 16);
    fmt.writeUInt16LE(extensible ? 0xfffe : format, 0);
    fmt.writeUInt16LE(channels, 2);
    fmt.writeUInt32LE(rate, 4);
    fmt.writeUInt32LE((rate * channels * bits) / 8, 8);
    fmt.writeUInt16LE((channels * bits) / 8, 12);
    fmt.writeUInt16LE(bits, 14);
    if (extensible) fmt.writeUInt16LE(format, 24);
    const chunk = (id, body) => {
      const h = Buffer.alloc(8);
      h.write(id, 0, 'latin1');
      h.writeUInt32LE(body.length, 4);
      return Buffer.concat([h, body]);
    };
    const data = Buffer.alloc(8);
    data.write('data', 0, 'latin1');
    data.writeUInt32LE(dataSize, 4);
    const head = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), chunk('fmt ', fmt), chunk('LIST', Buffer.alloc(10)), data]);
    return new Uint8Array(head);
  };
  const h = parseWavHeader(wav(), 1000);
  assert.deepStrictEqual({ ...h }, { float: false, bits: 16, channels: 2, sampleRate: 44100, blockAlign: 4, dataStart: 62, dataBytes: 400 });
  assert.strictEqual(parseWavHeader(wav({ dataSize: 0xffffffff }), 1001).dataBytes, 936, 'unknown size: the rest of the file, whole frames');
  assert.deepStrictEqual([parseWavHeader(wav({ format: 3, bits: 32, extensible: true }), 1000).float, parseWavHeader(wav({ bits: 24 }), 1000).bits], [true, 24]);
  assert.strictEqual(parseWavHeader(wav({ format: 2, bits: 4 }), 1000), null, 'ADPCM: decoded by the browser instead');
  assert.strictEqual(parseWavHeader(new Uint8Array(Buffer.from('ID3 not a wave file at all')), 100), null);
});

test('the streaming resampler gives exactly what resampling the whole recording gives', () => {
  for (const [from, to] of [[44100, 16000], [48000, 16000], [22050, 16000], [16000, 16000], [8000, 16000]]) {
    const x = Float32Array.from({ length: 20011 }, (_, i) => Math.sin(i / 7) * 0.5 + Math.sin(i / 3.1) * 0.3);
    const r = new Resampler(from, to);
    const parts = [];
    for (let i = 0, n = 1; i < x.length; i += n, n = (n * 7) % 3001 + 1) parts.push(r.push(x.subarray(i, i + n)));
    parts.push(r.flush());
    const streamed = Float32Array.from(parts.flatMap((p) => [...p]));
    assert.deepStrictEqual([...streamed], [...resample(x, from, to)], `${from} -> ${to}`);
  }
});
