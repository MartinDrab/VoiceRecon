import {
  api, h, icon, toast, initPage, formatDuration, formatDateTime, formatClock, transcriptTitle, highlight, speakerColor,
} from './common.js';

/** Elements by id; typed loosely because the pages read form fields, dialogs and buttons alike. */
const $ = (id) => /** @type {any} */ (document.getElementById(id));
const tid = Number(location.pathname.split('/').pop());
const params = new URLSearchParams(location.search);
const query = params.get('q') || '';
let focusLine = Number(params.get('line')) || null;
let me = null;
let transcript = null;
let lines = [];
let voices = [];
let editing = null; // id of the line whose text is being edited
let picking = null; // { lineIds, key, name } for the speaker dialog
let pollTimer = null;

const isLive = () => Boolean(transcript && transcript.recording);

async function load({ onlyIfChanged = false } = {}) {
  const [t, v] = await Promise.all([api(`/transcripts/${tid}`), api('/voices')]);
  const changed = !transcript || t.transcript.updatedAt !== transcript.updatedAt
    || t.transcript.recording !== transcript.recording || JSON.stringify(v.voices) !== JSON.stringify(voices);
  transcript = t.transcript;
  lines = t.lines;
  voices = v.voices;
  if (changed || !onlyIfChanged) {
    renderHeader();
    renderLines();
  }
  if (focusLine) {
    const el = document.getElementById(`line-${focusLine}`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
    }
    focusLine = null;
  }
  clearTimeout(pollTimer);
  // While the transcript is still being recorded, keep it up to date.
  if (isLive()) pollTimer = setTimeout(poll, 5000);
}

function poll() {
  if (editing || $('speaker-dialog').open || document.hidden) {
    pollTimer = setTimeout(poll, 5000);
    return;
  }
  load({ onlyIfChanged: true }).catch(() => {
    pollTimer = setTimeout(poll, 10000);
  });
}

function renderHeader() {
  const title = transcriptTitle(transcript);
  document.title = `${title} · VoiceRecon`;
  if (document.activeElement !== $('title')) $('title').value = transcript.title;
  $('title').placeholder = transcriptTitle({ ...transcript, title: '' });
  const meta = [formatDateTime(transcript.startedAt), formatDuration(transcript.duration), `${transcript.lines} line${transcript.lines === 1 ? '' : 's'}`];
  if (transcript.user) meta.push(`by ${transcript.user}`);
  $('meta').replaceChildren(...[meta.join(' · '), isLive() ? h('span.live-badge', {}, 'still recording') : null].filter(Boolean));
  $('speakers').replaceChildren(...transcript.speakers.map((s) => h('span.chip', { style: { '--c': speakerColor(s) } }, `${s.name} · ${s.lines}`)));
  for (const f of ['txt', 'srt', 'json']) $(`export-${f}`).href = `/api/transcripts/${tid}/export?format=${f}`;
  $('delete').classList.toggle('hidden', !(me.role === 'admin' || me.id === transcript.userId));
  if (query) $('back').href = `/history?q=${encodeURIComponent(query)}`;
}

function renderLines() {
  const container = $('lines');
  if (!lines.length) {
    container.replaceChildren(h('p.muted', {}, 'This transcript has no lines.'));
    return;
  }
  const blocks = [];
  for (const line of lines) {
    const last = blocks[blocks.length - 1];
    if (last && last.key === line.speaker.key) last.lines.push(line);
    else blocks.push({ key: line.speaker.key, speaker: line.speaker, lines: [line] });
  }
  container.replaceChildren(...blocks.map((b) => h('section.hblock', { style: { '--c': speakerColor(b.speaker) } },
    h('button.who', {
      type: 'button',
      title: 'Change who said this',
      onclick: () => openSpeaker(b.lines.map((l) => l.id), b.speaker),
    }, h('span.name', {}, b.speaker.name)),
    b.lines.map(lineRow))));
}

function lineRow(line) {
  const text = line.id === editing
    ? editor(line)
    : h('p.text', {}, highlight(line.text, query), line.edited ? h('span.edited', { title: 'Edited' }, ' (edited)') : null);
  return h('div.hline', { id: `line-${line.id}` },
    h('span.time', { title: new Date(line.spokenAt).toLocaleTimeString() }, formatClock(line.start)),
    text,
    line.id === editing ? null : h('div.hline-actions', {},
      h('button.btn.btn-ghost.btn-icon.btn-sm', { title: 'Change who said this line', onclick: () => openSpeaker([line.id], line.speaker) }, icon('person')),
      h('button.btn.btn-ghost.btn-icon.btn-sm', { title: 'Fix the text', onclick: () => startEdit(line.id) }, icon('edit')),
      h('button.btn.btn-ghost.btn-icon.btn-sm.btn-danger', { title: 'Delete the line', onclick: () => deleteLine(line) }, icon('trash'))));
}

// ---------- editing text ----------

function editor(line) {
  const area = h('textarea.line-editor', { rows: 2, 'aria-label': 'Line text' });
  area.value = line.text;
  const save = async () => {
    try {
      await api(`/transcripts/${tid}/lines/${line.id}`, { method: 'PATCH', body: { text: area.value } });
      editing = null;
      await load();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  const cancel = () => {
    editing = null;
    renderLines();
  };
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      cancel();
    }
  });
  setTimeout(() => {
    area.focus();
    area.style.height = `${area.scrollHeight + 4}px`;
  });
  return h('div.edit-box', {}, area,
    h('div.row', {},
      h('button.btn.btn-primary.btn-sm', { onclick: save }, 'Save'),
      h('button.btn.btn-sm', { onclick: cancel }, 'Cancel'),
      h('span.muted.small', {}, 'Enter saves, Shift+Enter starts a new line, Esc cancels.')));
}

function startEdit(lineId) {
  editing = lineId;
  renderLines();
}

async function deleteLine(line) {
  if (!confirm(`Delete this line?\n\n“${line.text}”`)) return;
  try {
    await api(`/transcripts/${tid}/lines/${line.id}`, { method: 'DELETE' });
    await load();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// ---------- changing the speaker ----------

function openSpeaker(lineIds, speaker) {
  const all = lines.filter((l) => l.speaker.key === speaker.key).length;
  picking = { lineIds, key: speaker.key, name: speaker.name, scope: 'lines' };
  const scope = $('scope');
  scope.replaceChildren();
  if (all > lineIds.length) {
    const option = (value, label) => h('label.check', {},
      h('input', { type: 'radio', name: 'scope', value, checked: value === 'lines', onchange: () => { picking.scope = value; } }), label);
    scope.append(
      option('lines', lineIds.length === 1 ? 'Only this line' : `Only these ${lineIds.length} lines`),
      option('all', `All ${all} lines of ${speaker.name} in this transcript`));
  }
  $('choices').replaceChildren(...voices.map((v) => {
    const current = speaker.voiceId === v.id;
    return h('button.voice-choice', {
      type: 'button',
      'aria-current': current ? 'true' : 'false',
      style: { '--c': v.color },
      onclick: () => (current ? $('speaker-dialog').close() : apply({ voiceId: v.id })),
    }, h('span.swatch'), h('span', {}, v.name), current ? h('span.current', {}, 'current') : null);
  }));
  $('other-name').value = speaker.voiceId ? '' : speaker.name;
  $('speaker-error').textContent = '';
  $('speaker-dialog').showModal();
}

async function apply(speaker) {
  const body = picking.scope === 'all' ? { key: picking.key, speaker } : { lineIds: picking.lineIds, speaker };
  try {
    const r = await api(`/transcripts/${tid}/speaker`, { method: 'POST', body });
    $('speaker-dialog').close();
    const v = speaker.voiceId && voices.find((x) => x.id === speaker.voiceId);
    toast(v && r.learned ? `Changed. ${v.name} will be recognized better from now on.` : `Changed ${r.lines} line${r.lines === 1 ? '' : 's'}.`);
    await load();
  } catch (err) {
    $('speaker-error').textContent = err.message;
  }
}

$('other-form').addEventListener('submit', (e) => {
  e.preventDefault();
  apply({ label: $('other-name').value });
});
$('speaker-cancel').addEventListener('click', () => $('speaker-dialog').close());

// ---------- title, refresh, delete ----------

$('title').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());
$('title').addEventListener('change', async (e) => {
  try {
    await api(`/transcripts/${tid}`, { method: 'PATCH', body: { title: e.target.value } });
    toast('Title saved.');
    await load();
  } catch (err) {
    toast(err.message, { error: true });
  }
});
$('refresh').replaceChildren(icon('refresh'), 'Refresh');
$('refresh').addEventListener('click', () => load().catch((err) => toast(err.message, { error: true })));
$('delete').addEventListener('click', async () => {
  if (!confirm(`Delete “${transcriptTitle(transcript)}” with all its ${transcript.lines} lines? This cannot be undone.`)) return;
  try {
    await api(`/transcripts/${tid}`, { method: 'DELETE' });
    location.href = query ? `/history?q=${encodeURIComponent(query)}` : '/history';
  } catch (err) {
    toast(err.message, { error: true });
  }
});

initPage('history').then((u) => {
  me = u;
  return load();
}).catch((err) => {
  $('lines').replaceChildren(h('p.muted', {}, err.message));
});
