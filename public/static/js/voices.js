import { api, h, icon, toast, initPage, formatDuration, nextColor } from './common.js';
import { MicRecorder, fileToWav } from './audio.js';

const $ = (id) => document.getElementById(id);
let user = null;
let state = { voices: [], threshold: 0.4, learnFromSpeech: false, ready: false };
let recorder = null; // { rec, target: voiceId | 'test', timer }
let player = null; // { audio, sampleId }
let uploadTarget = null;
let pollTimer = null;

async function load() {
  state = await api('/voices');
  render();
  renderTest();
  clearTimeout(pollTimer);
  if (!state.ready) pollTimer = setTimeout(load, 3000); // wait for the speech models
}

function render() {
  $('models-notice').classList.toggle('hidden', state.ready);
  $('threshold').value = state.threshold;
  $('threshold').disabled = user.role !== 'admin';
  $('threshold').title = user.role === 'admin' ? '' : 'Only administrators can change the threshold.';
  $('threshold-value').textContent = Number(state.threshold).toFixed(2);
  $('learn').checked = state.learnFromSpeech;
  $('learn').disabled = user.role !== 'admin';
  $('learn').title = user.role === 'admin' ? '' : 'Only administrators can change this.';

  const grid = $('grid');
  if (!state.voices.length) {
    grid.replaceChildren(h('div.card.empty-state', { style: { 'grid-column': '1 / -1' } },
      h('p', {}, 'No voices yet.'),
      h('p.small', {}, 'Create a voice for each person you want recognized, then add a recording of them speaking.')));
    return;
  }
  grid.replaceChildren(...state.voices.map(voiceCard));
}

function voiceCard(v) {
  const recording = recorder && recorder.target === v.id;
  const name = h('input.voice-name', {
    type: 'text', value: v.name, maxlength: '60', 'aria-label': 'Voice name',
    onkeydown: (e) => e.key === 'Enter' && e.target.blur(),
    onchange: (e) => update(v.id, { name: e.target.value }),
  });
  const color = h('input', {
    type: 'color', value: v.color, title: 'Change color',
    oninput: (e) => e.target.closest('.voice-card').style.setProperty('--c', e.target.value),
    onchange: (e) => update(v.id, { color: e.target.value }),
  });

  const samples = v.samples.length
    ? h('ul.samples', {}, v.samples.map((s, i) => sampleRow(v, s, i)))
    : h('div.notice.warn.small', {}, 'Not recognizable yet: add a recording of this person speaking.');

  return h('div.card.voice-card', { style: { '--c': v.color } },
    h('div.voice-head', {}, color, name),
    h('div.muted.small', {}, v.samples.length
      ? `${v.samples.length} recording${v.samples.length > 1 ? 's' : ''} · ${formatDuration(v.speechSeconds)} of speech`
      : 'No recordings'),
    samples,
    learnedInfo(v),
    h('div.voice-actions', {},
      h(`button.btn.btn-sm${recording ? '.recording' : ''}`, {
        disabled: !state.ready || (recorder && !recording),
        onclick: () => (recording ? finishRecording() : startRecording(v.id)),
      }, icon(recording ? 'stop' : 'mic'), recording ? h('span.rec-timer', { id: 'rec-timer' }, 'Stop 0:00') : 'Record'),
      h('button.btn.btn-sm', {
        disabled: !state.ready || Boolean(recorder),
        onclick: () => pickFiles(v.id),
      }, icon('upload'), 'Upload'),
      h('div.grow'),
      h('button.btn.btn-sm.btn-ghost.btn-danger', { title: 'Delete voice', onclick: () => removeVoice(v) }, icon('trash'))));
}

function learnedInfo(v) {
  const { live, correction } = v.learned;
  if (!live && !correction) return null;
  const parts = [];
  if (live) parts.push(`${live} clearly recognized line${live > 1 ? 's' : ''}`);
  if (correction) parts.push(`${correction} correction${correction > 1 ? 's' : ''}`);
  return h('div.learned', {},
    h('span.grow', {}, `Also learned from ${parts.join(' and ')}.`),
    h('button.btn.btn-sm.btn-ghost', {
      title: 'Forget what was learned; the recordings stay',
      onclick: () => {
        if (!confirm(`Forget what was learned for “${v.name}”? The recordings stay.`)) return;
        run(() => api(`/voices/${v.id}/learned`, { method: 'DELETE' }), 'Learned lines forgotten.');
      },
    }, 'Forget'));
}

function sampleRow(v, s, i) {
  const playing = player && player.sampleId === s.id;
  const when = new Date(`${s.createdAt.replace(' ', 'T')}Z`);
  return h('li', {},
    h('button.btn.btn-ghost.btn-icon.btn-sm', { title: playing ? 'Stop' : 'Play', onclick: () => play(v.id, s.id) }, icon(playing ? 'pause' : 'play')),
    h('span.label', { title: s.label || '' }, s.label || `Recording ${i + 1}`, h('span.muted', {}, ` · ${when.toLocaleDateString()}`)),
    h('span.muted', { title: `${formatDuration(s.speechDuration)} of speech` }, formatDuration(s.duration)),
    h('button.btn.btn-ghost.btn-icon.btn-sm.btn-danger', { title: 'Delete recording', onclick: () => removeSample(v, s) }, icon('trash')));
}

// ---------- actions ----------

async function run(fn, success) {
  try {
    await fn();
    if (success) toast(success);
  } catch (err) {
    toast(err.message, { error: true });
  }
  await load();
}

const update = (id, changes) => run(() => api(`/voices/${id}`, { method: 'PATCH', body: changes }));

function removeVoice(v) {
  if (!confirm(`Delete the voice “${v.name}” and all its recordings?`)) return;
  run(() => api(`/voices/${v.id}`, { method: 'DELETE' }), 'Voice deleted.');
}

function removeSample(v, s) {
  if (!confirm('Delete this recording?')) return;
  run(() => api(`/voices/${v.id}/samples/${s.id}`, { method: 'DELETE' }));
}

function play(voiceId, sampleId) {
  const same = player && player.sampleId === sampleId;
  if (player) player.audio.pause();
  player = null;
  if (!same) {
    const audio = new Audio(`/api/voices/${voiceId}/samples/${sampleId}/audio`);
    player = { audio, sampleId };
    audio.addEventListener('ended', () => {
      player = null;
      render();
    });
    audio.play().catch((err) => toast(err.message, { error: true }));
  }
  render();
}

async function uploadSample(voiceId, wav, label) {
  return api(`/voices/${voiceId}/samples?label=${encodeURIComponent(label)}`, { method: 'POST', raw: wav });
}

function pickFiles(target) {
  uploadTarget = target;
  $('file-input').value = '';
  $('file-input').multiple = target !== 'test';
  $('file-input').click();
}

$('file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  if (uploadTarget === 'test') {
    testClip(() => fileToWav(files[0]));
    return;
  }
  const voiceId = uploadTarget;
  for (const file of files) {
    toast(`Processing ${file.name}…`);
    await run(async () => uploadSample(voiceId, await fileToWav(file), file.name), `Added ${file.name}.`);
  }
});

async function startRecording(target) {
  const rec = new MicRecorder();
  try {
    await rec.start();
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Microphone access was denied.' : err.message, { error: true });
    return;
  }
  const started = Date.now();
  recorder = {
    rec,
    target,
    timer: setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      const el = target === 'test' ? $('test-record') : $('rec-timer');
      const text = `Stop ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (target === 'test') el.replaceChildren(icon('stop'), text);
      else if (el) el.textContent = text;
    }, 250),
  };
  render();
  renderTest();
}

async function finishRecording() {
  if (!recorder) return;
  const { rec, target, timer } = recorder;
  clearInterval(timer);
  recorder = null;
  const wav = await rec.stop();
  renderTest();
  if (target === 'test') {
    testClip(async () => wav);
    render();
    return;
  }
  toast('Processing recording…');
  await run(() => uploadSample(target, wav, `Recorded ${new Date().toLocaleString()}`), 'Recording added.');
}

// ---------- test recognition ----------

function renderTest() {
  const rec = recorder && recorder.target === 'test';
  $('test-record').replaceChildren(icon(rec ? 'stop' : 'mic'), rec ? 'Stop 0:00' : 'Record');
  $('test-record').classList.toggle('recording', Boolean(rec));
  $('test-record').disabled = !state.ready || Boolean(recorder && !rec);
  $('test-upload').disabled = !state.ready || Boolean(recorder);
}

async function testClip(getWav) {
  $('test-status').textContent = 'Analyzing…';
  $('test-scores').replaceChildren();
  try {
    const r = await api('/identify', { method: 'POST', raw: await getWav() });
    const byId = new Map(state.voices.map((v) => [v.id, v]));
    const match = r.voiceId !== null ? byId.get(r.voiceId) : null;
    $('test-status').textContent = match
      ? `Recognized as ${match.name}.`
      : (r.scores.length ? 'No voice matched (below the threshold).' : 'No voices with recordings yet.');
    $('test-scores').replaceChildren(...r.scores.map((s) => {
      const v = byId.get(s.voiceId);
      const pct = (x) => `${Math.max(0, Math.min(1, x)) * 100}%`;
      return h('div.score-row', {},
        h('span.name', {}, v ? v.name : `#${s.voiceId}`),
        h('div.score-bar', { style: { '--c': v ? v.color : 'var(--accent)' } },
          h('div.fill', { style: { width: pct(s.score) } }),
          h('div.mark', { style: { left: pct(r.threshold) }, title: 'Threshold' })),
        h('span.val', {}, s.score.toFixed(2)));
    }));
  } catch (err) {
    $('test-status').textContent = err.message;
  }
}

$('test-record').addEventListener('click', () => (recorder ? finishRecording() : startRecording('test')));
$('test-upload').addEventListener('click', () => pickFiles('test'));
$('test-upload').replaceChildren(icon('upload'), 'Upload clip');

// ---------- threshold ----------

$('threshold').addEventListener('input', (e) => {
  $('threshold-value').textContent = Number(e.target.value).toFixed(2);
});
$('threshold').addEventListener('change', (e) => {
  run(() => api('/settings/threshold', { method: 'PUT', body: { value: Number(e.target.value) } }), 'Threshold saved.');
});

$('learn').addEventListener('change', (e) => {
  const enabled = e.target.checked;
  run(() => api('/settings/learn', { method: 'PUT', body: { enabled } }),
    enabled ? 'Voices will learn from clearly recognized live speech.' : 'Learning from live speech is off.');
});

// ---------- new voice ----------

$('new-voice').replaceChildren(icon('plus'), 'New voice');
$('new-voice').addEventListener('click', () => {
  $('voice-name').value = '';
  $('voice-color').value = nextColor(state.voices.map((v) => v.color));
  $('voice-error').textContent = '';
  $('voice-dialog').showModal();
  $('voice-name').focus();
});
$('voice-cancel').addEventListener('click', () => $('voice-dialog').close());
$('voice-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/voices', { method: 'POST', body: { name: $('voice-name').value, color: $('voice-color').value } });
    $('voice-dialog').close();
    await load();
  } catch (err) {
    $('voice-error').textContent = err.message;
  }
});

initPage('voices').then((u) => {
  user = u;
  renderTest();
  return load();
}).then(renderTest).catch((err) => toast(err.message, { error: true }));
