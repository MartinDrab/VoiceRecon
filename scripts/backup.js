'use strict';

/**
 * Saves everything VoiceRecon keeps (DATA_DIR) as one file (src/backup.js), also while it runs:
 *   npm run backup -- [file]     default: voicerecon-backup-<date>.tar in the current folder
 * Administrators can also download one on the Users page. Restore with npm run restore.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../src/config');
const { prepareBackup, backupName } = require('../src/backup');

async function main() {
  const dbFile = path.join(config.dataDir, 'voicerecon.db');
  if (!fs.existsSync(dbFile)) throw new Error(`No VoiceRecon database at ${dbFile} (set DATA_DIR?).`);
  const out = path.resolve(process.argv[2] || backupName());
  if (fs.existsSync(out)) throw new Error(`${out} exists already; choose another name.`);
  const db = new DatabaseSync(dbFile);
  try {
    const backup = prepareBackup(db, config.dataDir);
    try {
      await backup.write(fs.createWriteStream(out));
    } finally {
      backup.cleanup();
    }
    const m = backup.manifest;
    console.log(`Backup saved to ${out} (${(backup.bytes / 1024 ** 2).toFixed(1)} MB): `
      + `${m.users} user(s), ${m.voices} voice(s), ${m.transcripts} transcript(s).`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
