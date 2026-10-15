// The dialog shown after audio files are chosen for upload (recordings of a voice, a file to
// transcribe): it shows how long they are and asks whether to use each whole file or only its
// first part, e.g. the first minute of a long recording of one person. Then it reads just that
// part (media.js), with progress, as a 16 kHz WAV file to upload.

import { h, t, plural, formatClock, formatPercent } from './common.js';
import { openAudioFile } from './media.js';
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
 * @typedef {{ file: File, wav: Blob, seconds: number }} ChosenFile
 *   wav: 16 kHz mono WAV of the chosen part, to upload; seconds: the whole file's length
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
  /** @type {{ file: File, audio: import('./media.js').AudioFile | null, status: HTMLElement }[]} */
  const rows = files.map((file) => ({ file, audio: null, status: h('span.muted', {}, t('reading…')) }));
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
  const fieldset = h('fieldset.length-choice', {},
    h('label.check', {}, whole, plural(files.length, 'The whole file', 'The whole files')),
    h('label.check', {}, start, before, length, after));
  const form = h('form.dialog-body', {},
    h('h2', {}, title),
    h('ul.file-list', {}, rows.map((r) => h('li', {}, h('span.name', { title: r.file.name }, r.file.name), r.status))),
    fieldset,
    error,
    h('div.buttons', {}, cancel, submit));
  const dialog = h('dialog.file-dialog', {}, form);
  document.body.append(dialog);
  const controller = new AbortController(); // stops reading when the dialog is cancelled

  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      controller.abort();
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    const readable = () => rows.filter((r) => r.audio);
    const tooLong = () => readable().some((r) => r.audio.duration > maxSeconds);
    const busy = (on) => {
      submit.disabled = on;
      fieldset.disabled = on;
    };

    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let limit = Infinity;
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
      // Read the chosen part of each file now (only that part is decoded where the format allows).
      error.textContent = '';
      busy(true);
      const chosen = [];
      for (const r of readable()) {
        const show = (fraction) => {
          r.status.textContent = t('reading… {percent}', { percent: formatPercent(fraction) });
        };
        show(0);
        try {
          const { wav, seconds } = await r.audio.read(limit, show, controller.signal);
          r.status.textContent = formatClock(seconds);
          chosen.push({ file: r.file, wav, seconds });
        } catch (err) {
          if (done) return;
          r.status.textContent = formatClock(r.audio.duration || 0);
          error.textContent = err.message;
          busy(false);
          return;
        }
        if (done) return;
      }
      finish(chosen);
    });

    dialog.showModal();
    (async () => {
      const problems = [];
      for (const r of rows) {
        try {
          const audio = await openAudioFile(r.file);
          r.audio = audio;
          r.status.textContent = formatClock(audio.duration);
        } catch (err) {
          if (done) return;
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
