'use strict';

/**
 * Builds a Debian package of VoiceRecon (for Debian or Ubuntu servers):
 *   npm run deb -- [--arch amd64|arm64] [--version <version>] [--maintainer "Name <email>"] [--out <folder>]
 * It runs on any system, also Windows: no dpkg-deb is needed, the package (an ar archive of two
 * gzipped tar files) is written here. The production dependencies are installed for the package's
 * architecture (npm ci --os=linux --cpu=…, which picks sherpa-onnx's Linux build), so npm needs
 * the internet. The package goes to dist/voicerecon_<version>_<arch>.deb.
 *
 * What it installs (packaging/deb/ holds the files besides the app):
 *   /usr/lib/voicerecon/                      the app and its dependencies
 *   /usr/lib/systemd/system/voicerecon.service runs scripts/launch.js as the user voicerecon: on the
 *                                             first start it downloads the speech models (about 3 GB),
 *                                             and it restarts the server when the Users page asks
 *   /etc/voicerecon/voicerecon.env            the settings (kept on upgrades)
 *   /usr/bin/voicerecon                       create-user, backup, restore, models, as that user
 *   /var/lib/voicerecon/                      data, models and backups (made on install, kept on purge)
 * It depends on Node.js 22.13 or newer as a package (Debian and Ubuntu ship older ones; NodeSource
 * has newer ones). --no-deps leaves node_modules out (the tests use it).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PACKAGING = path.join(ROOT, 'packaging', 'deb');
const APP = 'usr/lib/voicerecon';
const ARCHES = { amd64: 'x64', arm64: 'arm64' }; // Debian's name -> Node's
// The command-line tools the package keeps (the benchmarks and the test-audio generator are for development).
const SCRIPTS = ['launch.js', 'download-models.js', 'create-user.js', 'backup.js', 'restore.js', 'evaluate.js', 'export-test.js'];
const BLOCK = 512;

// ---------- archives ----------

/** A tar header (GNU format) for one entry. */
function tarHeader(name, { size, mode, type, mtime }) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  const octal = (value, at, width) => h.write(`${value.toString(8).padStart(width - 1, '0')}\0`, at, 'latin1');
  octal(mode, 100, 8);
  octal(0, 108, 8); // root
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(mtime, 136, 12);
  h.write(type, 156, 'latin1');
  h.write('ustar  \0', 257, 'latin1');
  h.write('root', 265, 'latin1');
  h.write('root', 297, 'latin1');
  h.fill(' ', 148, 156); // the checksum counts its own field as spaces
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

const padding = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/**
 * A tar archive of [{ name, data?, mode }] (a name ending in "/" is a directory), owned by root.
 * Names longer than 100 bytes get a GNU long-name entry before them, which dpkg reads.
 */
function tar(entries, mtime) {
  const out = [];
  for (const e of entries) {
    const dir = e.name.endsWith('/');
    const size = dir ? 0 : e.data.length;
    const name = Buffer.from(e.name, 'utf8');
    if (name.length > 100) {
      const long = Buffer.concat([name, Buffer.alloc(1)]);
      out.push(tarHeader('././@LongLink', { size: long.length, mode: 0, type: 'L', mtime }), long, padding(long.length));
    }
    out.push(tarHeader(e.name, { size, mode: e.mode, type: dir ? '5' : '0', mtime }));
    if (!dir) out.push(e.data, padding(size));
  }
  out.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(out);
}

/** An ar archive of [{ name, data }], the container of a .deb. */
function ar(members, mtime) {
  const out = [Buffer.from('!<arch>\n', 'latin1')];
  for (const m of members) {
    const header = `${m.name.padEnd(16)}${String(mtime).padEnd(12)}0     0     100644  ${String(m.data.length).padEnd(10)}\`\n`;
    out.push(Buffer.from(header, 'latin1'), m.data);
    if (m.data.length % 2) out.push(Buffer.from('\n', 'latin1'));
  }
  return Buffer.concat(out);
}

/**
 * The .deb: files [{ path ('usr/bin/x'), data, mode }] with every folder they need, the control
 * fields (Installed-Size is added), maintainer scripts { postinst, ... } and conffiles (paths).
 */
function deb({ files, control, scripts, conffiles, mtime }) {
  const dirs = new Set(['./']);
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`./${parts.slice(0, i).join('/')}/`);
  }
  const entries = [...[...dirs].map((name) => ({ name, mode: 0o755 })), ...files.map((f) => ({ name: `./${f.path}`, data: f.data, mode: f.mode }))]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const kib = files.reduce((n, f) => n + Math.ceil(f.data.length / 1024), 0) + dirs.size;
  const md5sums = files.filter((f) => !conffiles.includes(`/${f.path}`))
    .map((f) => `${crypto.createHash('md5').update(f.data).digest('hex')}  ${f.path}\n`).join('');
  // Installed-Size before Depends, as dpkg-gencontrol writes it; Description stays last.
  const fields = Object.entries(control).flatMap(([k, v]) => [...(k === 'Depends' ? [`Installed-Size: ${kib}`] : []), `${k}: ${v}`])
    .join('\n');
  const controlFiles = [
    { name: './', mode: 0o755 },
    { name: './control', data: Buffer.from(`${fields}\n`), mode: 0o644 },
    { name: './conffiles', data: Buffer.from(conffiles.map((c) => `${c}\n`).join('')), mode: 0o644 },
    { name: './md5sums', data: Buffer.from(md5sums), mode: 0o644 },
    ...Object.entries(scripts).map(([name, data]) => ({ name: `./${name}`, data, mode: 0o755 })),
  ];
  return ar([
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: zlib.gzipSync(tar(controlFiles, mtime), { level: 9 }) },
    { name: 'data.tar.gz', data: zlib.gzipSync(tar(entries, mtime), { level: 9 }) },
  ], mtime);
}

// ---------- what goes in ----------

/**
 * Files under `dir` (recursively) as paths relative to it, with "/" separators.
 * @param {string} dir
 * @param {(rel: string) => boolean} [skip] leaves out a file or folder (and what is in it)
 * @param {string} [prefix]
 * @returns {string[]}
 */
function walk(dir, skip = () => false, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (skip(rel)) continue;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), skip, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** A packaging file with LF line endings (a Windows checkout may have CRLF). */
const text = (name) => Buffer.from(fs.readFileSync(path.join(PACKAGING, name), 'utf8').replace(/\r\n/g, '\n'));

/** The production dependencies for Linux on `cpu`, installed into a temporary folder: their files. */
function dependencies(cpu) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'voicerecon-deb-'));
  try {
    for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
    console.log(`Installing the dependencies for linux-${cpu}...`);
    // npm is a script (npm.cmd) on Windows, which only starts through a shell.
    const r = spawnSync(`npm ci --omit=dev --ignore-scripts --no-audit --no-fund --os=linux --cpu=${cpu}`, { cwd: stage, stdio: 'inherit', shell: true });
    if (r.status !== 0) throw new Error('npm ci failed (see above).');
    const native = path.join(stage, 'node_modules', `sherpa-onnx-linux-${cpu}`);
    if (!fs.existsSync(native)) throw new Error(`npm did not install sherpa-onnx-linux-${cpu}: is npm 10 or newer?`);
    const modules = path.join(stage, 'node_modules');
    return walk(modules, (rel) => rel === '.bin' || rel === '.package-lock.json')
      .map((rel) => ({ path: `${APP}/node_modules/${rel}`, data: fs.readFileSync(path.join(modules, rel)), mode: 0o644 }));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function maintainer() {
  const git = (key) => spawnSync('git', ['config', key], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim();
  const name = git('user.name');
  const email = git('user.email');
  return name && email ? `${name} <${email}>` : null;
}

function parseArgs(argv) {
  const opts = { arch: 'amd64', deps: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value.`);
      return argv[++i];
    };
    if (a === '--arch') opts.arch = value();
    else if (a === '--version') opts.version = value();
    else if (a === '--maintainer') opts.maintainer = value();
    else if (a === '--out') opts.out = value();
    else if (a === '--no-deps') opts.deps = false;
    else throw new Error(`Unknown option ${a}.`);
  }
  if (!ARCHES[opts.arch]) throw new Error(`--arch must be ${Object.keys(ARCHES).join(' or ')}.`);
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = opts.version || pkg.version;
  const who = opts.maintainer || maintainer();
  if (!who) throw new Error('Give the maintainer: --maintainer "Name <email>" (or set git config user.name and user.email).');
  const mtime = Math.floor(Number(process.env.SOURCE_DATE_EPOCH) || Date.now() / 1000);

  const app = (rel, mode = 0o644) => ({ path: `${APP}/${rel}`, data: fs.readFileSync(path.join(ROOT, rel)), mode });
  const files = [
    ...['src', 'public'].flatMap((dir) => walk(path.join(ROOT, dir), (rel) => rel.endsWith('.d.ts') || rel.endsWith('tsconfig.json'))
      .map((rel) => app(`${dir}/${rel}`))),
    ...SCRIPTS.map((s) => app(`scripts/${s}`)),
    app('package.json'),
    ...(opts.deps ? dependencies(ARCHES[opts.arch]) : []),
    { path: 'usr/lib/systemd/system/voicerecon.service', data: text('voicerecon.service'), mode: 0o644 },
    { path: 'etc/voicerecon/voicerecon.env', data: text('voicerecon.env'), mode: 0o644 },
    { path: 'usr/bin/voicerecon', data: text('voicerecon'), mode: 0o755 },
    { path: 'usr/share/doc/voicerecon/copyright', data: text('copyright'), mode: 0o644 },
    { path: 'usr/share/doc/voicerecon/README.md', data: fs.readFileSync(path.join(ROOT, 'README.md')), mode: 0o644 },
  ];
  const control = {
    Package: 'voicerecon',
    Version: version,
    Architecture: opts.arch,
    Maintainer: who,
    Depends: 'nodejs (>= 22.13), adduser',
    Section: 'sound',
    Priority: 'optional',
    Homepage: pkg.homepage,
    Description: 'realtime transcription with speaker recognition (Czech and English)\n'
      + ' VoiceRecon transcribes speech in the browser as it is spoken, recognizes who\n'
      + ' is speaking from recordings of their voices, and keeps searchable transcripts\n'
      + ' with their audio. Everything runs on this computer; the speech models (about\n'
      + ' 3 GB) are downloaded on the first start.',
  };
  const scripts = Object.fromEntries(['postinst', 'prerm', 'postrm'].map((s) => [s, text(s)]));
  const out = opts.out || path.join(ROOT, 'dist');
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `voicerecon_${version}_${opts.arch}.deb`);
  fs.writeFileSync(file, deb({ files, control, scripts, conffiles: ['/etc/voicerecon/voicerecon.env'], mtime }));
  console.log(`${file}: ${(fs.statSync(file).size / 2 ** 20).toFixed(1)} MB, ${files.length} files.`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { tar, ar, deb };
