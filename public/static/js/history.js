import { api, h, toast, initPage, formatDuration, formatDateTime, transcriptTitle, snippetNodes, speakerColor } from './common.js';

const $ = (id) => document.getElementById(id);
const PAGE = 30;
let query = new URLSearchParams(location.search).get('q') || '';
let shown = [];
let total = 0;
let requestNo = 0;

function item(t) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const href = (lineId) => {
    const p = new URLSearchParams(params);
    if (lineId) p.set('line', lineId);
    const qs = p.toString();
    return `/history/${t.id}${qs ? `?${qs}` : ''}`;
  };
  const meta = [formatDateTime(t.startedAt), formatDuration(t.duration), `${t.lines} line${t.lines === 1 ? '' : 's'}`];
  if (t.user) meta.push(`by ${t.user}`);
  const body = t.snippets
    ? t.snippets.map((s) => h('a.snippet', { href: href(s.lineId) }, snippetNodes(s.text)))
    : [h('p.preview', {}, t.preview || 'No lines yet.')];
  return h('article.card.history-item', {},
    h('a.history-title', { href: href() }, transcriptTitle(t)),
    h('div.muted.small', {}, meta.join(' · '), t.hits > 3 ? ` · ${t.hits} matching lines` : ''),
    h('div.chips', {}, t.speakers.slice(0, 8).map((s) => h('span.chip', { style: { '--c': speakerColor(s) } }, s.name))),
    ...body);
}

function render() {
  $('list').replaceChildren(...shown.map(item));
  if (!shown.length) {
    $('list').append(h('div.card.empty-state', {}, query
      ? h('p', {}, 'No transcript contains all of these words.')
      : h('p', {}, 'Nothing saved yet. Transcripts appear here once something has been said on the Transcript page.')));
  }
  $('note').textContent = query ? `${total} transcript${total === 1 ? '' : 's'} found.` : '';
  $('more').classList.toggle('hidden', shown.length >= total);
}

async function load({ append = false } = {}) {
  const no = ++requestNo;
  const params = new URLSearchParams({ limit: PAGE, offset: append ? shown.length : 0 });
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
