'use strict';

/**
 * Ogg Opus files (RFC 7845) of 16 kHz mono speech, for the audio kept with transcripts
 * (audio-store.js): about 12 MB per hour instead of 115 MB as WAV. Encoding and decoding use
 * opusscript (libopus compiled to WebAssembly, no native build). On copies of real enrolled
 * recordings, voice prints of the decoded audio were 0.994-0.996 alike to the original's at 32 kbps.
 * Opus's AUDIO mode, not VOIP: transcribed again from Opus, FLEURS gave 6.35 % WER in English
 * (VOIP 6.51 %, the original 6.02 %) and 11.10 % in Czech (VOIP 11.17 %, the original 11.04 %),
 * at the same size; VOIP at 48 kbps was no better than AUDIO at 32.
 *
 * Packets are 20 ms; a page holds up to PAGE_PACKETS of them (one second), so a file being written
 * can be read up to its last full page. Granule positions count 48 kHz samples, as the format says.
 */

const fs = require('fs');
const OpusScript = require('opusscript');

const SAMPLE_RATE = 16000;
const FRAME = 320; // 20 ms
const BITRATE = 32000;
// The encoder's delay at 16 kHz, in 48 kHz samples (104 and 103 samples, measured). It is written to
// each file's OpusHead, which readers go by: files written in VOIP mode before 2026-10-17 keep theirs.
const PRE_SKIP = { AUDIO: 312, VOIP: 309 };
const PAGE_PACKETS = 50;
const TO_48K = 48000 / SAMPLE_RATE;

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
 * @param {{ bitrate?: number, application?: 'VOIP' | 'AUDIO' }} [options] bits per second and the
 *   encoder's mode (scripts/bench-asr.js compares others)
 */
class OpusWriter {
  constructor(out, { bitrate = BITRATE, application = 'AUDIO' } = {}) {
    this.out = out;
    this.encoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application[application]);
    this.encoder.setBitrate(bitrate);
    this.preSkip = PRE_SKIP[application];
    this.serial = (Math.random() * 0x100000000) >>> 0;
    this.sequence = 0;
    this.samples = 0; // encoded so far
    this.frames = 0; // packets so far (20 ms each)
    this.rest = new Int16Array(0); // less than a frame, waiting for more
    this.packets = [];
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'latin1');
    head[8] = 1; // version
    head[9] = 1; // channels
    head.writeUInt16LE(this.preSkip, 10);
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
    this.add(Buffer.from(this.encoder.encode(Buffer.from(copy.buffer), FRAME)), real);
  }

  /** An encoded 20 ms packet, e.g. one of another file (opusPackets()) or silence. */
  add(packet, real = FRAME) {
    this.packets.push(packet);
    this.samples += real;
    this.frames++;
    if (this.packets.length >= PAGE_PACKETS) this.flush();
  }

  /** 20 ms of silence. */
  silence() {
    this.add(silentPacket());
  }

  /** What is left of the samples written, padded to a whole frame (before packets of another file). */
  pad() {
    if (!this.rest.length) return;
    const frame = new Int16Array(FRAME);
    frame.set(this.rest);
    this.rest = new Int16Array(0);
    this.encode(frame);
  }

  flush(flags = 0) {
    if (!this.packets.length && !flags) return;
    // Granule of a page: where its last packet ends (the last page: where the audio ends).
    this.emit(this.packets, this.preSkip + this.samples * TO_48K, flags);
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
    this.dispose();
  }

  /** Frees the encoder without finishing the file (a download cut short); after end() a no-op. */
  dispose() {
    if (this.encoder) this.encoder.delete();
    this.encoder = null;
  }
}

let silent = null;

/** One encoded 20 ms frame of silence (made once). */
function silentPacket() {
  if (!silent) {
    const encoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.AUDIO);
    encoder.setBitrate(BITRATE);
    silent = Buffer.from(encoder.encode(Buffer.alloc(2 * FRAME), FRAME));
    encoder.delete();
  }
  return silent;
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

/** The encoder's delay as the file's OpusHead gives it (48 kHz samples). */
function preSkipOf(fd, list) {
  const head = Buffer.alloc(12);
  if (!list.length || fs.readSync(fd, head, 0, 12, list[0].packets[0][0]) < 12 || head.toString('latin1', 0, 8) !== 'OpusHead') {
    throw new Error('Not an Ogg Opus file.');
  }
  return head.readUInt16LE(10);
}

/**
 * How many samples can be decoded from these pages: up to where the last one ends; in a file still
 * being written (no last page yet), less the encoder's delay, which only the next packets bring out.
 */
function available(list, preSkip) {
  const last = list.filter((p) => p.granule > 0).pop();
  if (!last) return 0;
  const upTo = Math.round((last.granule - preSkip) / TO_48K);
  return Math.max(0, last.flags & 4 ? upTo : upTo - Math.round(preSkip / TO_48K));
}

/**
 * How many 16 kHz samples an Ogg Opus file holds (what can be decoded, if it is still being written).
 * @param {string} file
 */
function opusSamples(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const list = pages(fd, fs.fstatSync(fd).size);
    return list.length ? available(list, preSkipOf(fd, list)) : 0;
  } finally {
    fs.closeSync(fd);
  }
}

/** A page's packets as Buffers, read from the file in one go. */
function readPackets(fd, p) {
  if (!p.packets.length) return [];
  const from = p.packets[0][0];
  const [lastStart, lastLength] = p.packets[p.packets.length - 1];
  const body = Buffer.alloc(lastStart + lastLength - from);
  fs.readSync(fd, body, 0, body.length, from);
  return p.packets.map(([start, length]) => body.subarray(start - from, start - from + length));
}

/**
 * The audio packets of an Ogg Opus file (20 ms each), a page at a time: arrays of Buffers. Copying
 * them into another file (OpusWriter.add()) needs no decoding.
 * @param {string} file
 */
function* opusPackets(file) {
  const fd = fs.openSync(file, 'r');
  try {
    for (const p of pages(fd, fs.fstatSync(fd).size).slice(2)) { // after OpusHead and OpusTags
      const packets = readPackets(fd, p);
      if (packets.length) yield packets;
    }
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
    const all = pages(fd, fs.fstatSync(fd).size);
    if (!all.length) return;
    const preSkip = preSkipOf(fd, all);
    const list = all.slice(2); // after OpusHead and OpusTags
    // Sample number at the start of each page: the end of the one before.
    let first = 0;
    const startOf = (i) => (i === 0 ? 0 : Math.round((list[i - 1].granule - preSkip) / TO_48K));
    while (first + 1 < list.length && startOf(first + 1) <= from) first++;
    first = Math.max(0, first - 1);
    let at = startOf(first) - Math.round(preSkip / TO_48K); // the decoder's output lags behind by the encoder's delay
    const end = Math.min(to, available(list, preSkip));
    for (let i = first; i < list.length && at < end; i++) {
      for (const packet of readPackets(fd, list[i])) {
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

module.exports = { OpusWriter, opusSamples, opusDecode, opusPackets, crc, PRE_SKIP, FRAME };
