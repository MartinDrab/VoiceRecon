'use strict';

const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number, got "${v}"`);
  return n;
}

const modelsDir = path.resolve(process.env.MODELS_DIR || path.join(root, 'models'));
const asrDir = path.join(modelsDir, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8');

module.exports = {
  root,
  host: process.env.HOST || '127.0.0.1',
  port: num('PORT', 3000),
  tlsCert: process.env.TLS_CERT || '',
  tlsKey: process.env.TLS_KEY || '',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, 'data')),
  modelsDir,
  sessionTtlHours: num('SESSION_TTL_HOURS', 24 * 7),

  sampleRate: 16000,
  threads: num('THREADS', Math.max(1, Math.min(4, os.cpus().length))),

  asr: {
    encoder: path.join(asrDir, 'encoder.int8.onnx'),
    decoder: path.join(asrDir, 'decoder.int8.onnx'),
    joiner: path.join(asrDir, 'joiner.int8.onnx'),
    tokens: path.join(asrDir, 'tokens.txt'),
  },
  vadModel: path.join(modelsDir, 'silero_vad.onnx'),
  speakerModel: path.join(modelsDir, process.env.SPEAKER_MODEL || '3dspeaker_campplus_zh_en_advanced.onnx'),

  // Default cosine-similarity threshold for accepting a voice match.
  // Can be changed at runtime from the Voices page (stored in the database).
  speakerThreshold: num('SPEAKER_THRESHOLD', 0.4),
};
