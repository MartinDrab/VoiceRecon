// The dialog shown after audio files are chosen for upload (recordings of a voice, a file to
// transcribe): it reads them, shows how long they are, and asks whether to use each whole file
// or only its first part, e.g. the first minute of a long recording of one person.

import { h, t, plural, formatClock } from './common.js';
import { decodeFile, SAMPLE_RATE } from './audio.js';
import { parseLength } from './duration.js';

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

/**
 * @typedef {{ file: File, pcm: Int16Array, seconds: number }} ChosenFile
 *   pcm: 16 kHz mono samples to upload (only the chosen part); seconds: the whole file's length
 */

/**
 * Opens the dialog for the chosen files.
 * @param {File[]} files
 * @param {{ title: string, action: string, maxSeconds: number, storeKey: string, defaultLength: number }} options
 *   action: the submit button's text; maxSeconds: the longest part the server accepts;
 *   storeKey/defaultLength: where the last chosen length is remembered, and its first value
 * @returns {Promise<ChosenFile[] | null>} the readable files, or null when cancelled
 */
export function chooseFileLength(files, { title, action, maxSeconds, storeKey, defaultLength }) {
  const remembered = parseLength(readSetting(storeKey) || '');
  const rows = files.map((file) => ({ file, pcm: null, status: h('span.muted', {}, t('reading…')) }));
  const whole = h('input', { type: 'radio', name: 'length', value: 'whole', checked: true });
  const start = h('input', { type: 'radio', name: 'length', value: 'start' });
  const length = h('input.length-input', {
    type: 'text',
    value: formatClock(remembered > 0 ? remembered : defaultLength),
    'aria-label': t('Length of the part to use'),
    title: t('Minutes:seconds, e.g. 1:30'),
    autocomplete: 'off',
    // Clicking or typing into the field chooses "only the first …".
    onfocus: () => {
      start.checked = true;
    },
    oninput: () => {
      start.checked = true;
    },
  });
  // "Only the first {0} …": {0} is the length field.
  const [before, after] = plural(files.length, 'Only the first {0}', 'Only the first {0} of each').split('{0}');
  const error = h('p.error-text');
  const submit = h('button.btn.btn-primary', { type: 'submit', disabled: true }, action);
  const cancel = h('button.btn', { type: 'button' }, t('Cancel'));
  const form = h('form.dialog-body', {},
    h('h2', {}, title),
    h('ul.file-list', {}, rows.map((r) => h('li', {}, h('span.name', { title: r.file.name }, r.file.name), r.status))),
    h('div.length-choice', {},
      h('label.check', {}, whole, plural(files.length, 'The whole file', 'The whole files')),
      h('label.check', {}, start, before, length, after)),
    error,
    h('div.buttons', {}, cancel, submit));
  const dialog = h('dialog.file-dialog', {}, form);
  document.body.append(dialog);

  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    const readable = () => rows.filter((r) => r.pcm);
    const tooLong = () => readable().some((r) => r.pcm.length / SAMPLE_RATE > maxSeconds);

    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      let limit = null;
      if (start.checked) {
        limit = parseLength(length.value);
        if (!(limit > 0)) {
          error.textContent = t('Enter the length as minutes:seconds, e.g. 1:30.');
          length.focus();
          return;
        }
        // A length above the maximum only matters for a file that is longer than the maximum.
        if (limit > maxSeconds && tooLong()) {
          error.textContent = t('At most {max} can be used.', { max: formatClock(maxSeconds) });
          length.focus();
          return;
        }
        writeSetting(storeKey, formatClock(limit));
      } else if (tooLong()) {
        error.textContent = t('A recording may be at most {max} long: use only its first part.', { max: formatClock(maxSeconds) });
        return;
      }
      finish(readable().map((r) => ({
        file: r.file,
        seconds: r.pcm.length / SAMPLE_RATE,
        pcm: limit ? r.pcm.subarray(0, Math.round(limit * SAMPLE_RATE)) : r.pcm,
      })));
    });

    dialog.showModal();
    (async () => {
      const problems = [];
      for (const r of rows) {
        try {
          r.pcm = await decodeFile(r.file);
          r.status.textContent = formatClock(r.pcm.length / SAMPLE_RATE);
        } catch (err) {
          r.status.textContent = t('cannot be read');
          r.status.className = 'unreadable';
          problems.push(err.message);
        }
        if (done) return;
      }
      error.textContent = problems.join(' ');
      if (!readable().length) return;
      submit.disabled = false;
      if (tooLong()) {
        // Too long as a whole: offer the first part, at most as long as allowed.
        start.checked = true;
        if (!(parseLength(length.value) <= maxSeconds)) length.value = formatClock(maxSeconds);
      }
      if (document.activeElement !== length) submit.focus();
    })();
  });
}
