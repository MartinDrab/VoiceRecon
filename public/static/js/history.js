import {
  api, upload, h, icon, toast, initPage, formatDuration, formatDateTime, formatPercent, transcriptTitle, statusBadge,
  snippetNodes, speakerColor, t, plural, speakerLabel,
} from './common.js';
import { wavFromInt16, SAMPLE_RATE } from './audio.js';
import { chooseFileLength } from './file-length.js';

/** Elements by id; typed loosely because the pages read form fields, dialogs and buttons alike. */
const $ = (id) => /** @type {any} */ (document.getElementById(id));
const PAGE = 30;
let query = new URLSearchParams(location.search).get('q') || '';
let shown = [];
let total = 0;
let requestNo = 0;
let refreshTimer = null;
const MAX_HOURS = 4; // as the server accepts (src/uploads.js)

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
    h('div.muted.small', {}, meta.join(' · '), tr.hits > 3 ? ` · ${plural(tr.hits, '{n} matching line', '{n} matching lines')}` : '', statusBadge(tr)),
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

// ---------- transcribing a file ----------

let uploading = null; // AbortController of the file being uploaded

function showUpload(text, fraction) {
  $('upload').classList.remove('hidden');
  $('upload-text').textContent = text;
  $('upload-bar').style.width = `${Math.round(fraction * 100)}%`;
}

function hideUpload() {
  $('upload').classList.add('hidden');
  $('upload-btn').disabled = false;
  uploading = null;
}

/**
 * Uploads a file read by the length dialog (all of it or its first part) and opens the new
 * transcript, which fills in as it is transcribed.
 * @param {import('./file-length.js').ChosenFile} chosen
 */
async function transcribeFile({ file, pcm, seconds }) {
  const controller = new AbortController();
  uploading = controller;
  $('upload-btn').disabled = true;
  try {
    // The recording most likely ended when the file was last written; times count from its start.
    const ended = file.lastModified ? Math.min(file.lastModified, Date.now()) : Date.now();
    const params = new URLSearchParams({ name: file.name, startedAt: String(Math.max(1, ended - Math.round(seconds * 1000))) });
    const uploadingText = (f) => t('Uploading “{name}”… {percent}', { name: file.name, percent: formatPercent(f) });
    showUpload(uploadingText(0), 0);
    const r = await upload(`/transcripts/upload?${params}`, wavFromInt16(pcm, SAMPLE_RATE), {
      signal: controller.signal,
      onProgress: (f) => showUpload(uploadingText(f), f),
    });
    location.href = `/history/${r.id}`;
  } catch (err) {
    if (!controller.signal.aborted) toast(err.message, { error: true });
    if (uploading === controller) hideUpload();
  }
}

$('upload-btn').replaceChildren(icon('upload'), t('Transcribe a file'));
$('upload-btn').addEventListener('click', () => {
  $('upload-input').value = '';
  $('upload-input').click();
});
$('upload-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const chosen = await chooseFileLength([file], {
    title: t('Transcribe a file'),
    action: t('Transcribe'),
    maxSeconds: MAX_HOURS * 3600,
    storeKey: 'voicerecon.transcribeLength',
    defaultLength: 10 * 60,
  });
  if (chosen && chosen.length) transcribeFile(chosen[0]);
});
$('upload-cancel').addEventListener('click', () => {
  if (uploading) uploading.abort();
  hideUpload();
});

initPage('history').then(() => load()).catch((err) => toast(err.message, { error: true }));
