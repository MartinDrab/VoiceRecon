'use strict';

/**
 * The launcher behind start.cmd / start.sh (scripts/launch.js) restarts the server when it asks
 * (the Users page, src/restart.js): run it with a temporary DATA_DIR on a free port, restart it,
 * then restart it with a backup waiting to be restored. Needs the speech models, like the
 * end-to-end test: without them the launcher would download them.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const config = require('../src/config');

const haveModels = process.env.VOICERECON_REQUIRE_MODELS === '1' || config.modelFiles.every((f) => fs.existsSync(f));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('net').AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

test('the launcher starts the server again when it asks to restart, and a waiting backup is restored then', { skip: !haveModels && 'models missing', timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voicerecon-launch-'));
  const dataDir = path.join(root, 'data');
  const port = await freePort();
  const launcher = spawn(process.execPath, [path.join(config.root, 'scripts', 'launch.js'), '--no-browser'], {
    cwd: config.root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, TLS_CERT: '', TLS_KEY: '', VOICERECON_SUPERVISED: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  launcher.stdout.on('data', (d) => (log += d));
  launcher.stderr.on('data', (d) => (log += d));
  const until = async (pattern, what) => {
    for (let i = 0; !pattern.test(log); i++) {
      if (i > 600 || launcher.exitCode !== null) throw new Error(`${what}:\n${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  /** @returns {Promise<{ status: number, body: any }>} body: JSON, or a Buffer */
  const call = async (method, url, body = undefined) => {
    const res = await fetch(base + url, {
      method,
      headers: { cookie, ...(body ? { 'content-type': body instanceof Uint8Array ? 'application/x-tar' : 'application/json' } : {}) },
      body: body instanceof Uint8Array ? body : body && JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };

  try {
    await until(/VoiceRecon is running at/, 'The launcher did not start the server');
    assert.strictEqual((await call('POST', '/api/setup', { username: 'admin', password: 'admin-password' })).status, 200);
    assert.deepStrictEqual((await call('GET', '/api/restart')).body, { available: true, listening: 0, transcribing: 0 });
    await call('POST', '/api/voices', { name: 'Anna', color: '#e5484d' });

    // A plain restart: the server comes back, and the session is still valid.
    assert.deepStrictEqual((await call('POST', '/api/restart')).body, { restarting: true });
    await until(/VoiceRecon is running again/, 'The server did not come back');
    assert.strictEqual((await call('GET', '/api/me')).status, 200);

    // With a backup waiting: restored when the server comes back (a voice added since is gone,
    // and everyone signs in again).
    const backup = (await call('GET', '/api/backup')).body;
    assert.strictEqual((await call('POST', '/api/backup/restore', new Uint8Array(backup))).status, 200);
    await call('POST', '/api/voices', { name: 'Eva', color: '#30a46c' });
    log = '';
    await call('POST', '/api/restart');
    await until(/VoiceRecon is running again/, 'The server did not come back');
    assert.match(log, /Restored the uploaded backup of /);
    assert.strictEqual((await call('GET', '/api/me')).status, 401, 'signed out');
    assert.strictEqual((await call('POST', '/api/login', { username: 'admin', password: 'admin-password' })).status, 200);
    assert.deepStrictEqual((await call('GET', '/api/voices')).body.voices.map((v) => v.name), ['Anna']);
    const { pending, result } = (await call('GET', '/api/backup/restore')).body;
    assert.deepStrictEqual([pending, result.ok], [null, true]);
    assert.ok(fs.existsSync(result.previous), 'the previous data are kept');
  } finally {
    // The launcher forwards SIGTERM to the server; on Windows the whole tree is ended instead.
    if (launcher.exitCode === null) {
      const exited = new Promise((resolve) => launcher.once('exit', resolve));
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(launcher.pid), '/T', '/F'], { stdio: 'ignore' });
      else launcher.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
