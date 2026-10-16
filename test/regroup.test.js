'use strict';

// Speakers decided per recording (src/regroup.js), on voice prints made of a few directions.

const test = require('node:test');
const assert = require('node:assert');
const { regroupSpeakers } = require('../src/regroup');
const { l2normalize, cosine } = require('../src/speech/engine');

/** A voice print in direction `dir` (0, 1, 2, ...) of 8, slightly bent by `noise`. */
const print = (dir, noise = 0) => {
  const v = new Float32Array(8);
  v[dir] = 1;
  v[(dir + 1) % 8] = noise;
  return l2normalize(v);
};
const voice = (id, score = 0.8) => ({ kind: 'voice', id, score });
const unknown = (n) => ({ kind: 'unknown', id: `u${n}`, label: `Speaker ${n}` });
const line = (speaker, embedding, seconds = 3) => ({ speaker, embedding, seconds });

/** Saved voices: id -> enrollment print; a match counts from 0.6, as in the app. */
const voices = (enrolled) => ({
  identify(e) {
    const scores = Object.entries(enrolled).map(([id, p]) => ({ voiceId: Number(id), score: cosine(e, p) }))
      .sort((a, b) => b.score - a.score);
    const best = scores[0];
    return { voiceId: best && best.score >= 0.6 ? best.voiceId : null, score: best ? best.score : 0, scores };
  },
});

const names = (speakers) => speakers.map((s) => (s.kind === 'voice' ? `v${s.id}` : s.label));

test('one person split into two unknown speakers becomes one, numbered from 1', () => {
  const lines = [
    line(unknown(2), print(3)),
    line(unknown(2), print(3, 0.1)),
    line(unknown(5), print(3, 0.2)),
    line(unknown(5), print(3, 0.15)),
    line(unknown(7), print(5)), // someone else
    line(unknown(7), print(5, 0.1)),
  ];
  assert.deepStrictEqual(names(regroupSpeakers(lines, voices({}))), ['Speaker 1', 'Speaker 1', 'Speaker 1', 'Speaker 1', 'Speaker 2', 'Speaker 2']);
});

test('lines of an enrolled person that missed the threshold join that voice', () => {
  // In this recording Anna sounds like direction 1 bent toward 2; her enrollment is plain direction 1.
  const lines = [
    line(voice(1), print(1, 0.6)),
    line(voice(1), print(1, 0.7)),
    line(unknown(1), print(1, 0.9)), // scored below 0.6 alone, but sounds like her other lines
    line(unknown(1), print(1, 0.95)),
  ];
  assert.deepStrictEqual(names(regroupSpeakers(lines, voices({ 1: print(1) }))), ['v1', 'v1', 'v1', 'v1']);
});

test('an unknown speaker whose average matches a saved voice gets its name', () => {
  // Each line alone below 0.6 against the enrollment (direction 4); the average of both is above.
  const a = l2normalize(Float32Array.of(0, 0, 0, 0, 1, 1.3, 0, -0.5));
  const b = l2normalize(Float32Array.of(0, 0, 0, 0, 1, -0.5, 0, 1.3));
  assert.ok(cosine(a, print(4)) < 0.6 && cosine(b, print(4)) < 0.6);
  const after = regroupSpeakers([line(unknown(1), a), line(unknown(1), b)], voices({ 9: print(4) }));
  assert.deepStrictEqual(names(after), ['v9', 'v9']);
  assert.ok(after[0].score >= 0.6, 'the average match is the score');
});

test('a line clearly more like another speaker moves there', () => {
  const lines = [
    line(voice(1), print(0)),
    line(voice(1), print(0, 0.1)),
    line(voice(1), print(6, 0.1)), // named Anna, but sounds like the unknown speaker below
    line(voice(1), print(0, 0.2)),
    line(unknown(1), print(6)),
    line(unknown(1), print(6, 0.2)),
  ];
  assert.deepStrictEqual(names(regroupSpeakers(lines, voices({}))), ['v1', 'v1', 'Speaker 1', 'v1', 'Speaker 1', 'Speaker 1']);
});

test('two saved voices are never merged, however alike they sound in a recording', () => {
  const alike = l2normalize(Float32Array.of(0.8, 0.6, 0, 0, 0, 0, 0, 0)); // 0.8 similar to direction 0
  const lines = [line(voice(1), print(0)), line(voice(1), print(0, 0.05)), line(voice(2), alike), line(voice(2), alike)];
  assert.deepStrictEqual(names(regroupSpeakers(lines, voices({}))), ['v1', 'v1', 'v2', 'v2']);
});

test('lines without a voice print follow their speaker; regrouping can be turned off', () => {
  const lines = [
    line(unknown(3), print(2)),
    line(unknown(3), null, 0.8), // too short for a print
    line(unknown(4), print(2, 0.1)),
    line({ kind: 'unknown', id: null, label: '?' }, null, 0.5),
  ];
  assert.deepStrictEqual(names(regroupSpeakers(lines, voices({}))), ['Speaker 1', 'Speaker 1', 'Speaker 1', '?']);
  assert.deepStrictEqual(regroupSpeakers(lines, voices({}), { mergeSimilarity: 0 }), lines.map((l) => l.speaker));
  assert.deepStrictEqual(regroupSpeakers([], voices({})), []);
});
