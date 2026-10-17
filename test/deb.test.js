'use strict';

// The Debian package (scripts/build-deb.js), built without its dependencies and read back here:
// an ar archive of debian-binary, control.tar.gz and data.tar.gz, as dpkg expects it.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');
const { tar } = require('../scripts/build-deb');

const ROOT = path.join(__dirname, '..');
const folders = [];
test.after(() => {
  for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicerecon-deb-test-'));
  folders.push(dir);
  return dir;
};

/** The members of an ar archive: { name: Buffer }. */
function readAr(buf) {
  assert.strictEqual(buf.toString('latin1', 0, 8), '!<arch>\n');
  const out = {};
  for (let at = 8; at < buf.length;) {
    const header = buf.toString('latin1', at, at + 60);
    assert.strictEqual(header.slice(58), '`\n', 'header end');
    const size = Number(header.slice(48, 58).trim());
    out[header.slice(0, 16).trim()] = buf.subarray(at + 60, at + 60 + size);
    at += 60 + size + (size % 2);
  }
  return out;
}

/** The entries of a tar archive: { name: { mode, type, data } }, GNU long names resolved. */
function readTar(buf) {
  const out = {};
  let longName = null;
  for (let at = 0; at + 512 <= buf.length;) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const field = (from, len) => h.toString('utf8', from, from + len).replace(/\0.*$/s, '');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    assert.strictEqual(parseInt(field(148, 8), 8), sum, `checksum of ${field(0, 100)}`);
    const size = parseInt(field(124, 12), 8);
    const type = String.fromCharCode(h[156]);
    const data = buf.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0$/, '');
      continue;
    }
    const name = longName || field(0, 100);
    longName = null;
    out[name] = { mode: parseInt(field(100, 8), 8), type, data, owner: [field(265, 32), field(297, 32)].join(':') };
  }
  return out;
}

test('the package holds the app, its service, settings and command, with the folders and modes dpkg expects', () => {
  const out = tmp();
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-deb.js'), '--no-deps', '--out', out, '--version', '1.2.3', '--maintainer', 'Test <test@example.com>'], { stdio: 'pipe' });
  const file = path.join(out, 'voicerecon_1.2.3_amd64.deb');
  const members = readAr(fs.readFileSync(file));
  assert.deepStrictEqual(Object.keys(members), ['debian-binary', 'control.tar.gz', 'data.tar.gz'], 'in this order');
  assert.strictEqual(members['debian-binary'].toString(), '2.0\n');

  const control = readTar(zlib.gunzipSync(members['control.tar.gz']));
  const fields = Object.fromEntries(control['./control'].data.toString().split('\n').filter((l) => /^\S/.test(l)).map((l) => l.split(/: (.*)/s).slice(0, 2)));
  assert.deepStrictEqual([fields.Package, fields.Version, fields.Architecture, fields.Maintainer, fields.Depends],
    ['voicerecon', '1.2.3', 'amd64', 'Test <test@example.com>', 'nodejs (>= 22.13), adduser']);
  assert.ok(Number(fields['Installed-Size']) > 100);
  assert.match(control['./control'].data.toString(), /\nDescription: .+\n( \S.*\n)+$/, 'the long description: lines starting with a space');
  assert.strictEqual(control['./conffiles'].data.toString(), '/etc/voicerecon/voicerecon.env\n');
  for (const s of ['postinst', 'prerm', 'postrm']) {
    assert.strictEqual(control[`./${s}`].mode, 0o755, s);
    assert.ok(control[`./${s}`].data.toString().startsWith('#!/bin/sh\nset -e\n'), `${s}: a shell script with LF line endings`);
  }

  const data = readTar(zlib.gunzipSync(members['data.tar.gz']));
  const names = Object.keys(data);
  assert.deepStrictEqual(names, [...names].sort(), 'sorted: every folder before what is in it');
  for (const n of names.filter((x) => !x.endsWith('/'))) {
    const parts = n.split('/');
    for (let i = 1; i < parts.length; i++) assert.ok(data[`${parts.slice(0, i).join('/')}/`], `the folder of ${n}`);
  }
  assert.ok(Object.values(data).every((e) => e.owner === 'root:root'));
  const app = data['./usr/lib/voicerecon/src/server.js'];
  assert.deepStrictEqual([app.mode, app.type], [0o644, '0']);
  assert.ok(app.data.equals(fs.readFileSync(path.join(ROOT, 'src', 'server.js'))));
  assert.ok(data['./usr/lib/voicerecon/scripts/launch.js'] && data['./usr/lib/voicerecon/public/static/js/history.js']);
  assert.ok(!data['./usr/lib/voicerecon/scripts/bench-asr.js'] && !names.some((n) => n.includes('/test/')), 'no development files');
  assert.strictEqual(data['./usr/bin/voicerecon'].mode, 0o755);
  assert.strictEqual(data['./usr/lib/voicerecon/'].mode, 0o755);
  assert.ok(!data['./usr/bin/voicerecon'].data.includes('\r'), 'LF line endings');
  assert.match(data['./usr/lib/systemd/system/voicerecon.service'].data.toString(), /ExecStart=\/usr\/bin\/node \/usr\/lib\/voicerecon\/scripts\/launch\.js --no-browser/);
  assert.match(data['./etc/voicerecon/voicerecon.env'].data.toString(), /^DATA_DIR=\/var\/lib\/voicerecon\/data$/m);

  // md5sums: every file but the conffile, as dpkg checks them.
  const sums = control['./md5sums'].data.toString().trim().split('\n').map((l) => l.split('  '));
  const files = names.filter((n) => !n.endsWith('/') && n !== './etc/voicerecon/voicerecon.env');
  assert.strictEqual(sums.length, files.length);
  for (const [md5, name] of sums) assert.strictEqual(crypto.createHash('md5').update(data[`./${name}`].data).digest('hex'), md5, name);
});

test('a pre-release sorts before its release: 0.2.0-rc.1 is 0.2.0~rc.1 for Debian', () => {
  const out = tmp();
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-deb.js'), '--no-deps', '--out', out, '--version', '0.2.0-rc.1', '--arch', 'arm64',
    '--maintainer', 'Test <test@example.com>'], { stdio: 'pipe' });
  // The file keeps the hyphen: GitHub renames "~" in the files of a release.
  const control = readTar(zlib.gunzipSync(readAr(fs.readFileSync(path.join(out, 'voicerecon_0.2.0-rc.1_arm64.deb')))['control.tar.gz']));
  assert.match(control['./control'].data.toString(), /^Version: 0\.2\.0~rc\.1$/m);
  assert.match(control['./control'].data.toString(), /^Architecture: arm64$/m);
});

test('names longer than 100 bytes get a GNU long-name entry, which tar reads', () => {
  const long = `./usr/lib/voicerecon/node_modules/${'a-rather-long-package-name/'.repeat(4)}index.js`;
  assert.ok(Buffer.byteLength(long) > 100);
  const archive = tar([{ name: './', mode: 0o755 }, { name: long, data: Buffer.from('ok'), mode: 0o644 }], 1700000000);
  const entries = readTar(archive);
  assert.deepStrictEqual(Object.keys(entries), ['./', long]);
  assert.strictEqual(entries[long].data.toString(), 'ok');
  // The system's tar (GNU tar, or bsdtar on Windows) agrees, where there is one.
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.tar'), archive);
  const listed = spawnSync('tar', ['-tf', 'a.tar'], { cwd: dir, encoding: 'utf8' });
  if (listed.status === 0) assert.deepStrictEqual(listed.stdout.trim().split(/\r?\n/), ['./', long]);
});
