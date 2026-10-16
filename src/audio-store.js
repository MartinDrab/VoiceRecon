'use strict';

/**
 * The audio of saved transcripts, so that History can play any line (and the whole recording can be
 * downloaded). A transcript's audio is made of pieces in DATA_DIR/audio, each covering the transcript
 * from `start_sec` on: an uploaded file is one piece (its WAV file, kept after transcription), and
 * each live session writing to a transcript is another (raw 16 kHz mono 16-bit PCM, written as the
 * microphone audio arrives). A piece's length is its file's size, so it can be played while it is
 * still being written. Gaps between pieces play as silence.
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
const { HttpError } = require('./errors');

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const DEFAULT_LIMIT_GB = 10; // about 87 hours
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
  constructor(db, dataDir) {
    this.db = db;
    this.dir = path.join(dataDir, 'audio');
    fs.mkdirSync(this.dir, { recursive: true });
    this.writing = new Set(); // file names still being written (live sessions)
  }

  /** Call at startup: forgets pieces whose file is gone and deletes files no piece refers to. */
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
   * A new piece of live audio: raw 16 kHz mono 16-bit samples appended to a file as they arrive.
   * It belongs to no transcript until add() is called (a live transcript is created with its first
   * line); end() when no more audio comes.
   * @returns {{ name: string, write(pcm: Buffer): void, end(): void }}
   */
  startLive() {
    const name = `${crypto.randomUUID()}.pcm`;
    const stream = fs.createWriteStream(path.join(this.dir, name));
    stream.on('error', (err) => console.error(`Writing audio ${name} failed:`, err.message));
    this.writing.add(name);
    return {
      name,
      write: (pcm) => {
        stream.write(pcm);
      },
      end: () => {
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
    if (move) this.enforceLimit();
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
      if (this.writing.has(p.file)) continue;
      const full = path.join(this.dir, p.file);
      used -= fileSize(full);
      fs.rmSync(full, { force: true });
      this.db.prepare('DELETE FROM transcript_audio WHERE id = ?').run(p.id);
    }
  }

  // ---------- playing ----------

  /** The transcript's pieces: [{ file (full path), dataStart, start, seconds }] by start. */
  pieces(transcriptId) {
    return this.db.prepare('SELECT file, data_start, start_sec FROM transcript_audio WHERE transcript_id = ? ORDER BY start_sec, id')
      .all(transcriptId)
      .map((r) => {
        const file = path.join(this.dir, r.file);
        const bytes = Math.max(0, fileSize(file) - r.data_start);
        return { file, dataStart: r.data_start, start: r.start_sec, seconds: Math.floor(bytes / 2) / SAMPLE_RATE };
      })
      .filter((p) => p.seconds > 0);
  }

  /**
   * Writes the transcript's audio from `from` to `to` seconds (default: all of it) to an HTTP
   * response as a WAV file, with silence where no piece covers the time.
   * @param {import('express').Response} res
   * @param {number} transcriptId
   * @param {{ from?: number, to?: number, filename?: string }} [options] filename: save as this file
   */
  async send(res, transcriptId, { from, to, filename } = {}) {
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
      parts.push({ file: p.file, from: p.dataStart + 2 * (at - s0), to: p.dataStart + 2 * (end - s0) });
      at = end;
    }
    if (at < last) parts.push({ silence: last - at });

    async function* samples() {
      for (const part of parts) {
        if (part.silence) {
          for (let left = part.silence * 2; left > 0; left -= SILENCE.length) yield SILENCE.subarray(0, Math.min(left, SILENCE.length));
        } else if (part.to > part.from) {
          yield* fs.createReadStream(part.file, { start: part.from, end: part.to - 1 });
        }
      }
    }
    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': String(44 + 2 * total),
      'Cache-Control': 'no-store',
      ...(filename ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {}),
    });
    res.write(wavHeader(2 * total));
    try {
      await pipeline(Readable.from(samples()), res);
    } catch (err) {
      // The browser stops a line's audio when another one is played: nothing to report then.
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn(`Sending the audio of transcript ${transcriptId} failed:`, err.message);
    }
  }
}

module.exports = { AudioStore, wavHeader };
