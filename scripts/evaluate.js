'use strict';

/**
 * Measures transcription and speaker-recognition accuracy on a real recording, optionally for
 * several settings at once. See "Measuring accuracy" in README.md.
 *
 *   npm run evaluate -- <dataset folder> [options]
 *
 * The dataset folder contains:
 *   recording.wav    the conversation (any WAV; or the folder's only .wav file, or --audio)
 *   reference.txt    what was really said, one turn per line: "Name: text"
 *   voices/          enrollment recordings: voices/<Name>.wav or voices/<Name>/*.wav
 *                    (not needed with --app-voices)
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../src/config');
const { openDatabase, getSetting } = require('../src/db');
const { decodeWav } = require('../src/audio');
const { SpeechEngine, SAMPLE_RATE } = require('../src/speech/engine');
const { VoiceManager, savedThreshold } = require('../src/voices');
const { TranscriptionSession, CHANGE_MAX_SIMILARITY, JOIN_SIMILARITY } = require('../src/transcriber');
const { regroupSpeakers, MERGE_SIMILARITY } = require('../src/regroup');
const { parseReference, score, formatDetails } = require('../src/evaluation');

const USAGE = `Usage: npm run evaluate -- <dataset folder> [options]

Options:
  --audio <file>               the conversation recording (default: recording.wav in the folder)
  --reference <file>           the reference transcript (default: reference.txt in the folder)
  --app-voices                 use the voices enrolled in VoiceRecon instead of the folder's voices/
                               (and VoiceRecon's names and terms)
  --words <file>               names and terms the recognizer should prefer, one per line
                               (the voices' names are always included)
  --no-words                   no names and terms at all, not even the voices' names
  --threshold <list>           speaker match thresholds to try, e.g. 0.3,0.4,0.5
  --min-silence <list>         seconds of silence that end an utterance, e.g. 0.25,0.35,0.5
  --change-similarity <list>   similarity below which an utterance is split between speakers
  --split-middle <list>        cut out a stretch of someone else in the middle (A–B–A): 0 = off, 1 = on
  --join-similarity <list>     similarity at which a line joins an unknown speaker, e.g. 0.4,0.5,0.6
  --regroup <list>             decide speakers per recording afterwards, as for uploaded files, merging
                               speakers at this similarity (0 = off: per line, as live), e.g. 0,0.5
  --learn <list>               learn from clearly recognized lines during the run: 0 = off, 1 = on
  --details <file>             write word-by-word differences of the best run
  --json <file>                write all results as JSON`;

function parseArgs(argv) {
  const opts = { lists: {} };
  const list = (v, name) => {
    const values = String(v).split(',').map(Number);
    if (!values.length || values.some((x) => !Number.isFinite(x))) throw new Error(`${name} needs numbers, e.g. 0.3,0.4`);
    return values;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value.`);
      return argv[++i];
    };
    if (a === '--audio') opts.audio = value();
    else if (a === '--reference') opts.reference = value();
    else if (a === '--app-voices') opts.appVoices = true;
    else if (a === '--words') opts.words = value();
    else if (a === '--no-words') opts.noWords = true;
    else if (a === '--threshold') opts.lists.threshold = list(value(), a);
    else if (a === '--min-silence') opts.lists.minSilence = list(value(), a);
    else if (a === '--change-similarity') opts.lists.changeSimilarity = list(value(), a);
    else if (a === '--split-middle') opts.lists.splitMiddle = list(value(), a);
    else if (a === '--join-similarity') opts.lists.joinSimilarity = list(value(), a);
    else if (a === '--regroup') opts.lists.regroup = list(value(), a);
    else if (a === '--learn') opts.lists.learn = list(value(), a);
    else if (a === '--details') opts.details = value();
    else if (a === '--json') opts.json = value();
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.`);
    else if (!opts.dir) opts.dir = a;
    else throw new Error(`Unexpected argument ${a}.`);
  }
  return opts;
}

function findAudio(dir) {
  const wavs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav'));
  for (const name of ['recording.wav', 'conversation.wav']) if (wavs.includes(name)) return path.join(dir, name);
  if (wavs.length === 1) return path.join(dir, wavs[0]);
  throw new Error(`Cannot tell which WAV file in ${dir} is the conversation; name it recording.wav or use --audio.`);
}

function readWav(file) {
  try {
    return decodeWav(fs.readFileSync(file));
  } catch (err) {
    throw new Error(`${file}: ${err.message} (convert other formats to WAV first, e.g. in Audacity)`, { cause: err });
  }
}

/** [{ name, file }] from voices/<Name>.wav and voices/<Name>/*.wav. */
function folderVoices(dir) {
  const root = path.join(dir, 'voices');
  if (!fs.existsSync(root)) throw new Error(`${root} does not exist; add enrollment recordings or use --app-voices.`);
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.wav')) {
      out.push({ name: path.basename(entry.name, path.extname(entry.name)), file: full });
    } else if (entry.isDirectory()) {
      for (const f of fs.readdirSync(full)) if (f.toLowerCase().endsWith('.wav')) out.push({ name: entry.name, file: path.join(full, f) });
    }
  }
  return out;
}

/** [{ name, file }] from VoiceRecon's own database, opened read-only. */
function appVoices() {
  const dbFile = path.join(config.dataDir, 'voicerecon.db');
  if (!fs.existsSync(dbFile)) throw new Error(`No VoiceRecon database at ${dbFile} (set DATA_DIR?).`);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db.prepare('SELECT v.name, s.file FROM voices v JOIN voice_samples s ON s.voice_id = v.id ORDER BY v.name, s.id').all();
    return {
      voices: rows.map((r) => ({ name: r.name, file: path.join(config.dataDir, 'recordings', String(r.file)) })),
      threshold: savedThreshold(db, path.basename(config.speakerModel)) ?? config.speakerThreshold,
      learnFromSpeech: getSetting(db, 'learnFromSpeech', false),
      vocabulary: getSetting(db, 'vocabulary', []),
    };
  } finally {
    db.close();
  }
}

function product(lists) {
  let combos = [{}];
  for (const [key, values] of Object.entries(lists)) {
    combos = combos.flatMap((c) => values.map((v) => ({ ...c, [key]: v })));
  }
  return combos;
}

/**
 * Recognition results do not depend on the speaker settings, so when only those change between
 * runs the recognizer is not asked twice for the same audio. Interim results are skipped.
 */
function cacheTranscriptions(engine) {
  const cache = new Map();
  const transcribe = engine.transcribe.bind(engine);
  engine.transcribe = (samples, opts = {}) => {
    const key = crypto.createHash('sha1').update(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength))
      .update(engine.hotwords).digest('hex');
    if (!cache.has(key)) cache.set(key, transcribe(samples, opts));
    return cache.get(key);
  };
}

async function runOnce(engine, voices, audio, params) {
  voices.setThreshold(params.threshold);
  voices.setLearnFromSpeech(Boolean(params.learn));
  voices.forgetLearned(); // every run starts from the enrollment recordings only
  const session = new TranscriptionSession(engine, voices, {
    interim: false,
    vad: { minSilence: params.minSilence },
    changeMaxSimilarity: params.changeSimilarity,
    splitMiddle: Boolean(params.splitMiddle),
    joinSimilarity: params.joinSimilarity,
  });
  const names = new Map(voices.summary().map((v) => [v.id, v.name]));
  const finals = [];
  let error = null;
  session.on('message', (m) => {
    if (m.type !== 'final') return;
    const recent = session.recent.get(m.id) || {};
    finals.push({ m, embedding: recent.embedding, seconds: recent.seconds, speaker: m.speaker });
  });
  session.on('error', (err) => {
    error = err;
  });
  const t0 = Date.now();
  const chunk = SAMPLE_RATE / 10;
  for (let i = 0; i < audio.length; i += chunk) {
    session.push(audio.subarray(i, i + chunk));
    // Feed faster than real time, but do not queue the whole recording at once.
    while (engine.queue.length > 2) await new Promise((r) => setTimeout(r, 5));
  }
  await session.finish();
  session.close();
  if (error) throw error;
  // Uploaded files: speakers decided per recording once it is whole (src/regroup.js).
  const speakers = regroupSpeakers(finals, voices, { mergeSimilarity: params.regroup });
  const lines = finals.map(({ m }, i) => {
    const s = speakers[i];
    const speaker = s.kind === 'voice' ? names.get(s.id) || `voice ${s.id}` : s.label || '?';
    return { speaker, text: m.text, start: m.start, end: m.end, score: s.kind === 'voice' ? s.score : null };
  });
  const matched = lines.filter((l) => l.score !== null);
  return {
    lines,
    seconds: (Date.now() - t0) / 1000,
    unknown: new Set(lines.filter((l) => /^Speaker \d+$/.test(l.speaker)).map((l) => l.speaker)).size,
    meanScore: matched.length ? matched.reduce((n, l) => n + l.score, 0) / matched.length : null,
    learned: Object.fromEntries(voices.list().map((v) => [v.name, v.learned.live])),
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function printBreakdown(result) {
  console.log('\n  Per speaker          words    WER   speaker ok (name)  speaker ok (mapped)');
  for (const [name, p] of Object.entries(result.perSpeaker)) {
    console.log(`  ${pad(name, 18)} ${lpad(p.words, 7)} ${lpad(pct(p.wer), 7)} ${lpad(pct(p.accuracyByName), 18)} ${lpad(pct(p.accuracyMapped), 20)}`);
  }
  const hypNames = Object.keys(result.confusion);
  const refNames = Object.keys(result.perSpeaker);
  const width = Math.max(10, ...hypNames.map((h) => h.length + 2));
  console.log('\n  Who got the words (rows: who really spoke, columns: who VoiceRecon credited)');
  console.log(`  ${pad('', 18)}${hypNames.map((h) => lpad(h, width)).join('')}`);
  for (const r of refNames) {
    console.log(`  ${pad(r, 18)}${hypNames.map((h) => lpad(result.confusion[h][r] || 0, width)).join('')}`);
  }
  const mapped = Object.entries(result.mapping).filter(([h, r]) => h !== r).map(([h, r]) => `${h} → ${r}`);
  if (mapped.length) console.log(`\n  Unknown speakers mapped for "mapped" accuracy: ${mapped.join(', ')}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.dir) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 1);
  }
  const dir = path.resolve(opts.dir);
  const audioFile = opts.audio ? path.resolve(opts.audio) : findAudio(dir);
  const refFile = opts.reference ? path.resolve(opts.reference) : path.join(dir, 'reference.txt');
  const refTurns = parseReference(fs.readFileSync(refFile, 'utf8'));
  const app = opts.appVoices ? appVoices() : null;
  const voiceFiles = app ? app.voices : folderVoices(dir);
  if (!voiceFiles.length) console.warn('Warning: no voice recordings found; every speaker will be "unknown".');

  const engine = new SpeechEngine(config);
  await engine.load();
  cacheTranscriptions(engine);

  const wav = readWav(audioFile);
  const audio = engine.resample(wav.samples, wav.sampleRate);
  const duration = audio.length / SAMPLE_RATE;

  // A throw-away data folder, so evaluation never touches VoiceRecon's own database.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voicerecon-eval-'));
  const db = openDatabase(tmp);
  try {
    const voices = new VoiceManager(db, engine, { dataDir: tmp, defaultThreshold: config.speakerThreshold });
    voices.init();
    const ids = new Map();
    for (const v of voiceFiles) {
      if (!ids.has(v.name)) ids.set(v.name, voices.create({ name: v.name, color: '#888888' }));
      try {
        const { samples, sampleRate } = readWav(v.file);
        await voices.addSample(ids.get(v.name), { samples, sampleRate });
      } catch (err) {
        console.warn(`Warning: ${v.name}: ${path.basename(v.file)} skipped: ${err.message}`);
      }
    }

    const words = [...(app ? app.vocabulary : []),
      ...(opts.words ? fs.readFileSync(opts.words, 'utf8').split(/\r?\n/).map((w) => w.trim()).filter(Boolean) : [])];
    if (words.length) voices.setVocabulary(words);
    const preferred = opts.noWords ? engine.setHotwords([]) : engine.setHotwords(voices.hotwords());

    const refSpeakers = [...new Set(refTurns.map((t) => t.speaker))];
    const enrolled = voices.list().filter((v) => v.samples.length);
    const shown = path.relative(process.cwd(), audioFile);
    console.log(`Recording: ${shown.startsWith('..') ? audioFile : shown} (${(duration / 60).toFixed(1)} min)`);
    console.log(`Reference: ${refTurns.length} turns, ${refSpeakers.length} speakers (${refSpeakers.join(', ')})`);
    console.log(`Voices:    ${enrolled.map((v) => `${v.name} (${Math.round(v.speechSeconds)} s)`).join(', ') || 'none'}`);
    console.log(`Words:     ${preferred.join(', ') || 'none'}`);
    const notEnrolled = refSpeakers.filter((s) => !enrolled.some((v) => v.name.toLowerCase() === s.toLowerCase()));
    if (notEnrolled.length) console.log(`           not enrolled (expected as unknown speakers): ${notEnrolled.join(', ')}`);

    const defaults = {
      threshold: app ? app.threshold : config.speakerThreshold,
      minSilence: 0.35,
      changeSimilarity: CHANGE_MAX_SIMILARITY,
      splitMiddle: 1,
      joinSimilarity: JOIN_SIMILARITY,
      regroup: MERGE_SIMILARITY,
      learn: app && app.learnFromSpeech ? 1 : 0,
    };
    const combos = product(opts.lists).map((c) => ({ ...defaults, ...c }));
    const runs = [];
    console.log('\n  threshold  min-silence  change-sim  middle  join  regroup  learn |    WER  WER (no accents) | speaker ok (name)  speaker ok (mapped)'
      + '  avg score | lines  unknown   time');
    for (const params of combos) {
      const out = await runOnce(engine, voices, audio, params);
      const result = score(refTurns, out.lines);
      runs.push({ params, result, out });
      console.log(`  ${lpad(params.threshold.toFixed(2), 9)}  ${lpad(params.minSilence.toFixed(2), 11)}`
        + `  ${lpad(params.changeSimilarity.toFixed(2), 10)}  ${lpad(params.splitMiddle ? 'on' : 'off', 6)}`
        + `  ${lpad(params.joinSimilarity.toFixed(2), 4)}  ${lpad(params.regroup ? params.regroup.toFixed(2) : 'off', 7)}`
        + `  ${lpad(params.learn ? 'on' : 'off', 5)} |`
        + ` ${lpad(pct(result.wer), 6)}  ${lpad(pct(result.werNoAccents), 16)} |`
        + ` ${lpad(pct(result.speakerAccuracyByName), 17)}  ${lpad(pct(result.speakerAccuracyMapped), 19)}`
        + `  ${lpad(out.meanScore === null ? '–' : out.meanScore.toFixed(2), 9)} |`
        + ` ${lpad(result.hypTurns, 5)}  ${lpad(out.unknown, 7)}  ${lpad(`${out.seconds.toFixed(0)} s`, 5)}`);
    }

    // Best: most words credited to the right (named) person, then fewest word errors.
    const best = runs.slice().sort((a, b) => b.result.speakerAccuracyByName - a.result.speakerAccuracyByName
      || b.result.speakerAccuracyMapped - a.result.speakerAccuracyMapped || a.result.wer - b.result.wer)[0];
    if (runs.length > 1) {
      const p = best.params;
      console.log(`\nBest: threshold ${p.threshold}, min-silence ${p.minSilence}, change-similarity ${p.changeSimilarity}, `
        + `middle split ${p.splitMiddle ? 'on' : 'off'}, join similarity ${p.joinSimilarity}, regroup ${p.regroup || 'off'}, `
        + `learning ${p.learn ? 'on' : 'off'}`);
    }
    printBreakdown(best.result);
    console.log(`\n  ${best.result.refTurns} reference turns, ${best.result.hypTurns} transcript lines;`
      + ` ${best.result.counts.sub} wrong, ${best.result.counts.del} missing, ${best.result.counts.ins} extra words of ${best.result.refWords}.`);

    if (opts.details) {
      const hypText = best.out.lines.map((l) => `[${l.start.toFixed(1)}–${l.end.toFixed(1)} s] ${l.speaker}: ${l.text}`).join('\n');
      fs.writeFileSync(opts.details, `${formatDetails(refTurns, best.result)}\n\n---- VoiceRecon transcript ----\n${hypText}\n`);
      console.log(`\nWord-by-word differences written to ${opts.details}`);
    }
    if (opts.json) {
      const strip = ({ ops, ref, hyp, ...rest }) => rest; // eslint-disable-line no-unused-vars
      const json = {
        recording: audioFile,
        minutes: duration / 60,
        reference: { turns: refTurns.length, speakers: refSpeakers },
        voices: enrolled.map((v) => ({ name: v.name, speechSeconds: v.speechSeconds })),
        runs: runs.map((r) => ({
          params: r.params,
          ...strip(r.result),
          meanScore: r.out.meanScore,
          learnedLines: r.out.learned,
          lines: r.out.lines,
          seconds: r.out.seconds,
        })),
      };
      fs.writeFileSync(opts.json, JSON.stringify(json, null, 2));
      console.log(`Results written to ${opts.json}`);
    }
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(err.message);
  process.exit(1);
});
