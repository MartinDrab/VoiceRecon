'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE voices (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE voice_samples (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    voice_id        INTEGER NOT NULL REFERENCES voices(id) ON DELETE CASCADE,
    file            TEXT NOT NULL,
    label           TEXT NOT NULL DEFAULT '',
    duration        REAL NOT NULL,
    speech_duration REAL NOT NULL,
    embedding       BLOB NOT NULL,
    model           TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX voice_samples_voice ON voice_samples(voice_id);
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // Voice prints learned from live speech ('live') or from a user correcting a line ('correction').
  `
  CREATE TABLE voice_learned (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    voice_id   INTEGER NOT NULL REFERENCES voices(id) ON DELETE CASCADE,
    source     TEXT NOT NULL CHECK (source IN ('live', 'correction')),
    seconds    REAL NOT NULL,
    embedding  BLOB NOT NULL,
    model      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX voice_learned_voice ON voice_learned(voice_id);
  `,
  // Saved transcripts. Times are seconds from the transcript's start; spoken_at is wall-clock ms.
  // speaker_key groups the lines of one speaker: "v:<voice id>", "u:<session>:<unknown id>",
  // "n:<name>" for a name typed by a user, or "?".
  `
  CREATE TABLE transcripts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title      TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    duration   REAL NOT NULL DEFAULT 0,
    sessions   INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX transcripts_started ON transcripts(started_at);
  CREATE TABLE transcript_lines (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    transcript_id INTEGER NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    start_sec     REAL NOT NULL,
    end_sec       REAL NOT NULL,
    spoken_at     INTEGER NOT NULL,
    voice_id      INTEGER REFERENCES voices(id) ON DELETE SET NULL,
    speaker_key   TEXT NOT NULL,
    speaker_label TEXT NOT NULL,
    text          TEXT NOT NULL,
    edited        INTEGER NOT NULL DEFAULT 0,
    seconds       REAL NOT NULL DEFAULT 0,
    embedding     BLOB,
    model         TEXT
  );
  CREATE INDEX transcript_lines_transcript ON transcript_lines(transcript_id, start_sec);
  CREATE VIRTUAL TABLE transcript_lines_fts USING fts5(
    text, content='transcript_lines', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER transcript_lines_ai AFTER INSERT ON transcript_lines BEGIN
    INSERT INTO transcript_lines_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER transcript_lines_ad AFTER DELETE ON transcript_lines BEGIN
    INSERT INTO transcript_lines_fts(transcript_lines_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER transcript_lines_au AFTER UPDATE OF text ON transcript_lines BEGIN
    INSERT INTO transcript_lines_fts(transcript_lines_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO transcript_lines_fts(rowid, text) VALUES (new.id, new.text);
  END;
  `,
  // Audio of saved transcripts (src/audio-store.js): pieces of 16 kHz mono 16-bit audio in
  // DATA_DIR/audio, each beginning at start_sec of the transcript; data_start is where the samples
  // begin in the file (after a WAV header).
  `
  CREATE TABLE transcript_audio (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    transcript_id INTEGER NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    file          TEXT NOT NULL,
    data_start    INTEGER NOT NULL DEFAULT 0,
    start_sec     REAL NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX transcript_audio_transcript ON transcript_audio(transcript_id);
  `,
  // speaker_manual: a user chose the line's speaker (History, or a correction while listening), so
  // deciding the speakers again (regroup.js) leaves it alone.
  `
  ALTER TABLE transcript_lines ADD COLUMN speaker_manual INTEGER NOT NULL DEFAULT 0;
  `,
  // mixed: the share of a voice recording's speech that sounds like another person (0: one voice;
  // NULL: not checked yet, VoiceManager.init() does it).
  `
  ALTER TABLE voice_samples ADD COLUMN mixed REAL;
  `,
];

function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'voicerecon.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

module.exports = { openDatabase, getSetting, setSetting };
