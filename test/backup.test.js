'use strict';

// Backup and restore of the data folder (src/backup.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../src/db');
const { prepareBackup, restoreBackup, backupName } = require('../src/backup');

const folders = [];
test.after(() => {
  for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicerecon-backup-test-'));
  folders.push(dir);
  return dir;
};

/** A data folder with a user signed in, a voice with a recording, and a transcript with audio. */
function dataFolder() {
  const root = tmp();
  const dataDir = path.join(root, 'data');
  const db = openDatabase(dataDir);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('anna', 'x', 'admin')").run();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('t', 1, 9999999999999)").run();
  db.prepare("INSERT INTO voices (name, color) VALUES ('Anna', '#ff0000')").run();
  db.prepare("INSERT INTO voice_samples (voice_id, file, label, duration, speech_duration, embedding, model) VALUES (1, '1/a.wav', '', 1, 1, x'00', 'm')").run();
  db.prepare('INSERT INTO transcripts (started_at, updated_at) VALUES (1, 1)').run();
  db.prepare("INSERT INTO transcript_audio (transcript_id, file, start_sec, created_at) VALUES (1, 'p.pcm', 0, 1)").run();
  fs.mkdirSync(path.join(dataDir, 'recordings', '1'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'recordings', '1', 'a.wav'), Buffer.alloc(1000, 7));
  fs.mkdirSync(path.join(dataDir, 'audio'));
  fs.writeFileSync(path.join(dataDir, 'audio', 'p.pcm'), Buffer.alloc(70000, 9));
  return { root, dataDir, db };
}

async function save(db, dataDir, file) {
  const backup = prepareBackup(db, dataDir);
  try {
    await backup.write(fs.createWriteStream(file));
  } finally {
    backup.cleanup();
  }
  return backup;
}

test('a backup holds the data folder in one standard tar file, without login sessions', async () => {
  const { root, dataDir, db } = dataFolder();
  const file = path.join(root, 'backup.tar');
  const backup = await save(db, dataDir, file);
  db.close();
  assert.strictEqual(fs.statSync(file).size, backup.bytes, 'its size is known before it is written');
  assert.match(backup.filename, /^voicerecon-backup-\d{4}-\d\d-\d\d\.tar$/);
  assert.deepStrictEqual({ ...backup.manifest, createdAt: 'x', schema: 0 },
    { app: 'VoiceRecon', format: 1, createdAt: 'x', schema: 0, users: 1, voices: 1, transcripts: 1 });
  // Any tar program reads it.
  const listed = execFileSync('tar', ['-tf', path.basename(file)], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.deepStrictEqual(listed, ['backup.json', 'voicerecon.db', 'recordings/1/a.wav', 'audio/p.pcm']);

  // Restored into a new place, and into a folder that has data already (kept, renamed).
  const fresh = path.join(root, 'fresh');
  assert.strictEqual(restoreBackup(file, fresh).previous, null);
  const restored = new DatabaseSync(path.join(fresh, 'voicerecon.db'));
  assert.deepStrictEqual([
    restored.prepare('SELECT username FROM users').get().username,
    restored.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
    restored.prepare('SELECT file FROM transcript_audio').get().file,
  ], ['anna', 0, 'p.pcm']);
  restored.close();
  assert.ok(fs.readFileSync(path.join(fresh, 'audio', 'p.pcm')).equals(Buffer.alloc(70000, 9)));
  assert.ok(fs.readFileSync(path.join(fresh, 'recordings', '1', 'a.wav')).equals(Buffer.alloc(1000, 7)));
  fs.writeFileSync(path.join(fresh, 'marker'), 'old');
  const { previous } = restoreBackup(file, fresh);
  assert.strictEqual(fs.readFileSync(path.join(previous, 'marker'), 'utf8'), 'old');
  assert.ok(!fs.existsSync(path.join(fresh, 'marker')), 'the restored folder is the backup only');
});

test('a restore refuses anything that is not a VoiceRecon backup, and changes nothing then', () => {
  const root = tmp();
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'keep'), 'mine');
  fs.writeFileSync(path.join(root, 'evil.txt'), 'x');
  execFileSync('tar', ['-cf', 'other.tar', 'evil.txt'], { cwd: root });
  assert.throws(() => restoreBackup(path.join(root, 'other.tar'), dataDir), /should not: evil\.txt/);
  fs.writeFileSync(path.join(root, 'junk.tar'), Buffer.alloc(100, 1));
  assert.throws(() => restoreBackup(path.join(root, 'junk.tar'), dataDir), /cut short|not a VoiceRecon backup/);
  assert.strictEqual(fs.readFileSync(path.join(dataDir, 'keep'), 'utf8'), 'mine');
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['data', 'evil.txt', 'junk.tar', 'other.tar'], 'no half-restored folder left');
  assert.strictEqual(backupName(new Date(2026, 9, 5)), 'voicerecon-backup-2026-10-05.tar');
});
