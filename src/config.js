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
// The int8 package's decoder, joiner and tokens with the full-precision (fp32) encoder: the int8
// encoder doubled the Czech word error rate (FLEURS: 21.6 % instead of 11.0 %) at the same speed.
// An fp32 decoder and joiner would gain only 0.3 points but double the beam search's decoding time.
const asrDir = path.join(modelsDir, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8');
const asr = {
  encoder: path.join(asrDir, 'encoder.onnx'),
  encoderWeights: path.join(asrDir, 'encoder.weights'), // loaded by encoder.onnx from its own folder
  decoder: path.join(asrDir, 'decoder.int8.onnx'),
  joiner: path.join(asrDir, 'joiner.int8.onnx'),
  tokens: path.join(asrDir, 'tokens.txt'),
};
const vadModel = path.join(modelsDir, 'silero_vad.onnx');
// WeSpeaker ResNet34-LM with mean normalization added to its metadata (scripts/download-models.js
// says why). On Czech (VoxPopuli, 52 speakers) its equal error rate was 1.34 % against 1.72 % for
// CAM++, with about half the false names at the same accuracy, for twice the CPU (24 ms per 1.5 s
// voice print at 2 threads). CAM++ (3dspeaker_campplus_zh_en_advanced.onnx) is the alternative.
const speakerModel = path.join(modelsDir, process.env.SPEAKER_MODEL || 'wespeaker_resnet34_LM_cmn.onnx');

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
  modelFiles: [asr.encoder, asr.encoderWeights, asr.decoder, asr.joiner, asr.tokens, vadModel, speakerModel],

  // Default cosine-similarity threshold for accepting a voice match (also for joining an unknown
  // speaker). Can be changed at runtime from the Voices page (stored in the database, for the
  // speaker model it was set with). 0.6 for ResNet34-LM: on Czech parliament speakers with 10
  // enrolled voices, people who were not enrolled got a name for 0.6 / 1.1 / 1.8 % of their
  // 1.5 / 3 / 6 s segments (5 / 10 / 16 % at 0.5), while enrolled speakers were named correctly for
  // 78 / 96 / 99 %; what is lost at 1.5 s becomes "unknown", not a wrong name. CAM++ at 0.5 gave
  // 12 / 21 / 33 % false names, like the real recordings where different people scored up to 0.5.
  speakerThreshold: num('SPEAKER_THRESHOLD', 0.6),
};
