import { api, h, icon, toast, initPage, t, locale, formatNumber } from './common.js';

/** Elements by id; typed loosely because the pages read form fields, dialogs and buttons alike. */
const $ = (id) => /** @type {any} */ (document.getElementById(id));
let me = null;
let resetting = null;

const created = (s) => new Date(`${s.replace(' ', 'T')}Z`).toLocaleDateString(locale);

async function loadUsers() {
  const { users } = await api('/users');
  $('user-rows').replaceChildren(...users.map((u) => {
    const self = u.id === me.id;
    const role = h('select', {
      'aria-label': t('Role of {username}', { username: u.username }),
      onchange: (e) => change(u, { role: e.target.value }),
    }, h('option', { value: 'user', selected: u.role === 'user' }, t('User')),
    h('option', { value: 'admin', selected: u.role === 'admin' }, t('Administrator')));
    return h('tr', {},
      h('td', {}, h('strong', {}, u.username), self ? h('span.muted', {}, ` ${t('(you)')}`) : null),
      h('td', {}, role),
      h('td.muted', {}, created(u.createdAt)),
      h('td.actions', {},
        h('button.btn.btn-sm', { onclick: () => openReset(u) }, t('Set password')),
        ' ',
        h('button.btn.btn-sm.btn-ghost.btn-danger', {
          title: self ? t('You cannot delete your own account') : t('Delete {username}', { username: u.username }),
          disabled: self,
          onclick: () => remove(u),
        }, icon('trash'))));
  }));
}

async function change(u, changes) {
  try {
    await api(`/users/${u.id}`, { method: 'PATCH', body: changes });
    toast(t('Saved.'));
  } catch (err) {
    toast(err.message, { error: true });
  }
  await loadUsers();
}

async function remove(u) {
  if (!confirm(t('Delete the user “{username}”?', { username: u.username }))) return;
  try {
    await api(`/users/${u.id}`, { method: 'DELETE' });
    toast(t('User deleted.'));
  } catch (err) {
    toast(err.message, { error: true });
  }
  await loadUsers();
}

function openReset(u) {
  resetting = u;
  $('reset-title').textContent = t('Set password for {username}', { username: u.username });
  $('reset-password').value = '';
  $('reset-error').textContent = '';
  $('reset-dialog').showModal();
}

$('reset-cancel').addEventListener('click', () => $('reset-dialog').close());
$('reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/users/${resetting.id}`, { method: 'PATCH', body: { password: $('reset-password').value } });
    $('reset-dialog').close();
    toast(resetting.id === me.id
      ? t('Password changed.')
      : t('Password changed. {username} was signed out everywhere.', { username: resetting.username }));
  } catch (err) {
    $('reset-error').textContent = err.message;
  }
});

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  $('add-error').textContent = '';
  try {
    await api('/users', { method: 'POST', body: data });
    form.reset();
    toast(t('User {username} added.', { username: String(data.username) }));
    await loadUsers();
  } catch (err) {
    $('add-error').textContent = err.message;
  }
});

// ---------- audio of transcripts ----------

function showAudio(s) {
  $('keep-audio').checked = s.keep;
  $('audio-limit').value = String(s.limitGb);
  const gb = s.usedBytes / 1024 ** 3;
  const size = gb >= 1 ? `${formatNumber(gb, 1)} GB` : `${formatNumber(Math.ceil(s.usedBytes / 1024 ** 2), 0)} MB`;
  $('audio-used').textContent = t('Audio kept now: {size}.', { size });
}

$('audio-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('audio-error').textContent = '';
  try {
    showAudio(await api('/settings/audio', { method: 'PUT', body: { keep: $('keep-audio').checked, limitGb: Number($('audio-limit').value) } }));
    toast(t('Saved.'));
  } catch (err) {
    $('audio-error').textContent = err.message;
  }
});

$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  $('password-error').textContent = '';
  if (data.newPassword !== data.confirm) {
    $('password-error').textContent = t('The new passwords do not match.');
    return;
  }
  try {
    await api('/me/password', { method: 'POST', body: { currentPassword: data.currentPassword, newPassword: data.newPassword } });
    form.reset();
    toast(t('Password changed. Other sessions were signed out.'));
  } catch (err) {
    $('password-error').textContent = err.message;
  }
});

initPage('users').then(async (user) => {
  me = user;
  $('account-info').textContent = user.role === 'admin'
    ? t('Signed in as {username} (administrator).', { username: user.username })
    : t('Signed in as {username} (user).', { username: user.username });
  if (user.role === 'admin') {
    $('admin-section').classList.remove('hidden');
    await loadUsers();
    showAudio(await api('/settings/audio'));
  } else {
    $('account-section').classList.remove('mt');
  }
}).catch((err) => toast(err.message, { error: true }));
