'use strict';

/**
 * The audio of saved transcripts, so that History can play any line (and the whole recording can be
 * downloaded). A transcript's audio is made of pieces in DATA_DIR/audio, each covering the transcript
 * from `start_sec` on: an uploaded file is one piece, and each live session writing to a transcript
 * is another. Pieces are Ogg Opus (opus.js, about 12 MB per hour instead of 115 MB as WAV): live
 * audio is encoded as it arrives, an uploaded WAV file is converted in the background after it was
 * transcribed (and so are WAV or raw PCM pieces of older versions, at startup). A piece can be
 * played while it is still being written. Gaps between pieces play as silence.
 *
 * Settings (administrators, on the Users page): whether audio is kept at all, and how much of it at
 * most; beyond that the audio of the oldest transcripts is deleted, their text stays.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { getSetting, setSetting } = require('./db');
const { OpusWriter, opusSamples, opusDecode, opusPackets, FRAME } = require('./opus');
const { HttpError } = require('./errors');

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const DEFAULT_LIMIT_GB = 10; // about 900 hours of Opus
const GB = 1024 ** 3;
const SILENCE = Buffer.alloc(64 * 1024);

/** A 44-byte WAV header for 16 kHz mono 16-bit samples. */
function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(BYTES_PER_SECOND, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

class AudioStore {
  /**
   * @param {any} db
   * @param {string} dataDir
   * @param {{ compress?: boolean }} [options] compress: false keeps raw PCM and WAV pieces as they are (tests)
   */
  constructor(db, dataDir, { compress = true } = {}) {
    this.db = db;
    this.dir = path.join(dataDir, 'audio');
    this.compress = compress;
    fs.mkdirSync(this.dir, { recursive: true });
    this.writing = new Set(); // file names still being written (live sessions)
    this.held = new Map(); // file name -> users reading it (transcribing again): not deleted for the limit
    this.toConvert = []; // WAV and raw PCM pieces waiting to become Ogg Opus
    this.converting = null; // Promise while converting
    this.afterRelease = new Set(); // waiting to be converted until no one reads them
  }

  /**
   * Call at startup: forgets pieces whose file is gone, deletes files no piece refers to, and
   * converts pieces that are not Ogg Opus yet.
   */
  init() {
    const known = new Set();
    for (const r of this.db.prepare('SELECT id, file FROM transcript_audio').all()) {
      if (fs.existsSync(path.join(this.dir, r.file))) known.add(r.file);
      else this.db.prepare('DELETE FROM transcript_audio WHERE id = ?').run(r.id);
    }
    for (const f of fs.readdirSync(this.dir)) {
      if (!known.has(f)) fs.rmSync(path.join(this.dir, f), { force: true });
    }
    this.enforceLimit();
    this.convertLater(...[...known].filter((f) => !f.endsWith('.opus')));
  }

  // ---------- settings ----------

  get keep() {
    return getSetting(this.db, 'keepAudio', true);
  }

  get limitGb() {
    return getSetting(this.db, 'audioLimitGb', DEFAULT_LIMIT_GB);
  }

  /** { keep, limitGb, usedBytes } */
  settings() {
    return { keep: this.keep, limitGb: this.limitGb, usedBytes: this.usedBytes() };
  }

  /** @param {{ keep?: boolean, limitGb?: number }} changes */
  setSettings({ keep, limitGb }) {
    if (keep !== undefined && typeof keep !== 'boolean') throw new HttpError(400, 'Expected true or false.');
    if (limitGb !== undefined) {
      const v = Number(limitGb);
      if (!Number.isFinite(v) || v < 0.1 || v > 100000) {
        throw new HttpError(400, 'The limit must be between {min} and {max} GB.', { min: 0.1, max: 100000 });
      }
      setSetting(this.db, 'audioLimitGb', Math.round(v * 10) / 10);
    }
    if (keep !== undefined) setSetting(this.db, 'keepAudio', keep);
    this.enforceLimit();
    return this.settings();
  }

  usedBytes() {
    let n = 0;
    for (const f of fs.readdirSync(this.dir)) n += fileSize(path.join(this.dir, f));
    return n;
  }

  // ---------- storing ----------

  /**
   * A new piece of live audio: 16 kHz mono 16-bit samples, encoded to Ogg Opus as they arrive (one
   * page a second). It belongs to no transcript until add() is called (a live transcript is created
   * with its first line); end() when no more audio comes.
   * @returns {{ name: string, write(pcm: Buffer): void, end(): void }}
   */
  startLive() {
    const name = `${crypto.randomUUID()}${this.compress ? '.opus' : '.pcm'}`;
    const stream = fs.createWriteStream(path.join(this.dir, name));
    stream.on('error', (err) => console.error(`Writing audio ${name} failed:`, err.message));
    const writer = this.compress ? new OpusWriter((chunk) => stream.write(chunk)) : null;
    this.writing.add(name);
    return {
      name,
      write: (pcm) => {
        if (writer) writer.write(pcm);
        else stream.write(pcm);
      },
      end: () => {
        if (writer) writer.end();
        stream.end(() => {
          this.writing.delete(name);
          // Not added to a transcript (no line was said), or its transcript was deleted meanwhile.
          if (!this.db.prepare('SELECT 1 FROM transcript_audio WHERE file = ?').get(name)) {
            fs.rmSync(path.join(this.dir, name), { force: true });
          }
          this.enforceLimit();
        });
      },
    };
  }

  /**
   * Adds a piece to a transcript.
   * @param {number} transcriptId
   * @param {string} name a file in the audio folder (startLive()) or, with `move`, a file to move there
   * @param {{ start: number, dataStart?: number, move?: boolean }} where start: the transcript time
   *   of the piece's first sample (s); dataStart: where the samples begin in the file (a WAV header)
   */
  add(transcriptId, name, { start, dataStart = 0, move = false }) {
    let file = name;
    if (move) {
      file = `${crypto.randomUUID()}${path.extname(name)}`;
      fs.renameSync(name, path.join(this.dir, file));
    }
    this.db.prepare('INSERT INTO transcript_audio (transcript_id, file, data_start, start_sec, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(transcriptId, file, dataStart, start, Date.now());
    if (move) {
      this.enforceLimit();
      if (!file.endsWith('.opus')) this.convertLater(file);
    }
  }

  // ---------- converting to Ogg Opus ----------

  /** Converts these WAV or raw PCM pieces to Ogg Opus, one at a time, in the background. */
  convertLater(...names) {
    if (!this.compress) return;
    for (const n of names) if (!this.toConvert.includes(n)) this.toConvert.push(n);
    if (!this.converting && this.toConvert.length) {
      this.converting = (async () => {
        while (this.toConvert.length) {
          const name = this.toConvert.shift();
          try {
            await this.convert(name);
          } catch (err) {
            console.warn(`Converting audio ${name} failed:`, err.message);
          }
        }
      })().finally(() => {
        this.converting = null;
      });
    }
  }

  /** Resolves once nothing waits to be converted (tests). */
  async converted() {
    while (this.converting) await this.converting;
  }

  async convert(name) {
    const row = this.db.prepare('SELECT data_start FROM transcript_audio WHERE file = ?').get(name);
    if (!row || this.writing.has(name)) return;
    const source = path.join(this.dir, name);
    const opusName = `${crypto.randomUUID()}.opus`;
    const target = path.join(this.dir, opusName);
    const out = fs.createWriteStream(target);
    const writer = new OpusWriter((chunk) => out.write(chunk));
    const fh = await fs.promises.open(source, 'r');
    try {
      const buf = Buffer.alloc(BYTES_PER_SECOND);
      for (let pos = row.data_start; ;) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        writer.write(buf.subarray(0, bytesRead - (bytesRead % 2)));
        pos += bytesRead;
        await new Promise((resolve) => setImmediate(resolve)); // a second at a time: listening goes on
      }
      writer.end();
    } finally {
      await fh.close();
      await new Promise((resolve) => out.end(resolve));
    }
    // Swapped in only if the piece is still there and no one reads its file (transcribing again).
    if (this.held.has(name)) {
      fs.rmSync(target, { force: true });
      this.afterRelease.add(name);
      return;
    }
    if (!this.db.prepare('UPDATE transcript_audio SET file = ?, data_start = 0 WHERE file = ?').run(opusName, name).changes) {
      fs.rmSync(target, { force: true });
      return;
    }
    try {
      fs.rmSync(source, { force: true });
    } catch { /* still open somewhere: deleted at the next start, as no piece refers to it */ }
  }

  /** Deletes a transcript's audio (the transcript stays). Returns whether it had any. */
  remove(transcriptId) {
    const rows = this.db.prepare('SELECT id, file FROM transcript_audio WHERE transcript_id = ?').all(transcriptId);
    for (const r of rows) {
      this.db.prepare('DELETE FROM transcript_audio WHERE id = ?').run(r.id);
      // A file still being written is deleted when its session ends (startLive().end()).
      if (!this.writing.has(r.file)) fs.rmSync(path.join(this.dir, r.file), { force: true });
    }
    return rows.length > 0;
  }

  /** Beyond the size limit, the audio of the oldest transcripts goes (not what is being written). */
  enforceLimit() {
    let used = this.usedBytes();
    const limit = this.limitGb * GB;
    if (used <= limit) return;
    const pieces = this.db.prepare(`SELECT a.id, a.file, a.transcript_id FROM transcript_audio a
      JOIN transcripts t ON t.id = a.transcript_id ORDER BY t.started_at, a.id`).all();
    for (const p of pieces) {
      if (used <= limit) break;
      if (this.writing.has(p.file) || this.held.has(p.file)) continue;
      const full = path.join(this.dir, p.file);
      used -= fileSize(full);
      fs.rmSync(full, { force: true });
      this.db.prepare('DELETE FROM transcript_audio WHERE id = ?').run(p.id);
    }
  }

  // ---------- playing ----------

  /** Keeps files from being deleted for the size limit while they are read (release() afterwards). */
  hold(names) {
    for (const n of names) this.held.set(n, (this.held.get(n) || 0) + 1);
  }

  release(names) {
    for (const n of names) {
      const left = (this.held.get(n) || 1) - 1;
      if (left > 0) this.held.set(n, left);
      else this.held.delete(n);
    }
    this.enforceLimit();
    const ready = [...this.afterRelease].filter((n) => !this.held.has(n));
    for (const n of ready) this.afterRelease.delete(n);
    this.convertLater(...ready);
  }

  /** The transcript's pieces: [{ name, file (full path), opus, dataStart, start, seconds }] by start. */
  pieces(transcriptId) {
    return this.db.prepare('SELECT file, data_start, start_sec FROM transcript_audio WHERE transcript_id = ? ORDER BY start_sec, id')
      .all(transcriptId)
      .map((r) => {
        const file = path.join(this.dir, r.file);
        const opus = r.file.endsWith('.opus');
        const samples = opus
          ? (fs.existsSync(file) ? opusSamples(file) : 0)
          : Math.floor(Math.max(0, fileSize(file) - r.data_start) / 2);
        return { name: r.file, file, opus, dataStart: r.data_start, start: r.start_sec, seconds: samples / SAMPLE_RATE };
      })
      .filter((p) => p.seconds > 0);
  }

  /** A piece's samples from its start, as Buffers of 16-bit samples (transcribing it again). */
  async* pcm(piece) {
    if (piece.opus) {
      for (const chunk of opusDecode(piece.file, 0, Math.round(piece.seconds * SAMPLE_RATE))) yield chunk;
      return;
    }
    const end = piece.dataStart + 2 * Math.round(piece.seconds * SAMPLE_RATE);
    if (end > piece.dataStart) yield* fs.createReadStream(piece.file, { start: piece.dataStart, end: end - 1 });
  }

  /**
   * The transcript's audio from `from` to `to` seconds (default: all of it) as a WAV file, with
   * silence where no piece covers the time: { bytes, stream }.
   * @param {number} transcriptId
   * @param {{ from?: number, to?: number }} [range]
   */
  wav(transcriptId, { from, to } = {}) {
    const pieces = this.pieces(transcriptId);
    if (!pieces.length) throw new HttpError(404, 'This transcript has no audio.');
    const first = Math.round((from ?? Math.min(...pieces.map((p) => p.start))) * SAMPLE_RATE);
    const last = Math.round((to ?? Math.max(...pieces.map((p) => p.start + p.seconds))) * SAMPLE_RATE);
    const total = Math.max(0, last - first);
    // [{ silence: samples } | { file, from, to }] (byte ranges) covering first..last
    const parts = [];
    let at = first;
    for (const p of pieces) {
      const s0 = Math.round(p.start * SAMPLE_RATE);
      const s1 = s0 + Math.round(p.seconds * SAMPLE_RATE);
      if (s1 <= at || s0 >= last) continue;
      if (s0 > at) {
        parts.push({ silence: s0 - at });
        at = s0;
      }
      const end = Math.min(s1, last);
      if (p.opus) parts.push({ opus: p.file, from: at - s0, to: end - s0 }); // samples
      else parts.push({ file: p.file, from: p.dataStart + 2 * (at - s0), to: p.dataStart + 2 * (end - s0) });
      at = end;
    }
    if (at < last) parts.push({ silence: last - at });

    const silence = function* (bytes) {
      for (let left = bytes; left > 0; left -= SILENCE.length) yield SILENCE.subarray(0, Math.min(left, SILENCE.length));
    };
    async function* samples() {
      yield wavHeader(2 * total);
      for (const part of parts) {
        if (part.silence) {
          yield* silence(part.silence * 2);
        } else if (part.opus) {
          // Exactly the samples promised, even if decoding gives fewer (a page still being written).
          let sent = 0;
          for (const chunk of opusDecode(part.opus, part.from, part.to)) {
            sent += chunk.length;
            yield chunk;
          }
          yield* silence(2 * (part.to - part.from) - sent);
        } else if (part.to > part.from) {
          yield* fs.createReadStream(part.file, { start: part.from, end: part.to - 1 });
        }
      }
    }
    return { bytes: 44 + 2 * total, stream: Readable.from(samples()) };
  }

  /**
   * The transcript's whole audio as one Ogg Opus file, about 10 times smaller than WAV, as Buffers:
   * the Opus pieces' packets as they are (nothing is decoded), a piece not converted yet encoded
   * now, and silence between pieces. Each piece starts at the 20 ms frame nearest its time.
   * @param {number} transcriptId
   * @returns {{ pieces: string[], chunks: AsyncGenerator<Buffer> }} pieces: the files read
   */
  opus(transcriptId) {
    const pieces = this.pieces(transcriptId);
    if (!pieces.length) throw new HttpError(404, 'This transcript has no audio.');
    const self = this;
    async function* chunks() {
      const out = [];
      const writer = new OpusWriter((chunk) => out.push(chunk));
      for (const p of pieces) {
        const at = Math.round(((p.start - pieces[0].start) * SAMPLE_RATE) / FRAME);
        while (writer.frames < at) writer.silence();
        if (p.opus) {
          for (const packets of opusPackets(p.file)) {
            for (const packet of packets) writer.add(packet);
            yield* out.splice(0);
          }
        } else {
          for await (const chunk of self.pcm(p)) {
            writer.write(chunk);
            yield* out.splice(0);
            await new Promise((resolve) => setImmediate(resolve)); // encoding takes the CPU
          }
          writer.pad();
        }
      }
      writer.end();
      yield* out.splice(0);
    }
    return { pieces: pieces.map((p) => p.name), chunks: chunks() };
  }

  /**
   * Sends the transcript's whole audio as Ogg Opus (opus()), as an HTTP response.
   * @param {import('express').Response} res
   * @param {number} transcriptId
   * @param {{ filename?: string }} [options] filename: save as this file
   */
  async sendOpus(res, transcriptId, { filename } = {}) {
    const { pieces, chunks } = this.opus(transcriptId);
    this.hold(pieces); // not deleted or converted while they are read
    res.set({
      'Content-Type': 'audio/ogg',
      'Cache-Control': 'no-store',
      ...(filename ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {}),
    });
    try {
      await pipeline(Readable.from(chunks), res);
    } catch (err) {
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn(`Sending the audio of transcript ${transcriptId} failed:`, err.message);
    } finally {
      this.release(pieces);
    }
  }

  /**
   * Sends the transcript's audio (wav()) as an HTTP response.
   * @param {import('express').Response} res
   * @param {number} transcriptId
   * @param {{ from?: number, to?: number, filename?: string }} [options] filename: save as this file
   */
  async send(res, transcriptId, { from, to, filename } = {}) {
    const { bytes, stream } = this.wav(transcriptId, { from, to });
    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': String(bytes),
      'Cache-Control': 'no-store',
      ...(filename ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {}),
    });
    try {
      await pipeline(stream, res);
    } catch (err) {
      // The browser stops a line's audio when another one is played: nothing to report then.
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn(`Sending the audio of transcript ${transcriptId} failed:`, err.message);
    }
  }
}

module.exports = { AudioStore, wavHeader };
