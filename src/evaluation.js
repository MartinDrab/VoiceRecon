'use strict';

/**
 * Scoring for scripts/evaluate.js: compares a hand-written reference transcript ("Name: text"
 * per turn) with what VoiceRecon produced. Needs no timestamps: the words of both transcripts
 * are aligned, which gives the word error rate, and every aligned word pair also says whether
 * the right person was credited with it.
 */

const DIAG = 0;
const DEL = 1;
const INS = 2;

const nameKey = (s) => String(s).normalize('NFC').trim().toLowerCase();

/** Lower-cased words without punctuation; optionally without diacritics (é -> e). */
function normalizeWords(text, { accents = true } = {}) {
  let t = String(text).normalize('NFC').toLowerCase();
  if (!accents) t = t.normalize('NFD').replace(/\p{M}/gu, '');
  return t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const TURN_RE = /^([^:.,!?]{1,40}):\s*(.*)$/u;

/**
 * Parses a reference transcript: one turn per line as "Name: text". A "[...]" prefix (the time
 * stamps of VoiceRecon's "Download transcript") is ignored, lines without "Name:" continue the
 * previous turn, and blank lines and lines starting with "#" are skipped.
 */
function parseReference(text) {
  const turns = [];
  String(text).replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim().replace(/^\[[^\]]*\]\s*/, '');
    if (!line || line.startsWith('#')) return;
    const m = TURN_RE.exec(line);
    if (m) turns.push({ speaker: m[1].trim(), text: m[2].trim() });
    else if (turns.length) turns[turns.length - 1].text += ` ${line}`;
    else throw new Error(`Line ${i + 1} of the reference transcript does not start with "Name:".`);
  });
  if (!turns.length) throw new Error('The reference transcript is empty.');
  return turns;
}

/**
 * Levenshtein alignment of two word lists. Returns operations in order:
 * { op: 'match' | 'sub', r, h } | { op: 'del', r } | { op: 'ins', h } (r/h are indexes).
 * Only a diagonal band is computed (both transcripts follow the same conversation), which keeps
 * hour-long recordings at a few tens of megabytes.
 */
function align(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  const longer = Math.max(n, m, 1);
  const width = Math.max(200, Math.ceil(0.15 * longer), Math.ceil((2 * longer) / Math.max(1, Math.min(n, m))));
  const center = (i) => (n === 0 ? 0 : Math.round((i * m) / n));
  const ptrs = new Array(n + 1);
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const lo = Math.max(0, center(i) - width);
    const hi = Math.min(m, center(i) + width);
    const cost = new Float64Array(hi - lo + 1);
    const ptr = new Uint8Array(hi - lo + 1);
    const above = (j) => (prev && j >= prev.lo && j <= prev.hi ? prev.cost[j - prev.lo] : Infinity);
    for (let j = lo; j <= hi; j++) {
      let best;
      let op;
      if (i === 0) {
        best = j;
        op = INS;
      } else {
        best = above(j) + 1;
        op = DEL;
        if (j > 0) {
          const diag = above(j - 1) + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
          if (diag <= best) {
            best = diag;
            op = DIAG;
          }
          const left = j > lo ? cost[j - 1 - lo] + 1 : Infinity;
          if (left < best) {
            best = left;
            op = INS;
          }
        }
      }
      cost[j - lo] = best;
      ptr[j - lo] = op;
    }
    ptrs[i] = { lo, ptr };
    prev = { lo, hi, cost };
  }

  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const op = ptrs[i].ptr[j - ptrs[i].lo];
    if (i > 0 && j > 0 && op === DIAG) {
      ops.push({ op: ref[i - 1] === hyp[j - 1] ? 'match' : 'sub', r: i - 1, h: j - 1 });
      i--;
      j--;
    } else if (i > 0 && (op === DEL || j === 0)) {
      ops.push({ op: 'del', r: i - 1 });
      i--;
    } else {
      ops.push({ op: 'ins', h: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}

function errorCounts(ops) {
  const c = { match: 0, sub: 0, del: 0, ins: 0 };
  for (const o of ops) c[o.op]++;
  return c;
}

/**
 * Maps hypothesis speakers to reference speakers. Voices whose name equals a reference speaker
 * keep that mapping; every other hypothesis speaker (e.g. "Speaker 1") is matched to the unused
 * reference speaker it shares the most words with (greedy, largest overlap first).
 */
function mapSpeakers(contingency, refSpeakers) {
  const mapping = new Map();
  const used = new Set();
  const refByKey = new Map(refSpeakers.map((r) => [nameKey(r), r]));
  for (const h of contingency.keys()) {
    const r = refByKey.get(nameKey(h));
    if (r !== undefined && !used.has(r)) {
      mapping.set(h, r);
      used.add(r);
    }
  }
  const pairs = [];
  for (const [h, row] of contingency) {
    if (mapping.has(h)) continue;
    for (const [r, count] of row) pairs.push({ h, r, count });
  }
  pairs.sort((a, b) => b.count - a.count);
  for (const { h, r } of pairs) {
    if (!mapping.has(h) && !used.has(r)) {
      mapping.set(h, r);
      used.add(r);
    }
  }
  return mapping;
}

/**
 * Scores a hypothesis against the reference.
 * @param refTurns  [{ speaker, text }] from parseReference
 * @param hypLines  [{ speaker, text }] final results, speaker = voice name or e.g. "Speaker 1"
 */
function score(refTurns, hypLines) {
  const ref = [];
  refTurns.forEach((t, turn) => normalizeWords(t.text).forEach((w) => ref.push({ w, speaker: t.speaker, turn })));
  const hyp = [];
  hypLines.forEach((l, line) => normalizeWords(l.text).forEach((w) => hyp.push({ w, speaker: l.speaker, line })));

  const ops = align(ref.map((x) => x.w), hyp.map((x) => x.w));
  const counts = errorCounts(ops);
  const strip = (words) => words.map((x) => normalizeWords(x.w, { accents: false }).join(''));
  const plain = errorCounts(align(strip(ref), strip(hyp)));
  const refSpeakers = [...new Set(refTurns.map((t) => t.speaker))];

  // Who was credited with each reference word that has a counterpart in the hypothesis.
  const contingency = new Map(); // hyp speaker -> Map(ref speaker -> words)
  const perSpeaker = new Map(refSpeakers.map((s) => [s, { words: 0, sub: 0, del: 0, ins: 0, aligned: 0, byName: 0, mapped: 0 }]));
  let lastRefSpeaker = refSpeakers[0];
  for (const o of ops) {
    if (o.op === 'ins') {
      perSpeaker.get(lastRefSpeaker).ins++;
      continue;
    }
    const r = ref[o.r];
    lastRefSpeaker = r.speaker;
    const ps = perSpeaker.get(r.speaker);
    ps.words++;
    if (o.op === 'del') {
      ps.del++;
      continue;
    }
    if (o.op === 'sub') ps.sub++;
    ps.aligned++;
    const h = hyp[o.h].speaker;
    if (!contingency.has(h)) contingency.set(h, new Map());
    const row = contingency.get(h);
    row.set(r.speaker, (row.get(r.speaker) || 0) + 1);
    if (nameKey(h) === nameKey(r.speaker)) ps.byName++;
  }
  const mapping = mapSpeakers(contingency, refSpeakers);
  for (const o of ops) {
    if (o.op === 'match' || o.op === 'sub') {
      if (mapping.get(hyp[o.h].speaker) === ref[o.r].speaker) perSpeaker.get(ref[o.r].speaker).mapped++;
    }
  }

  const aligned = counts.match + counts.sub;
  const sum = (key) => [...perSpeaker.values()].reduce((n, s) => n + s[key], 0);
  const ratio = (a, b) => (b ? a / b : 0);
  const mergedLines = hypLines.filter((l, i) => i === 0 || hypLines[i - 1].speaker !== l.speaker).length;
  return {
    refWords: ref.length,
    hypWords: hyp.length,
    refTurns: refTurns.length,
    hypTurns: mergedLines,
    counts,
    wer: ratio(counts.sub + counts.del + counts.ins, ref.length),
    werNoAccents: ratio(plain.sub + plain.del + plain.ins, ref.length),
    speakerAccuracyByName: ratio(sum('byName'), aligned),
    speakerAccuracyMapped: ratio(sum('mapped'), aligned),
    mapping: Object.fromEntries(mapping),
    perSpeaker: Object.fromEntries([...perSpeaker].map(([s, p]) => [s, {
      ...p,
      wer: ratio(p.sub + p.del + p.ins, p.words),
      accuracyByName: ratio(p.byName, p.aligned),
      accuracyMapped: ratio(p.mapped, p.aligned),
    }])),
    confusion: Object.fromEntries([...contingency].map(([h, row]) => [h, Object.fromEntries(row)])),
    ops,
    ref,
    hyp,
  };
}

/**
 * Word-level differences per reference turn: correct words as they are, "[ref→hyp]" for a
 * substitution, "[-ref]" for a missing word, "[+hyp]" for an extra word, and "@Name" after a
 * word credited to the wrong person (after mapping unknown speakers).
 */
function formatDetails(refTurns, result) {
  const { ops, ref, hyp, mapping } = result;
  const parts = refTurns.map(() => []);
  let turn = 0;
  for (const o of ops) {
    if (o.op !== 'ins') turn = ref[o.r].turn;
    const wrong = o.op === 'match' || o.op === 'sub'
      ? mapping[hyp[o.h].speaker] !== ref[o.r].speaker
      : o.op === 'ins' && mapping[hyp[o.h].speaker] !== refTurns[turn].speaker;
    const who = wrong ? `@${hyp[o.h].speaker}` : '';
    if (o.op === 'match') parts[turn].push(`${hyp[o.h].w}${who}`);
    else if (o.op === 'sub') parts[turn].push(`[${ref[o.r].w}→${hyp[o.h].w}]${who}`);
    else if (o.op === 'del') parts[turn].push(`[-${ref[o.r].w}]`);
    else parts[turn].push(`[+${hyp[o.h].w}]${who}`);
  }
  return refTurns.map((t, i) => `${i + 1}. ${t.speaker}: ${t.text}\n   ${parts[i].join(' ')}`).join('\n\n');
}

module.exports = { normalizeWords, parseReference, align, score, mapSpeakers, formatDetails };
