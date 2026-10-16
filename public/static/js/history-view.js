import {
  api, h, icon, toast, initPage, formatDuration, formatDateTime, formatClock, transcriptTitle, statusBadge, highlight,
  speakerColor, t, plural, locale, speakerLabel,
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
let stopping = false; // the user stopped the transcription of the file
let linesLoadedAt = 0;
const PROGRESS_POLL_MS = 2000; // while a file is transcribed: its progress this often,
const LINES_POLL_MS = 10000; // and its new lines this often (a long file has thousands)

const isLive = () => Boolean(transcript && transcript.recording);
const isProcessing = () => Boolean(transcript && transcript.processing && transcript.processing.state !== 'failed');
const mayDelete = () => me.role === 'admin' || me.id === transcript.userId;

async function load({ onlyIfChanged = false } = {}) {
  const [tr, v] = await Promise.all([api(`/transcripts/${tid}`), api('/voices')]);
  const changed = !transcript || tr.transcript.updatedAt !== transcript.updatedAt
    || tr.transcript.recording !== transcript.recording || JSON.stringify(v.voices) !== JSON.stringify(voices)
    || JSON.stringify(tr.transcript.processing) !== JSON.stringify(transcript.processing);
  const wasProcessing = isProcessing();
  transcript = tr.transcript;
  lines = tr.lines;
  voices = v.voices;
  linesLoadedAt = Date.now();
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
  if (wasProcessing && !transcript.processing && !stopping) toast(t('The recording is transcribed.'));
  clearTimeout(pollTimer);
  // While the transcript is still being recorded or transcribed, keep it up to date.
  if (isLive()) pollTimer = setTimeout(poll, isProcessing() ? PROGRESS_POLL_MS : 5000);
}

function poll() {
  if (editing || $('speaker-dialog').open || document.hidden) {
    pollTimer = setTimeout(poll, 5000);
    return;
  }
  (isProcessing() ? pollProgress() : load({ onlyIfChanged: true })).catch(() => {
    pollTimer = setTimeout(poll, 10000);
  });
}

/** While a file is transcribed: the progress without the lines, which are loaded less often. */
async function pollProgress() {
  const { transcript: tr } = await api(`/transcripts/${tid}?lines=0`);
  const finished = !tr.recording || !tr.processing || tr.processing.state === 'failed';
  const newLines = tr.updatedAt !== transcript.updatedAt;
  if (finished || (newLines && Date.now() - linesLoadedAt >= LINES_POLL_MS)) {
    await load({ onlyIfChanged: true });
    return;
  }
  // Only the progress is shown as it is now; the rest still matches the lines on the page.
  transcript = { ...transcript, processing: tr.processing };
  renderHeader();
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, PROGRESS_POLL_MS);
}

function renderHeader() {
  const title = transcriptTitle(transcript);
  document.title = `${title} · VoiceRecon`;
  if (document.activeElement !== $('title')) $('title').value = transcript.title;
  $('title').placeholder = transcriptTitle({ ...transcript, title: '' });
  const meta = [formatDateTime(transcript.startedAt), formatDuration(transcript.duration), plural(transcript.lines, '{n} line', '{n} lines')];
  if (transcript.user) meta.push(t('by {user}', { user: transcript.user }));
  $('meta').replaceChildren(...[meta.join(' · '), statusBadge(transcript)].filter(Boolean));
  $('speakers').replaceChildren(...transcript.speakers.map((s) => h('span.chip', { style: { '--c': speakerColor(s) } }, `${speakerLabel(s.name)} · ${s.lines}`)));
  for (const f of ['txt', 'srt', 'json']) $(`export-${f}`).href = `/api/transcripts/${tid}/export?format=${f}`;
  $('export-wav').href = `/api/transcripts/${tid}/audio?download=1`;
  $('export-wav').classList.toggle('hidden', !transcript.audio);
  $('delete-audio').classList.toggle('hidden', !(transcript.audio && mayDelete()));
  $('regroup').classList.toggle('hidden', isLive());
  $('delete').classList.toggle('hidden', !mayDelete());
  $('stop').classList.toggle('hidden', !(isProcessing() && mayDelete()));
  if (query) $('back').href = `/history?q=${encodeURIComponent(query)}`;
}

function renderLines() {
  const container = $('lines');
  if (!lines.length) {
    container.replaceChildren(h('p.muted', {}, t('This transcript has no lines.')));
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
      title: t('Change who said this'),
      onclick: () => openSpeaker(b.lines.map((l) => l.id), b.speaker),
    }, h('span.name', {}, speakerLabel(b.speaker.name))),
    b.lines.map(lineRow))));
}

function lineRow(line) {
  const text = line.id === editing
    ? editor(line)
    : h('p.text', {}, highlight(line.text, query), line.edited ? h('span.edited', {}, ` ${t('(edited)')}`) : null);
  const playing = Boolean(player && player.lineId === line.id);
  return h(`div.hline${playing ? '.playing' : ''}`, { id: `line-${line.id}` },
    h('span.time', { title: new Date(line.spokenAt).toLocaleTimeString(locale) }, formatClock(line.start)),
    text,
    line.id === editing ? null : h('div.hline-actions', {},
      transcript.audio ? h('button.btn.btn-ghost.btn-icon.btn-sm', {
        title: playing ? t('Stop playing') : t('Play this line'),
        'aria-pressed': String(playing),
        onclick: () => playLine(line),
      }, icon(playing ? 'stop' : 'play')) : null,
      h('button.btn.btn-ghost.btn-icon.btn-sm', { title: t('Change who said this line'), onclick: () => openSpeaker([line.id], line.speaker) }, icon('person')),
      h('button.btn.btn-ghost.btn-icon.btn-sm', { title: t('Fix the text'), onclick: () => startEdit(line.id) }, icon('edit')),
      h('button.btn.btn-ghost.btn-icon.btn-sm.btn-danger', { title: t('Delete the line'), onclick: () => deleteLine(line) }, icon('trash'))));
}

// ---------- playing lines ----------

let player = null; // { audio: HTMLAudioElement, lineId } while a line plays

function refreshLine(lineId) {
  const el = document.getElementById(`line-${lineId}`);
  const line = lines.find((l) => l.id === lineId);
  if (el && line && line.id !== editing) el.replaceWith(lineRow(line));
}

function stopPlaying() {
  if (!player) return;
  const { audio, lineId } = player;
  player = null;
  audio.pause();
  audio.removeAttribute('src');
  refreshLine(lineId);
}

/** Plays a line from the transcript's audio; the same line again stops it. */
function playLine(line) {
  const again = player && player.lineId === line.id;
  stopPlaying();
  if (again) return;
  // A little more on both sides: a line's first and last sounds are often right at its edges.
  const from = Math.max(0, line.start - 0.2).toFixed(2);
  const to = (line.end + 0.3).toFixed(2);
  const audio = new Audio(`/api/transcripts/${tid}/audio?start=${from}&end=${to}`);
  const current = () => player && player.audio === audio;
  player = { audio, lineId: line.id };
  audio.addEventListener('ended', () => {
    if (current()) stopPlaying();
  });
  audio.addEventListener('error', () => {
    if (!current()) return;
    stopPlaying();
    toast(t('The audio could not be played.'), { error: true });
  });
  audio.play().catch(() => {}); // a failure also arrives as the 'error' event
  refreshLine(line.id);
}

// ---------- editing text ----------

function editor(line) {
  const area = h('textarea.line-editor', { rows: 2, 'aria-label': t('Line text') });
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
      h('button.btn.btn-primary.btn-sm', { onclick: save }, t('Save')),
      h('button.btn.btn-sm', { onclick: cancel }, t('Cancel')),
      h('span.muted.small', {}, t('Enter saves, Shift+Enter starts a new line, Esc cancels.'))));
}

function startEdit(lineId) {
  editing = lineId;
  renderLines();
}

async function deleteLine(line) {
  if (!confirm(t('Delete this line?\n\n“{text}”', { text: line.text }))) return;
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
  const name = speakerLabel(speaker.name);
  picking = { lineIds, key: speaker.key, name, scope: 'lines' };
  const scope = $('scope');
  scope.replaceChildren();
  if (all > lineIds.length) {
    const option = (value, label) => h('label.check', {},
      h('input', { type: 'radio', name: 'scope', value, checked: value === 'lines', onchange: () => { picking.scope = value; } }), label);
    scope.append(
      option('lines', plural(lineIds.length, 'Only this line', 'Only these {n} lines')),
      option('all', t('All {n} lines of {name} in this transcript', { n: all, name })));
  }
  $('choices').replaceChildren(...voices.map((v) => {
    const current = speaker.voiceId === v.id;
    return h('button.voice-choice', {
      type: 'button',
      'aria-current': current ? 'true' : 'false',
      style: { '--c': v.color },
      onclick: () => (current ? $('speaker-dialog').close() : apply({ voiceId: v.id })),
    }, h('span.swatch'), h('span', {}, v.name), current ? h('span.current', {}, t('current')) : null);
  }));
  $('other-name').value = speaker.voiceId ? '' : name;
  $('speaker-error').textContent = '';
  $('speaker-dialog').showModal();
}

async function apply(speaker) {
  const body = picking.scope === 'all' ? { key: picking.key, speaker } : { lineIds: picking.lineIds, speaker };
  try {
    const r = await api(`/transcripts/${tid}/speaker`, { method: 'POST', body });
    $('speaker-dialog').close();
    const v = speaker.voiceId && voices.find((x) => x.id === speaker.voiceId);
    toast(v && r.learned
      ? t('Changed. {name} will be recognized better from now on.', { name: v.name })
      : plural(r.lines, 'Changed {n} line.', 'Changed {n} lines.'));
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
    toast(t('Title saved.'));
    await load();
  } catch (err) {
    toast(err.message, { error: true });
  }
});
$('refresh').replaceChildren(icon('refresh'), t('Refresh'));
$('stop').addEventListener('click', async () => {
  if (!confirm(t('Stop transcribing this recording? The lines found so far stay.'))) return;
  stopping = true;
  try {
    await api(`/transcripts/${tid}/stop`, { method: 'POST' });
    await load();
    toast(t('Transcribing stopped.'));
  } catch (err) {
    toast(err.message, { error: true });
  }
  stopping = false;
});
$('refresh').addEventListener('click', () => load().catch((err) => toast(err.message, { error: true })));
$('regroup').addEventListener('click', async () => {
  try {
    const { moved } = await api(`/transcripts/${tid}/regroup`, { method: 'POST' });
    await load();
    toast(moved ? plural(moved, '{n} line has another speaker now.', '{n} lines have another speaker now.') : t('Every line keeps its speaker.'));
  } catch (err) {
    toast(err.message, { error: true });
  }
});
$('delete-audio').addEventListener('click', async () => {
  if (!confirm(t('Delete the audio of this transcript? Its text stays.'))) return;
  try {
    stopPlaying();
    await api(`/transcripts/${tid}/audio`, { method: 'DELETE' });
    await load();
    toast(t('Audio deleted.'));
  } catch (err) {
    toast(err.message, { error: true });
  }
});
$('delete').addEventListener('click', async () => {
  const question = plural(transcript.lines, 'Delete “{title}” with its {n} line? This cannot be undone.',
    'Delete “{title}” with all its {n} lines? This cannot be undone.', { title: transcriptTitle(transcript) });
  if (!confirm(question)) return;
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
