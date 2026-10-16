'use strict';

/**
 * Speakers of a whole recording, decided per speaker instead of per line (uploaded files).
 *
 * While a file is transcribed, every line is named on its own, as in live listening: a line of a
 * few seconds is matched against the saved voices, or else joined to the closest unknown speaker.
 * Once the last line is out, the file is known whole, and the lines of one speaker together give a
 * voice print of minutes of speech, which tells far more reliably who it is:
 *  1. speakers whose prints sound alike are merged: one guest split into "Speaker 2" and
 *     "Speaker 5", or an enrolled person whose lines missed the threshold and became an unknown
 *     speaker (compared with that person's other lines of the same recording: same room, same
 *     microphone). Two saved voices are never merged.
 *  2. a line that sounds clearly more like another speaker than like its own moves there;
 *  3. an unknown speaker whose average matches a saved voice gets that voice's name;
 *  4. unknown speakers are numbered again in the order they first speak.
 * Lines too short for a voice print stay with their speaker and follow it.
 */

const { cosine, l2normalize } = require('./speech/engine');

// Speakers' averages at least this similar are one person (averages of one person in one recording
// score far higher than single lines). On five test conversations of four real speakers (none to all
// of them enrolled), the words credited to the right person rose from 89.4 % to 92.1 % on average at
// 0.5, and to 91.3 % at 0.6; 0.5 was never worse than 0.6 or 0.7. It is also the similarity at
// which a line joins an unknown speaker (JOIN_SIMILARITY in transcriber.js).
const MERGE_SIMILARITY = 0.5;
// A line moves when it is at least this much more similar to another speaker than to its own.
const MOVE_MARGIN = 0.1;
const MIN_SECONDS = 3; // speech a speaker needs before its average counts
const LINE_MIN_SECONDS = 1.5; // shorter lines do not move: their print is too noisy
const LINE_WEIGHT_MAX = 15; // seconds a long line counts for, so one monologue does not drown the rest

const round = (x) => Math.round(x * 1000) / 1000;

/**
 * @param {{ embedding: Float32Array | null | undefined, seconds?: number, speaker: any }[]} lines
 *   in the order spoken; speaker as TranscriptionSession emits it ({ kind: 'voice', id, score } or
 *   { kind: 'unknown', id, label })
 * @param {{ identify(embedding: Float32Array): { voiceId: number | null, score: number, scores?: { voiceId: number, score: number }[] } }} voices
 * @param {{ mergeSimilarity?: number, moveMargin?: number }} [options]
 * @returns {any[]} each line's speaker afterwards, in the same form
 */
function regroupSpeakers(lines, voices, { mergeSimilarity = MERGE_SIMILARITY, moveMargin = MOVE_MARGIN } = {}) {
  if (!mergeSimilarity) return lines.map((l) => l.speaker); // off (npm run evaluate -- --regroup 0)
  const sample = lines.find((l) => l.embedding);
  if (!sample) return lines.map((l) => l.speaker);
  const dim = sample.embedding.length;
  const weight = (l) => (l.embedding ? Math.min(l.seconds || 0, LINE_WEIGHT_MAX) : 0);

  /** @type {Map<string, { key: string, voiceId: number | null, first: number, score: number | null, sum: Float64Array | null, weight: number, print: Float32Array | null }>} */
  const groups = new Map();
  const groupOf = lines.map((l, i) => {
    const sp = l.speaker;
    const key = sp && sp.kind === 'voice' ? `v:${sp.id}` : sp && sp.kind === 'unknown' && sp.id ? `u:${sp.id}` : null;
    if (key && !groups.has(key)) {
      groups.set(key, { key, voiceId: sp.kind === 'voice' ? sp.id : null, first: i, score: null, sum: null, weight: 0, print: null });
    }
    return key;
  });
  const setPrint = (g) => {
    g.print = g.weight >= MIN_SECONDS ? l2normalize(g.sum) : null;
  };
  const sumUp = () => {
    for (const g of groups.values()) {
      g.sum = new Float64Array(dim);
      g.weight = 0;
    }
    lines.forEach((l, i) => {
      const g = groups.get(groupOf[i]);
      const w = weight(l);
      if (!g || !w) return;
      for (let j = 0; j < dim; j++) g.sum[j] += w * l.embedding[j];
      g.weight += w;
    });
    for (const g of groups.values()) setPrint(g);
  };
  const merge = (keep, drop) => {
    for (let i = 0; i < groupOf.length; i++) if (groupOf[i] === drop.key) groupOf[i] = keep.key;
    for (let j = 0; j < dim; j++) keep.sum[j] += drop.sum[j];
    keep.weight += drop.weight;
    keep.first = Math.min(keep.first, drop.first);
    setPrint(keep);
    groups.delete(drop.key);
  };

  // 1. Merge the most similar pair of speakers while it is similar enough.
  sumUp();
  for (;;) {
    const list = [...groups.values()].filter((g) => g.print);
    let best = null;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        if (list[a].voiceId !== null && list[b].voiceId !== null) continue;
        const s = cosine(list[a].print, list[b].print);
        if (s >= mergeSimilarity && (!best || s > best.s)) best = { a: list[a], b: list[b], s };
      }
    }
    if (!best) break;
    // A saved voice keeps its name; of two unknown speakers, the one heard first stays.
    const bFirst = best.b.voiceId !== null || (best.a.voiceId === null && best.b.first < best.a.first);
    if (bFirst) merge(best.b, best.a);
    else merge(best.a, best.b);
  }

  // 2. Lines that sound clearly more like another speaker move there (all decided on the speakers
  // as they are now). A line is compared with its own speaker without itself.
  const moves = [];
  lines.forEach((l, i) => {
    const own = groups.get(groupOf[i]);
    if (!own || !l.embedding || (l.seconds || 0) < LINE_MIN_SECONDS) return;
    let best = null;
    for (const g of groups.values()) {
      if (g === own || !g.print) continue;
      const s = cosine(l.embedding, g.print);
      if (!best || s > best.s) best = { g, s };
    }
    if (!best) return;
    const w = weight(l);
    const rest = own.weight - w;
    // A speaker of little more than this line says nothing about it: move only to a clear match.
    if (rest < MIN_SECONDS) {
      if (best.s >= mergeSimilarity) moves.push([i, best.g.key]);
      return;
    }
    const ownSim = cosine(l.embedding, l2normalize(own.sum.map((x, j) => x - w * l.embedding[j])));
    if (best.s - ownSim >= moveMargin) moves.push([i, best.g.key]);
  });
  for (const [i, key] of moves) groupOf[i] = key;
  for (const g of groups.values()) if (!groupOf.includes(g.key)) groups.delete(g.key);
  sumUp();

  // 3. Unknown speakers whose average matches a saved voice get its name (one who already has
  // lines in this recording takes them in).
  for (const g of [...groups.values()]) {
    if (g.voiceId !== null || !g.print) continue;
    const m = voices.identify(g.print);
    if (m.voiceId === null) continue;
    const named = [...groups.values()].find((x) => x.voiceId === m.voiceId);
    if (named) {
      merge(named, g);
    } else {
      g.voiceId = m.voiceId;
      g.score = m.score;
    }
  }

  // 4. Unknown speakers numbered in the order they first speak.
  const unknown = [...groups.values()].filter((g) => g.voiceId === null).sort((a, b) => a.first - b.first);
  const refs = new Map(unknown.map((g, n) => [g.key, { kind: 'unknown', id: `u${n + 1}`, label: `Speaker ${n + 1}` }]));

  return lines.map((l, i) => {
    const g = groups.get(groupOf[i]);
    if (!g) return l.speaker;
    if (g.voiceId === null) return refs.get(g.key);
    if (l.speaker.kind === 'voice' && l.speaker.id === g.voiceId) return l.speaker;
    if (g.score === null) {
      const m = g.print ? voices.identify(g.print) : null;
      const own = m && m.scores ? m.scores.find((x) => x.voiceId === g.voiceId) : null;
      g.score = own ? own.score : 0;
    }
    return { kind: 'voice', id: g.voiceId, score: round(g.score) };
  });
}

module.exports = { regroupSpeakers, MERGE_SIMILARITY, MOVE_MARGIN };
