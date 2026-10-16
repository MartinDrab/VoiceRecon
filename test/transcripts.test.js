'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { VoiceManager } = require('../src/voices');
const { TranscriptStore, ftsTerms, srtTime } = require('../src/transcripts');
const { l2normalize } = require('../src/speech/engine');

// Data folders of the tests, deleted when they are done (each test closes its database).
const folders = [];
test.after(() => {
  for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicerecon-transcripts-'));
  folders.push(dataDir);
  const db = openDatabase(dataDir);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('anna', 'x', 'admin'), ('ben', 'x', 'user')").run();
  const voices = new VoiceManager(db, { ready: true, speakerModelName: 'm' }, { dataDir, defaultThreshold: 0.5 });
  voices.init();
  const store = new TranscriptStore(db, voices);
  const jirka = voices.create({ name: 'Jirka', color: '#e5484d' });
  const klara = voices.create({ name: 'Klára', color: '#3e63dd' });
  return { db, voices, store, jirka, klara };
}

const emb = (...xs) => l2normalize(Float32Array.from(xs));

function addLines(store, tid, jirka) {
  const at = Date.UTC(2026, 9, 15, 12, 0, 0);
  const line = (start, speaker, text, embedding) => store.appendLine(tid, {
    start, end: start + 2, spokenAt: at + start * 1000, speaker, text, seconds: 2, embedding, model: 'm',
  });
  return [
    line(1, { voiceId: jirka, key: `v:${jirka}`, label: 'Jirka' }, 'Ahoj, jak se máš?', emb(1, 0, 0)),
    line(4, { voiceId: null, key: 'u:1:u1', label: 'Speaker 1' }, 'Právě jsem se vrátila z dovolené.', emb(0, 1, 0)),
    line(7, { voiceId: null, key: 'u:1:u1', label: 'Speaker 1' }, 'Byli jsme v Itálii u moře.', emb(0, 1, 0.1)),
    line(10, { voiceId: jirka, key: `v:${jirka}`, label: 'Jirka' }, 'To je skvělé.', emb(1, 0.1, 0)),
  ];
}

test('transcripts keep lines, show current voice names and summarize speakers', () => {
  const { db, voices, store, jirka } = setup();
  const t = store.create(1);
  addLines(store, t.id, jirka);
  const s = store.summary(t.id);
  assert.strictEqual(s.lines, 4);
  assert.strictEqual(s.duration, 12);
  assert.strictEqual(s.user, 'anna');
  assert.deepStrictEqual(s.speakers.map((x) => [x.name, x.lines]).sort(), [['Jirka', 2], ['Speaker 1', 2]]);
  assert.strictEqual(s.preview, 'Ahoj, jak se máš?');

  voices.update(jirka, { name: 'Jiří' });
  assert.strictEqual(store.lines(t.id)[0].speaker.name, 'Jiří', 'renaming a voice renames its lines');
  voices.remove(jirka);
  const first = store.lines(t.id)[0].speaker;
  assert.deepStrictEqual([first.name, first.voiceId], ['Jirka', null], 'a deleted voice falls back to the saved name');

  assert.throws(() => store.get(999), /Transcript not found/);
  db.close();
});

test('only the author can continue a transcript from a new live session', () => {
  const { db, store } = setup();
  const t = store.create(1);
  assert.strictEqual(store.resume(t.id, { id: 2 }), null);
  assert.strictEqual(store.resume(t.id, { id: 1 }).sessions, 2);
  assert.strictEqual(store.resume(999, { id: 1 }), null);
  db.close();
});

test('search ignores case and diacritics and returns marked snippets', () => {
  const { db, store, jirka } = setup();
  const a = store.create(1);
  addLines(store, a.id, jirka);
  const b = store.create(2);
  store.rename(b.id, 'Porada o rozpočtu');
  store.appendLine(b.id, { start: 0, end: 1, spokenAt: Date.now(), speaker: { voiceId: null, key: '?', label: '?' }, text: 'Rozpočet na příští rok.' });

  const r = store.list({ q: 'italii MORE' });
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.transcripts[0].id, a.id);
  assert.ok(r.transcripts[0].snippets[0].text.includes('\u0002Itálii\u0003 u \u0002moře\u0003'), 'matches are marked');
  assert.strictEqual(store.list({ q: 'dovol' }).total, 1, 'words match as prefixes');
  const spread = store.list({ q: 'dovolene skvele' });
  assert.strictEqual(spread.total, 1, 'the words may be in different lines');
  assert.strictEqual(spread.transcripts[0].snippets.length, 2);
  assert.strictEqual(store.list({ q: 'dovolene rozpocet' }).total, 0, 'but all in the same transcript');
  assert.strictEqual(store.list({ q: 'rozpoctu' }).total, 1, 'titles are searched too');
  assert.strictEqual(store.list({ q: 'nic takového' }).total, 0);
  assert.strictEqual(store.list({ q: '"*()' }).total, 2, 'a query without words lists everything');
  assert.deepStrictEqual(store.list().transcripts.map((t) => t.id), [b.id, a.id], 'newest first');
  assert.deepStrictEqual(ftsTerms('Ahoj, "světe"* OR'), ['"ahoj"*', '"světe"*', '"or"*']);
  db.close();
});

test('search counts and shows the matching lines of each transcript on the page', () => {
  const { db, store } = setup();
  const speaker = { voiceId: null, key: '?', label: '?' };
  const now = Date.now();
  // Uploaded files are dated when they were recorded, so the newest transcript need not be the last made.
  const ids = [3, 1, 2].map((daysAgo) => store.create(1, { startedAt: now - daysAgo * 86400000 }).id);
  ids.forEach((tid, n) => {
    for (let i = 0; i < 5 + n; i++) {
      store.appendLine(tid, { start: i, end: i + 1, spokenAt: now, speaker, text: `Bod ${i}: rozpočet.` });
    }
  });
  const first = store.list({ q: 'rozpoc', limit: 2 });
  assert.strictEqual(first.total, 3);
  assert.deepStrictEqual(first.transcripts.map((t) => [t.id, t.hits, t.snippets.length]), [[ids[1], 6, 3], [ids[2], 7, 3]]);
  assert.deepStrictEqual(first.transcripts[0].snippets.map((s) => s.text), [0, 1, 2].map((i) => `Bod ${i}: rozpočet.`));
  const second = store.list({ q: 'rozpoc', limit: 2, offset: 2 });
  assert.deepStrictEqual(second.transcripts.map((t) => [t.id, t.hits]), [[ids[0], 5]]);
  db.close();
});

test('lines are moved to other speakers only if no one moved them meanwhile', () => {
  const { db, store, jirka, klara } = setup();
  const t = store.create(1);
  const [a, b] = addLines(store, t.id, jirka).slice(1, 3); // both 'Speaker 1' (u:1:u1)
  store.setSpeaker(t.id, { lineIds: [b] }, { voiceId: klara }); // a user moved one of them
  const to = { voiceId: jirka, key: `v:${jirka}`, label: 'Jirka' };
  assert.strictEqual(store.moveLines(t.id, [{ lineId: a, from: 'u:1:u1', to }, { lineId: b, from: 'u:1:u1', to }]), 1);
  const speakerOf = (id) => store.lines(t.id).find((l) => l.id === id).speaker;
  assert.deepStrictEqual([speakerOf(a).voiceId, speakerOf(b).voiceId], [jirka, klara]);
  db.close();
});

test('editing, moving and deleting lines keeps search up to date', () => {
  const { db, voices, store, jirka, klara } = setup();
  const t = store.create(1);
  const ids = addLines(store, t.id, jirka);

  store.updateText(t.id, ids[0], 'Ahoj, jak se daří?');
  assert.strictEqual(store.list({ q: 'dari' }).total, 1);
  assert.strictEqual(store.list({ q: 'mas' }).total, 0, 'the old text is no longer found');
  assert.strictEqual(store.lines(t.id)[0].edited, true);
  assert.throws(() => store.updateText(t.id, ids[0], '  '), /Delete the line instead/);

  // All lines of the unknown speaker become Klára, and Klára learns how they sounded.
  const rows = store.setSpeaker(t.id, { key: 'u:1:u1' }, { voiceId: klara });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(store.learnFrom(rows, klara, 'm'), 1);
  assert.strictEqual(voices.list().find((v) => v.id === klara).learned.correction, 1);
  assert.strictEqual(store.learnFrom(rows, klara, 'other-model'), 0, 'prints of another model are not used');
  assert.deepStrictEqual(store.lines(t.id).map((l) => l.speaker.name), ['Jirka', 'Klára', 'Klára', 'Jirka']);

  // One line to a typed name.
  store.setSpeaker(t.id, { lineIds: [ids[3]] }, { label: 'Host' });
  const last = store.lines(t.id)[3].speaker;
  assert.deepStrictEqual([last.name, last.key, last.voiceId], ['Host', 'n:host', null]);
  assert.throws(() => store.setSpeaker(t.id, { lineIds: [ids[3]] }, { label: ' ' }), /type a name/);
  assert.throws(() => store.setSpeaker(t.id, { lineIds: [ids[3]] }, { voiceId: 999 }), /Voice not found/);
  assert.throws(() => store.setSpeaker(t.id, { key: 'nobody' }, { label: 'X' }), /Line not found/);

  store.deleteLine(t.id, ids[2]);
  assert.strictEqual(store.list({ q: 'italii' }).total, 0);
  store.remove(t.id);
  assert.strictEqual(store.list({ q: 'dovolene' }).total, 0, 'deleting a transcript removes its lines from search');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM transcript_lines').get().n, 0);
  db.close();
});

test('export as TXT, SRT and JSON', () => {
  const { db, store, jirka } = setup();
  const t = store.create(1);
  addLines(store, t.id, jirka);
  store.rename(t.id, 'Test meeting');

  const txt = store.export(t.id, 'txt');
  assert.match(txt.filename, new RegExp(`^transcript-${t.id}-\\d{4}-\\d{2}-\\d{2}\\.txt$`));
  assert.match(txt.body, /^Test meeting\n/);
  assert.match(txt.body, /\[\d\d:\d\d:\d\d\] Speaker 1: Byli jsme v Itálii u moře\./);

  const srt = store.export(t.id, 'srt').body;
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:03,000\nJirka: Ahoj, jak se máš\?\n\n2\n/);
  assert.strictEqual(srt.match(/-->/g).length, 4);

  const json = JSON.parse(store.export(t.id, 'json').body);
  assert.strictEqual(json.title, 'Test meeting');
  assert.deepStrictEqual(json.lines.map((l) => l.speaker), ['Jirka', 'Speaker 1', 'Speaker 1', 'Jirka']);
  assert.throws(() => store.export(t.id, 'pdf'), /Format must be/);
  assert.strictEqual(srtTime(3723.4567), '01:02:03,457');
  db.close();
});
