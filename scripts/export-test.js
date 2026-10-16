'use strict';

/**
 * Turns a transcript corrected in History into a test case for `npm run evaluate`:
 *   npm run export-test -- <transcript id> <folder> [--no-voices]
 * The folder gets conversation.wav (the transcript's kept audio), reference.txt (its lines as they
 * are now, one "Name: text" turn per change of speaker) and voices/<name>/ (copies of the
 * recordings of the saved voices who speak in it, so the evaluation enrolls them as the app did;
 * --no-voices leaves them out, then use `npm run evaluate -- <folder> --app-voices`). Correct the
 * transcript first: the reference is what was really said, and by whom. VoiceRecon's data folder
 * (DATA_DIR) is only read.
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { DatabaseSync } = require('node:sqlite');
const config = require('../src/config');
const { AudioStore } = require('../src/audio-store');

const USAGE = 'Usage: npm run export-test -- <transcript id> <folder> [--no-voices]';

/** A speaker name as a reference turn can carry it ("Name: text"; no ":.,!?"). */
const referenceName = (name) => String(name || '').replace(/[:.,!?]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Unknown';

/** The same name as a folder name (evaluate takes voices/<name>/ as the voice's name). */
const folderName = (name) => name.replace(/[\\/*"<>|]/g, '_');

async function main() {
  const args = process.argv.slice(2);
  const [idArg, folder] = args.filter((a) => !a.startsWith('--'));
  const transcriptId = Number(idArg);
  if (!Number.isInteger(transcriptId) || transcriptId <= 0 || !folder) throw new Error(USAGE);
  const out = path.resolve(folder);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty; choose a new folder.`);

  const dbFile = path.join(config.dataDir, 'voicerecon.db');
  if (!fs.existsSync(dbFile)) throw new Error(`No VoiceRecon database at ${dbFile} (set DATA_DIR?).`);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const t = db.prepare('SELECT * FROM transcripts WHERE id = ?').get(transcriptId);
    if (!t) throw new Error(`There is no transcript ${transcriptId}.`);
    const lines = db.prepare(`SELECT l.text, l.voice_id, COALESCE(v.name, l.speaker_label) AS name
      FROM transcript_lines l LEFT JOIN voices v ON v.id = l.voice_id
      WHERE l.transcript_id = ? ORDER BY l.start_sec, l.id`).all(transcriptId);
    if (!lines.length) throw new Error(`Transcript ${transcriptId} has no lines.`);
    const audio = new AudioStore(db, config.dataDir);
    if (!audio.pieces(transcriptId).length) {
      throw new Error(`Transcript ${transcriptId} has no audio (it is kept only while "Keep audio" is on, see the Users page).`);
    }

    // One turn per change of speaker.
    const turns = [];
    for (const l of lines) {
      const name = referenceName(l.name);
      const last = turns[turns.length - 1];
      if (last && last.name === name) last.text += ` ${l.text}`;
      else turns.push({ name, text: l.text, voiceId: l.voice_id });
    }

    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'reference.txt'), `${turns.map((x) => `${x.name}: ${x.text}`).join('\n')}\n`);
    const { stream } = audio.wav(transcriptId);
    await pipeline(stream, fs.createWriteStream(path.join(out, 'conversation.wav')));

    const voiceIds = [...new Set(lines.map((l) => l.voice_id).filter((v) => v !== null))];
    let copied = 0;
    if (!args.includes('--no-voices')) {
      for (const voiceId of voiceIds) {
        const voice = db.prepare('SELECT name FROM voices WHERE id = ?').get(voiceId);
        const samples = db.prepare('SELECT file FROM voice_samples WHERE voice_id = ? ORDER BY id').all(voiceId);
        if (!voice || !samples.length) continue;
        const dir = path.join(out, 'voices', folderName(referenceName(voice.name)));
        fs.mkdirSync(dir, { recursive: true });
        samples.forEach((s, i) => fs.copyFileSync(path.join(config.dataDir, 'recordings', String(s.file)), path.join(dir, `${i + 1}.wav`)));
        copied++;
      }
    }

    const names = [...new Set(turns.map((x) => x.name))];
    const seconds = (fs.statSync(path.join(out, 'conversation.wav')).size - 44) / 32000;
    console.log(`Transcript ${transcriptId} exported to ${out}:`);
    console.log(`  conversation.wav  ${(seconds / 60).toFixed(1)} min`);
    console.log(`  reference.txt     ${turns.length} turns of ${names.join(', ')}`);
    if (copied) console.log(`  voices/           recordings of ${copied} saved voice(s)`);
    console.log(`\nRun: npm run evaluate -- "${folder}"${args.includes('--no-voices') ? ' --app-voices' : ''}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
