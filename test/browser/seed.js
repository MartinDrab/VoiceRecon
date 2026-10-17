'use strict';

// Test data for the browser tests, written straight into the test server's database (its
// DATA_DIR) through the stores, so no speech models are needed. Transcripts can be added while
// the server runs: SQLite lets a second connection write, and the server reads transcripts from
// the database on every request. Each test that changes a transcript seeds its own.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openDatabase } = require('../../src/db');
const { Auth } = require('../../src/auth');
const { VoiceManager } = require('../../src/voices');
const { TranscriptStore } = require('../../src/transcripts');
const { AudioStore, wavHeader } = require('../../src/audio-store');

const STARTED = Date.UTC(2026, 9, 15, 9, 0, 0);

/** `seconds` of a 16 kHz mono tone as a WAV file: something to play or upload. */
function toneWav(seconds, { hz = 220, amplitude = 2000 } = {}) {
  const samples = Buffer.alloc(Math.round(seconds * 16000) * 2);
  for (let i = 0; i < samples.length / 2; i++) samples.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / 16000)), 2 * i);
  return Buffer.concat([wavHeader(samples.length), samples]);
}

async function withDatabase(dataDir, fn) {
  const db = openDatabase(dataDir);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

const voiceManager = (db, dataDir) => new VoiceManager(db, { ready: false, speakerModelName: '' }, { dataDir, defaultThreshold: 0.5 });

/** Before the server starts: the administrator `admin` and the voice Anna. */
function seedUsers(dataDir, password) {
  return withDatabase(dataDir, async (db) => {
    await new Auth(db, { sessionTtlHours: 1, secureCookies: false }).createUser({ username: 'admin', password, role: 'admin' });
    voiceManager(db, dataDir).create({ name: 'Anna', color: '#e5484d' });
  });
}

/**
 * A transcript of the administrator with these lines, each 2.5 s long, and audio: a tone until
 * 4 s after the last line starts, kept as Ogg Opus like everything the server keeps.
 * @param {string} dataDir
 * @param {string} title
 * @param {[number, number | string, string][]} lines [start (s), speaker, text]: a number is an
 *   unknown speaker ("Speaker n"), a string the name of a saved voice
 * @param {{ startedAt?: number }} [options] when it started (ms)
 * @returns {Promise<number>} its id
 */
function seedTranscript(dataDir, title, lines, { startedAt = STARTED } = {}) {
  return withDatabase(dataDir, async (db) => {
    const voices = voiceManager(db, dataDir);
    const store = new TranscriptStore(db, voices);
    const audio = new AudioStore(db, dataDir);
    const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    db.exec('BEGIN IMMEDIATE'); // all lines at once, while the server waits
    let id;
    try {
      id = store.create(admin, { title, startedAt }).id;
      for (const [start, who, text] of lines) {
        let speaker = { voiceId: null, key: `u:1:u${who}`, label: `Speaker ${who}` };
        if (typeof who === 'string') {
          const voiceId = db.prepare('SELECT id FROM voices WHERE name = ?').get(who).id;
          speaker = { voiceId, key: `v:${voiceId}`, label: who };
        }
        store.appendLine(id, { start, end: start + 2.5, spokenAt: startedAt + start * 1000, speaker, text, seconds: 2.5, model: '' });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const wav = path.join(dataDir, `seed-${crypto.randomUUID()}.wav`);
    fs.writeFileSync(wav, toneWav(lines[lines.length - 1][0] + 4));
    audio.add(id, wav, { start: 0, dataStart: 44, move: true });
    await audio.converted();
    return id;
  });
}

module.exports = { seedUsers, seedTranscript, toneWav };
