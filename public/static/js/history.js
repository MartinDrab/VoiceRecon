import {
  api, h, toast, initPage, formatDuration, formatDateTime, transcriptTitle, snippetNodes, speakerColor, t, plural, speakerLabel,
} from './common.js';

/** Elements by id; typed loosely because the pages read form fields, dialogs and buttons alike. */
const $ = (id) => /** @type {any} */ (document.getElementById(id));
const PAGE = 30;
let query = new URLSearchParams(location.search).get('q') || '';
let shown = [];
let total = 0;
let requestNo = 0;

function item(tr) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const href = (lineId) => {
    const p = new URLSearchParams(params);
    if (lineId) p.set('line', lineId);
    const qs = p.toString();
    return `/history/${tr.id}${qs ? `?${qs}` : ''}`;
  };
  const meta = [formatDateTime(tr.startedAt), formatDuration(tr.duration), plural(tr.lines, '{n} line', '{n} lines')];
  if (tr.user) meta.push(t('by {user}', { user: tr.user }));
  const body = tr.snippets
    ? tr.snippets.map((s) => h('a.snippet', { href: href(s.lineId) }, snippetNodes(s.text)))
    : [h('p.preview', {}, tr.preview || t('No lines yet.'))];
  return h('article.card.history-item', {},
    h('a.history-title', { href: href() }, transcriptTitle(tr)),
    h('div.muted.small', {}, meta.join(' · '), tr.hits > 3 ? ` · ${plural(tr.hits, '{n} matching line', '{n} matching lines')}` : ''),
    h('div.chips', {}, tr.speakers.slice(0, 8).map((s) => h('span.chip', { style: { '--c': speakerColor(s) } }, speakerLabel(s.name)))),
    ...body);
}

function render() {
  $('list').replaceChildren(...shown.map(item));
  if (!shown.length) {
    $('list').append(h('div.card.empty-state', {}, query
      ? h('p', {}, t('No transcript contains all of these words.'))
      : h('p', {}, t('Nothing saved yet. Transcripts appear here once something has been said on the Transcript page.'))));
  }
  $('note').textContent = query ? plural(total, '{n} transcript found.', '{n} transcripts found.') : '';
  $('more').classList.toggle('hidden', shown.length >= total);
}

async function load({ append = false } = {}) {
  const no = ++requestNo;
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(append ? shown.length : 0) });
  if (query) params.set('q', query);
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

let timer = null;
$('search').value = query;
$('search').addEventListener('input', (e) => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    query = e.target.value.trim();
    const url = new URL(location.href);
    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    history.replaceState(null, '', url);
    load();
  }, 250);
});
$('more').addEventListener('click', () => load({ append: true }));

initPage('history').then(() => load()).catch((err) => toast(err.message, { error: true }));
