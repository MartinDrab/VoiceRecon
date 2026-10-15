// Shared helpers for all pages: API calls, DOM building, top navigation, toasts.

export async function api(path, { method = 'GET', body, raw } = {}) {
  const opts = { method, headers: {} };
  if (raw) {
    opts.body = raw;
    opts.headers['Content-Type'] = 'audio/wav';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, opts);
  if (res.status === 401 && !path.startsWith('/login') && !path.startsWith('/setup')) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('Please log in.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

/** Tiny element builder: h('div.card', { onclick }, child, ...). */
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  logo: '<path d="M12 3v18M8 7v10M4 10v4M16 6v12M20 9v6" stroke-linecap="round"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke-linecap="round"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14" stroke-linecap="round" stroke-linejoin="round"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" stroke-linecap="round" stroke-linejoin="round"/>',
  play: '<path d="M7 5l12 7-12 7z" stroke-linejoin="round"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-linecap="round"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke-linecap="round"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16" stroke-linecap="round"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14" stroke-linecap="round" stroke-linejoin="round"/>',
  minus: '<path d="M5 12h14" stroke-linecap="round"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" stroke-linecap="round" stroke-linejoin="round"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0" stroke-linecap="round"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" stroke-linecap="round" stroke-linejoin="round"/>',
  back: '<path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke-linecap="round"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" stroke-linejoin="round"/>',
  system: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4" stroke-linecap="round"/>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstChild;
}

// ---------- color theme (applied early by theme.js) ----------

const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
const THEME_ICONS = { system: 'system', light: 'sun', dark: 'moon' };

export function themeLabel(mode = window.voiceReconTheme.get()) {
  return THEME_LABELS[mode];
}

export function nextTheme() {
  return window.voiceReconTheme.next();
}

/** A button that cycles System -> Light -> Dark and shows the current choice. */
export function themeButton() {
  const btn = h('button.btn.btn-ghost.btn-icon.theme-btn', { type: 'button' });
  const render = () => {
    const mode = window.voiceReconTheme.get();
    const next = window.voiceReconTheme.modes[(window.voiceReconTheme.modes.indexOf(mode) + 1) % 3];
    btn.replaceChildren(icon(THEME_ICONS[mode]));
    btn.title = `Theme: ${THEME_LABELS[mode]}. Click for ${THEME_LABELS[next]}.`;
    btn.setAttribute('aria-label', btn.title);
  };
  btn.addEventListener('click', () => nextTheme());
  window.addEventListener('voicerecon-theme', render);
  render();
  return btn;
}

export function toast(message, { error = false } = {}) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), error ? 6000 : 2500);
}

export async function logout() {
  await api('/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
}

/** Renders the top bar for the management pages and returns the current user. */
export async function initPage(active) {
  const { user } = await api('/me');
  const links = [
    ['transcript', 'Transcript'],
    ['history', 'History'],
    ['voices', 'Voices'],
    ['users', user.role === 'admin' ? 'Users' : 'Account'],
  ];
  const bar = h('header.topbar',
    {},
    h('a.brand', { href: '/transcript' }, icon('logo'), h('span', {}, 'VoiceRecon')),
    h('nav.nav', {}, links.map(([key, label]) => h(`a${key === active ? '.active' : ''}`, { href: `/${key}` }, label))),
    h('div.account', {},
      themeButton(),
      h('span.who-am-i', {}, user.username),
      h('button.btn.btn-sm', { onclick: logout }, 'Log out')));
  document.body.prepend(bar);
  return user;
}

/** Lower case without diacritics, one character for one character (so indexes still match). */
function foldChar(c) {
  const base = c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return base.length === 1 ? base : c.toLowerCase();
}

export function fold(text) {
  return String(text).split('').map(foldChar).join('');
}

/**
 * Text nodes with <mark> around the words that start with one of the query's words, ignoring
 * case and diacritics (the same rule as the server's search).
 */
export function highlight(text, query) {
  const terms = fold(query || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!terms.length) return [text];
  const folded = fold(text);
  const out = [];
  let last = 0;
  for (const m of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = terms.find((t) => m[0].startsWith(t));
    if (!term) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('mark', {}, text.slice(m.index, m.index + term.length)));
    last = m.index + term.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A server search snippet: \u0002…\u0003 surround the matches. */
export function snippetNodes(snippet) {
  return snippet.split('\u0002').flatMap((part, i) => {
    if (i === 0) return [part];
    const [hit, rest] = part.split('\u0003');
    return [h('mark', {}, hit), rest || ''];
  });
}

/** Grey shades for speakers that are not saved voices, stable per speaker key. */
const OTHER_COLORS = ['#8b8d98', '#a18072', '#7e9c8f', '#9083a8', '#a0937a', '#7f95a8'];
export function speakerColor(speaker) {
  if (speaker.color) return speaker.color;
  let n = 0;
  for (const c of speaker.key || '') n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return OTHER_COLORS[n % OTHER_COLORS.length];
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const two = (n) => String(n).padStart(2, '0');
  const hrs = Math.floor(s / 3600);
  return hrs ? `${hrs}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

export function formatDateTime(ms) {
  return new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function transcriptTitle(t) {
  return t.title || `Transcript of ${formatDateTime(t.startedAt)}`;
}

export function formatDuration(seconds) {
  const s = Math.round(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** Black or white, whichever reads better on the given #rrggbb background. */
export function contrastText(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111' : '#fff';
}

/** Distinct, readable default colors for new voices. */
export const PALETTE = ['#e5484d', '#3e63dd', '#30a46c', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#ffb224', '#0090ff', '#7c5f46'];

export function nextColor(used) {
  const taken = new Set(used.map((c) => c.toLowerCase()));
  return PALETTE.find((c) => !taken.has(c)) || PALETTE[used.length % PALETTE.length];
}
