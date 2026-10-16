'use strict';

/**
 * Restores a backup made with npm run backup (or downloaded on the Users page):
 *   npm run restore -- <backup file>
 * Everything in DATA_DIR is replaced: users, voices, transcripts, audio and settings, as they were
 * in the backup (everyone signs in again). The current data folder is kept next to it, renamed
 * (…before-restore-<time>); delete it once all is well. VoiceRecon must be stopped first.
 */

const http = require('http');
const https = require('https');
const config = require('../src/config');
const { restoreBackup } = require('../src/backup');

/** Whether VoiceRecon answers on its address (then its data must not be replaced under it). */
function running() {
  const local = ['127.0.0.1', '::1', '0.0.0.0', '::', 'localhost'].includes(config.host);
  const tls = Boolean(config.tlsCert && config.tlsKey);
  return new Promise((resolve) => {
    const req = (tls ? https : http).get({
      host: local ? '127.0.0.1' : config.host, port: config.port, path: '/api/setup', timeout: 2000, rejectUnauthorized: false,
    }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
  });
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run restore -- <backup file>');
  if (await running()) throw new Error(`VoiceRecon is running on port ${config.port}: stop it first, then restore.`);
  const { manifest, previous } = restoreBackup(file, config.dataDir);
  console.log(`Restored the backup of ${manifest.createdAt}: ${manifest.users} user(s), ${manifest.voices} voice(s), `
    + `${manifest.transcripts} transcript(s), into ${config.dataDir}.`);
  if (previous) console.log(`The data that were there are in ${previous}; delete that folder once everything works.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
