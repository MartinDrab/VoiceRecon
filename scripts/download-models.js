'use strict';

/**
 * Downloads the speech models into ./models (or MODELS_DIR).
 *   npm run models            models needed to run VoiceRecon (~3 GB download)
 *   npm run models -- --test  also the Czech TTS voices used by scripts/make-test-audio.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../src/config');

const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const FP32 = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3/resolve/main';
const PARAKEET = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';

const MODELS = [
  { name: 'Silero VAD', url: `${BASE}/asr-models/silero_vad.onnx`, file: 'silero_vad.onnx' },
  // Speaker models (`speaker`) are fetched only when SPEAKER_MODEL names them.
  {
    name: 'WeSpeaker ResNet34-LM speaker embeddings, with mean normalization',
    url: `${BASE}/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx`,
    file: 'wespeaker_resnet34_LM_cmn.onnx',
    speaker: true,
    sha256: 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012',
    // WeSpeaker models expect the mean of each feature removed over the clip (CMN), but this file
    // does not say so, and sherpa-onnx removes it only when the model's metadata asks. Without it
    // the voice print follows the loudness (17 % EER on Czech instead of 1.3 %).
    metadata: { feature_normalize_type: 'global-mean' },
    patchedSha256: 'ce2c5db3fb2c438f1d58de35577c951bc27ea0d41ef74968de4a480a1a59e39b',
  },
  {
    name: 'CAM++ speaker embeddings (3D-Speaker)',
    url: `${BASE}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`,
    file: '3dspeaker_campplus_zh_en_advanced.onnx',
    speaker: true,
  },
  {
    name: 'NVIDIA Parakeet TDT 0.6B v3 (int8 decoder and joiner), 25 European languages incl. Czech',
    url: `${BASE}/asr-models/${PARAKEET}.tar.bz2`,
    dir: PARAKEET,
    unused: ['encoder.int8.onnx'], // replaced by the fp32 encoder (src/config.js says why)
  },
  // The fp32 encoder goes into the folder above, so it must come after it (an existing folder
  // counts as installed). encoder.onnx loads its weights from encoder.weights next to it.
  {
    name: 'Parakeet encoder (fp32)',
    url: `${FP32}/encoder.onnx`,
    file: `${PARAKEET}/encoder.onnx`,
    sha256: '3eed7ce424bf8339ad09233533c687e2dbd07e74ccf5027b5e7344019ea373b0',
  },
  {
    name: 'Parakeet encoder weights (fp32)',
    url: `${FP32}/encoder.weights`,
    file: `${PARAKEET}/encoder.weights`,
    sha256: '3af3f51af5f2d01dbbf5af47d42c7962a2c205f11004254bb4f2b979862f39a8',
  },
];

const TEST_MODELS = [
  { name: 'Czech TTS voice "jirka" (Piper)', url: `${BASE}/tts-models/vits-piper-cs_CZ-jirka-medium.tar.bz2`, dir: 'vits-piper-cs_CZ-jirka-medium' },
  { name: 'Czech TTS voice (Coqui, Common Voice)', url: `${BASE}/tts-models/vits-coqui-cs-cv.tar.bz2`, dir: 'vits-coqui-cs-cv' },
];

/** Downloads url to dest; with a sha256, checks the file while it arrives and deletes it if it differs. */
async function download(url, dest, sha256) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = sha256 && crypto.createHash('sha256');
  let done = 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    if (hash) hash.update(chunk);
    done += chunk.length;
    const pct = total ? Math.floor((done / total) * 100) : -1;
    if (pct !== lastPct && pct % 5 === 0) {
      process.stdout.write(`\r  ${pct}% of ${(total / 1e6).toFixed(0)} MB`);
      lastPct = pct;
    }
  });
  await pipeline(body, fs.createWriteStream(dest));
  if (total) process.stdout.write('\n');
  if (hash && hash.digest('hex') !== sha256) {
    fs.rmSync(dest);
    throw new Error(`The download of ${url} is damaged (SHA-256 does not match). Start again.`);
  }
}

/**
 * Appends entries to an ONNX model's metadata. A model file is one protobuf message (ModelProto),
 * and a field appended to it is read like the others: metadata_props is field 14, a list of
 * key (1) / value (2) string pairs.
 */
function addMetadata(file, entries) {
  const varint = (n) => {
    const bytes = [];
    for (; n > 127; n >>>= 7) bytes.push((n & 127) | 128);
    return [...bytes, n];
  };
  const field = (number, data) => Buffer.from([(number << 3) | 2, ...varint(data.length), ...data]);
  for (const [key, value] of Object.entries(entries)) {
    fs.appendFileSync(file, field(14, Buffer.concat([field(1, Buffer.from(key)), field(2, Buffer.from(value))])));
  }
}

function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function fetchModel(m) {
  const target = path.join(config.modelsDir, m.file || m.dir);
  if (fs.existsSync(target)) {
    console.log(`✓ ${m.name} (already present)`);
    return;
  }
  console.log(`↓ ${m.name}`);
  if (m.file) {
    const part = `${target}.part`;
    await download(m.url, part, m.sha256);
    if (m.metadata) {
      addMetadata(part, m.metadata);
      if (sha256Of(part) !== m.patchedSha256) {
        fs.rmSync(part);
        throw new Error(`Adding the metadata to ${m.file} gave an unexpected file.`);
      }
    }
    fs.renameSync(part, target);
    return;
  }
  const archive = path.join(config.modelsDir, `${m.dir}.tar.bz2`);
  await download(m.url, archive);
  console.log('  extracting…');
  // Extract into a scratch folder and move the result into place only when tar succeeded, so an
  // interrupted extraction is never mistaken for an installed model on the next run.
  const scratch = path.join(config.modelsDir, `.extract-${m.dir}`);
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch);
  // bsdtar ships with Windows 10+ and macOS; GNU tar handles .bz2 on Linux. A relative archive
  // path avoids GNU tar reading "C:\..." as a remote host.
  execFileSync('tar', ['-xjf', `../${path.basename(archive)}`], { cwd: scratch, stdio: 'inherit' });
  for (const f of m.unused || []) fs.rmSync(path.join(scratch, m.dir, f), { force: true });
  fs.renameSync(path.join(scratch, m.dir), target);
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(archive);
}

async function main() {
  fs.mkdirSync(config.modelsDir, { recursive: true });
  const list = (process.argv.includes('--test') ? [...MODELS, ...TEST_MODELS] : MODELS)
    .filter((m) => !m.speaker || path.join(config.modelsDir, m.file) === config.speakerModel);
  for (const m of list) await fetchModel(m);
  console.log(`Models are in ${config.modelsDir}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
