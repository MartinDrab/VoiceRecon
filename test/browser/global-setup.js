'use strict';

/**
 * Before the browser tests: a temporary data folder with an administrator and the voice Anna
 * (seed.js), then the real server on a free port. The tests get its address, the
 * administrator's signed-in cookie and the data folder (to seed transcripts) through environment
 * variables (fixtures.js). The function returned stops the server and deletes the folder.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('../../src/config');
const { seedUsers } = require('./seed');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('net').AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

module.exports = async function globalSetup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicerecon-browser-'));
  const password = crypto.randomBytes(18).toString('base64url');
  await seedUsers(dataDir, password);

  const port = await freePort();
  const server = spawn(process.execPath, [path.join(config.root, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, TLS_CERT: '', TLS_KEY: '' }, // over any .env
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const stop = async () => {
    if (server.exitCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.kill();
      await exited;
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  try {
    // Until the speech models are loaded, or failed to load (most tests do without them).
    for (let i = 0; !/Speech models (ready|failed)/.test(log); i++) {
      if (i > 1200 || server.exitCode !== null) throw new Error(`The server did not start:\n${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const base = `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    });
    if (!res.ok) throw new Error(`Signing in failed: ${res.status}`);
    const [name, value] = res.headers.get('set-cookie').split(';')[0].split('=');
    const state = path.join(dataDir, 'browser-state.json');
    fs.writeFileSync(state, JSON.stringify({
      cookies: [{ name, value, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' }],
      origins: [],
    }));

    const speech = log.includes('Speech models ready') && fs.existsSync(path.join(FIXTURES, 'conversation.wav'));
    if (!speech && process.env.VOICERECON_REQUIRE_MODELS === '1') {
      throw new Error(`VOICERECON_REQUIRE_MODELS=1, but the speech models or the test audio are missing:\n${log}`);
    }
    process.env.VOICERECON_TEST_URL = base;
    process.env.VOICERECON_TEST_STATE = state;
    process.env.VOICERECON_TEST_DATA = dataDir;
    process.env.VOICERECON_TEST_SPEECH = speech ? '1' : '';
  } catch (err) {
    await stop();
    throw err;
  }
  return stop;
};
