'use strict';

// "Transcribe a file": the dialog that shows a file's length and lets a part of it be chosen
// (file-length.js, also used on the Voices page), reading that part in the browser, uploading it.

const path = require('path');
const { test, expect, FIXTURES, needsSpeech, toneWav } = require('./fixtures');

/** Opens the dialog on the History page with a file. */
async function chooseFile(page, file) {
  await page.goto('/history');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Transcribe a file' }).click()]);
  await chooser.setFiles(file);
  const dialog = page.locator('dialog.file-dialog');
  await expect(dialog.getByRole('heading', { name: 'Transcribe a file' })).toBeVisible();
  return dialog;
}

test('the dialog shows the length, refuses a part that is not there, and cancels without uploading', async ({ page }) => {
  const uploads = [];
  page.on('request', (r) => r.url().includes('/upload') && uploads.push(r.url()));
  const dialog = await chooseFile(page, { name: 'meeting.wav', mimeType: 'audio/wav', buffer: toneWav(20) });
  await expect(dialog.locator('.file-list li')).toHaveText('meeting.wav00:20');
  await expect(dialog.getByLabel('The whole file')).toBeChecked();

  // Typing a start chooses "only part of it".
  const from = dialog.getByRole('textbox', { name: 'Where the part starts' });
  const length = dialog.getByRole('textbox', { name: 'Length of the part to use' });
  await from.fill('0:30');
  await expect(dialog.getByLabel('Only part of it:')).toBeChecked();
  await dialog.getByRole('button', { name: 'Transcribe' }).click();
  await expect(dialog.locator('.error-text')).toHaveText('“meeting.wav” is only 00:20 long.');
  await expect(from).toBeFocused();
  await from.fill('0:05');
  await length.fill('soon');
  await dialog.getByRole('button', { name: 'Transcribe' }).click();
  await expect(dialog.locator('.error-text')).toHaveText('Enter the length as minutes:seconds, e.g. 1:30.');

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(uploads).toEqual([]);
});

test('a file the browser cannot read is shown as such', async ({ page }) => {
  const dialog = await chooseFile(page, { name: 'notes.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('not audio at all') });
  await expect(dialog.locator('.file-list li')).toContainText('cannot be read');
  await expect(dialog.getByRole('button', { name: 'Transcribe' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('only the chosen part is uploaded, with where it starts', async ({ page }) => {
  const dialog = await chooseFile(page, { name: 'meeting.wav', mimeType: 'audio/wav', buffer: toneWav(20) });
  await dialog.getByRole('textbox', { name: 'Where the part starts' }).fill('0:05');
  await dialog.getByRole('textbox', { name: 'Length of the part to use' }).fill('0:10');
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/api/transcripts/upload')),
    dialog.getByRole('button', { name: 'Transcribe' }).click(),
  ]);
  const url = new URL(request.url());
  expect(url.searchParams.get('name')).toBe('meeting.wav');
  expect(url.searchParams.get('offset')).toBe('5');
  expect(Number((await request.allHeaders())['content-length'])).toBe(44 + 10 * 32000); // 10 s of 16 kHz mono
  await expect(page).toHaveURL(/\/history\/\d+$/); // the new transcript opens
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('meeting'); // the file name without its extension
});

test('an uploaded part is transcribed with the times of the whole recording', async ({ page }) => {
  needsSpeech();
  test.setTimeout(120 * 1000);
  const dialog = await chooseFile(page, path.join(FIXTURES, 'conversation.wav'));
  await expect(dialog.locator('.file-list li')).toHaveText('conversation.wav00:34');
  await dialog.getByRole('textbox', { name: 'Where the part starts' }).fill('0:10');
  await dialog.getByRole('textbox', { name: 'Length of the part to use' }).fill('0:15');
  await dialog.getByRole('button', { name: 'Transcribe' }).click();
  await expect(page).toHaveURL(/\/history\/\d+$/);
  await expect(page.locator('#toast')).toHaveText('The recording is transcribed.', { timeout: 60 * 1000 });

  const times = await page.locator('.hline .time').allTextContents();
  expect(times.length).toBeGreaterThan(1);
  for (const time of times) expect(time >= '00:10' && time <= '00:25', time).toBe(true);
  await expect(page.locator('.hline').first()).toContainText(/\w+/);
});
