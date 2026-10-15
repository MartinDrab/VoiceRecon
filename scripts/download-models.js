'use strict';

/**
 * Downloads the speech models into ./models (or MODELS_DIR).
 *   npm run models            models needed to run VoiceRecon (~520 MB download)
 *   npm run models -- --test  also the Czech TTS voices used by scripts/make-test-audio.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../src/config');

const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

const MODELS = [
  { name: 'Silero VAD', url: `${BASE}/asr-models/silero_vad.onnx`, file: 'silero_vad.onnx' },
  {
    name: 'CAM++ speaker embeddings (3D-Speaker)',
    url: `${BASE}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`,
    file: '3dspeaker_campplus_zh_en_advanced.onnx',
  },
  {
    name: 'NVIDIA Parakeet TDT 0.6B v3 (int8), 25 European languages incl. Czech',
    url: `${BASE}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
  },
];

const TEST_MODELS = [
  { name: 'Czech TTS voice "jirka" (Piper)', url: `${BASE}/tts-models/vits-piper-cs_CZ-jirka-medium.tar.bz2`, dir: 'vits-piper-cs_CZ-jirka-medium' },
  { name: 'Czech TTS voice (Coqui, Common Voice)', url: `${BASE}/tts-models/vits-coqui-cs-cv.tar.bz2`, dir: 'vits-coqui-cs-cv' },
];

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    done += chunk.length;
    const pct = total ? Math.floor((done / total) * 100) : -1;
    if (pct !== lastPct && pct % 5 === 0) {
      process.stdout.write(`\r  ${pct}% of ${(total / 1e6).toFixed(0)} MB`);
      lastPct = pct;
    }
  });
  await pipeline(body, fs.createWriteStream(dest));
  if (total) process.stdout.write('\n');
}

async function fetchModel(m) {
  const target = path.join(config.modelsDir, m.file || m.dir);
  if (fs.existsSync(target)) {
    console.log(`✓ ${m.name} (already present)`);
    return;
  }
  console.log(`↓ ${m.name}`);
  if (m.file) {
    await download(m.url, `${target}.part`);
    fs.renameSync(`${target}.part`, target);
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
  fs.renameSync(path.join(scratch, m.dir), target);
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(archive);
}

async function main() {
  fs.mkdirSync(config.modelsDir, { recursive: true });
  const list = process.argv.includes('--test') ? [...MODELS, ...TEST_MODELS] : MODELS;
  for (const m of list) await fetchModel(m);
  console.log(`Models are in ${config.modelsDir}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
