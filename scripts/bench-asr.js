'use strict';

/**
 * Compares speech models on a test set with references, e.g. the Czech test split of FLEURS:
 * word error rate (with and without accents) and real-time factor at the app's THREADS setting.
 * Each utterance is recognized alone, offline, with the 0.3 s of trailing silence the app adds to
 * final results; no hotwords. This measures the models, not the app's pipeline (VAD, context for
 * short utterances, speaker splits): use `npm run evaluate` for that.
 *
 *   node scripts/bench-asr.js <data folder> --variant <name> [--models <folder>] [--limit <n>] [--out <folder>]
 *   node scripts/bench-asr.js --table [--out <folder>]
 *
 * The data folder holds test.tsv (FLEURS columns: id, file name, raw transcription, ...) and the
 * WAV files in test/. Models other than the app's own int8 Parakeet are looked up in --models
 * (default %TEMP%/cs-bench/models). Results go to --out (default: the data folder's results/), one JSONL
 * line per utterance, so an interrupted run continues where it stopped; --table prints all
 * variants measured there as a Markdown table.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const sherpa = require('sherpa-onnx-node');
const config = require('../src/config');
const { decodeWav, resample } = require('../src/audio');
const { normalizeWords, align } = require('../src/evaluation');

const SAMPLE_RATE = 16000;
const TAIL_SILENCE = 0.3; // seconds of zeros after each utterance, as in transcriber.js

const FP32_DIR = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3';

/** Parakeet with the encoder and the decoder + joiner each in int8 (the app's files) or fp32 (--models). */
const parakeet = (encoder, decoderJoiner, decodingMethod, maxActivePaths) => ({
  kind: 'transducer',
  precision: encoder === decoderJoiner ? encoder : `encoder ${encoder}, decoder+joiner ${decoderJoiner}`,
  files: { encoder, decoder: decoderJoiner, joiner: decoderJoiner },
  decodingMethod,
  maxActivePaths,
});

const VARIANTS = {
  'parakeet-int8-beam4': parakeet('int8', 'int8', 'modified_beam_search', 4), // the app's current setting
  'parakeet-int8-beam8': parakeet('int8', 'int8', 'modified_beam_search', 8),
  'parakeet-int8-greedy': parakeet('int8', 'int8', 'greedy_search', 1),
  'parakeet-fp32-beam4': parakeet('fp32', 'fp32', 'modified_beam_search', 4),
  'parakeet-fp32-greedy': parakeet('fp32', 'fp32', 'greedy_search', 1),
  'parakeet-fp32enc-beam4': parakeet('fp32', 'int8', 'modified_beam_search', 4),
  'parakeet-fp32enc-greedy': parakeet('fp32', 'int8', 'greedy_search', 1),
  'parakeet-int8enc-beam4': parakeet('int8', 'fp32', 'modified_beam_search', 4),
  'canary-1b-v2-int8': { kind: 'canary', dir: 'canary-1b-v2-int8', precision: 'int8', decodingMethod: 'greedy_search' },
  // The decoder patched to take its position from its cache length, as NeMo does (sherpa-onnx 1.13.8
  // passes 1, 2, ... for generated tokens, which overlap the 9 prompt positions).
  'canary-1b-v2-int8-abspos': {
    kind: 'canary', dir: 'canary-1b-v2-int8', decoder: 'decoder.int8.abspos.onnx', precision: 'int8', decodingMethod: 'greedy_search',
  },
};

function parseArgs(argv) {
  const opts = { models: path.join(os.tmpdir(), 'cs-bench', 'models') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value.`);
      return argv[++i];
    };
    if (a === '--variant') opts.variant = value();
    else if (a === '--models') opts.models = value();
    else if (a === '--out') opts.out = value();
    else if (a === '--limit') opts.limit = Number(value());
    else if (a === '--table') opts.table = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.`);
    else if (!opts.dir) opts.dir = a;
    else throw new Error(`Unexpected argument ${a}.`);
  }
  return opts;
}

/**
 * sherpa-onnx 1.13.8 knows only en/es/de/fr as Canary languages (newer versions read them from
 * the vocabulary) and silently falls back to English for any other. A copy of tokens.txt with
 * <|cs|> and <|es|> swapped makes "es" select Czech in both.
 */
function czechAsSpanishTokens(tokensFile) {
  const file = path.join(path.dirname(tokensFile), 'tokens-cs-as-es.txt');
  const swap = { '<|cs|>': '<|es|>', '<|es|>': '<|cs|>' };
  const lines = fs.readFileSync(tokensFile, 'utf8').split('\n').map((line) => {
    const i = line.lastIndexOf(' ');
    const piece = line.slice(0, i);
    return swap[piece] ? `${swap[piece]}${line.slice(i)}` : line;
  });
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

function createRecognizer(variant, modelsDir) {
  const threads = config.threads;
  if (variant.kind === 'canary') {
    const dir = path.join(modelsDir, variant.dir);
    return new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 128 },
      modelConfig: {
        canary: {
          encoder: path.join(dir, 'encoder.int8.onnx'),
          decoder: path.join(dir, variant.decoder || 'decoder.int8.onnx'),
          srcLang: 'es', // = Czech, see czechAsSpanishTokens()
          tgtLang: 'es',
          usePnc: 1,
        },
        tokens: czechAsSpanishTokens(path.join(dir, 'tokens.txt')),
        numThreads: threads,
        debug: 0,
      },
    });
  }
  const file = (name, precision) => (precision === 'int8' ? config.asr[name] : path.join(modelsDir, FP32_DIR, `${name}.onnx`));
  const files = Object.fromEntries(Object.entries(variant.files).map(([name, precision]) => [name, file(name, precision)]));
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: files,
      tokens: config.asr.tokens, // the fp32 package's tokens.txt is identical
      numThreads: threads,
      modelType: 'nemo_transducer',
      debug: 0,
    },
    decodingMethod: variant.decodingMethod,
    maxActivePaths: variant.maxActivePaths,
  });
}

/** FLEURS test.tsv: id, file name, raw transcription, normalized transcription, ... */
function readTestSet(dir) {
  return fs.readFileSync(path.join(dir, 'test.tsv'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, file, raw] = line.split('\t');
    return { id, file, reference: raw };
  });
}

function loadAudio(file) {
  const { samples, sampleRate } = decodeWav(fs.readFileSync(file));
  const audio = sampleRate === SAMPLE_RATE ? samples : resample(samples, sampleRate, SAMPLE_RATE);
  const padded = new Float32Array(audio.length + Math.round(TAIL_SILENCE * SAMPLE_RATE));
  padded.set(audio);
  return { samples: padded, seconds: audio.length / SAMPLE_RATE };
}

function recognize(recognizer, samples) {
  const start = performance.now();
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  return { result, seconds: (performance.now() - start) / 1000 };
}

/** Corpus word error rate: all substitutions, deletions and insertions over all reference words. */
function wer(rows, accents) {
  let errors = 0;
  let words = 0;
  for (const row of rows) {
    const ref = normalizeWords(row.reference, { accents });
    const hyp = normalizeWords(row.text, { accents });
    errors += align(ref, hyp).filter((o) => o.op !== 'match').length;
    words += ref.length;
  }
  return errors / Math.max(1, words);
}

function summarize(name, rows, extra) {
  const audio = rows.reduce((s, r) => s + r.audioSeconds, 0);
  const decode = rows.reduce((s, r) => s + r.decodeSeconds, 0);
  return {
    variant: name,
    utterances: rows.length,
    audioHours: audio / 3600,
    wer: wer(rows, true),
    werNoAccents: wer(rows, false),
    rtf: decode / audio,
    threads: config.threads,
    ...extra,
  };
}

const pct = (x) => `${(100 * x).toFixed(2)} %`;

function printTable(outDir) {
  const order = Object.keys(VARIANTS);
  const results = fs.readdirSync(outDir).filter((f) => f.endsWith('.summary.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')))
    .sort((a, b) => order.indexOf(a.variant) - order.indexOf(b.variant));
  console.log('| Variant | Utterances | WER | WER without accents | RTF | Load (s) | RSS (MB) | Timestamps |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---|');
  for (const r of results) {
    console.log(`| ${r.variant} | ${r.utterances} | ${pct(r.wer)} | ${pct(r.werNoAccents)} | ${r.rtf.toFixed(3)} | `
      + `${r.loadSeconds.toFixed(1)} | ${r.rssMb} | ${r.timestamps ? 'yes' : 'no'} |`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = opts.out || (opts.dir && path.join(opts.dir, 'results'));
  if (opts.table && outDir) return printTable(outDir);
  const variant = VARIANTS[opts.variant];
  if (!opts.dir || !variant) {
    console.error(`Usage: node scripts/bench-asr.js <data folder> --variant <${Object.keys(VARIANTS).join(' | ')}>`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${opts.variant}.jsonl`);
  const done = new Map();
  if (fs.existsSync(outFile)) {
    for (const line of fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      done.set(row.file, row);
    }
  }
  const items = readTestSet(opts.dir).slice(0, opts.limit || undefined);

  const loadStart = performance.now();
  const recognizer = createRecognizer(variant, opts.models);
  const loadSeconds = (performance.now() - loadStart) / 1000;
  recognize(recognizer, loadAudio(path.join(opts.dir, 'test', items[0].file)).samples); // warm-up, not timed
  let rssMb = Math.round(process.memoryUsage().rss / 2 ** 20);

  const rows = [];
  for (const [i, item] of items.entries()) {
    let row = done.get(item.file);
    if (!row) {
      const audio = loadAudio(path.join(opts.dir, 'test', item.file));
      const { result, seconds } = recognize(recognizer, audio.samples);
      const timestamps = (result.timestamps || []).length > 0;
      row = { ...item, text: (result.text || '').trim(), timestamps, audioSeconds: audio.seconds, decodeSeconds: seconds };
      fs.appendFileSync(outFile, `${JSON.stringify(row)}\n`);
      rssMb = Math.max(rssMb, Math.round(process.memoryUsage().rss / 2 ** 20));
    }
    rows.push(row);
    if ((i + 1) % 50 === 0 || i + 1 === items.length) {
      const s = summarize(opts.variant, rows, {});
      console.log(`${i + 1}/${items.length}  WER ${pct(s.wer)}  without accents ${pct(s.werNoAccents)}  RTF ${s.rtf.toFixed(3)}`);
    }
  }
  const timestamps = rows.some((r) => r.timestamps);
  const summary = summarize(opts.variant, rows, { ...variant, loadSeconds, rssMb, timestamps, sherpa: sherpa.version });
  fs.writeFileSync(path.join(outDir, `${opts.variant}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
