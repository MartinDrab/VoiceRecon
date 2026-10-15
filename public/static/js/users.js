import { api, h, icon, toast, initPage } from './common.js';

const $ = (id) => document.getElementById(id);
let me = null;
let resetting = null;

const created = (s) => new Date(`${s.replace(' ', 'T')}Z`).toLocaleDateString();

async function loadUsers() {
  const { users } = await api('/users');
  $('user-rows').replaceChildren(...users.map((u) => {
    const self = u.id === me.id;
    const role = h('select', {
      'aria-label': `Role of ${u.username}`,
      onchange: (e) => change(u, { role: e.target.value }),
    }, h('option', { value: 'user', selected: u.role === 'user' }, 'User'),
    h('option', { value: 'admin', selected: u.role === 'admin' }, 'Administrator'));
    return h('tr', {},
      h('td', {}, h('strong', {}, u.username), self ? h('span.muted', {}, ' (you)') : null),
      h('td', {}, role),
      h('td.muted', {}, created(u.createdAt)),
      h('td.actions', {},
        h('button.btn.btn-sm', { onclick: () => openReset(u) }, 'Set password'),
        ' ',
        h('button.btn.btn-sm.btn-ghost.btn-danger', {
          title: self ? 'You cannot delete your own account' : `Delete ${u.username}`,
          disabled: self,
          onclick: () => remove(u),
        }, icon('trash'))));
  }));
}

async function change(u, changes) {
  try {
    await api(`/users/${u.id}`, { method: 'PATCH', body: changes });
    toast('Saved.');
  } catch (err) {
    toast(err.message, { error: true });
  }
  await loadUsers();
}

async function remove(u) {
  if (!confirm(`Delete the user “${u.username}”?`)) return;
  try {
    await api(`/users/${u.id}`, { method: 'DELETE' });
    toast('User deleted.');
  } catch (err) {
    toast(err.message, { error: true });
  }
  await loadUsers();
}

function openReset(u) {
  resetting = u;
  $('reset-title').textContent = `Set password for ${u.username}`;
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
    toast(resetting.id === me.id ? 'Password changed.' : `Password changed. ${resetting.username} was signed out everywhere.`);
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
    toast(`User ${data.username} added.`);
    await loadUsers();
  } catch (err) {
    $('add-error').textContent = err.message;
  }
});

$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  $('password-error').textContent = '';
  if (data.newPassword !== data.confirm) {
    $('password-error').textContent = 'The new passwords do not match.';
    return;
  }
  try {
    await api('/me/password', { method: 'POST', body: { currentPassword: data.currentPassword, newPassword: data.newPassword } });
    form.reset();
    toast('Password changed. Other sessions were signed out.');
  } catch (err) {
    $('password-error').textContent = err.message;
  }
});

initPage('users').then(async (user) => {
  me = user;
  $('account-info').textContent = `Signed in as ${user.username} (${user.role === 'admin' ? 'administrator' : 'user'}).`;
  if (user.role === 'admin') {
    $('admin-section').classList.remove('hidden');
    await loadUsers();
  } else {
    $('account-section').classList.remove('mt');
  }
}).catch((err) => toast(err.message, { error: true }));
