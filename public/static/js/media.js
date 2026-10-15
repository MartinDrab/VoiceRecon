// Reads audio and video files as 16 kHz mono WAV for uploading. MP4/M4A/MOV files with AAC audio
// and WAV files are read piece by piece: their length is known at once, only the part that is used
// is decoded (WebCodecs decodes the AAC frames), and recordings of any length fit in memory. Other
// formats are decoded whole by the browser (decodeAudioData), which first decodes the whole file at
// its own rate and fails on long recordings (a 2-hour M4A needed 2.7 GB that way).

import { t } from './i18n.js';
import { decodeFile, wavBlob, SAMPLE_RATE } from './audio.js';
import { Resampler } from './resample.js';
import { parseMp4Audio, parseWavHeader } from './containers.js';

const SLICE = 4 << 20; // bytes read from the file at a time
const QUEUE = 64; // encoded frames waiting in the decoder at most

/**
 * @typedef {object} AudioFile
 * @property {number} duration in seconds
 * @property {(limit: number, onProgress?: (fraction: number) => void, signal?: AbortSignal) =>
 *   Promise<{ wav: Blob, seconds: number }>} read the first `limit` seconds (Infinity: all) as a
 *   16 kHz mono WAV, and the whole file's length
 */

/**
 * Opens an audio or video file for reading.
 * @param {File} file
 * @returns {Promise<AudioFile>}
 */
export async function openAudioFile(file) {
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const wav = parseWavHeader(head, file.size);
  if (wav) return wavReader(file, wav);
  if (String.fromCharCode(...head.subarray(4, 8)) === 'ftyp') {
    const track = await mp4Track(file);
    if (track && (await decodable(track))) return mp4Reader(file, track);
  }
  // Other formats: their length is known only once the browser has decoded them, so now.
  return wholeReader(await decodeFile(file));
}

/** 16 kHz samples as they are converted, up to a limit; then a WAV file. */
class Output {
  constructor(limit) {
    this.max = Number.isFinite(limit) ? Math.round(limit * SAMPLE_RATE) : Infinity;
    this.chunks = [];
    this.length = 0;
  }

  get full() {
    return this.length >= this.max;
  }

  push(samples) {
    const n = Math.min(samples.length, this.max - this.length);
    if (n <= 0) return;
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = Math.round(s < 0 ? s * 32768 : s * 32767);
    }
    this.chunks.push(pcm);
    this.length += n;
  }

  blob() {
    return wavBlob(this.chunks, SAMPLE_RATE);
  }
}

const cancelled = () => new DOMException('Reading cancelled', 'AbortError');

// ---------- WAV ----------

function wavReader(file, h) {
  const frames = h.dataBytes / h.blockAlign;
  const duration = frames / h.sampleRate;
  return {
    duration,
    async read(limit, onProgress, signal) {
      const out = new Output(limit);
      const resampler = new Resampler(h.sampleRate, SAMPLE_RATE);
      const end = h.dataStart + Math.min(frames, Math.ceil(Math.min(limit, duration) * h.sampleRate)) * h.blockAlign;
      const step = Math.floor(SLICE / h.blockAlign) * h.blockAlign;
      for (let pos = h.dataStart; pos < end && !out.full; pos += step) {
        if (signal && signal.aborted) throw cancelled();
        const bytes = await file.slice(pos, Math.min(end, pos + step)).arrayBuffer();
        out.push(resampler.push(wavMono(new DataView(bytes), h)));
        if (onProgress) onProgress(Math.min(1, (pos + step - h.dataStart) / (end - h.dataStart)));
      }
      out.push(resampler.flush());
      return { wav: out.blob(), seconds: duration };
    },
  };
}

/** WAV samples (any of the supported encodings) averaged over the channels. */
function wavMono(view, h) {
  const bytes = h.bits / 8;
  const frames = Math.floor(view.byteLength / h.blockAlign);
  const read = h.float
    ? (o) => (h.bits === 32 ? view.getFloat32(o, true) : view.getFloat64(o, true))
    : {
      8: (o) => (view.getUint8(o) - 128) / 128,
      16: (o) => view.getInt16(o, true) / 32768,
      24: (o) => ((view.getUint8(o + 2) << 24) | (view.getUint8(o + 1) << 16) | (view.getUint8(o) << 8)) / 2147483648,
      32: (o) => view.getInt32(o, true) / 2147483648,
    }[h.bits];
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < h.channels; c++) sum += read(f * h.blockAlign + c * bytes);
    out[f] = sum / h.channels;
  }
  return out;
}

// ---------- MP4 / M4A / MOV with AAC audio ----------

/** The audio track, from the 'moov' box wherever it is in the file (at the start or at the end). */
async function mp4Track(file) {
  for (let pos = 0; pos + 8 <= file.size;) {
    const h = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = h.getUint32(0);
    let header = 8;
    if (size === 1 && h.byteLength >= 16) {
      size = Number(h.getBigUint64(8));
      header = 16;
    } else if (size === 0) {
      size = file.size - pos;
    }
    if (size < header) return null;
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    if (type === 'moov') return parseMp4Audio(new Uint8Array(await file.slice(pos + header, pos + size).arrayBuffer()));
    pos += size;
  }
  return null;
}

const decoderConfig = (track) => ({
  codec: track.codec,
  sampleRate: track.sampleRate,
  numberOfChannels: track.channels,
  description: track.description,
});

async function decodable(track) {
  try {
    return typeof AudioDecoder !== 'undefined' && Boolean((await AudioDecoder.isConfigSupported(decoderConfig(track))).supported);
  } catch {
    return false;
  }
}

/** Decoded audio averaged over the channels. */
function mono(data) {
  const n = data.numberOfFrames;
  const out = new Float32Array(n);
  const plane = new Float32Array(n);
  for (let c = 0; c < data.numberOfChannels; c++) {
    data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
    for (let i = 0; i < n; i++) out[i] += plane[i];
  }
  if (data.numberOfChannels > 1) for (let i = 0; i < n; i++) out[i] /= data.numberOfChannels;
  return out;
}

function mp4Reader(file, track) {
  return {
    duration: track.duration,
    async read(limit, onProgress, signal) {
      const out = new Output(limit);
      const until = Math.min(limit, track.duration);
      /** @type {Resampler | null} */
      let resampler = null; // set by the decoder's output callback
      let failure = null;
      const decoder = new AudioDecoder({
        output: (data) => {
          try {
            if (!resampler) resampler = new Resampler(data.sampleRate, SAMPLE_RATE); // HE-AAC may double the rate
            out.push(resampler.push(mono(data)));
          } catch (err) {
            failure = err;
          } finally {
            data.close();
          }
        },
        error: (err) => {
          failure = err;
        },
      });
      decoder.configure(decoderConfig(track));
      const { offsets, sizes, starts } = track;
      let last = 0; // frames needed: those starting before the limit (and one more)
      while (last < starts.length && starts[last] < until) last++;
      last = Math.min(starts.length, last + 1);
      try {
        for (let i = 0; i < last && !failure;) {
          if (signal && signal.aborted) throw cancelled();
          // A run of frames stored one after another, read at once.
          const from = offsets[i];
          let to = from;
          let j = i;
          while (j < last && offsets[j] === to && to - from < SLICE) to += sizes[j++];
          if (j === i) to = from + sizes[j++];
          const bytes = new Uint8Array(await file.slice(from, to).arrayBuffer());
          if (failure) break; // the decoder failed (and closed) while the file was read
          for (let k = i; k < j; k++) {
            const at = offsets[k] - from;
            decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(starts[k] * 1e6), data: bytes.subarray(at, at + sizes[k]) }));
          }
          i = j;
          while (decoder.decodeQueueSize > QUEUE && !failure) await dequeued(decoder);
          if (onProgress) onProgress(Math.min(1, starts[i - 1] / until));
        }
        if (!failure) await decoder.flush();
      } catch (err) {
        if (signal && signal.aborted) throw err;
        // decode() on a decoder that has just failed, a rejected flush(), a file that changed on
        // disk: all mean that the file cannot be read.
        failure = failure || err;
      } finally {
        if (decoder.state !== 'closed') decoder.close();
      }
      if (failure) throw new Error(t('"{name}" could not be read.', { name: file.name }), { cause: failure });
      if (resampler) out.push(resampler.flush());
      return { wav: out.blob(), seconds: track.duration };
    },
  };
}

/** Until the decoder has taken frames off its queue (some browsers lack the event: then 50 ms). */
function dequeued(decoder) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      decoder.removeEventListener('dequeue', done);
      resolve();
    };
    const timer = setTimeout(done, 50);
    decoder.addEventListener('dequeue', done);
  });
}

// ---------- other formats: decoded whole ----------

/** @param {Int16Array<ArrayBuffer>} pcm the whole file, decoded */
function wholeReader(pcm) {
  const duration = pcm.length / SAMPLE_RATE;
  return {
    duration,
    async read(limit, onProgress) {
      const n = Number.isFinite(limit) ? Math.min(pcm.length, Math.round(limit * SAMPLE_RATE)) : pcm.length;
      if (onProgress) onProgress(1);
      return { wav: wavBlob([pcm.subarray(0, n)], SAMPLE_RATE), seconds: duration };
    },
  };
}
