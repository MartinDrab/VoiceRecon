import {
  api, h, icon, toast, initPage, formatDuration, formatDateTime, transcriptTitle, statusBadge, snippetNodes, speakerColor,
  t, plural, speakerLabel,
} from './common.js';
import { transcribeFile } from './transcribe-file.js';

/** Elements by id; typed loosely because the pages read form fields, dialogs and buttons alike. */
const $ = (id) => /** @type {any} */ (document.getElementById(id));
const PAGE = 30;
const initial = new URLSearchParams(location.search);
let query = initial.get('q') || '';
// voice: a voice id; from, to: days (YYYY-MM-DD), both included. Kept in the address like the query.
const filters = { voice: initial.get('voice') || '', from: initial.get('from') || '', to: initial.get('to') || '' };
let voices = [];
let shown = [];
let total = 0;
let requestNo = 0;
let refreshTimer = null;

const filtered = () => Boolean(filters.voice || filters.from || filters.to);
const voiceName = () => (voices.find((v) => String(v.id) === filters.voice) || { name: '' }).name;

/** The query and filters, as this page's address keeps them (and a transcript's back link). */
function pageParams() {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  return params;
}

/** A day (YYYY-MM-DD) as the time its local midnight is, in ms; `next`: the midnight after it. */
function dayStart(day, next = false) {
  const d = new Date(`${day}T00:00`);
  if (next) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function item(tr) {
  const params = pageParams();
  const href = (lineId) => {
    const p = new URLSearchParams(params);
    if (lineId) p.set('line', lineId);
    const qs = p.toString();
    return `/history/${tr.id}${qs ? `?${qs}` : ''}`;
  };
  const meta = [formatDateTime(tr.startedAt), formatDuration(tr.duration), plural(tr.lines, '{n} line', '{n} lines')];
  if (tr.user) meta.push(t('by {user}', { user: tr.user }));
  // How many lines matched: a search shows them beyond the three snippets; a speaker alone, always.
  if (query && tr.hits > 3) meta.push(plural(tr.hits, '{n} matching line', '{n} matching lines'));
  else if (filters.voice && !query) meta.push(plural(tr.hits, '{name}: {n} line', '{name}: {n} lines', { name: voiceName() }));
  const body = tr.snippets
    ? tr.snippets.map((s) => h('a.snippet', { href: href(s.lineId) }, snippetNodes(s.text)))
    : [h('p.preview', {}, tr.preview || t('No lines yet.'))];
  return h('article.card.history-item', {},
    h('a.history-title', { href: href() }, transcriptTitle(tr)),
    h('div.muted.small', {}, meta.join(' · '), statusBadge(tr)),
    h('div.chips', {}, tr.speakers.slice(0, 8).map((s) => h('span.chip', { style: { '--c': speakerColor(s) } }, speakerLabel(s.name)))),
    ...body);
}

function render() {
  $('list').replaceChildren(...shown.map(item));
  if (!shown.length) {
    let empty = h('p', {}, t('Nothing saved yet. Transcripts appear here once something has been said on the Transcript page.'));
    if (filtered()) empty = h('p', {}, t('No transcript matches these filters.'));
    if (query) empty = h('p', {}, t('No transcript contains all of these words.'));
    $('list').append(h('div.card.empty-state', {}, empty));
  }
  $('note').textContent = query || filtered() ? plural(total, '{n} transcript found.', '{n} transcripts found.') : '';
  $('clear-filters').classList.toggle('hidden', !filtered());
  $('more').classList.toggle('hidden', shown.length >= total);
  // Transcripts that are still being recorded or transcribed are kept up to date.
  clearTimeout(refreshTimer);
  if (shown.some((x) => x.recording)) refreshTimer = setTimeout(() => load({ refresh: true }), 3000);
}

/** @param {{ append?: boolean, refresh?: boolean }} [options] refresh reloads what is shown */
async function load({ append = false, refresh = false } = {}) {
  const no = ++requestNo;
  const limit = refresh ? Math.min(100, Math.max(PAGE, shown.length)) : PAGE;
  const params = new URLSearchParams({ limit: String(limit), offset: String(append ? shown.length : 0) });
  if (query) params.set('q', query);
  if (filters.voice) params.set('voice', filters.voice);
  if (filters.from) params.set('from', String(dayStart(filters.from)));
  if (filters.to) params.set('to', String(dayStart(filters.to, true)));
  try {
    const r = await api(`/transcripts?${params}`);
    if (no !== requestNo) return; // a newer search is on its way
    shown = append ? shown.concat(r.transcripts) : r.transcripts;
    total = r.total;
    render();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/** Shows the list for the current query and filters, and keeps them in the address. */
function update() {
  const url = new URL(location.href);
  url.search = pageParams().toString();
  history.replaceState(null, '', url);
  load();
}

let timer = null;
$('search').value = query;
$('search').addEventListener('input', (e) => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    query = e.target.value.trim();
    update();
  }, 250);
});

// ---------- filters ----------

// From the address: a voice id and days, or nothing (a mistyped link is not sent to the server).
if (!/^\d+$/.test(filters.voice)) filters.voice = '';
const days = /^\d{4}-\d{2}-\d{2}$/;
if (!days.test(filters.from)) filters.from = '';
if (!days.test(filters.to)) filters.to = '';
$('from-filter').value = filters.from;
$('to-filter').value = filters.to;
$('voice-filter').addEventListener('change', (e) => {
  filters.voice = e.target.value;
  update();
});
for (const [key, id] of [['from', 'from-filter'], ['to', 'to-filter']]) {
  $(id).addEventListener('change', (e) => {
    filters[key] = days.test(e.target.value) ? e.target.value : '';
    update();
  });
}
$('clear-filters').addEventListener('click', () => {
  Object.assign(filters, { voice: '', from: '', to: '' });
  $('voice-filter').value = '';
  $('from-filter').value = '';
  $('to-filter').value = '';
  update();
});

async function loadVoices() {
  voices = (await api('/voices')).voices;
  $('voice-filter').replaceChildren($('voice-filter').firstElementChild, ...voices.map((v) => h('option', { value: String(v.id) }, v.name)));
  if (!voices.some((v) => String(v.id) === filters.voice)) filters.voice = ''; // e.g. deleted since
  $('voice-filter').value = filters.voice;
}
$('more').addEventListener('click', () => load({ append: true }));

// ---------- transcribing a file ----------

$('upload-btn').replaceChildren(icon('upload'), t('Transcribe a file'));
$('upload-btn').addEventListener('click', () => transcribeFile());

initPage('history').then(loadVoices).then(() => load()).catch((err) => toast(err.message, { error: true }));
