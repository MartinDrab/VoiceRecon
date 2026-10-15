'use strict';

const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');

// Settings may also be kept in a .env file in the project folder (VARIABLE=value lines).
// Variables that are already set in the environment win.
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

/** A path setting; relative paths count from the project folder (where .env is), not from the
 * folder the server happens to be started in. */
function pathSetting(name, fallback = '') {
  return path.resolve(root, process.env[name] || fallback);
}

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number, got "${v}"`);
  return n;
}

const modelsDir = pathSetting('MODELS_DIR', 'models');
const asrDir = path.join(modelsDir, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8');
const asr = {
  encoder: path.join(asrDir, 'encoder.int8.onnx'),
  decoder: path.join(asrDir, 'decoder.int8.onnx'),
  joiner: path.join(asrDir, 'joiner.int8.onnx'),
  tokens: path.join(asrDir, 'tokens.txt'),
};
const vadModel = path.join(modelsDir, 'silero_vad.onnx');
const speakerModel = path.join(modelsDir, process.env.SPEAKER_MODEL || '3dspeaker_campplus_zh_en_advanced.onnx');

module.exports = {
  root,
  host: process.env.HOST || '127.0.0.1',
  port: num('PORT', 3000),
  tlsCert: process.env.TLS_CERT ? pathSetting('TLS_CERT') : '',
  tlsKey: process.env.TLS_KEY ? pathSetting('TLS_KEY') : '',
  dataDir: pathSetting('DATA_DIR', 'data'),
  modelsDir,
  sessionTtlHours: num('SESSION_TTL_HOURS', 24 * 7),

  sampleRate: 16000,
  threads: num('THREADS', Math.max(1, Math.min(4, os.cpus().length))),

  asr,
  vadModel,
  speakerModel,
  /** Every file the speech engine loads (scripts/download-models.js fetches them). */
  modelFiles: [asr.encoder, asr.decoder, asr.joiner, asr.tokens, vadModel, speakerModel],

  // Default cosine-similarity threshold for accepting a voice match (also for joining an unknown
  // speaker). Can be changed at runtime from the Voices page (stored in the database). 0.5 rather
  // than 0.4: on real recordings different people scored up to 0.5 against each other, and at 0.4
  // a person who was not enrolled got some lines of an enrolled voice.
  speakerThreshold: num('SPEAKER_THRESHOLD', 0.5),
};
