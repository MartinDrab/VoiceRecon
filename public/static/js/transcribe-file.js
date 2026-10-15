// "Transcribe a file", shared by the History and Transcript pages: pick an audio or video file,
// choose how much of it to use (file-length.js), upload it with progress, and get a transcript
// that fills in while the server transcribes it in the background.

import { upload, h, t, toast, formatPercent } from './common.js';
import { wavFromInt16, SAMPLE_RATE } from './audio.js';
import { chooseFileLength } from './file-length.js';

const MAX_HOURS = 4; // as the server accepts (src/uploads.js)
const ACCEPT = 'audio/*,video/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus,.webm,.flac,.mp4';

let input = null; // the page's hidden file input
let openWhenUploaded = true;
let card = null; // the progress card of the file being uploaded (one at a time)

/**
 * Lets the user pick a file and transcribes it. Must run in a click handler: browsers open file
 * pickers only then.
 * @param {{ open?: boolean }} [options] open: go to the new transcript once it is uploaded; else
 *   show a link to it (the Transcript page keeps listening)
 */
export function transcribeFile({ open = true } = {}) {
  if (card) return;
  openWhenUploaded = open;
  if (!input) {
    input = h('input', { type: 'file', accept: ACCEPT, hidden: true });
    input.addEventListener('change', () => {
      const file = input.files[0];
      input.value = '';
      if (file) chooseAndUpload(file, openWhenUploaded);
    });
    document.body.append(input);
  }
  input.click();
}

async function chooseAndUpload(file, open) {
  const chosen = await chooseFileLength([file], {
    title: t('Transcribe a file'),
    action: t('Transcribe'),
    maxSeconds: MAX_HOURS * 3600,
    storeKey: 'voicerecon.transcribeLength',
    defaultLength: 10 * 60,
  });
  if (!chosen || !chosen.length || card) return;
  const { pcm, seconds } = chosen[0];

  const controller = new AbortController();
  const text = h('span.grow');
  const bar = h('div');
  const progress = h('div.progress', {}, bar);
  const button = h('button.btn.btn-sm', { type: 'button' }, t('Cancel'));
  const own = h('div.card.upload-card', { 'aria-live': 'polite' }, h('div.row', {}, text, button), progress);
  card = own;
  const close = () => {
    own.remove();
    if (card === own) card = null;
  };
  button.addEventListener('click', () => {
    controller.abort();
    close();
  });
  const show = (fraction) => {
    text.textContent = t('Uploading “{name}”… {percent}', { name: file.name, percent: formatPercent(fraction) });
    bar.style.width = `${Math.round(fraction * 100)}%`;
  };
  show(0);
  document.body.append(own);
  try {
    // The recording most likely ended when the file was last written; times count from its start.
    const ended = file.lastModified ? Math.min(file.lastModified, Date.now()) : Date.now();
    const params = new URLSearchParams({ name: file.name, startedAt: String(Math.max(1, ended - Math.round(seconds * 1000))) });
    const r = await upload(`/transcripts/upload?${params}`, wavFromInt16(pcm, SAMPLE_RATE), { signal: controller.signal, onProgress: show });
    if (open) {
      location.href = `/history/${r.id}`;
      return;
    }
    // Uploaded: the server transcribes it now; the link opens it in another tab.
    progress.remove();
    text.replaceChildren(t('“{name}” is being transcribed in the background.', { name: file.name }), ' ',
      h('a', { href: `/history/${r.id}`, target: '_blank', rel: 'noopener' }, t('Open in History')));
    button.textContent = t('Close');
  } catch (err) {
    if (!controller.signal.aborted) toast(err.message, { error: true });
    close();
  }
}
