'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const sherpa = require('sherpa-onnx-node');
const { concat, resample, decodeWav, encodeWav } = require('../audio');
const { HttpError } = require('../errors');

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512; // samples per Silero VAD step at 16 kHz
const MIN_EMBED_SECONDS = 0.6;
const EMBED_CHUNK_SECONDS = 6;
// The two halves of one person's recording (6 s voice prints split in two groups) scored 0.84-0.95
// against each other on the enrolled voices; two people mixed 70/30 or 50/50 scored 0.09-0.50.
const MIX_SIMILARITY = 0.6;
const MIX_MIN_SHARE = 0.1;
const EMPTY_RESULT = { text: '', lang: '', tokens: [], timestamps: [], durations: [] };
// Names and terms (hotwords) need beam search; 4 paths cost about 20-40% more decoding time.
const BEAM_PATHS = 4;
// sherpa-onnx's beam search for TDT models (Parakeet) sometimes returns no text, or one short word,
// for plain speech (k2-fsa/sherpa-onnx#3267, unfixed in 1.13.8); the same audio cut in two decodes
// fine. In English test conversations built from VoxPopuli it lost 19-22 % of the words (with this
// retry the WER fell from 22-24 % to 9-11.5 %), in Czech ones built from real recordings 0.5 %, on
// FLEURS and real microphone recordings nothing; a safety net costs nothing then. Speech gives at least 0.7 words per second
// (FLEURS, silences included), so a result with fewer than 0.5 tokens per second of at least 2 s
// of audio is decoded again in two halves (and those in two again). Greedy search fails less but
// not never (it lost 13-16 %), and was 0.2 points worse on Czech FLEURS.
const MIN_TOKENS_PER_SECOND = 0.5;
const MIN_RETRY_SECONDS = 2;
const MAX_SPLITS = 2;
const CUT_FRAME = 320; // 20 ms: the quietest one in the middle third is where audio is cut in two

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The model's tokens ("▁" starts a word). Hotwords are given as words, which the recognizer splits
 * into tokens with a BPE vocabulary file (token, tab, score). Parakeet ships only tokens.txt, whose
 * order is the vocabulary's merge order, so a vocabulary with score = -id is written next to it
 * (or to the temp folder if the models folder is read-only). Returns the pieces and the file.
 */
function loadVocabulary(tokensFile) {
  const tokens = fs.readFileSync(tokensFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const i = line.lastIndexOf(' ');
    return { piece: line.slice(0, i), id: Number(line.slice(i + 1)) };
  }).filter((t) => !/^<.*>$/.test(t.piece)); // <unk>, <blk>, … are not text
  const pieces = new Set(tokens.map((t) => t.piece));
  const content = `${tokens.map((t) => `${t.piece}\t${-t.id}`).join('\n')}\n`;
  const shipped = path.join(path.dirname(tokensFile), 'bpe.vocab');
  if (fs.existsSync(shipped)) return { pieces, file: shipped };
  for (const file of [path.join(path.dirname(tokensFile), 'voicerecon-bpe.vocab'), path.join(os.tmpdir(), 'voicerecon-bpe.vocab')]) {
    try {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content);
      return { pieces, file };
    } catch { /* read-only: try the next place */ }
  }
  return { pieces: new Set(), file: '' };
}

/** Whether every word of a phrase can be written with the model's tokens (else the recognizer drops the whole list). */
function spellable(phrase, pieces) {
  return phrase.split(' ').every((word) => {
    let rest = `▁${word}`;
    while (rest) {
      let n = rest.length;
      while (n > 0 && !pieces.has(rest.slice(0, n))) n--;
      if (!n) return false;
      rest = rest.slice(n);
    }
    return true;
  });
}

/** Where to cut audio in two: the middle of its quietest 20 ms in the middle third (a pause, if any). */
function quietestCut(samples) {
  let best = samples.length >> 1;
  let bestEnergy = Infinity;
  const end = Math.ceil((2 * samples.length) / 3);
  for (let s = Math.floor(samples.length / 3); s + CUT_FRAME <= end; s += CUT_FRAME / 2) {
    let e = 0;
    for (let i = s; i < s + CUT_FRAME; i++) e += samples[i] * samples[i];
    if (e < bestEnergy) {
      bestEnergy = e;
      best = s + CUT_FRAME / 2;
    }
  }
  return best;
}

/** The results of two consecutive pieces of audio as one; the second's times start `offset` s later. */
function joinResults(a, b, offset) {
  const timed = a.timestamps.length === a.tokens.length && b.timestamps.length === b.tokens.length;
  return {
    text: [a.text, b.text].filter(Boolean).join(' '),
    lang: a.lang || b.lang,
    tokens: [...a.tokens, ...b.tokens],
    timestamps: timed ? [...a.timestamps, ...b.timestamps.map((t) => t + offset)] : [],
    durations: timed ? [...a.durations, ...b.durations] : [],
  };
}

function l2normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d; // both vectors are L2-normalized
}

/** Embeddings are stored in SQLite as the raw bytes of their Float32Array. */
function embeddingToBlob(embedding) {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function embeddingFromBlob(blob) {
  const copy = Uint8Array.from(blob);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

/** Weighted mean of normalized embeddings, re-normalized. */
function meanEmbedding(items) {
  if (!items.length) return null;
  const dim = items[0].embedding.length;
  const acc = new Float32Array(dim);
  for (const { embedding, weight = 1 } of items) {
    for (let i = 0; i < dim; i++) acc[i] += embedding[i] * weight;
  }
  return l2normalize(acc);
}

/**
 * Owns the neural models (Silero VAD, Parakeet ASR, speaker embeddings) and shares them
 * between all transcription sessions. ASR runs off the main thread and is serialized through a
 * queue so concurrent sessions do not oversubscribe the CPU; final results take priority over
 * interim (partial) ones, and both over background work (uploaded files).
 */
class SpeechEngine {
  constructor(config) {
    this.config = config;
    this.ready = false;
    this.loadError = null;
    this.queue = [];
    this.running = null; // the job being decoded
    this.vocabulary = { pieces: new Set(), file: '' };
    this.hotwords = ''; // in the recognizer's syntax: "phrase :score/phrase :score"
    this.worker = null; // computes voice prints of recordings (voice-worker.js)
    this.pending = new Map(); // worker job id -> { resolve, reject }
    this.jobSeq = 0;
    // Stored with every voice print and saved threshold; known before the model loads.
    this.speakerModelName = path.basename(config.speakerModel || '');
  }

  async load() {
    try {
      const missing = this.config.modelFiles.filter((f) => !fs.existsSync(f));
      if (missing.length) {
        throw new HttpError(500, 'Missing model files (run "npm run models"):\n{files}', { files: missing.map((f) => `  ${f}`).join('\n') });
      }
      const { asr, threads } = this.config;
      this.loadSpeakerModel();
      this.vocabulary = loadVocabulary(asr.tokens);
      this.recognizer = await sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: asr.encoder, decoder: asr.decoder, joiner: asr.joiner },
          tokens: asr.tokens,
          numThreads: threads,
          modelType: 'nemo_transducer',
          debug: 0,
          ...(this.vocabulary.file ? { modelingUnit: 'bpe', bpeVocab: this.vocabulary.file } : {}),
        },
        decodingMethod: 'modified_beam_search',
        maxActivePaths: BEAM_PATHS,
      });
      await this.startWorker();
      this.ready = true;
    } catch (err) {
      this.loadError = err;
      throw err;
    }
  }

  /** The speaker-embedding model alone (all the voice-print worker needs). */
  loadSpeakerModel() {
    const { threads, speakerModel } = this.config;
    this.extractor = new sherpa.SpeakerEmbeddingExtractor({ model: speakerModel, numThreads: Math.min(2, threads), debug: 0 });
  }

  /** Starts the voice-print worker; without it (it failed to start or stopped) the work runs here. */
  async startWorker() {
    try {
      this.worker = await new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'voice-worker.js'), { workerData: { config: this.config } });
        worker.once('message', () => resolve(worker));
        worker.once('error', reject);
        worker.once('exit', (code) => reject(Object.assign(new Error('The voice-print worker stopped.'), { code })));
      });
    } catch (err) {
      console.warn(`Voice prints are computed on the main thread (the worker did not start: ${err.message}).`);
      return;
    }
    const worker = this.worker;
    worker.unref(); // it must not keep scripts such as the evaluation running
    worker.on('message', ({ id, result, error }) => {
      const job = this.pending.get(id);
      this.pending.delete(id);
      if (!job) return;
      if (!error) job.resolve(result);
      else job.reject(error.template ? new HttpError(error.status, error.template, error.params) : Object.assign(new Error(error.message), { status: error.status }));
    });
    const stopped = (err) => {
      if (this.worker !== worker) return;
      console.error('The voice-print worker stopped; voice prints are computed on the main thread from now on:', err);
      this.worker = null;
      for (const job of this.pending.values()) job.reject(new Error('Computing the voice print failed.'));
      this.pending.clear();
    };
    worker.on('error', stopped);
    worker.on('exit', (code) => stopped(Object.assign(new Error('The voice-print worker stopped.'), { code })));
  }

  /**
   * Length, speech and voice print of a recording, given as a WAV file or as samples at any rate,
   * computed in the worker thread so that a long recording never stalls live transcription. With
   * keepWav also the 16 kHz WAV file to store.
   * @param {{ wav?: Uint8Array, samples?: Float32Array, sampleRate?: number, keepWav?: boolean }} input
   * @returns {Promise<{ duration: number, speechSeconds: number, embedding: Float32Array | null, wav: Uint8Array | null }>}
   */
  analyzeRecording(input) {
    if (!this.worker) return new Promise((resolve) => resolve(analyze(this, input)));
    return new Promise((resolve, reject) => {
      const id = ++this.jobSeq;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, input });
    });
  }

  /** Stops the voice-print worker (tests and scripts that end before the process does). */
  close() {
    const worker = this.worker;
    this.worker = null;
    if (worker) worker.terminate();
  }

  /**
   * Names and terms the recognizer should prefer when they fit what was said (contextual biasing),
   * each with its boost per token (see VoiceManager.hotwords()). Phrases the model cannot spell are
   * left out; a phrase listed twice keeps its higher boost. Returns the phrases in use.
   * @param {{ text: string, score: number }[]} entries
   */
  setHotwords(entries) {
    const scores = new Map();
    for (const { text, score } of entries) {
      const p = String(text).replace(/[/:]/g, ' ').replace(/\s+/g, ' ').trim();
      if (p && this.vocabulary.file && spellable(p, this.vocabulary.pieces)) scores.set(p, Math.max(score, scores.get(p) || 0));
    }
    this.hotwords = [...scores].map(([p, score]) => `${p} :${score}`).join('/');
    return [...scores.keys()];
  }

  /**
   * Creates a voice activity detector. Speech segments are cut after `minSilence` seconds of
   * silence and forcibly split when longer than `maxSpeech` seconds.
   */
  createVad({ minSilence = 0.35, minSpeech = 0.25, maxSpeech = 15, threshold = 0.4 } = {}) {
    return new sherpa.Vad({
      sileroVad: {
        model: this.config.vadModel,
        threshold,
        minSilenceDuration: minSilence,
        minSpeechDuration: minSpeech,
        maxSpeechDuration: maxSpeech,
        windowSize: VAD_WINDOW,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      debug: 0,
    }, 60);
  }

  resample(samples, fromRate) {
    return resample(samples, fromRate, SAMPLE_RATE);
  }

  /** Runs the VAD over a whole recording and returns only the speech parts, concatenated. */
  speechOnly(samples) {
    const vad = this.createVad({ minSilence: 0.3, maxSpeech: 30 });
    const parts = [];
    const drain = () => {
      while (!vad.isEmpty()) {
        parts.push(Float32Array.from(vad.front(false).samples));
        vad.pop();
      }
    };
    for (let i = 0; i + VAD_WINDOW <= samples.length; i += VAD_WINDOW) {
      vad.acceptWaveform(samples.subarray(i, i + VAD_WINDOW));
      drain();
    }
    vad.flush();
    drain();
    return concat(parts);
  }

  /** Returns an L2-normalized speaker embedding, or null when the audio is too short. */
  embed(samples) {
    if (samples.length < MIN_EMBED_SECONDS * SAMPLE_RATE) return null;
    const stream = this.extractor.createStream();
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    stream.inputFinished();
    if (!this.extractor.isReady(stream)) return null;
    return l2normalize(Float32Array.from(this.extractor.compute(stream, false)));
  }

  /** Voice prints of a longer recording in equal pieces of about EMBED_CHUNK_SECONDS: [{ embedding, weight }]. */
  embedChunks(samples) {
    const n = Math.max(1, Math.round(samples.length / (EMBED_CHUNK_SECONDS * SAMPLE_RATE)));
    const size = Math.ceil(samples.length / n);
    const items = [];
    for (let i = 0; i < samples.length; i += size) {
      const piece = samples.subarray(i, Math.min(samples.length, i + size));
      const embedding = this.embed(piece);
      if (embedding) items.push({ embedding, weight: piece.length });
    }
    return items;
  }

  /** Embedding of a longer recording: averaged over chunks so long samples stay cheap and robust. */
  embedLong(samples) {
    return meanEmbedding(this.embedChunks(samples));
  }

  /**
   * Voice print of a line (an utterance or part of one), on the main thread. One embed() call
   * blocks it for the whole clip, ~16 ms per second of audio with ResNet34-LM at 2 threads, so a
   * 15 s line would stop audio for every user for ~0.24 s. Longer lines are embedded in equal
   * pieces of at most EMBED_CHUNK_SECONDS, with an event-loop turn between them, and averaged as
   * in embedLong().
   */
  async embedLine(samples) {
    const n = Math.ceil(samples.length / (EMBED_CHUNK_SECONDS * SAMPLE_RATE));
    if (n <= 1) return this.embed(samples);
    const size = Math.ceil(samples.length / n);
    const items = [];
    for (let i = 0; i < samples.length; i += size) {
      if (i) await yieldToEventLoop();
      const piece = samples.subarray(i, Math.min(samples.length, i + size));
      const embedding = this.embed(piece);
      if (embedding) items.push({ embedding, weight: piece.length });
    }
    return meanEmbedding(items);
  }

  /**
   * Speech-to-text. Jobs run in FIFO order within their priority: final results first, then
   * interim ones, then background ones (uploaded files), so a long file never delays what people
   * see live. `owner` tags the job so that cancel() can drop it while it is still queued.
   * @param {Float32Array} samples
   * @param {{ interim?: boolean, background?: boolean, owner?: any }} [options]
   * @returns {Promise<{text: string, lang: string, tokens: string[], timestamps: number[], durations: number[]}>}
   */
  transcribe(samples, { interim = false, background = false, owner = null } = {}) {
    return new Promise((resolve, reject) => {
      const rank = background ? 2 : interim ? 1 : 0;
      const job = { samples, rank, interim, owner, resolve, reject };
      const i = this.queue.findIndex((j) => j.rank > rank);
      if (i < 0) this.queue.push(job);
      else this.queue.splice(i, 0, job);
      this.pump();
    });
  }

  /**
   * Drops queued (not yet running) jobs of an owner, e.g. a closed session or interim results
   * of an utterance that has already ended. Their promises resolve with an empty result.
   */
  cancel(owner, { interimOnly = false } = {}) {
    this.queue = this.queue.filter((job) => {
      const drop = job.owner === owner && (!interimOnly || job.interim);
      if (drop) job.resolve({ ...EMPTY_RESULT });
      return !drop;
    });
  }

  /** No live work is running or waiting (background work does not count: live work goes first). */
  get idle() {
    return !(this.running && this.running.rank < 2) && !this.queue.some((j) => j.rank < 2);
  }

  /** One pass of the recognizer, with the names and terms. */
  async decodeOnce(samples) {
    const stream = this.hotwords ? this.recognizer.createStream(this.hotwords) : this.recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    const r = await this.recognizer.decodeAsync(stream);
    return { text: (r.text || '').trim(), lang: r.lang || '', tokens: r.tokens || [], timestamps: r.timestamps || [], durations: r.durations || [] };
  }

  /** decodeOnce(), and again in two halves when the result is too short for the audio (see MIN_TOKENS_PER_SECOND). */
  async decode(samples, splits = 0) {
    const r = await this.decodeOnce(samples);
    const seconds = samples.length / SAMPLE_RATE;
    if (splits >= MAX_SPLITS || seconds < MIN_RETRY_SECONDS || r.tokens.length >= MIN_TOKENS_PER_SECOND * seconds) return r;
    const cut = quietestCut(samples);
    const first = await this.decode(samples.subarray(0, cut), splits + 1);
    const second = await this.decode(samples.subarray(cut), splits + 1);
    const both = joinResults(first, second, cut / SAMPLE_RATE);
    return both.tokens.length > r.tokens.length ? both : r;
  }

  async pump() {
    if (this.running || !this.queue.length) return;
    const job = this.queue.shift();
    this.running = job;
    try {
      job.resolve(await this.decode(job.samples));
    } catch (err) {
      job.reject(err);
    } finally {
      this.running = null;
      this.pump();
    }
  }
}

/**
 * The work of SpeechEngine.analyzeRecording(), in the worker (or on the main thread without it).
 * WAV files are decoded here too: a 10-minute file is millions of samples.
 * @param {SpeechEngine} engine
 * @param {{ wav?: Uint8Array, samples?: Float32Array, sampleRate?: number, keepWav?: boolean }} input
 */
function analyze(engine, { wav, samples, sampleRate, keepWav = false }) {
  const input = wav ? decodeWav(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength)) : { samples, sampleRate };
  const audio = engine.resample(input.samples, input.sampleRate);
  const speech = engine.speechOnly(audio);
  const encoded = keepWav ? encodeWav(audio, SAMPLE_RATE) : null;
  const chunks = speech.length ? engine.embedChunks(speech) : [];
  return {
    duration: audio.length / SAMPLE_RATE,
    speechSeconds: speech.length / SAMPLE_RATE,
    embedding: meanEmbedding(chunks),
    mixed: otherVoiceShare(chunks),
    // A view of its own buffer, so the worker can hand it over without a copy.
    wav: encoded && new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
  };
}

/**
 * How much of a recording sounds like a second person: its voice prints of about 6 s are split in
 * the two groups that sound least alike (2-means); when the groups' averages are less similar than
 * MIX_SIMILARITY, the smaller group's share of the speech (0..0.5), else 0.
 * @param {{ embedding: Float32Array, weight: number }[]} chunks
 */
function otherVoiceShare(chunks) {
  if (chunks.length < 2) return 0;
  // Start from the two pieces least alike.
  let a = 0;
  let b = 1;
  let low = Infinity;
  for (let i = 0; i < chunks.length; i++) {
    for (let j = i + 1; j < chunks.length; j++) {
      const s = cosine(chunks[i].embedding, chunks[j].embedding);
      if (s < low) [low, a, b] = [s, i, j];
    }
  }
  let ca = chunks[a].embedding;
  let cb = chunks[b].embedding;
  let inA = [];
  for (let round = 0; round < 10; round++) {
    inA = chunks.map((c) => cosine(c.embedding, ca) >= cosine(c.embedding, cb));
    const groupA = chunks.filter((_, i) => inA[i]);
    const groupB = chunks.filter((_, i) => !inA[i]);
    if (!groupA.length || !groupB.length) return 0;
    ca = meanEmbedding(groupA);
    cb = meanEmbedding(groupB);
  }
  const total = chunks.reduce((n, c) => n + c.weight, 0);
  const weightA = chunks.reduce((n, c, i) => n + (inA[i] ? c.weight : 0), 0);
  const smaller = Math.min(weightA, total - weightA) / total;
  return cosine(ca, cb) < MIX_SIMILARITY && smaller >= MIX_MIN_SHARE ? smaller : 0;
}

module.exports = {
  SpeechEngine, SAMPLE_RATE, VAD_WINDOW, l2normalize, cosine, meanEmbedding, embeddingToBlob, embeddingFromBlob, spellable, analyze,
  yieldToEventLoop, otherVoiceShare,
};
