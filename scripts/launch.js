'use strict';

/**
 * Starts VoiceRecon in one step; start.cmd (Windows) and start.sh (Linux, macOS) run this.
 *   node scripts/launch.js [--no-browser]
 * On first use it installs the dependencies and downloads the speech models. Then it starts the
 * server, opens the app in the browser once the server is listening, and stops with the server
 * (Ctrl+C). When the server exits to be restarted (the Users page, src/restart.js), it starts it
 * again. If VoiceRecon is already running, it only opens the browser.
 * Settings come from the environment or from a .env file in the project folder (see README.md).
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MIN_NODE = [22, 13]; // node:sqlite without a flag

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    fail(`VoiceRecon needs Node.js ${MIN_NODE.join('.')} or newer, but this is ${process.versions.node}. Get it from https://nodejs.org/`);
  }
}

/** Installs the dependencies when one is missing: on first use, or after an update added one. */
function installDependencies() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const missing = Object.keys(pkg.dependencies).filter((d) => !fs.existsSync(path.join(ROOT, 'node_modules', d, 'package.json')));
  if (!missing.length) return;
  console.log(`Installing the dependencies (${missing.join(', ')})...`);
  // npm is a script (npm.cmd) on Windows, which only starts through a shell.
  const r = spawnSync('npm install --no-audit --no-fund', { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail('Installing the dependencies failed (see above). Check the internet connection and start again.');
}

/**
 * Downloads the speech models when a file is missing (about 3 GB, once). Installs from before the
 * fp32 encoder lack only its two files; the int8 encoder they have is no longer used. Installs from
 * before ResNet34-LM lack only the speaker model (CAM++ stays in the folder).
 */
function downloadModels(config) {
  const missing = config.modelFiles.filter((f) => !fs.existsSync(f));
  if (!missing.length) return;
  try {
    require('./download-models').checkSpeakerModel(); // a SPEAKER_MODEL that must be copied by hand
  } catch (err) {
    fail(err.message);
  }
  const { encoder, encoderWeights } = config.asr;
  if (missing.every((f) => f === config.speakerModel)) {
    console.log('Downloading the more accurate speaker recognition model (27 MB, once)...');
  } else if (missing.every((f) => f === encoder || f === encoderWeights || f === config.speakerModel)) {
    console.log('Downloading the more accurate speech recognition model (about 2.4 GB, once)...');
  } else {
    console.log('Downloading the speech models (about 3 GB, only the first time)...');
  }
  const r = spawnSync(process.execPath, [path.join(__dirname, 'download-models.js')], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    fail('Downloading the speech models failed (see above). Check the internet connection and start again; finished models are kept.');
  }
}

const isLocal = (host) => ['127.0.0.1', '::1', '0.0.0.0', '::', 'localhost'].includes(host);

/** The address to open in the browser (http://localhost:3000/ by default). */
function appUrl(config) {
  const host = isLocal(config.host) ? 'localhost' : config.host;
  const proto = config.tlsCert && config.tlsKey ? 'https' : 'http';
  return `${proto}://${host.includes(':') ? `[${host}]` : host}:${config.port}/`;
}

/**
 * What answers on the server's address: 'voicerecon', 'other' (another program has the port)
 * or 'none'.
 */
function probe(config) {
  const tls = Boolean(config.tlsCert && config.tlsKey);
  const options = {
    host: isLocal(config.host) ? '127.0.0.1' : config.host,
    port: config.port,
    path: '/api/setup',
    timeout: 2000,
    rejectUnauthorized: false, // a self-signed certificate is fine for this check
  };
  return new Promise((resolve) => {
    const req = (tls ? https : http).get(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve('needed' in JSON.parse(body) ? 'voicerecon' : 'other');
        } catch {
          resolve('other');
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve(/** @type {any} */ (err).code === 'ECONNREFUSED' ? 'none' : 'other'));
  });
}

function openBrowser(url) {
  const [command, args, verbatim] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '""', url], true] // start "" <url>: the empty title keeps the URL from becoming the title
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url], false];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: verbatim });
  child.on('error', () => console.log(`Open ${url} in your browser.`));
  child.unref();
}

/**
 * Runs the server until it stops, and opens the browser once it listens. A server that exits with
 * RESTART_CODE is started again (the browser is not opened again: the pages reconnect by themselves).
 */
function runServer(url, browser) {
  const { RESTART_CODE } = require('../src/restart');
  let server = null;
  const start = (again) => {
    server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      stdio: ['inherit', 'pipe', 'inherit'],
      env: { ...process.env, VOICERECON_SUPERVISED: '1' }, // the Users page may restart it
    });
    let output = '';
    server.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      if (output === null) return;
      output += chunk;
      if (!output.includes('VoiceRecon listening on')) return;
      output = null;
      console.log(`\nVoiceRecon is running${again ? ' again' : ''} at ${url}  Press Ctrl+C to stop it.\n`);
      if (browser && !again) openBrowser(url);
    });
    server.on('exit', (code, signal) => {
      if (code === RESTART_CODE) {
        console.log('\nRestarting VoiceRecon...\n');
        start(true);
      } else {
        process.exit(code ?? (signal ? 1 : 0));
      }
    });
  };
  // Ctrl+C reaches the server too (same console); wait for it to shut down cleanly.
  process.on('SIGINT', () => {});
  for (const signal of /** @type {const} */ (['SIGTERM', 'SIGHUP'])) process.on(signal, () => server.kill(signal));
  start(false);
}

async function main() {
  checkNode();
  installDependencies();
  const config = require('../src/config'); // after installing: reads .env, nothing else
  downloadModels(config);
  const url = appUrl(config);
  const browser = !process.argv.includes('--no-browser');
  const running = await probe(config);
  if (running === 'voicerecon') {
    console.log(`VoiceRecon is already running at ${url}`);
    if (browser) openBrowser(url);
    return;
  }
  if (running === 'other') {
    fail(`Another program uses port ${config.port}. Choose another port, e.g. PORT=3001 in a .env file in ${ROOT}.`);
  }
  runServer(url, browser);
}

main().catch((err) => fail(err.stack || String(err)));
