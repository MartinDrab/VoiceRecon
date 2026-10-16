'use strict';

/**
 * Ogg Opus files (RFC 7845) of 16 kHz mono speech, for the audio kept with transcripts
 * (audio-store.js): about 12 MB per hour instead of 115 MB as WAV. Encoding and decoding use
 * opusscript (libopus compiled to WebAssembly, no native build). On copies of real enrolled
 * recordings, voice prints of the decoded audio were 0.994-0.996 alike to the original's at 32 kbps.
 *
 * Packets are 20 ms; a page holds up to PAGE_PACKETS of them (one second), so a file being written
 * can be read up to its last full page. Granule positions count 48 kHz samples, as the format says.
 */

const fs = require('fs');
const OpusScript = require('opusscript');

const SAMPLE_RATE = 16000;
const FRAME = 320; // 20 ms
const BITRATE = 32000;
const PRE_SKIP = 309; // the encoder's delay at 16 kHz in VOIP mode (103 samples, measured), in 48 kHz samples
const PAGE_PACKETS = 50;
const TO_48K = 48000 / SAMPLE_RATE;
const DELAY = PRE_SKIP / TO_48K; // 16 kHz samples the decoder's output lags behind

// ---------- Ogg pages ----------

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  CRC_TABLE[i] = r >>> 0;
}

function crc(buf) {
  let c = 0;
  for (const b of buf) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ b) & 0xff]) >>> 0;
  return c;
}

/** One Ogg page with whole packets. flags: 2 first page, 4 last page. */
function page(packets, { granule, serial, sequence, flags = 0 }) {
  const lacing = [];
  for (const p of packets) {
    for (let n = p.length; ; n -= 255) {
      lacing.push(Math.min(n, 255));
      if (n < 255) break;
    }
  }
  const h = Buffer.alloc(27 + lacing.length);
  h.write('OggS', 0, 'latin1');
  h[5] = flags;
  h.writeBigInt64LE(BigInt(granule), 6);
  h.writeUInt32LE(serial, 14);
  h.writeUInt32LE(sequence, 18);
  h[26] = lacing.length;
  Buffer.from(lacing).copy(h, 27);
  const out = Buffer.concat([h, ...packets]);
  out.writeUInt32LE(crc(out), 22);
  return out;
}

/**
 * Writes 16 kHz mono 16-bit samples as an Ogg Opus file, as they come.
 * @param {(chunk: Buffer) => void} out receives the file's bytes in order
 */
class OpusWriter {
  constructor(out) {
    this.out = out;
    this.encoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
    this.encoder.setBitrate(BITRATE);
    this.serial = (Math.random() * 0x100000000) >>> 0;
    this.sequence = 0;
    this.samples = 0; // encoded so far
    this.rest = new Int16Array(0); // less than a frame, waiting for more
    this.packets = [];
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'latin1');
    head[8] = 1; // version
    head[9] = 1; // channels
    head.writeUInt16LE(PRE_SKIP, 10);
    head.writeUInt32LE(SAMPLE_RATE, 12);
    const vendor = Buffer.from('VoiceRecon');
    const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write('OpusTags', 0, 'latin1');
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    this.emit([head], 0, 2);
    this.emit([tags], 0);
  }

  emit(packets, granule, flags = 0) {
    this.out(page(packets, { granule, serial: this.serial, sequence: this.sequence++, flags }));
  }

  /** @param {Int16Array | Buffer} pcm samples (a Buffer holds them as 16-bit little-endian) */
  write(pcm) {
    const input = Buffer.isBuffer(pcm) ? new Int16Array(Uint8Array.from(pcm).buffer, 0, pcm.length >> 1) : pcm;
    const all = new Int16Array(this.rest.length + input.length);
    all.set(this.rest);
    all.set(input, this.rest.length);
    let at = 0;
    for (; at + FRAME <= all.length; at += FRAME) this.encode(all.subarray(at, at + FRAME));
    this.rest = all.slice(at);
  }

  encode(frame, real = FRAME) {
    const copy = Int16Array.from(frame);
    this.packets.push(Buffer.from(this.encoder.encode(Buffer.from(copy.buffer), FRAME)));
    this.samples += real;
    if (this.packets.length >= PAGE_PACKETS) this.flush();
  }

  flush(flags = 0) {
    if (!this.packets.length && !flags) return;
    // Granule of a page: where its last packet ends (the last page: where the audio ends).
    this.emit(this.packets, PRE_SKIP + this.samples * TO_48K, flags);
    this.packets = [];
  }

  /**
   * The rest, padded to a frame, and one silent frame more, which brings out the last samples the
   * encoder still holds (its delay); the last page says where the audio really ends.
   */
  end() {
    if (this.rest.length) {
      const frame = new Int16Array(FRAME);
      frame.set(this.rest);
      this.encode(frame, this.rest.length);
      this.rest = new Int16Array(0);
    }
    this.encode(new Int16Array(FRAME), 0);
    this.flush(4);
    this.encoder.delete();
  }
}

// ---------- reading ----------

/** The pages of an Ogg file: [{ offset, size, granule, flags, packets: [[start, length]] }]. */
function pages(fd, size) {
  const out = [];
  const head = Buffer.alloc(27 + 255);
  for (let at = 0; at + 27 <= size;) {
    const n = fs.readSync(fd, head, 0, head.length, at);
    if (n < 27 || head.toString('latin1', 0, 4) !== 'OggS') break;
    const segments = head[26];
    if (n < 27 + segments) break;
    const packets = [];
    let start = at + 27 + segments;
    let length = 0;
    for (let i = 0; i < segments; i++) {
      length += head[27 + i];
      if (head[27 + i] < 255) {
        packets.push([start, length]);
        start += length;
        length = 0;
      }
    }
    const body = start + length - (at + 27 + segments);
    if (at + 27 + segments + body > size) break; // a page still being written
    out.push({ offset: at, granule: Number(head.readBigInt64LE(6)), flags: head[5], packets });
    at = start + length;
  }
  return out;
}

/**
 * How many samples can be decoded from these pages: up to where the last one ends; in a file still
 * being written (no last page yet), less the encoder's delay, which only the next packets bring out.
 */
function available(list) {
  const last = list.filter((p) => p.granule > 0).pop();
  if (!last) return 0;
  const upTo = Math.round((last.granule - PRE_SKIP) / TO_48K);
  return Math.max(0, last.flags & 4 ? upTo : upTo - DELAY);
}

/**
 * How many 16 kHz samples an Ogg Opus file holds (what can be decoded, if it is still being written).
 * @param {string} file
 */
function opusSamples(file) {
  const fd = fs.openSync(file, 'r');
  try {
    return available(pages(fd, fs.fstatSync(fd).size));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Decodes samples `from` to `to` (16 kHz sample numbers) of an Ogg Opus file, as Buffers of
 * 16-bit samples. Decoding starts a page early, so the decoder has settled when `from` comes.
 * @param {string} file
 * @param {number} from
 * @param {number} to
 */
function* opusDecode(file, from, to) {
  const fd = fs.openSync(file, 'r');
  const decoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
  try {
    const list = pages(fd, fs.fstatSync(fd).size).slice(2); // after OpusHead and OpusTags
    // Sample number at the start of each page: the end of the one before.
    let first = 0;
    const startOf = (i) => (i === 0 ? 0 : Math.round((list[i - 1].granule - PRE_SKIP) / TO_48K));
    while (first + 1 < list.length && startOf(first + 1) <= from) first++;
    first = Math.max(0, first - 1);
    let at = startOf(first) - DELAY; // the decoder's output lags behind by the encoder's delay
    const end = Math.min(to, available(list));
    for (let i = first; i < list.length && at < end; i++) {
      for (const [start, length] of list[i].packets) {
        const packet = Buffer.alloc(length);
        fs.readSync(fd, packet, 0, length, start);
        const d = decoder.decode(packet);
        const pcm = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
        const n = pcm.length / 2;
        const a = Math.max(0, from - at);
        const b = Math.min(n, end - at);
        if (b > a) yield Buffer.from(pcm.subarray(2 * a, 2 * b));
        at += n;
        if (at >= end) break;
      }
    }
  } finally {
    decoder.delete();
    fs.closeSync(fd);
  }
}

module.exports = { OpusWriter, opusSamples, opusDecode, crc, PRE_SKIP };
