'use strict';

const fs = require('fs');
const sherpa = require('sherpa-onnx-node');
const { concat, resample } = require('../audio');
const { HttpError } = require('../errors');

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512; // samples per Silero VAD step at 16 kHz
const MIN_EMBED_SECONDS = 0.6;
const EMBED_CHUNK_SECONDS = 6;
const EMPTY_RESULT = { text: '', lang: '', tokens: [], timestamps: [], durations: [] };

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
  }

  modelFiles() {
    const { asr, vadModel, speakerModel } = this.config;
    return [asr.encoder, asr.decoder, asr.joiner, asr.tokens, vadModel, speakerModel];
  }

  async load() {
    try {
      const missing = this.modelFiles().filter((f) => !fs.existsSync(f));
      if (missing.length) {
        throw new HttpError(500, 'Missing model files (run "npm run models"):\n{files}', { files: missing.map((f) => `  ${f}`).join('\n') });
      }
      const { asr, threads, speakerModel } = this.config;
      this.extractor = new sherpa.SpeakerEmbeddingExtractor({ model: speakerModel, numThreads: Math.min(2, threads), debug: 0 });
      this.speakerModelName = require('path').basename(speakerModel);
      this.recognizer = await sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: asr.encoder, decoder: asr.decoder, joiner: asr.joiner },
          tokens: asr.tokens,
          numThreads: threads,
          modelType: 'nemo_transducer',
          debug: 0,
        },
      });
      this.ready = true;
    } catch (err) {
      this.loadError = err;
      throw err;
    }
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
      const stream = this.recognizer.createStream();
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

module.exports = {
  SpeechEngine, SAMPLE_RATE, VAD_WINDOW, l2normalize, cosine, meanEmbedding, embeddingToBlob, embeddingFromBlob,
};
