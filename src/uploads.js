'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { HttpError } = require('./errors');
const { int16ToFloat } = require('./audio');
const { TranscriptionSession } = require('./transcriber');
const { SAMPLE_RATE } = require('./speech/engine');

const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 16 kHz mono 16-bit
const MAX_HOURS = 4;
const MAX_BYTES = MAX_HOURS * 3600 * BYTES_PER_SECOND + 4096; // plus room for the WAV header
const MAX_OFFSET = 7 * 24 * 3600; // seconds: where in a (long) recording an uploaded part may start
const PIECE = BYTES_PER_SECOND; // fed at a time, giving live sessions the event loop in between
const STEP = 5 * BYTES_PER_SECOND; // then wait until this much audio has been transcribed

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Passes a stream through, failing once it is longer than `max` bytes. */
function limit(max) {
  let n = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      n += chunk.length;
      if (n > max) done(new HttpError(413, 'Recordings may be at most {hours} hours long.', { hours: MAX_HOURS }));
      else done(null, chunk);
    },
  });
}

/**
 * Where the samples of an uploaded WAV file are: { dataStart, dataBytes }. Only 16 kHz mono
 * 16-bit PCM is accepted, which is what the browser converts every file to.
 */
async function readHeader(file) {
  const { size } = await fs.promises.stat(file);
  const fh = await fs.promises.open(file, 'r');
  const head = Buffer.alloc(Math.min(size, 65536));
  try {
    await fh.read(head, 0, head.length, 0);
  } finally {
    await fh.close();
  }
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
    throw new HttpError(400, 'Not a WAV file.');
  }
  let fmt = null;
  for (let pos = 12; pos + 8 <= head.length;) {
    const id = head.toString('ascii', pos, pos + 4);
    const chunkSize = head.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (id === 'fmt ' && start + 16 <= head.length) {
      let format = head.readUInt16LE(start);
      if (format === 0xfffe && start + 26 <= head.length) format = head.readUInt16LE(start + 24); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels: head.readUInt16LE(start + 2), rate: head.readUInt32LE(start + 4), bits: head.readUInt16LE(start + 14) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== SAMPLE_RATE || fmt.bits !== 16) {
        throw new HttpError(400, 'Send the recording as a 16 kHz mono 16-bit WAV file.');
      }
      // Streamed files may leave the size at 0 or at the maximum: the rest of the file is the data.
      const rest = size - start;
      const dataBytes = chunkSize > 0 && chunkSize <= rest ? chunkSize : rest;
      if (dataBytes < 2) throw new HttpError(400, 'The recording is empty.');
      return { dataStart: start, dataBytes: dataBytes - (dataBytes % 2) };
    }
    pos = start + chunkSize + (chunkSize & 1);
  }
  throw new HttpError(400, 'WAV file is missing its fmt or data chunk.');
}

/** "Meeting 2026-10-01.m4a" -> "Meeting 2026-10-01" */
function titleFromName(name) {
  const base = String(name || '').split(/[\\/]/).pop().trim();
  return base.replace(/\.[^.\s]{1,5}$/, '') || base;
}

/**
 * Transcribes uploaded recordings into saved transcripts in the background, one file at a time.
 * The browser converts any audio file to 16 kHz mono 16-bit WAV (public/static/js/audio.js); the
 * upload is streamed to a temporary file and fed through the same TranscriptionSession as live
 * audio, with speaker recognition and unknown speakers alike. It recognizes at background priority
 * and waits after every few seconds of audio until they are transcribed, so live listening never
 * waits behind a long file. Once the file is done, its speakers are decided again per speaker,
 * from all their lines together (src/regroup.js). Uploaded files never teach the voices (their sound differs from the
 * room's microphone); moving lines to a voice in History does, as for live transcripts.
 *
 * Each transcript's progress is in TranscriptStore.processing (shown by the History pages):
 *   { state: 'queued' | 'transcribing' | 'failed', done, total }   done/total in seconds of audio
 */
class UploadQueue {
  /** @param {{ dataDir: string, engine: any, voices: any, transcripts: any, audio?: any }} options
   *   audio: an AudioStore that keeps the files of transcribed recordings (History plays their lines) */
  constructor({ dataDir, engine, voices, transcripts, audio = null }) {
    this.dir = path.join(dataDir, 'uploads');
    fs.rmSync(this.dir, { recursive: true, force: true }); // files of a run that was interrupted
    fs.mkdirSync(this.dir, { recursive: true });
    this.engine = engine;
    this.voices = voices;
    this.transcripts = transcripts;
    this.audio = audio;
    this.waiting = [];
    this.running = null;
  }

  /**
   * Saves an uploaded WAV file (the request body, streamed) and queues it.
   * @param {import('http').IncomingMessage} req
   * @param {{ id: number }} user
   * @param {{ name?: string, startedAt?: number, offset?: number }} options  file name (the title),
   *   when the recording started (ms; default now): the lines' times count from it, and where in the
   *   recording the uploaded part starts (seconds; default 0), so that line times match the recording
   * @returns {Promise<number>} the id of the new transcript
   */
  async add(req, user, { name = '', startedAt, offset = 0 } = {}) {
    if (Number(req.headers['content-length']) > MAX_BYTES) {
      throw new HttpError(413, 'Recordings may be at most {hours} hours long.', { hours: MAX_HOURS });
    }
    if (!(Number.isFinite(offset) && offset >= 0 && offset <= MAX_OFFSET)) {
      throw new HttpError(400, 'The start of the part must be a number of seconds.');
    }
    const file = path.join(this.dir, `${crypto.randomUUID()}.wav`);
    try {
      try {
        await pipeline(req, limit(MAX_BYTES), fs.createWriteStream(file));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, 'The upload was interrupted.');
      }
      const { dataStart, dataBytes } = await readHeader(file);
      const now = Date.now();
      const start = Number.isInteger(startedAt) && startedAt > 0 && startedAt <= now ? startedAt : now;
      const transcript = this.transcripts.create(user.id, { title: titleFromName(name), startedAt: start });
      const status = { state: 'queued', done: 0, total: dataBytes / BYTES_PER_SECOND };
      /** @type {(value?: unknown) => void} */
      let resolveDone = () => {};
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      this.waiting.push({
        id: transcript.id, file, dataStart, dataBytes, startedAt: start, offset, status, cancelled: false, done, resolveDone,
      });
      this.transcripts.processing.set(transcript.id, status);
      this.transcripts.setRecording(transcript.id, true);
      this.pump();
      return transcript.id;
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
  }

  /**
   * Transcribes a saved transcript again from its kept audio (audio-store.js), with the current
   * models, voices and names: once its turn comes, its lines are replaced by the new ones. Queued
   * like uploaded files, behind live listening; stopping keeps what is done.
   * @param {number} transcriptId
   */
  again(transcriptId) {
    this.transcripts.get(transcriptId);
    if (this.transcripts.recording.has(transcriptId)) throw new HttpError(409, 'Wait until the transcript is finished.');
    const pieces = this.audio ? this.audio.pieces(transcriptId) : [];
    if (!pieces.length) throw new HttpError(400, 'This transcript has no audio.');
    const status = { state: 'queued', done: 0, total: pieces.reduce((n, p) => n + p.seconds, 0) };
    /** @type {(value?: unknown) => void} */
    let resolveDone = () => {};
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    this.audio.hold(pieces.map((p) => p.name)); // not deleted for the size limit meanwhile
    this.waiting.push({
      id: transcriptId,
      // Each piece in its own session (live sessions were separate too), at its own times.
      pieces: pieces.map((p, i) => ({ ...p, bytes: Math.round(p.seconds * 16000) * 2, session: i + 1 })),
      status,
      cancelled: false,
      done,
      resolveDone,
    });
    this.transcripts.processing.set(transcriptId, status);
    this.transcripts.setRecording(transcriptId, true);
    this.pump();
  }

  /** Whether a file of this transcript waits or is being transcribed. */
  busy(transcriptId) {
    return Boolean((this.running && this.running.id === transcriptId) || this.waiting.some((j) => j.id === transcriptId));
  }

  /**
   * Stops transcribing a transcript's file; the lines found so far stay. Resolves once it has
   * stopped, with whether it was running or queued.
   */
  async cancel(transcriptId) {
    const queued = this.waiting.find((j) => j.id === transcriptId);
    if (queued) {
      this.waiting = this.waiting.filter((j) => j !== queued);
      this.finished(queued);
      return true;
    }
    if (this.running && this.running.id === transcriptId) {
      this.running.cancelled = true;
      await this.running.done;
      return true;
    }
    this.transcripts.processing.delete(transcriptId); // a failed one: forget the failure
    return false;
  }

  async pump() {
    if (this.running || !this.waiting.length) return;
    const job = this.waiting.shift();
    this.running = job;
    try {
      await this.transcribe(job);
    } catch (err) {
      console.error(`Transcribing the uploaded file of transcript ${job.id} failed:`, err);
      job.status.state = 'failed';
    } finally {
      this.running = null;
      this.finished(job);
      this.pump();
    }
  }

  finished(job) {
    if (job.pieces) {
      this.audio.release(job.pieces.map((p) => p.name)); // transcribed again: the audio stays as it was
    } else {
      // What was transcribed of the recording is kept with its transcript, so its lines can be
      // played; the file covers the transcript from the part's start (offset).
      try {
        if (this.audio && this.audio.keep && job.status.done > 0 && this.transcripts.exists(job.id)) {
          this.audio.add(job.id, job.file, { start: job.offset, dataStart: job.dataStart, move: true });
        }
      } catch (err) {
        console.warn(`Transcript ${job.id}: keeping its audio failed: ${err.message}`);
      }
      fs.rmSync(job.file, { force: true });
    }
    this.transcripts.setRecording(job.id, false);
    if (job.status.state !== 'failed') this.transcripts.processing.delete(job.id);
    job.resolveDone();
  }

  async transcribe(job) {
    while (!this.engine.ready) {
      if (this.engine.loadError) throw this.engine.loadError;
      if (job.cancelled) return;
      await sleep(1000);
    }
    job.status.state = 'transcribing';
    // An uploaded file is one piece; a transcript transcribed again has a piece per live session or file.
    const pieces = job.pieces || [{ file: job.file, dataStart: job.dataStart, bytes: job.dataBytes, start: job.offset, session: 1 }];
    if (job.pieces) {
      // Wall-clock times of the new lines come from the old ones (live sessions may be days apart).
      job.clock = this.transcripts.wallClock(job.id);
      this.transcripts.clearLines(job.id);
    }
    let before = 0; // seconds of the pieces done
    for (const piece of pieces) {
      if (job.cancelled) break;
      job.piece = piece;
      await this.feed(job, piece, before);
      before += piece.bytes / BYTES_PER_SECOND;
    }
    this.regroup(job); // also when stopped: the lines that are there
    if (!job.pieces) this.transcripts.extendDuration(job.id, job.offset + job.status.done);
  }

  /** Feeds one piece of audio through a TranscriptionSession; its lines are saved as they come. */
  async feed(job, piece, before) {
    let failure = null;
    const session = new TranscriptionSession(this.engine, this.voices, { interim: false, learn: false, background: true });
    session.on('message', (m) => {
      if (m.type === 'final') this.save(job, session, m);
    });
    session.on('error', (err) => {
      failure = err;
    });
    // An uploaded WAV file is read directly; kept audio (transcribing again) may be Ogg Opus.
    const chunks = job.pieces ? this.audio.pcm(piece) : wavChunks(piece.file, piece.dataStart, piece.bytes);
    try {
      let pos = 0;
      let settledAt = 0;
      for await (const chunk of chunks) {
        if (job.cancelled || failure) break;
        for (let o = 0; o < chunk.length && !job.cancelled; o += PIECE) {
          session.push(int16ToFloat(chunk.subarray(o, Math.min(o + PIECE, chunk.length))));
          await yieldToEventLoop();
        }
        pos += chunk.length;
        if (pos - settledAt >= STEP) {
          await session.settled(); // wait every few seconds of audio until it is transcribed
          settledAt = pos;
        }
        job.status.done = before + pos / BYTES_PER_SECOND;
      }
      if (!job.cancelled && !failure) await session.finish();
      if (failure) throw failure;
    } finally {
      session.close();
    }
  }

  save(job, session, m) {
    if (job.cancelled) return;
    const recent = session.recent.get(m.id) || {};
    const { start: offset, session: sessionNo } = job.piece;
    const speaker = this.transcripts.speakerFields(m.speaker, sessionNo);
    const start = m.start + offset;
    try {
      this.transcripts.appendLine(job.id, {
        start,
        end: m.end + offset,
        spokenAt: job.clock ? wallTime(job.clock, start) : job.startedAt + Math.round(start * 1000),
        speaker,
        text: m.text,
        seconds: recent.seconds,
        embedding: recent.embedding,
        model: this.engine.speakerModelName,
      });
    } catch (err) {
      // Most likely the transcript was deleted meanwhile: there is nothing left to fill.
      console.warn(`Transcript ${job.id}: ${err.message}; stopping its file transcription.`);
      job.cancelled = true;
    }
  }

  /**
   * Decides the speakers again per speaker, now that the recording is whole (src/regroup.js). A line
   * that a user moved to another speaker meanwhile stays where it is.
   */
  regroup(job) {
    try {
      this.transcripts.regroup(job.id, this.engine.speakerModelName);
    } catch (err) {
      console.warn(`Transcript ${job.id}: deciding its speakers per recording failed: ${err.message}`);
    }
  }
}

/** A WAV file's samples from dataStart on, `bytes` of them, in pieces of a few seconds. */
async function* wavChunks(file, dataStart, bytes) {
  const fh = await fs.promises.open(file, 'r');
  try {
    for (let pos = 0; pos < bytes;) {
      const buf = Buffer.alloc(Math.min(STEP, bytes - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, dataStart + pos);
      if (!bytesRead) break;
      yield buf.subarray(0, bytesRead);
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
}

/**
 * The wall-clock time (ms) of transcript time `t`, from the lines it had: [[start, spokenAt]] by
 * start; the closest line before it (or the first) counts.
 */
function wallTime(clock, t) {
  let best = clock[0];
  for (const c of clock) {
    if (c[0] > t) break;
    best = c;
  }
  return best ? Math.round(best[1] + (t - best[0]) * 1000) : Date.now();
}

module.exports = { UploadQueue, readHeader, titleFromName, MAX_HOURS };
