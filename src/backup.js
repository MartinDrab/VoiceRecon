'use strict';

/**
 * Backup and restore of everything VoiceRecon keeps (DATA_DIR) as one file: a tar archive with
 *   backup.json      what the backup holds (app, format, date, database schema, counts)
 *   voicerecon.db    a consistent copy of the database (VACUUM INTO, also while the server runs),
 *                    without login sessions: a restored backup signs everyone out
 *   recordings/...   the voices' recordings
 *   audio/...        the transcripts' audio (audio-store.js)
 * Uploads still waiting to be transcribed are not included. A restore replaces the data folder,
 * keeping the previous one next to it, and must run while VoiceRecon is stopped
 * (scripts/restore.js).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { DatabaseSync } = require('node:sqlite');

const FORMAT = 1;
const BLOCK = 512;
const ZEROS = Buffer.alloc(64 * 1024);
// What an archive may hold (anything else is refused on restore: no "..", no absolute paths).
const ALLOWED = /^(backup\.json|voicerecon\.db|recordings\/[\w-]+(\/[\w.-]+)*|audio\/[\w.-]+)$/;

const pad = (size) => (BLOCK - (size % BLOCK)) % BLOCK;

/** A ustar header for a file. */
function header(name, size, mtime) {
  const h = Buffer.alloc(BLOCK);
  if (Buffer.byteLength(name) > 100) throw new Error(`Name too long for the archive: ${name}`);
  h.write(name, 0, 'utf8');
  const octal = (value, at, width) => h.write(`${value.toString(8).padStart(width - 1, '0')}\0`, at, 'latin1');
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(Math.floor(mtime / 1000), 136, 12);
  h.write('        ', 148, 'latin1'); // the checksum counts its own field as spaces
  h.write('0', 156, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

/** All files below `dir` as [{ name (relative, with "/"), file, size, mtime }]. */
function files(dir, prefix) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full, `${prefix}${entry.name}/`));
    else if (entry.isFile()) {
      const st = fs.statSync(full);
      out.push({ name: `${prefix}${entry.name}`, file: full, size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

/** The backup's file name: voicerecon-backup-2026-10-16.tar (local date). */
function backupName(date = new Date()) {
  const two = (n) => String(n).padStart(2, '0');
  return `voicerecon-backup-${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}.tar`;
}

/**
 * Prepares a backup of the data folder: copies the database now (a moment's work), and lists the
 * files with their sizes, so that the archive's size is known before it is written.
 * @param {DatabaseSync} db an open connection to DATA_DIR/voicerecon.db
 * @param {string} dataDir
 * @returns {{ bytes: number, filename: string, manifest: any, write(out: NodeJS.WritableStream): Promise<void>, cleanup(): void }}
 */
function prepareBackup(db, dataDir) {
  const copy = path.join(os.tmpdir(), `voicerecon-backup-${crypto.randomUUID()}.db`);
  db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  let manifest;
  try {
    const c = new DatabaseSync(copy);
    try {
      c.exec('DELETE FROM sessions');
      const count = (table) => Number(c.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
      manifest = {
        app: 'VoiceRecon',
        format: FORMAT,
        createdAt: new Date().toISOString(),
        schema: Number(c.prepare('PRAGMA user_version').get().user_version),
        users: count('users'),
        voices: count('voices'),
        transcripts: count('transcripts'),
      };
    } finally {
      c.close();
    }
  } catch (err) {
    fs.rmSync(copy, { force: true });
    throw err;
  }
  const info = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const now = Date.now();
  const entries = [
    { name: 'backup.json', data: info, size: info.length, mtime: now },
    { name: 'voicerecon.db', file: copy, size: fs.statSync(copy).size, mtime: now },
    ...files(path.join(dataDir, 'recordings'), 'recordings/'),
    ...files(path.join(dataDir, 'audio'), 'audio/'),
  ];
  const bytes = entries.reduce((n, e) => n + BLOCK + e.size + pad(e.size), 0) + 2 * BLOCK;

  async function* archive() {
    for (const e of entries) {
      yield header(e.name, e.size, e.mtime);
      let sent = 0;
      if (e.data) {
        yield e.data;
        sent = e.size;
      } else if (e.size) {
        // Exactly the size listed: a file written to meanwhile is cut there, one deleted meanwhile
        // (audio over the size limit) is zeros.
        try {
          for await (const chunk of fs.createReadStream(e.file, { start: 0, end: e.size - 1 })) {
            sent += chunk.length;
            yield chunk;
          }
        } catch { /* deleted meanwhile */ }
      }
      for (let left = e.size - sent + pad(e.size); left > 0; left -= ZEROS.length) yield ZEROS.subarray(0, Math.min(left, ZEROS.length));
    }
    yield Buffer.alloc(2 * BLOCK);
  }

  return {
    bytes,
    filename: backupName(),
    manifest,
    write: (out) => pipeline(Readable.from(archive()), out),
    cleanup: () => fs.rmSync(copy, { force: true }),
  };
}

/** The files in a backup: [{ name, offset, size }]; throws if it is not a VoiceRecon backup. */
function readArchive(fd) {
  const entries = [];
  const h = Buffer.alloc(BLOCK);
  for (let at = 0; ;) {
    if (fs.readSync(fd, h, 0, BLOCK, at) < BLOCK) throw new Error('The backup file is cut short.');
    if (h.every((b) => b === 0)) break;
    const text = (from, len) => h.toString('utf8', from, from + len).replace(/\0.*$/s, '');
    let name = text(0, 100);
    const prefix = text(345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(text(124, 12).trim(), 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('This is not a VoiceRecon backup.');
    const type = String.fromCharCode(h[156]);
    if (type === '0' || type === '\0') entries.push({ name, offset: at + BLOCK, size });
    at += BLOCK + size + pad(size);
  }
  return entries;
}

/**
 * Restores a backup into `dataDir`: the files go to a new folder first, which replaces `dataDir`
 * only once all is there and its database opens; the previous data folder is kept, renamed.
 * VoiceRecon must not be running.
 * @returns {{ manifest: any, previous: string | null }} previous: where the old data folder went
 */
function restoreBackup(file, dataDir) {
  const fd = fs.openSync(file, 'r');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${dataDir}.restoring-${stamp}`;
  try {
    const entries = readArchive(fd);
    const bad = entries.find((e) => !ALLOWED.test(e.name) || e.name.split('/').includes('..'));
    if (bad) throw new Error(`The backup holds a file it should not: ${bad.name}`);
    const info = entries.find((e) => e.name === 'backup.json');
    if (!info || !entries.some((e) => e.name === 'voicerecon.db')) throw new Error('This is not a VoiceRecon backup.');
    const buf = Buffer.alloc(info.size);
    fs.readSync(fd, buf, 0, info.size, info.offset);
    const manifest = JSON.parse(buf.toString('utf8'));
    if (manifest.app !== 'VoiceRecon' || manifest.format !== FORMAT) throw new Error('This is not a VoiceRecon backup (or one of a newer version).');

    fs.mkdirSync(target, { recursive: true });
    const chunk = Buffer.alloc(1 << 20);
    for (const e of entries) {
      if (e.name === 'backup.json') continue;
      const dest = path.join(target, ...e.name.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.openSync(dest, 'w');
      try {
        for (let done = 0; done < e.size;) {
          const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, e.size - done), e.offset + done);
          if (!n) throw new Error('The backup file is cut short.');
          fs.writeSync(out, chunk, 0, n);
          done += n;
        }
      } finally {
        fs.closeSync(out);
      }
    }
    // Its database must open before anything is replaced.
    const db = new DatabaseSync(path.join(target, 'voicerecon.db'));
    try {
      db.prepare('SELECT COUNT(*) AS n FROM users').get();
    } finally {
      db.close();
    }
    let previous = null;
    if (fs.existsSync(dataDir)) {
      previous = `${dataDir}.before-restore-${stamp}`;
      fs.renameSync(dataDir, previous);
    }
    fs.renameSync(target, dataDir);
    return { manifest, previous };
  } catch (err) {
    fs.rmSync(target, { recursive: true, force: true });
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { prepareBackup, restoreBackup, backupName };
