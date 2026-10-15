import { api, h, icon, toast, logout, nextColor, themeLabel, nextTheme } from './common.js';
import {
  MicCapture, wavFromInt16, SAMPLE_RATE, listMicrophones, preferredMicrophone, setPreferredMicrophone,
} from './audio.js';

/** Elements by id; typed loosely because the pages read form fields, dialogs and buttons alike. */
const $ = (id) => /** @type {any} */ (document.getElementById(id));
const STORE_KEY = 'voicerecon.transcript';
const TRANSCRIPT_ID_KEY = 'voicerecon.transcriptId'; // the saved transcript this tab continues
const SIZE_KEY = 'voicerecon.textSize';
const KEEP_AUDIO_KEY = 'voicerecon.keepAudio';
const MAX_KEPT_SECONDS = 3 * 3600; // ~330 MB of 16 kHz PCM
const MERGE_GAP_SECONDS = 20;
const UNKNOWN_COLORS = ['#8b8d98', '#a18072', '#7e9c8f', '#9083a8', '#a0937a', '#7f95a8'];
const NONE_COLOR = '#8b8d98';

const voices = new Map(); // id -> { name, color }
let turns = []; // { key, speaker, epoch, ids: [], texts: [], start, end, wall, el }
let pendingEl = null;
let ws = null;
let epoch = Date.now(); // identifies the server-side session that unknown speaker ids belong to
let modelsReady = false;
let listening = false;
let stopping = false;
let mic = null;
let reconnectDelay = 1000;
let wakeLock = null;
// Microphone audio kept in this tab (only when enabled in the menu) for "Download recording".
let keepAudio = readSetting(KEEP_AUDIO_KEY) === '1';
let kept = [];
let keptSamples = 0;
let keptFull = false;

function readSetting(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
}

// ---------- speakers ----------

function speakerKey(sp, ep = epoch) {
  if (sp.kind === 'voice') return `v${sp.id}`;
  if (sp.kind === 'unknown') return `u:${ep}:${sp.id}`;
  return 'none';
}

function speakerInfo(sp) {
  if (sp.kind === 'voice') {
    const v = voices.get(sp.id);
    return v ? { name: v.name, color: v.color } : { name: 'Deleted voice', color: NONE_COLOR };
  }
  if (sp.kind === 'unknown' && sp.id) {
    const n = parseInt(String(sp.id).replace(/\D/g, ''), 10) || 0;
    return { name: sp.label, color: UNKNOWN_COLORS[(n - 1) % UNKNOWN_COLORS.length], unknown: true };
  }
  return { name: sp.kind === 'unknown' ? 'Unknown' : '…', color: NONE_COLOR, unknown: true };
}

const clock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Lines of the current server session can be corrected: their voice prints are still there. */
const correctable = (turn) => Boolean(turn && turn.epoch === epoch && turn.ids.length && ws && ws.readyState === WebSocket.OPEN);

function renderHeader(turnEl, sp, wall, turn = null) {
  const info = speakerInfo(sp);
  turnEl.style.setProperty('--c', info.color);
  turnEl.classList.toggle('unknown', Boolean(info.unknown));
  const parts = [h('span.name', {}, info.name), wall ? h('span.time', {}, clock(wall)) : null];
  const who = correctable(turn)
    ? h('button.who', { type: 'button', title: 'Wrong person? Click to correct', onclick: () => openWho(turn) }, parts)
    : h('div.who', {}, parts);
  const old = turnEl.querySelector('.who');
  if (old) old.replaceWith(who);
  else turnEl.prepend(who);
}

// ---------- transcript rendering ----------

function isAtBottom() {
  const s = $('scroll');
  return s.scrollTop + s.clientHeight >= s.scrollHeight - 80;
}

function afterAppend(stick) {
  $('empty').classList.toggle('hidden', turns.length > 0 || Boolean(pendingEl && !pendingEl.classList.contains('hidden')));
  if (stick) $('scroll').scrollTop = $('scroll').scrollHeight;
  else $('jump').classList.remove('hidden');
}

function buildTurn(t) {
  t.el = h('div.turn', {}, h('p.text', {}, t.texts.join(' ')));
  renderHeader(t.el, t.speaker, t.wall, t);
  $('transcript').insertBefore(t.el, pendingEl);
}

function addFinal(msg) {
  const stick = isAtBottom();
  const key = speakerKey(msg.speaker);
  const last = turns[turns.length - 1];
  if (last && last.key === key && msg.start - last.end < MERGE_GAP_SECONDS && last.epoch === epoch) {
    last.texts.push(msg.text);
    last.ids.push(msg.id);
    last.end = msg.end;
    last.el.querySelector('.text').textContent = last.texts.join(' ');
  } else {
    const t = { key, speaker: msg.speaker, epoch, ids: [msg.id], texts: [msg.text], start: msg.start, end: msg.end, wall: new Date() };
    turns.push(t);
    buildTurn(t);
  }
  save();
  afterAppend(stick);
}

function setPartial(msg) {
  const stick = isAtBottom();
  if (!pendingEl) {
    pendingEl = h('div.turn.pending', {}, h('p.text'));
    $('transcript').append(pendingEl);
  }
  pendingEl.classList.toggle('hidden', !msg.text);
  if (msg.text) {
    renderHeader(pendingEl, msg.speaker, null);
    pendingEl.querySelector('.text').textContent = msg.text;
  }
  afterAppend(stick);
}

function rerenderAll() {
  for (const t of turns) renderHeader(t.el, t.speaker, t.wall, t);
}

function setSpeaker(t, sp) {
  t.speaker = sp;
  t.key = speakerKey(sp, t.epoch);
  renderHeader(t.el, t.speaker, t.wall, t);
}

function relabel(from, to) {
  const fromKey = speakerKey(from);
  for (const t of turns) if (t.key === fromKey) setSpeaker(t, to);
  save();
}

function clearTranscript() {
  turns = [];
  $('transcript').replaceChildren();
  pendingEl = null;
  discardAudio();
  setTranscriptId(null);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'newTranscript' }));
  save();
  afterAppend(true);
}

function savedTranscriptId() {
  try {
    return Number(sessionStorage.getItem(TRANSCRIPT_ID_KEY)) || null;
  } catch {
    return null;
  }
}

function setTranscriptId(id) {
  try {
    if (id) sessionStorage.setItem(TRANSCRIPT_ID_KEY, String(id));
    else sessionStorage.removeItem(TRANSCRIPT_ID_KEY);
  } catch { /* storage unavailable */ }
  $('history-link').href = id ? `/history/${id}` : '/history';
  $('history-link').textContent = id ? 'Open in History' : 'History';
}

const startMessage = () => JSON.stringify({ type: 'start', transcriptId: savedTranscriptId() });

// ---------- persistence (survives a page reload, not closing the tab) ----------

function save() {
  try {
    const data = turns.map(({ speaker, epoch: ep, texts, start, end, wall }) => ({ speaker, epoch: ep, texts, start, end, wall: wall.getTime() }));
    sessionStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch { /* storage unavailable or full */ }
}

function restore() {
  try {
    const data = JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]');
    for (const d of data) {
      const t = { ...d, ids: [], key: speakerKey(d.speaker, d.epoch), wall: new Date(d.wall) };
      turns.push(t);
      buildTurn(t);
    }
  } catch { /* ignore */ }
  afterAppend(true);
}

function saveFile(blob, prefix, ext) {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
  const a = h('a', { href: URL.createObjectURL(blob), download: `${prefix}-${stamp}.${ext}` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function download() {
  const lines = turns.map((t) => `[${clock(t.wall)}] ${speakerInfo(t.speaker).name}: ${t.texts.join(' ')}`);
  saveFile(new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }), 'transcript', 'txt');
}

// ---------- kept audio ----------

function keepChunk(pcm) {
  if (keptSamples >= MAX_KEPT_SECONDS * SAMPLE_RATE) {
    if (!keptFull) toast('Audio is kept for at most 3 hours; later audio is not kept.', { error: true });
    keptFull = true;
    return;
  }
  kept.push(pcm);
  keptSamples += pcm.length;
}

function discardAudio() {
  kept = [];
  keptSamples = 0;
  keptFull = false;
}

function downloadAudio() {
  const pcm = new Int16Array(keptSamples);
  let o = 0;
  for (const c of kept) {
    pcm.set(c, o);
    o += c.length;
  }
  saveFile(wavFromInt16(pcm, SAMPLE_RATE), 'recording', 'wav');
}

function renderAudioMenu() {
  const s = Math.floor(keptSamples / SAMPLE_RATE);
  const length = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  $('keep-audio').textContent = `${keepAudio ? '✓ ' : ''}Keep audio for download`;
  $('keep-audio').setAttribute('aria-checked', String(keepAudio));
  $('download-audio').textContent = `Download recording (${length})`;
  $('download-audio').classList.toggle('hidden', keptSamples === 0);
}

// ---------- status ----------

function setStatus(text, state) {
  $('status').textContent = text;
  $('dot').className = `dot ${state || ''}`;
}

function refreshStatus() {
  const open = ws && ws.readyState === WebSocket.OPEN;
  const rec = $('rec');
  rec.disabled = !open || !modelsReady || stopping;
  rec.replaceChildren(icon(listening ? 'stop' : 'mic'), listening ? 'Stop' : 'Start');
  rec.classList.toggle('on', listening);
  if (!open) setStatus(listening ? 'Reconnecting… (audio is not being sent)' : 'Connecting…', 'wait');
  else if (!modelsReady) setStatus('Loading speech models…', 'wait');
  else if (stopping) setStatus('Finishing…', 'wait');
  else if (listening) setStatus('Listening', 'live');
  else setStatus('Ready', 'ready');
  if (!listening) $('level').style.width = '0';
}

// ---------- connection ----------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/transcribe`);
  ws.binaryType = 'arraybuffer';
  epoch = Date.now();
  refreshStatus();

  ws.onopen = () => {
    reconnectDelay = 1000;
    if (listening) ws.send(startMessage());
    refreshStatus();
    rerenderAll();
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'hello':
      case 'status':
        modelsReady = msg.ready;
        if (msg.error) toast(`Speech models failed to load: ${msg.error}`, { error: true });
        refreshStatus();
        break;
      case 'voices':
        voices.clear();
        for (const v of msg.voices) voices.set(v.id, v);
        rerenderAll();
        break;
      case 'partial':
        setPartial(msg);
        break;
      case 'final':
        addFinal(msg);
        break;
      case 'relabel':
        relabel(msg.from, msg.to);
        break;
      case 'saved':
        $('who-dialog').close();
        toast('Voice saved. It will be recognized from now on.');
        break;
      case 'transcript':
        setTranscriptId(msg.id);
        break;
      case 'corrected':
        corrected(msg);
        break;
      case 'stopped':
        stopping = false;
        refreshStatus();
        break;
      case 'error':
        if ($('who-dialog').open) $('who-error').textContent = msg.message;
        else toast(msg.message, { error: true });
        break;
      default:
    }
  };
  ws.onclose = () => {
    stopping = false;
    refreshStatus();
    rerenderAll();
    // Check the login is still valid (api() redirects to the login page otherwise), then retry.
    setTimeout(() => api('/me').then(connect, () => setTimeout(connect, reconnectDelay)), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
}

// ---------- microphone ----------

function createMic() {
  return new MicCapture({
    onChunk: (pcm) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(pcm.buffer);
      if (keepAudio) keepChunk(pcm);
    },
    onLevel: (rms) => {
      $('level').style.width = `${Math.min(100, Math.sqrt(rms) * 220)}%`;
    },
  });
}

const micError = (err) => (err.name === 'NotAllowedError' ? 'Microphone access was denied.' : err.message);

/** After a microphone started: say so if the chosen one was missing, and show which one is used. */
function micStarted(m) {
  if (m.fellBack) {
    const chosen = preferredMicrophone();
    toast(`${chosen && chosen.label ? `“${chosen.label}”` : 'The chosen microphone'} is not available, so the default one is used.`, { error: true });
  }
  renderMicChoice();
}

async function start() {
  if (listening) return;
  mic = createMic();
  try {
    ws.send(startMessage());
    await mic.start();
  } catch (err) {
    mic = null;
    toast(micError(err), { error: true });
    return;
  }
  listening = true;
  micStarted(mic);
  refreshStatus();
  idleWatch();
  keepScreenOn();
}

// ---------- choosing the microphone ----------

function micName() {
  if (mic && mic.label) return mic.label;
  const chosen = preferredMicrophone();
  return chosen ? chosen.label || 'Chosen microphone' : 'System default';
}

function renderMicChoice() {
  const chosen = preferredMicrophone();
  $('mic-choice').textContent = `Microphone: ${chosen ? chosen.label || 'Chosen microphone' : 'System default'}`;
  $('level').parentElement.title = `Microphone level: ${micName()}`;
}

async function renderMicDialog() {
  let devices = [];
  try {
    devices = await listMicrophones();
  } catch { /* listing not allowed: only the default is offered */ }
  const chosen = preferredMicrophone();
  const choice = (device, name) => {
    const current = chosen ? Boolean(device) && device.deviceId === chosen.id : !device;
    return h('button.voice-choice', { type: 'button', 'aria-current': current ? 'true' : 'false', onclick: () => chooseMic(device) },
      h('span', {}, name), current ? h('span.current', {}, 'chosen') : null);
  };
  $('mic-choices').replaceChildren(
    choice(null, 'System default'),
    ...devices.map((d, i) => choice(d, d.label || `Microphone ${i + 1}`)));
  const unnamed = devices.length && devices.every((d) => !d.label);
  $('mic-hint').textContent = unnamed
    ? 'The browser shows microphone names after you allow microphone access: press Start once, then come back here.'
    : `The chosen microphone is also used for recordings on the Voices page.${listening ? ' Switching takes effect immediately.' : ''}`;
}

async function chooseMic(device) {
  setPreferredMicrophone(device);
  $('mic-dialog').close();
  renderMicChoice();
  if (!listening || !mic) return;
  // Swap the microphone while the transcription keeps running.
  const old = mic;
  mic = null;
  await old.stop();
  const next = createMic();
  try {
    await next.start();
    mic = next;
    micStarted(next);
    toast(`Now listening with ${micName()}.`);
  } catch (err) {
    toast(micError(err), { error: true });
    await stop();
  }
}

$('mic-choice').addEventListener('click', async () => {
  await renderMicDialog();
  $('mic-dialog').showModal();
});
$('mic-close').addEventListener('click', () => $('mic-dialog').close());
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if ($('mic-dialog').open) renderMicDialog();
  });
}
renderMicChoice();

// Keeps the screen from sleeping while listening (the lock is dropped when the tab is hidden).
async function keepScreenOn() {
  if (wakeLock || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch { /* not allowed right now */ }
}

async function stop() {
  if (!listening) return;
  listening = false;
  if (mic) await mic.stop();
  mic = null;
  if (ws && ws.readyState === WebSocket.OPEN) {
    stopping = true;
    ws.send(JSON.stringify({ type: 'stop' }));
  }
  refreshStatus();
  $('bar').classList.remove('idle');
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

// The toolbar fades out while listening so that only the transcript is visible.
let idleTimer = null;
function idleWatch() {
  $('bar').classList.remove('idle');
  clearTimeout(idleTimer);
  if (listening) idleTimer = setTimeout(() => listening && $('bar').classList.add('idle'), 4000);
}

// ---------- "Who said this?": corrections and saving unknown speakers ----------

let whoTurn = null;

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    $('who-error').textContent = 'Not connected to the server. Try again in a moment.';
    return;
  }
  ws.send(JSON.stringify(obj));
}

function openWho(turn) {
  whoTurn = turn;
  const sp = turn.speaker;
  const unknown = sp.kind === 'unknown' && Boolean(sp.id);
  $('who-hint').textContent = unknown
    ? `Pick who “${sp.label}” is. All their lines in this session are reassigned and the voice learns how they sound.`
    : 'Pick who really said this. The voice learns how the line sounded and is recognized better next time.';
  const list = [...voices.values()].sort((a, b) => a.name.localeCompare(b.name));
  $('who-choices').replaceChildren(...(list.length
    ? list.map((v) => {
      const current = sp.kind === 'voice' && sp.id === v.id;
      return h('button.voice-choice', {
        type: 'button',
        'aria-current': current ? 'true' : 'false',
        style: { '--c': v.color },
        onclick: () => pickVoice(v.id),
      }, h('span.swatch'), h('span', {}, v.name), current ? h('span.current', {}, 'current') : null);
    })
    : [h('p.muted.small', {}, 'There are no voices yet.')]));
  $('save-form').classList.toggle('hidden', !unknown);
  $('save-name').value = '';
  $('save-color').value = nextColor(list.map((v) => v.color));
  $('who-error').textContent = '';
  $('who-dialog').showModal();
}

function pickVoice(voiceId) {
  const sp = whoTurn.speaker;
  if (sp.kind === 'voice' && sp.id === voiceId) {
    $('who-dialog').close();
  } else if (sp.kind === 'unknown' && sp.id) {
    send({ type: 'assignUnknown', speakerId: sp.id, voiceId });
  } else {
    send({ type: 'correct', ids: whoTurn.ids, voiceId });
  }
}

function corrected(msg) {
  if (msg.ids) {
    const ids = new Set(msg.ids);
    const to = { kind: 'voice', id: msg.voiceId, score: 1 };
    for (const t of turns) if (t.ids.some((i) => ids.has(i))) setSpeaker(t, to);
    save();
  }
  $('who-dialog').close();
  const v = voices.get(msg.voiceId);
  toast(msg.learned
    ? `Corrected. ${v ? v.name : 'The voice'} will be recognized better from now on.`
    : 'Corrected. The line was too short to learn from.');
}

$('save-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const sp = whoTurn && whoTurn.speaker;
  if (!sp || sp.kind !== 'unknown') return;
  send({ type: 'saveUnknown', speakerId: sp.id, name: $('save-name').value, color: $('save-color').value });
});
$('who-cancel').addEventListener('click', () => $('who-dialog').close());

// ---------- UI wiring ----------

function setTextSize(rem) {
  const v = Math.max(0.9, Math.min(3, rem));
  document.documentElement.style.setProperty('--tx-size', `${v}rem`);
  writeSetting(SIZE_KEY, String(v));
  return v;
}
let textSize = setTextSize(Number(readSetting(SIZE_KEY)) || 1.35);

$('rec').addEventListener('click', () => (listening ? stop() : start()));
$('smaller').addEventListener('click', () => (textSize = setTextSize(textSize - 0.1)));
$('larger').addEventListener('click', () => (textSize = setTextSize(textSize + 0.1)));
$('menu-btn').append(icon('menu'));

const menu = $('menu');
const toggleMenu = (open) => {
  if (open) renderAudioMenu();
  menu.classList.toggle('hidden', !open);
  $('menu-btn').setAttribute('aria-expanded', String(open));
};
$('menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu(menu.classList.contains('hidden'));
});
document.addEventListener('click', () => toggleMenu(false));
$('download').addEventListener('click', download);
$('download-audio').addEventListener('click', downloadAudio);
$('keep-audio').addEventListener('click', () => {
  if (keepAudio && keptSamples && !confirm('Stop keeping audio and discard what was kept so far?')) return;
  keepAudio = !keepAudio;
  writeSetting(KEEP_AUDIO_KEY, keepAudio ? '1' : '0');
  if (!keepAudio) discardAudio();
  toast(keepAudio ? 'Microphone audio will be kept in this tab until you clear the transcript.' : 'Audio is no longer kept.');
});
$('clear').addEventListener('click', () => {
  if (!turns.length && !keptSamples) return;
  const question = 'Start a new transcript? The current one stays saved in History.'
    + (keptSamples ? ' The audio kept for download is discarded.' : '');
  if (confirm(question)) clearTranscript();
});
$('fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
$('logout').addEventListener('click', logout);
const renderTheme = () => {
  $('theme').textContent = `Theme: ${themeLabel()}`;
};
$('theme').addEventListener('click', (e) => {
  e.stopPropagation(); // keep the menu open, so the themes can be clicked through
  nextTheme();
});
window.addEventListener('voicerecon-theme', renderTheme);
renderTheme();

$('scroll').addEventListener('scroll', () => {
  if (isAtBottom()) $('jump').classList.add('hidden');
});
$('jump').addEventListener('click', () => {
  $('scroll').scrollTop = $('scroll').scrollHeight;
  $('jump').classList.add('hidden');
});

document.addEventListener('mousemove', idleWatch);
document.addEventListener('keydown', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (target.closest('input, textarea, select, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space' && !target.closest('button')) {
    e.preventDefault();
    if (!$('rec').disabled) $('rec').click();
  } else if (e.key === '+' || e.key === '=') {
    textSize = setTextSize(textSize + 0.1);
  } else if (e.key === '-') {
    textSize = setTextSize(textSize - 0.1);
  }
});
document.addEventListener('visibilitychange', () => {
  if (listening && document.visibilityState === 'visible') keepScreenOn();
});

api('/me').then(({ user }) => {
  if (user.role !== 'admin') $('users-link').textContent = 'Account';
  restore();
  setTranscriptId(savedTranscriptId());
  connect();
}).catch(() => {});
