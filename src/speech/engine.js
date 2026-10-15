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
const EMPTY_RESULT = { text: '', lang: '', tokens: [], timestamps: [], durations: [] };
// Names and terms (hotwords) need beam search; 4 paths cost about 20-40% more decoding time.
const BEAM_PATHS = 4;

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
 * Owns the neural models (Silero VAD, Parakeet ASR, CAM++ speaker embeddings) and shares them
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
    this.speakerModelName = path.basename(speakerModel);
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

  /** Embedding of a longer recording: averaged over chunks so long samples stay cheap and robust. */
  embedLong(samples) {
    const n = Math.max(1, Math.round(samples.length / (EMBED_CHUNK_SECONDS * SAMPLE_RATE)));
    const size = Math.ceil(samples.length / n);
    const items = [];
    for (let i = 0; i < samples.length; i += size) {
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

  async pump() {
    if (this.running || !this.queue.length) return;
    const job = this.queue.shift();
    this.running = job;
    try {
      const stream = this.hotwords ? this.recognizer.createStream(this.hotwords) : this.recognizer.createStream();
      stream.acceptWaveform({ samples: job.samples, sampleRate: SAMPLE_RATE });
      const r = await this.recognizer.decodeAsync(stream);
      job.resolve({
        text: (r.text || '').trim(),
        lang: r.lang || '',
        tokens: r.tokens || [],
        timestamps: r.timestamps || [],
        durations: r.durations || [],
      });
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
  return {
    duration: audio.length / SAMPLE_RATE,
    speechSeconds: speech.length / SAMPLE_RATE,
    embedding: speech.length ? engine.embedLong(speech) : null,
    // A view of its own buffer, so the worker can hand it over without a copy.
    wav: encoded && new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
  };
}

module.exports = {
  SpeechEngine, SAMPLE_RATE, VAD_WINDOW, l2normalize, cosine, meanEmbedding, embeddingToBlob, embeddingFromBlob, spellable, analyze,
};
