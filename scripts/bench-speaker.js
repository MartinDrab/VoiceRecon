'use strict';

/**
 * Speaker-recognition benchmark: how well a speaker model tells people apart the way
 * VoiceManager.identify() uses voice prints (open set: enrolled voices must be named, everyone else
 * must stay unknown), with and without adaptive score normalization (AS-norm), and what one voice
 * print costs. Speech is found with Silero VAD and embedded with SpeechEngine.speechOnly(),
 * embed() and embedLong() from src/speech/engine.js, as in the app: enrollment recordings are
 * speech only and averaged over 6 s chunks; lines and 1.5 s windows are embedded whole.
 *
 *   node scripts/bench-speaker.js prepare --vad <silero_vad.onnx> --eval <dir>... [--cohort <dir>...] [--voices <dir>] --out <dir>
 *   node scripts/bench-speaker.js embed --model <file.onnx> [--threads <n>] --out <dir>
 *   node scripts/bench-speaker.js time --model <file.onnx>... --out <dir>
 *   node scripts/bench-speaker.js report [--enrolled <n>] [--draws <n>] [--top <n>] [--best <model>] --out <dir>
 *   node scripts/bench-speaker.js cmn --model <wespeaker.onnx> --out <copy.onnx>   (see addCmn())
 *
 * --eval and --cohort are VoxPopuli split folders: asr_<split>.tsv and the WAV files of
 * <split>_part_0.tar.gz (speakers with the same id in several folders are merged). --voices is a
 * folder with a COPY of the app's voicerecon.db and recordings/, never the app's data folder.
 * prepare stores the speech-only audio (16-bit, as the data is) and the trial plan in --out, so
 * every model gets exactly the same audio; embed writes the voice prints of one model; time
 * measures milliseconds per voice print; report prints Markdown tables.
 *
 * Protocol for --eval: each speaker's earliest utterances (ids start with the session date) form an
 * enrollment pool of 60 s of speech, and the prints use its first 10, 30 or 60 s. Speakers with
 * less, or with fewer than 3 utterances left over, are never enrolled: they are only unknown people.
 * Test segments of 1.5, 3 and 6 s come from the other utterances (at most 40 per speaker; all
 * lengths start at the same, random place in the utterance's speech). Open set: --enrolled speakers
 * (default 10) are drawn as the enrolled voices, --draws times (default 200); a segment gets the
 * best-scoring voice's name when that score reaches the threshold. --voices: each voice's speech is
 * halved; one half enrolls, the other is cut into test segments, and then the other way round.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const sherpa = require('sherpa-onnx-node');
const config = require('../src/config');
const { decodeWav } = require('../src/audio');
const { SpeechEngine, SAMPLE_RATE } = require('../src/speech/engine');
const { CHANGE_MAX_SIMILARITY } = require('../src/transcriber');

const ENROLL_SECONDS = [10, 30, 60];
const MAIN_ENROLL = 30; // README: "Add 20–60 seconds of natural speech"
const SEGMENT_SECONDS = [1.5, 3, 6];
const POOL_SECONDS = Math.max(...ENROLL_SECONDS);
const MAX_TEST_UTTERANCES = 40; // per speaker, so that talkative speakers do not dominate
const MIN_TEST_UTTERANCES = 3;
const MAX_COHORT_SECONDS = 30;
const TIMING_RUNS = 30;
const FALSE_NAME_TARGET = 0.01; // for the "few false names" threshold
const LABELS = {
  '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced': 'CAM++ zh/en advanced',
  '3dspeaker_campplus_zh_en_advanced': 'CAM++ zh/en advanced',
  '3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common': 'ERes2NetV2 zh-cn',
  wespeaker_en_voxceleb_resnet293_LM: 'WeSpeaker ResNet293-LM (as shipped)',
  wespeaker_en_voxceleb_resnet34_LM: 'WeSpeaker ResNet34-LM (as shipped)',
  wespeaker_en_voxceleb_resnet293_LM_cmn: 'WeSpeaker ResNet293-LM + CMN',
  wespeaker_en_voxceleb_resnet34_LM_cmn: 'WeSpeaker ResNet34-LM + CMN',
  wespeaker_resnet34_LM_cmn: 'WeSpeaker ResNet34-LM + CMN', // as npm run models saves it
  nemo_en_titanet_large: 'NeMo TitaNet-L',
};

function parseArgs(argv) {
  const opts = { command: argv[0], eval: [], cohort: [], model: [], enrolled: 10, draws: 200, top: 100 };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value.`);
      return argv[++i];
    };
    if (a === '--eval') opts.eval.push(value());
    else if (a === '--cohort') opts.cohort.push(value());
    else if (a === '--model') opts.model.push(value());
    else if (a === '--vad') opts.vad = value();
    else if (a === '--voices') opts.voices = value();
    else if (a === '--out') opts.out = value();
    else if (a === '--threads') opts.threads = Number(value());
    else if (a === '--enrolled') opts.enrolled = Number(value());
    else if (a === '--draws') opts.draws = Number(value());
    else if (a === '--top') opts.top = Number(value());
    else if (a === '--best') opts.best = value();
    else throw new Error(`Unknown option ${a}.`);
  }
  if (!opts.out) throw new Error('--out is required.');
  return opts;
}

const modelName = (file) => path.basename(file).replace(/\.onnx$/, '');
/** The model's name; "(current)" for the file the app uses (SPEAKER_MODEL). */
const label = (name) => `${LABELS[name] || name}${name === modelName(config.speakerModel) ? ' (current)' : ''}`;
const seconds = (n) => n / SAMPLE_RATE;

/** Deterministic random numbers (mulberry32), so every run and every model gets the same trials. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Utterances of a VoxPopuli split folder with their speaker. GNU tar on Windows stores the ":" of
 * the ids as U+F03A, so files are matched by name with that mapped back. Utterances without a
 * speaker id ("None") are left out.
 */
function readVoxPopuli(dir) {
  const tsv = fs.readdirSync(dir).find((f) => /^asr_.*\.tsv$/.test(f));
  if (!tsv) throw new Error(`No asr_*.tsv in ${dir}.`);
  const [head, ...rows] = fs.readFileSync(path.join(dir, tsv), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));
  const idCol = head.indexOf('id');
  const speakerCol = head.indexOf('speaker_id');
  const files = new Map();
  for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(dir, sub.name))) {
      if (f.endsWith('.wav')) files.set(f.slice(0, -4).replace(//g, ':'), path.join(dir, sub.name, f));
    }
  }
  return rows.map((c) => ({ id: c[idCol], spk: c[speakerCol], file: files.get(c[idCol]) }))
    .filter((u) => u.file && u.spk && u.spk !== 'None');
}

/** The enrolled voices' recordings, from a copy of the app's database (opened read-only). */
function readVoices(dir) {
  const inside = path.relative(path.resolve(config.dataDir), path.resolve(dir));
  if (!inside.startsWith('..') && !path.isAbsolute(inside)) {
    throw new Error('--voices must be a copy of the data folder, not the app\'s own data folder.');
  }
  const db = new DatabaseSync(path.join(dir, 'voicerecon.db'), { readOnly: true });
  try {
    return db.prepare('SELECT s.id, s.file, v.name FROM voice_samples s JOIN voices v ON v.id = s.voice_id ORDER BY s.id').all()
      .map((r) => ({ id: String(r.id), spk: String(r.name), file: path.join(dir, 'recordings', String(r.file)) }));
  } finally {
    db.close();
  }
}

/** Every `max`-th utterance when there are more than `max`, spread over all of them. */
function thin(list, max) {
  if (list.length <= max) return list;
  return Array.from({ length: max }, (_, k) => list[Math.floor((k * list.length) / max)]);
}

/** Sub-ranges [from, to) of `parts` (ranges of speech.pcm) covering samples a..b of their concatenation. */
function sliceParts(parts, a, b) {
  const out = [];
  let pos = 0;
  for (const [from, to] of parts) {
    const lo = Math.max(a, pos);
    const hi = Math.min(b, pos + to - from);
    if (lo < hi) out.push([from + lo - pos, from + hi - pos]);
    pos += to - from;
  }
  return out;
}

/**
 * The trials: which audio becomes an enrollment print, a test segment or a cohort print (see the
 * protocol at the top). Each job is a list of speech.pcm ranges that are concatenated and embedded
 * with embedLong() (long: enrollment and cohort) or embed() (segments, as lines and windows are).
 */
function makePlan(utts) {
  const jobs = [];
  const speakers = [];
  const len = (u) => seconds(u.to - u.from);
  const groups = (set) => {
    const map = new Map();
    for (const u of utts.filter((x) => x.set === set)) map.set(u.spk, [...(map.get(u.spk) || []), u]);
    return [...map].sort(([a], [b]) => (a < b ? -1 : 1));
  };

  for (const [spk, list] of groups('eval')) {
    list.sort((a, b) => (a.id < b.id ? -1 : 1)); // ids start with the session's date and time
    let n = 0;
    let pool = 0;
    while (n < list.length && pool < POOL_SECONDS) pool += len(list[n++]);
    const rest = list.slice(n).filter((u) => len(u) >= SEGMENT_SECONDS[0]);
    const enrollable = pool >= POOL_SECONDS && rest.length >= MIN_TEST_UTTERANCES;
    const test = thin(enrollable ? rest : list.filter((u) => len(u) >= SEGMENT_SECONDS[0]), MAX_TEST_UTTERANCES);
    speakers.push({ spk, enrollable, utterances: list.length, speechSeconds: list.reduce((s, u) => s + len(u), 0), test: test.length });
    if (enrollable) {
      const parts = list.slice(0, n).map((u) => [u.from, u.to]);
      for (const s of ENROLL_SECONDS) jobs.push({ set: 'eval', role: 'enroll', seconds: s, spk, parts: sliceParts(parts, 0, s * SAMPLE_RATE), long: true });
    }
    for (const u of test) {
      const longest = SEGMENT_SECONDS.filter((s) => s <= len(u)).pop();
      const start = u.from + Math.floor(random(hash(u.id))() * (len(u) - longest) * SAMPLE_RATE);
      for (const s of SEGMENT_SECONDS.filter((x) => x <= longest)) {
        jobs.push({ set: 'eval', role: 'segment', seconds: s, spk, utt: u.id, parts: [[start, start + s * SAMPLE_RATE]] });
      }
      // The second half of the 6 s segment: with the 3 s segment, the two halves of one utterance.
      if (longest === 6) jobs.push({ set: 'eval', role: 'half', seconds: 3, spk, utt: u.id, parts: [[start + 3 * SAMPLE_RATE, start + 6 * SAMPLE_RATE]] });
    }
  }

  for (const u of utts.filter((x) => x.set === 'cohort' && len(x) >= SEGMENT_SECONDS[0])) {
    jobs.push({ set: 'cohort', role: 'cohort', spk: u.spk, utt: u.id, parts: [[u.from, Math.min(u.to, u.from + MAX_COHORT_SECONDS * SAMPLE_RATE)]], long: true });
  }

  for (const [spk, list] of groups('voices')) {
    const parts = list.map((u) => [u.from, u.to]);
    const total = parts.reduce((n, [a, b]) => n + b - a, 0);
    const half = Math.floor(total / 2);
    speakers.push({ spk, voice: true, speechSeconds: seconds(total) });
    [[0, half, half, total], [half, total, 0, half]].forEach(([ea, eb, ta, tb], fold) => {
      jobs.push({ set: 'voices', role: 'enroll', fold, seconds: seconds(eb - ea), spk, parts: sliceParts(parts, ea, eb), long: true });
      for (const s of SEGMENT_SECONDS) {
        const size = s * SAMPLE_RATE;
        for (let a = ta; a + size <= tb; a += size) {
          jobs.push({ set: 'voices', role: 'segment', fold, seconds: s, spk, parts: sliceParts(parts, a, a + size) });
        }
      }
    });
  }
  return { jobs, speakers };
}

/** Runs the VAD over all data once and stores the speech (16-bit) and the plan. */
function prepare(opts) {
  if (!opts.vad || !opts.eval.length) throw new Error('prepare needs --vad and --eval.');
  const engine = new SpeechEngine({ vadModel: opts.vad });
  fs.mkdirSync(opts.out, { recursive: true });
  const fd = fs.openSync(path.join(opts.out, 'speech.pcm'), 'w');
  let pos = 0;
  const utts = [];
  const add = (set, list) => {
    list.forEach((u, i) => {
      const { samples, sampleRate } = decodeWav(fs.readFileSync(u.file));
      const speech = engine.speechOnly(engine.resample(samples, sampleRate));
      const pcm = Int16Array.from(speech, (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32768))));
      fs.writeSync(fd, new Uint8Array(pcm.buffer));
      utts.push({ set, id: u.id, spk: u.spk, from: pos, to: pos + pcm.length });
      pos += pcm.length;
      if ((i + 1) % 200 === 0 || i + 1 === list.length) console.log(`${set}: ${i + 1}/${list.length}`);
    });
  };
  add('eval', opts.eval.flatMap(readVoxPopuli));
  add('cohort', opts.cohort.flatMap(readVoxPopuli));
  if (opts.voices) add('voices', readVoices(opts.voices));
  fs.closeSync(fd);
  const plan = makePlan(utts);
  fs.writeFileSync(path.join(opts.out, 'plan.json'), JSON.stringify({ ...plan, utterances: utts.length, speechSeconds: seconds(pos) }));
  console.log(`${plan.jobs.length} voice prints to compute, ${(seconds(pos) / 3600).toFixed(2)} h of speech`);
}

function loadSpeech(out) {
  const buf = fs.readFileSync(path.join(out, 'speech.pcm'));
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
}

function audioOf(pcm, parts) {
  const out = new Float32Array(parts.reduce((n, [a, b]) => n + b - a, 0));
  let pos = 0;
  for (const [a, b] of parts) {
    for (let i = a; i < b; i++) out[pos++] = pcm[i] / 32768;
  }
  return out;
}

/** A SpeechEngine with only a speaker model, so embed() and embedLong() run the app's own code. */
function speakerEngine(model, numThreads) {
  const engine = new SpeechEngine({});
  engine.extractor = new sherpa.SpeakerEmbeddingExtractor({ model, numThreads, debug: 0 });
  return engine;
}

function embedAll(opts) {
  const [model] = opts.model;
  if (!model) throw new Error('embed needs --model.');
  const { jobs } = JSON.parse(fs.readFileSync(path.join(opts.out, 'plan.json'), 'utf8'));
  const pcm = loadSpeech(opts.out);
  const threads = opts.threads || config.threads;
  const engine = speakerEngine(model, threads);
  const started = Date.now();
  const { dim } = engine.extractor;
  const vectors = new Float32Array(jobs.length * dim);
  let failed = 0;
  jobs.forEach((job, j) => {
    const audio = audioOf(pcm, job.parts);
    const e = job.long ? engine.embedLong(audio) : engine.embed(audio);
    if (e) vectors.set(e, j * dim);
    else failed++;
    if ((j + 1) % 500 === 0) console.log(`${modelName(model)}: ${j + 1}/${jobs.length} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  });
  const dir = path.join(opts.out, 'embeddings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${modelName(model)}.f32`), new Uint8Array(vectors.buffer));
  const info = { model: modelName(model), dim, jobs: jobs.length, failed, threads, seconds: (Date.now() - started) / 1000 };
  fs.writeFileSync(path.join(dir, `${modelName(model)}.json`), JSON.stringify(info));
  console.log(info);
}

/**
 * Milliseconds per voice print of real speech, with the threads the app gives the speaker model
 * (min(2, THREADS), see SpeechEngine.loadSpeakerModel()) and with THREADS itself.
 */
function timeModels(opts) {
  const { jobs } = JSON.parse(fs.readFileSync(path.join(opts.out, 'plan.json'), 'utf8'));
  const pcm = loadSpeech(opts.out);
  const long = jobs.find((j) => j.role === 'segment' && j.seconds === 6);
  const audio = audioOf(pcm, long.parts);
  const file = path.join(opts.out, 'timing.json');
  const timing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const model of opts.model) {
    const result = { fileMB: fs.statSync(model).size / 1e6 };
    for (const threads of [...new Set([Math.min(2, config.threads), config.threads])]) {
      const engine = speakerEngine(model, threads);
      result[threads] = {};
      for (const s of SEGMENT_SECONDS) {
        const piece = audio.subarray(0, s * SAMPLE_RATE);
        for (let i = 0; i < 3; i++) engine.embed(piece); // warm-up
        const ms = [];
        for (let i = 0; i < TIMING_RUNS; i++) {
          const t = process.hrtime.bigint();
          engine.embed(piece);
          ms.push(Number(process.hrtime.bigint() - t) / 1e6);
        }
        result[threads][s] = sorted(ms)[Math.floor(TIMING_RUNS / 2)];
      }
    }
    timing[modelName(model)] = result;
    console.log(modelName(model), JSON.stringify(result));
  }
  fs.writeFileSync(file, JSON.stringify(timing, null, 2));
}

// ---- statistics ----

const sorted = (values) => Float64Array.from(values).sort();

/** Number of values below t in an ascending array. */
function below(values, t) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const atLeast = (values, t) => values.length - below(values, t);

function quantile(values, q) {
  if (!values.length) return NaN;
  const x = q * (values.length - 1);
  const i = Math.floor(x);
  return values[i] + (values[Math.min(i + 1, values.length - 1)] - values[i]) * (x - i);
}

function meanStd(values) {
  let m = 0;
  for (const v of values) m += v;
  m /= values.length;
  let v2 = 0;
  for (const v of values) v2 += (v - m) ** 2;
  return { mean: m, std: Math.sqrt(v2 / values.length) };
}

/** Equal error rate of ascending genuine and impostor scores, and the score where it occurs. */
function equalError(gen, imp) {
  let best = { gap: Infinity, eer: NaN, at: NaN };
  let g = 0; // genuine scores below t
  let i = 0; // impostor scores below t
  while (g < gen.length || i < imp.length) {
    const t = Math.min(g < gen.length ? gen[g] : Infinity, i < imp.length ? imp[i] : Infinity);
    const miss = g / gen.length;
    const accept = (imp.length - i) / imp.length;
    if (Math.abs(miss - accept) < best.gap) best = { gap: Math.abs(miss - accept), eer: (miss + accept) / 2, at: t };
    while (g < gen.length && gen[g] <= t) g++;
    while (i < imp.length && imp[i] <= t) i++;
  }
  return best;
}

/** Separation of genuine and impostor scores: low genuine and high impostor percentiles, d'. */
function separation(gen, imp) {
  const g = meanStd(gen);
  const i = meanStd(imp);
  const genP5 = quantile(gen, 0.05);
  const impP99 = quantile(imp, 0.99);
  return { genP5, impP99, margin: genP5 - impP99, dprime: (g.mean - i.mean) / Math.sqrt((g.std ** 2 + i.std ** 2) / 2) };
}

// ---- scoring ----

function dot(v, a, b, dim) {
  let d = 0;
  const x = a * dim;
  const y = b * dim;
  for (let k = 0; k < dim; k++) d += v[x + k] * v[y + k];
  return d;
}

/**
 * Scores between voice prints (jobs a and b). Raw: cosine, as identify() uses it. AS-norm: the
 * cosine standardized against the `top` closest cohort prints of each side, averaged:
 * ((s - mean_a) / std_a + (s - mean_b) / std_b) / 2. Without a cohort (no --cohort) AS-norm is raw
 * cosine: normalizing by no scores would make every score NaN.
 */
function scorer(model, cohort, top, normalize) {
  const { v, dim } = model;
  if (!normalize || !cohort.length) return (a, b) => dot(v, a, b, dim);
  const stats = new Map();
  const stat = (j) => {
    let s = stats.get(j);
    if (!s) {
      const scores = cohort.map((c) => dot(v, j, c, dim)).sort((x, y) => y - x).slice(0, top || cohort.length);
      const { mean, std } = meanStd(scores);
      s = { mean, std: std || 1 };
      stats.set(j, s);
    }
    return s;
  };
  return (a, b) => {
    const s = dot(v, a, b, dim);
    const sa = stat(a);
    const sb = stat(b);
    return ((s - sa.mean) / sa.std + (s - sb.mean) / sb.std) / 2;
  };
}

/** Random sets of `k` enrolled speakers, the same for every model. */
function draws(speakers, k, n) {
  const rand = random(12345);
  return Array.from({ length: n }, () => {
    const pool = [...speakers];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return new Set(pool.slice(0, k));
  });
}

/**
 * Open-set identification at any threshold, from each trial's best score: an enrolled speaker's
 * segment is named correctly (best voice is theirs and reaches the threshold), named wrongly or
 * left unknown; an unenrolled speaker's segment either stays unknown or gets a false name.
 */
function openSetCurves(score, prints, segments, sets) {
  const right = [];
  const wrong = [];
  const unenrolled = [];
  const speakers = [...prints.keys()];
  const members = sets.map((set) => speakers.map((spk, k) => (set.has(spk) ? k : -1)).filter((k) => k >= 0));
  const s = new Float64Array(speakers.length);
  for (const seg of segments) {
    speakers.forEach((spk, k) => {
      s[k] = score(prints.get(spk), seg.j);
    });
    const own = speakers.indexOf(seg.spk); // -1: never enrolled
    sets.forEach((set, d) => {
      let best = -Infinity;
      let who = -1;
      for (const k of members[d]) {
        if (s[k] > best) {
          best = s[k];
          who = k;
        }
      }
      if (!set.has(seg.spk)) unenrolled.push(best);
      else if (who === own) right.push(best);
      else wrong.push(best);
    });
  }
  const r = sorted(right);
  const w = sorted(wrong);
  const u = sorted(unenrolled);
  const n = r.length + w.length;
  return {
    at: (t) => ({ acc: atLeast(r, t) / n, wrong: atLeast(w, t) / n, falseName: atLeast(u, t) / u.length }),
    scores: [...right, ...wrong, ...unenrolled],
  };
}

/**
 * The single threshold for all segment lengths that minimizes the balanced error (mean over the
 * lengths of ((1 - accuracy) + false-name rate) / 2), the lowest one whose mean false-name rate is
 * at most FALSE_NAME_TARGET, and for comparison the best threshold of each length on its own.
 */
function bestThreshold(curves) {
  const all = sorted(curves.flatMap((c) => c.scores));
  const lo = quantile(all, 0.001);
  const hi = quantile(all, 0.999);
  const balanced = (x) => (1 - x.acc + x.falseName) / 2;
  let best = { t: NaN, err: Infinity };
  let safe = NaN;
  const each = curves.map(() => ({ t: NaN, err: Infinity }));
  for (let i = 0; i <= 2000; i++) {
    const t = lo + ((hi - lo) * i) / 2000;
    const at = curves.map((c) => c.at(t));
    const err = at.reduce((s, x) => s + balanced(x), 0) / at.length;
    if (err < best.err) best = { t, err };
    if (Number.isNaN(safe) && at.reduce((s, x) => s + x.falseName, 0) / at.length <= FALSE_NAME_TARGET) safe = t;
    at.forEach((x, k) => {
      if (balanced(x) < each[k].err) each[k] = { t, err: balanced(x) };
    });
  }
  return {
    theta: best.t, balancedError: best.err, safe,
    eachTheta: each.map((e) => e.t), eachError: each.reduce((s, e) => s + e.err, 0) / each.length,
  };
}

/** Indexes of the plan's jobs by what they are. */
function indexJobs(jobs) {
  const ix = { prints: {}, segments: {}, halves: [], cohort: [], voices: [{ prints: new Map(), segments: {} }, { prints: new Map(), segments: {} }] };
  for (const s of ENROLL_SECONDS) ix.prints[s] = new Map();
  for (const s of SEGMENT_SECONDS) {
    ix.segments[s] = [];
    for (const f of ix.voices) f.segments[s] = [];
  }
  const firstHalf = new Map();
  jobs.forEach((job, j) => {
    if (job.set === 'eval' && job.role === 'enroll') ix.prints[job.seconds].set(job.spk, j);
    else if (job.set === 'eval' && job.role === 'segment') {
      ix.segments[job.seconds].push({ spk: job.spk, j });
      if (job.seconds === 3) firstHalf.set(job.utt, j);
    } else if (job.role === 'half') ix.halves.push({ spk: job.spk, a: firstHalf.get(job.utt), b: j });
    else if (job.role === 'cohort') ix.cohort.push(j);
    else if (job.set === 'voices' && job.role === 'enroll') ix.voices[job.fold].prints.set(job.spk, j);
    else if (job.set === 'voices') ix.voices[job.fold].segments[job.seconds].push({ spk: job.spk, j });
  });
  return ix;
}

/** Verification (EER, separation) and open-set identification for one model, scoring and enrollment length. */
function evaluate(score, ix, enrollSeconds, sets) {
  const prints = ix.prints[enrollSeconds];
  const perLength = {};
  const curves = [];
  for (const s of SEGMENT_SECONDS) {
    const gen = [];
    const imp = [];
    const bySpeaker = new Map(); // test speaker -> their trials, for the bootstrap
    for (const seg of ix.segments[s]) {
      if (!bySpeaker.has(seg.spk)) bySpeaker.set(seg.spk, { gen: [], imp: [] });
      const own = bySpeaker.get(seg.spk);
      for (const [spk, j] of prints) {
        const x = score(j, seg.j);
        (spk === seg.spk ? gen : imp).push(x);
        (spk === seg.spk ? own.gen : own.imp).push(x);
      }
    }
    const g = sorted(gen);
    const i = sorted(imp);
    const c = openSetCurves(score, prints, ix.segments[s], sets);
    curves.push(c);
    perLength[s] = { ...equalError(g, i), ...separation(g, i), curve: c, bySpeaker, trials: { genuine: g.length, impostor: i.length } };
  }
  return { perLength, ...bestThreshold(curves) };
}

/**
 * Mean EER over the segment lengths of `a` minus that of `b`, and its 95 % interval from a paired
 * bootstrap over test speakers (both results resampled with the same speakers).
 */
function bootstrapEer(a, b, resamples = 300) {
  const speakers = [...a.perLength[SEGMENT_SECONDS[0]].bySpeaker.keys()];
  const meanEer = (res, pick) => SEGMENT_SECONDS.reduce((n, s) => {
    const by = res.perLength[s].bySpeaker;
    const chosen = pick.map((spk) => by.get(spk)).filter(Boolean);
    return n + equalError(sorted(chosen.flatMap((t) => t.gen)), sorted(chosen.flatMap((t) => t.imp))).eer;
  }, 0) / SEGMENT_SECONDS.length;
  const rand = random(4242);
  const diffs = [];
  for (let r = 0; r < resamples; r++) {
    const pick = speakers.map(() => speakers[Math.floor(rand() * speakers.length)]);
    diffs.push(meanEer(a, pick) - meanEer(b, pick));
  }
  const d = sorted(diffs);
  return { diff: meanEer(a, speakers) - meanEer(b, speakers), lo: quantile(d, 0.025), hi: quantile(d, 0.975) };
}

/** The app's own voices: genuine and impostor scores, and leave-one-voice-out open-set naming at `theta`. */
function evaluateVoices(score, ix, theta) {
  const out = {};
  for (const s of SEGMENT_SECONDS) {
    const gen = [];
    const imp = [];
    let right = 0;
    let named = 0;
    let unknownTrials = 0;
    let falseNames = 0;
    for (const fold of ix.voices) {
      const voices = [...fold.prints.keys()];
      for (const seg of fold.segments[s]) {
        const scores = new Map(voices.map((v) => [v, score(fold.prints.get(v), seg.j)]));
        for (const [v, x] of scores) (v === seg.spk ? gen : imp).push(x);
        for (const left of voices) { // this voice is not enrolled
          let best = -Infinity;
          let who = null;
          for (const v of voices) {
            if (v !== left && scores.get(v) > best) {
              best = scores.get(v);
              who = v;
            }
          }
          if (seg.spk === left) {
            unknownTrials++;
            if (best >= theta) falseNames++;
          } else {
            named++;
            if (who === seg.spk && best >= theta) right++;
          }
        }
      }
    }
    const g = sorted(gen);
    const i = sorted(imp);
    out[s] = {
      n: g.length, genMin: g[0], genP5: quantile(g, 0.05), impMax: i[i.length - 1], ...equalError(g, i),
      acc: right / named, falseName: falseNames / unknownTrials,
    };
  }
  return out;
}

/**
 * The two halves of one utterance against halves of different speakers, as speakerTurns() compares
 * them (raw cosine; the app averages 1.5 s windows instead of embedding 3 s at once). A same-speaker
 * pair below the split value is a false split; a different-speaker pair at or above it is a missed change.
 */
function evaluateHalves(model, ix) {
  const { v, dim } = model;
  const same = [];
  const diff = [];
  const rand = random(777);
  const halves = ix.halves.filter((h) => h.a !== undefined);
  for (const h of halves) {
    same.push(dot(v, h.a, h.b, dim));
    for (let k = 0; k < 20; k++) {
      const o = halves[Math.floor(rand() * halves.length)];
      if (o.spk !== h.spk) diff.push(dot(v, h.a, o.b, dim));
    }
  }
  return { same: sorted(same), diff: sorted(diff) };
}

// ---- report ----

const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)} %` : '–');
const pct2 = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(2)} %` : '–');
const num = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map((h, i) => (i ? '---:' : '---')).join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

function report(opts) {
  const plan = JSON.parse(fs.readFileSync(path.join(opts.out, 'plan.json'), 'utf8'));
  const ix = indexJobs(plan.jobs);
  const dir = path.join(opts.out, 'embeddings');
  const models = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const info = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const buf = fs.readFileSync(path.join(dir, `${info.model}.f32`));
    return { ...info, v: new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4) };
  }).sort((a, b) => (label(a.model).includes('current') ? -1 : label(b.model).includes('current') ? 1 : a.model < b.model ? -1 : 1));
  const timingFile = path.join(opts.out, 'timing.json');
  const timing = fs.existsSync(timingFile) ? JSON.parse(fs.readFileSync(timingFile, 'utf8')) : {};
  const enrollable = plan.speakers.filter((s) => s.enrollable).map((s) => s.spk);
  const sets = draws(enrollable, opts.enrolled, opts.draws);
  const evalSpeakers = plan.speakers.filter((s) => !s.voice);
  const lines = [];
  const say = (text = '') => lines.push(text);

  say('## Data');
  say();
  say(`- Eval: ${evalSpeakers.length} speakers, ${(evalSpeakers.reduce((n, s) => n + s.speechSeconds, 0) / 3600).toFixed(2)} h of speech; `
    + `${enrollable.length} can be enrolled (${POOL_SECONDS} s pool + at least ${MIN_TEST_UTTERANCES} test utterances), `
    + `${evalSpeakers.length - enrollable.length} are only unknown people.`);
  say(`- Test segments: ${SEGMENT_SECONDS.map((s) => `${ix.segments[s].length} × ${s} s`).join(', ')}; ${ix.halves.length} utterances with two 3 s halves.`);
  say(`- Open set: ${opts.enrolled} enrolled voices drawn ${opts.draws} times; every other speaker's segments must stay unknown.`);
  say(ix.cohort.length
    ? `- AS-norm cohort: ${ix.cohort.length} utterance prints of ${new Set(plan.jobs.filter((j) => j.role === 'cohort').map((j) => j.spk)).size} other speakers, top ${opts.top || 'all'}.`
    : '- No AS-norm cohort (--cohort): the AS-norm columns repeat raw cosine.');
  const voices = plan.speakers.filter((s) => s.voice);
  if (voices.length) say(`- App voices: ${voices.map((s) => `${s.spk} (${s.speechSeconds.toFixed(0)} s)`).join(', ')}; each half enrolls once (~${(voices[0].speechSeconds / 2).toFixed(0)} s).`);
  say();

  const results = new Map();
  for (const m of models) {
    const r = {};
    for (const norm of [false, true]) {
      const score = scorer(m, ix.cohort, opts.top, norm);
      const byEnroll = {};
      for (const e of ENROLL_SECONDS) byEnroll[e] = evaluate(score, ix, e, sets);
      r[norm ? 'asnorm' : 'raw'] = { score, byEnroll };
    }
    results.set(m.model, r);
  }

  const meanEer = (res) => SEGMENT_SECONDS.reduce((n, s) => n + res.perLength[s].eer, 0) / SEGMENT_SECONDS.length;
  for (const norm of ['raw', 'asnorm']) {
    say(`## ${norm === 'raw' ? 'Models, raw cosine (as the app scores now)' : 'Models with AS-norm'}: enrollment ${MAIN_ENROLL} s`);
    say();
    const rows = [];
    for (const m of models) {
      const res = results.get(m.model)[norm].byEnroll[MAIN_ENROLL];
      for (const s of SEGMENT_SECONDS) {
        const p = res.perLength[s];
        const at = p.curve.at(res.theta);
        rows.push([s === SEGMENT_SECONDS[0] ? `${label(m.model)} (θ ${num(res.theta, 2)})` : '', `${s} s`, pct2(p.eer), pct(at.acc), pct(at.wrong),
          pct(at.falseName), num(p.genP5), num(p.impP99), num(p.margin), num(p.dprime, 2)]);
      }
      rows.push(['', 'mean', pct2(meanEer(res)), '', '', '', '', '', '', '']);
    }
    say(table(['Model (best θ)', 'Segment', 'EER', 'ID accuracy', 'wrong name', 'false name', 'genuine P5', 'impostor P99', 'margin', 'd′'], rows));
    say();
    say('Threshold choice (one threshold for all lengths):');
    say();
    say(table(['Model', 'best θ', 'balanced error', `θ for ≤ ${pct(FALSE_NAME_TARGET)} false names`, ...SEGMENT_SECONDS.map((s) => `ID acc / false name ${s} s there`),
      `best θ per length (${SEGMENT_SECONDS.join(' / ')} s)`, 'balanced error with those'],
    models.map((m) => {
      const res = results.get(m.model)[norm].byEnroll[MAIN_ENROLL];
      return [label(m.model), num(res.theta, 2), pct(res.balancedError), num(res.safe, 2),
        ...SEGMENT_SECONDS.map((s) => {
          const at = res.perLength[s].curve.at(res.safe);
          return `${pct(at.acc)} / ${pct(at.falseName)}`;
        }),
        res.eachTheta.map((t) => num(t, 2)).join(' / '), pct(res.eachError)];
    })));
    say();
  }

  const current = models.find((m) => label(m.model).includes('current'));
  if (current) {
    const base = results.get(current.model).raw.byEnroll[MAIN_ENROLL];
    const interval = ({ diff, lo, hi }) => `${(100 * diff).toFixed(2)} [${(100 * lo).toFixed(2)}, ${(100 * hi).toFixed(2)}]`;
    say(`## Mean EER over the three lengths, with paired bootstrap 95 % intervals over test speakers (points; enrollment ${MAIN_ENROLL} s)`);
    say();
    say(table(['Model', 'raw', 'AS-norm', 'AS-norm − raw', 'raw − current', 'AS-norm − current raw'], models.map((m) => {
      const raw = results.get(m.model).raw.byEnroll[MAIN_ENROLL];
      const norm = results.get(m.model).asnorm.byEnroll[MAIN_ENROLL];
      return [label(m.model), pct2(meanEer(raw)), pct2(meanEer(norm)), interval(bootstrapEer(norm, raw)),
        m === current ? '' : interval(bootstrapEer(raw, base)), interval(bootstrapEer(norm, base))];
    })));
    say();
  }
  if (current) {
    const res = results.get(current.model).raw.byEnroll[MAIN_ENROLL];
    say(`The app today (${label(current.model)}, raw cosine, threshold ${config.speakerThreshold}): `
      + SEGMENT_SECONDS.map((s) => {
        const at = res.perLength[s].curve.at(config.speakerThreshold);
        return `${s} s: ${pct(at.acc)} named correctly, ${pct(at.falseName)} false names`;
      }).join('; ') + '.');
    say();
  }

  say(`## Raw cosine at fixed thresholds: ID accuracy / false names (enrollment ${MAIN_ENROLL} s)`);
  say();
  say(table(['Model', 'θ', ...SEGMENT_SECONDS.map((s) => `${s} s`)], models.filter((m) => !label(m.model).includes('as shipped')).flatMap((m) => {
    const res = results.get(m.model).raw.byEnroll[MAIN_ENROLL];
    return [0.5, 0.55, 0.6, 0.65].map((t, k) => [k ? '' : label(m.model), t.toFixed(2), ...SEGMENT_SECONDS.map((s) => {
      const at = res.perLength[s].curve.at(t);
      return `${pct(at.acc)} / ${pct(at.falseName)}`;
    })]);
  })));
  say();

  const best = opts.best || models.reduce((a, b) => (meanEer(results.get(b.model).asnorm.byEnroll[MAIN_ENROLL])
    < meanEer(results.get(a.model).asnorm.byEnroll[MAIN_ENROLL]) ? b : a)).model;
  say(`## Enrollment length: ${label(best)}`);
  say();
  const rows = [];
  for (const e of ENROLL_SECONDS) {
    for (const s of SEGMENT_SECONDS) {
      const cells = ['raw', 'asnorm'].flatMap((norm) => {
        const res = results.get(best)[norm].byEnroll[e];
        const at = res.perLength[s].curve.at(res.theta);
        return [pct2(res.perLength[s].eer), pct(at.acc), pct(at.falseName), s === SEGMENT_SECONDS[0] ? num(res.theta, 2) : ''];
      });
      rows.push([s === SEGMENT_SECONDS[0] ? `${e} s` : '', `${s} s`, ...cells]);
    }
  }
  say(table(['Enrollment', 'Segment', 'EER', 'ID acc', 'false name', 'best θ', 'EER AS-norm', 'ID acc AS-norm', 'false name AS-norm', 'best θ AS-norm'], rows));
  say();

  if (ix.cohort.length) {
    say(`## AS-norm cohort size: ${label(best)}, enrollment ${MAIN_ENROLL} s`);
    say();
    say(table(['top', ...SEGMENT_SECONDS.map((s) => `EER ${s} s`)], [25, 50, 100, 200, 400, 0].map((top) => {
      const res = evaluate(scorer(models.find((m) => m.model === best), ix.cohort, top, true), ix, MAIN_ENROLL, sets.slice(0, 1));
      return [top || `all (${ix.cohort.length})`, ...SEGMENT_SECONDS.map((s) => pct2(res.perLength[s].eer))];
    })));
    say();
  }

  if (voices.length) {
    say('## The app\'s enrolled voices (each half of a recording enrolls once; θ from the eval data above)');
    say();
    const vrows = [];
    for (const m of models) {
      for (const norm of ['raw', 'asnorm']) {
        const { score, byEnroll } = results.get(m.model)[norm];
        const theta = byEnroll[MAIN_ENROLL].theta;
        const v = evaluateVoices(score, ix, theta);
        for (const s of SEGMENT_SECONDS) {
          const x = v[s];
          vrows.push([s === SEGMENT_SECONDS[0] ? `${label(m.model)}${norm === 'asnorm' ? ', AS-norm' : ''}` : '', `${s} s`, x.n, num(x.genMin), num(x.genP5),
            num(x.impMax), num(x.genMin - x.impMax), pct(x.eer), s === SEGMENT_SECONDS[0] ? num(theta, 2) : '', pct(x.acc), pct(x.falseName)]);
        }
      }
    }
    say(table(['Model', 'Segment', 'segments', 'genuine min', 'genuine P5', 'impostor max', 'min − max', 'EER', 'θ', 'ID acc', 'false name'], vrows));
    say();
  }

  say(`## Splitting an utterance: its two 3 s halves vs. halves of different speakers (raw cosine; the app splits below ${CHANGE_MAX_SIMILARITY})`);
  say();
  const halves = new Map(models.map((m) => [m.model, evaluateHalves(m, ix)]));
  const ref = current && halves.get(current.model);
  const refSplit = ref ? below(ref.same, CHANGE_MAX_SIMILARITY) / ref.same.length : NaN;
  say(table(['Model', 'same speaker P5', 'different P95', 'EER', `false splits at ${CHANGE_MAX_SIMILARITY}`, `missed changes at ${CHANGE_MAX_SIMILARITY}`,
    `value with ${pct(refSplit)} false splits`, 'missed changes there'], models.map((m) => {
    const { same, diff } = halves.get(m.model);
    const value = quantile(same, refSplit);
    return [label(m.model), num(quantile(same, 0.05)), num(quantile(diff, 0.95)), pct(equalError(same, diff).eer),
      pct(below(same, CHANGE_MAX_SIMILARITY) / same.length), pct(atLeast(diff, CHANGE_MAX_SIMILARITY) / diff.length), num(value, 2),
      pct(atLeast(diff, value) / diff.length)];
  })));
  say();

  if (Object.keys(timing).length) {
    const appThreads = Math.min(2, config.threads);
    say(`## CPU per voice print (median of ${TIMING_RUNS}; the app gives the speaker model min(2, THREADS) = ${appThreads} threads, THREADS = ${config.threads})`);
    say();
    say(table(['Model', 'file', 'dim', ...SEGMENT_SECONDS.map((s) => `${s} s, ${appThreads} thr`), `3 s, ${config.threads} thr`, 'per 0.5 s window (1.5 s print)', 'share of real time'],
      models.filter((m) => timing[m.model]).map((m) => {
        const t = timing[m.model];
        return [label(m.model), `${t.fileMB.toFixed(0)} MB`, m.dim, ...SEGMENT_SECONDS.map((s) => `${t[appThreads][s].toFixed(1)} ms`),
          `${t[config.threads][3].toFixed(1)} ms`, `${t[appThreads][1.5].toFixed(1)} ms`, pct(t[appThreads][1.5] / 500)];
      })));
    say();
  }
  console.log(lines.join('\n'));
}

/**
 * WeSpeaker models expect fbank features minus their mean over time (CMN), but the files of the
 * sherpa-onnx release lack the metadata that makes sherpa-onnx do it (feature_normalize_type), so
 * their voice prints depend on loudness. This writes a copy (--out) with the entry
 * feature_normalize_type=global-mean appended: a repeated protobuf field (ModelProto.metadata_props,
 * field 14) may be appended to the end of the serialized model.
 */
function addCmn(opts) {
  const varint = (n) => {
    const bytes = [];
    for (; n > 127; n >>>= 7) bytes.push((n & 127) | 128);
    return [...bytes, n];
  };
  const field = (tag, data) => Buffer.from([tag, ...varint(data.length), ...data]);
  const entry = Buffer.concat([field(0x0a, Buffer.from('feature_normalize_type')), field(0x12, Buffer.from('global-mean'))]);
  fs.writeFileSync(opts.out, Buffer.concat([fs.readFileSync(opts.model[0]), field(0x72, entry)]));
}

const COMMANDS = { prepare, embed: embedAll, time: timeModels, report, cmn: addCmn };

try {
  const opts = parseArgs(process.argv.slice(2));
  if (!COMMANDS[opts.command]) throw new Error('Usage: bench-speaker.js prepare|embed|time|report ... (see the top of the file).');
  COMMANDS[opts.command](opts);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
