import { api, themeButton } from './common.js';

// Only same-origin targets: resolving the URL catches tricks like "/\evil.example", which
// browsers treat as "//evil.example".
const next = (() => {
  const n = new URLSearchParams(location.search).get('next');
  if (!n) return '/transcript';
  try {
    const url = new URL(n, location.origin);
    return url.origin === location.origin ? url.pathname + url.search + url.hash : '/transcript';
  } catch {
    return '/transcript';
  }
})();

/** Elements by id; typed loosely because the pages read form fields, dialogs and buttons alike. */
const $ = (id) => /** @type {any} */ (document.getElementById(id));
$('corner').append(themeButton());

async function init() {
  const setup = await api('/setup');
  if (!setup.needed) $('login-form').classList.remove('hidden');
  else if (setup.allowed) $('setup-form').classList.remove('hidden');
  else $('setup-remote').classList.remove('hidden');
  const visible = /** @type {HTMLInputElement | null} */ (document.querySelector('form:not(.hidden) input'));
  if (visible) visible.focus();
}

function bind(formId, errorId, submit) {
  const form = $(formId);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const data = Object.fromEntries(new FormData(form));
    $(errorId).textContent = '';
    btn.disabled = true;
    try {
      await submit(data);
      location.href = next;
    } catch (err) {
      $(errorId).textContent = err.message;
      btn.disabled = false;
    }
  });
}

bind('login-form', 'login-error', (d) => api('/login', { method: 'POST', body: { username: d.username, password: d.password } }));
bind('setup-form', 'setup-error', (d) => {
  if (d.password !== d.confirm) throw new Error('The passwords do not match.');
  return api('/setup', { method: 'POST', body: { username: d.username, password: d.password } });
});

init().catch((err) => {
  $('login-form').classList.remove('hidden');
  $('login-error').textContent = err.message;
});
