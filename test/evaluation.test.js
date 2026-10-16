'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../src/config');
const { resample } = require('../src/audio');
const { normalizeWords, parseReference, align, score, formatDetails } = require('../src/evaluation');

test('normalizeWords drops punctuation and case, optionally accents', () => {
  assert.deepStrictEqual(normalizeWords('Ahoj, jak se MÁŠ? 3,5 km…'), ['ahoj', 'jak', 'se', 'máš', '3', '5', 'km']);
  assert.deepStrictEqual(normalizeWords('Příliš žluťoučký kůň', { accents: false }), ['prilis', 'zlutoucky', 'kun']);
});

test('parseReference reads "Name: text" turns', () => {
  const turns = parseReference([
    '﻿# comment',
    '[01:58:46 AM] Jirka: Ahoj, jak se máš?',
    '',
    'Klára: Dobře.',
    'A ty?',
    '[10:00:01] Jirka: Taky.',
  ].join('\r\n'));
  assert.deepStrictEqual(turns, [
    { speaker: 'Jirka', text: 'Ahoj, jak se máš?' },
    { speaker: 'Klára', text: 'Dobře. A ty?' },
    { speaker: 'Jirka', text: 'Taky.' },
  ]);
  assert.throws(() => parseReference('no speaker here'), /does not start with "Name:"/);
  assert.throws(() => parseReference('# only a comment'), /empty/);
});

test('align counts substitutions, deletions and insertions', () => {
  const ops = align(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']).map((o) => o.op);
  assert.deepStrictEqual(ops, ['match', 'sub', 'match', 'match', 'ins']);
  assert.deepStrictEqual(align(['a', 'b'], []).map((o) => o.op), ['del', 'del']);
  assert.deepStrictEqual(align([], ['a']).map((o) => o.op), ['ins']);
});

test('align stays exact on long transcripts (banded)', () => {
  const ref = Array.from({ length: 5000 }, (_, i) => `w${i % 97}`);
  const hyp = ref.slice();
  for (let i = 100; i < 5000; i += 100) hyp[i] = 'wrong'; // 49 substitutions
  hyp.splice(2550, 3); // 3 deletions
  hyp.splice(4000, 0, 'extra', 'extra'); // 2 insertions
  const counts = { match: 0, sub: 0, del: 0, ins: 0 };
  for (const o of align(ref, hyp)) counts[o.op]++;
  assert.strictEqual(counts.sub + counts.del + counts.ins, 54);
});

test('score: word error rate and speaker accuracy by name and after mapping', () => {
  const ref = [{ speaker: 'Anna', text: 'jedna dva tři' }, { speaker: 'Bohdan', text: 'čtyři pět' }];
  const hyp = [{ speaker: 'Anna', text: 'jedna dva' }, { speaker: 'Speaker 1', text: 'tři čtyři pět šest' }];
  const r = score(ref, hyp);
  assert.strictEqual(r.wer, 1 / 5); // one extra word
  assert.strictEqual(r.speakerAccuracyByName, 2 / 5); // only Anna's first two words are credited by name
  assert.deepStrictEqual(r.mapping, { Anna: 'Anna', 'Speaker 1': 'Bohdan' });
  assert.strictEqual(r.speakerAccuracyMapped, 4 / 5); // "tři" was still credited to Bohdan's cluster
  assert.deepStrictEqual(r.confusion, { Anna: { Anna: 2 }, 'Speaker 1': { Anna: 1, Bohdan: 2 } });
  assert.strictEqual(r.perSpeaker.Bohdan.ins, 1);
  assert.strictEqual(r.hypTurns, 2);
  assert.match(formatDetails(ref, r), /tři@Speaker 1/);
});

test('speaker names match case-insensitively and accents count in WER', () => {
  const r = score([{ speaker: 'Klára', text: 'Itálii' }], [{ speaker: 'klára', text: 'Italii' }]);
  assert.strictEqual(r.speakerAccuracyByName, 1);
  assert.strictEqual(r.wer, 1);
  assert.strictEqual(r.werNoAccents, 0);
});

test('resample keeps speech frequencies and removes aliasing', () => {
  const gain = (from, f) => {
    const x = Float32Array.from({ length: from * 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / from));
    const y = resample(x, from, 16000);
    assert.strictEqual(y.length, 32000);
    let q = 0;
    for (let i = 1600; i < y.length - 1600; i++) q += y[i] * y[i];
    return Math.sqrt(q / (y.length - 3200)) / (0.5 / Math.SQRT2);
  };
  assert.ok(Math.abs(gain(48000, 1000) - 1) < 0.01);
  assert.ok(Math.abs(gain(44100, 3000) - 1) < 0.01);
  assert.ok(gain(48000, 12000) < 0.01, 'a 12 kHz tone would alias to 4 kHz');
  assert.strictEqual(resample(new Float32Array(5), 16000, 16000).length, 5);
});

const FIXTURES = path.join(__dirname, 'fixtures');
// Skipped without models and test audio, unless VOICERECON_REQUIRE_MODELS=1 (nightly CI): then it fails.
const haveModels = process.env.VOICERECON_REQUIRE_MODELS === '1'
  || (config.modelFiles.every((f) => fs.existsSync(f)) && fs.existsSync(path.join(FIXTURES, 'reference.txt')));

test('evaluate script on the synthetic conversation', { skip: !haveModels && 'models or fixtures missing', timeout: 180000 }, () => {
  const json = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voicerecon-eval-test-')), 'out.json');
  execFileSync(process.execPath, [path.join(config.root, 'scripts', 'evaluate.js'), FIXTURES, '--threshold', '0.3,0.6', '--learn', '0,1', '--json', json],
    { stdio: 'pipe' });
  const out = JSON.parse(fs.readFileSync(json, 'utf8'));
  assert.strictEqual(out.runs.length, 4);
  for (const run of out.runs) {
    assert.strictEqual(run.speakerAccuracyByName, 1, `threshold ${run.params.threshold}`);
    assert.ok(run.wer < 0.3, `WER ${run.wer}`);
    assert.strictEqual(run.refTurns, 7);
  }
});
