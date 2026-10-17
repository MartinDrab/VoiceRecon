'use strict';

// The History pages: searching, playing lines, changing speakers (merging them), fixing text,
// exports. Each test seeds its own transcript (seed.js); none needs the speech models.

const fs = require('fs');
const { test, expect, seedTranscript, uniqueWord } = require('./fixtures');

const chips = (page) => page.locator('#speakers .chip'); // most lines first
const blockNames = (page) => page.locator('.hblock .who');

/** @type {[number, number | string, string][]} */
const MEETING = [
  [1, 1, 'Good morning, shall we start with the budget?'],
  [4, 2, 'Yes, the numbers came in yesterday.'],
  [7, 1, 'Then let us go through them one by one.'],
  [10, 2, 'The first item is travel.'],
];

test('the list finds transcripts by their words and opens the matching line', async ({ page }) => {
  const word = uniqueWord();
  const id = await seedTranscript('Search', [[1, 1, 'I will take the notes today.'], [4, 2, `Fine, I have the ${word} here.`]]);
  await page.goto('/history');
  await page.getByRole('searchbox', { name: 'Search all transcripts' }).fill(word);
  await expect(page.locator('.history-item')).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`\\?q=${word}$`));
  await page.locator('.history-item .snippet').click();
  await expect(page).toHaveURL(new RegExp(`/history/${id}\\?q=${word}&line=\\d+$`));
  const line = page.locator('.hline.flash');
  await expect(line).toContainText(`Fine, I have the ${word} here.`);
  await expect(line.locator('mark')).toHaveText(word);
  await expect(page.locator('#back')).toHaveAttribute('href', `/history?q=${word}`);
});

test('playing from a line follows the text until it is stopped', async ({ page }) => {
  const id = await seedTranscript('Playback', MEETING);
  await page.goto(`/history/${id}`);
  const lines = page.locator('.hline');
  await expect(lines).toHaveCount(4);
  await expect(page.locator('#export-wav')).toBeVisible();

  // From a little before the second line (4 s), as WAV decoded from the kept Opus audio.
  const audio = page.waitForResponse((r) => r.url().includes(`/api/transcripts/${id}/audio?start=`));
  await lines.nth(1).getByRole('button', { name: 'Play from here' }).click();
  const res = await audio;
  expect(res.url()).toMatch(/start=3\.80$/);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('audio/wav');
  expect(Number(res.headers()['content-length'])).toBe(44 + 2 * Math.round((14 - 3.8) * 16000));
  await expect(lines.nth(1)).toHaveClass(/playing/);

  // The third line starts at 7 s: the highlight moves on by itself.
  await expect(lines.nth(2)).toHaveClass(/playing/);
  await expect(lines.nth(1)).not.toHaveClass(/playing/);
  await lines.nth(2).getByRole('button', { name: 'Stop playing' }).click();
  await expect(page.locator('.hline.playing')).toHaveCount(0);
  await expect(lines.nth(2).getByRole('button', { name: 'Play from here' })).toBeVisible();
});

test('speakers are merged, moved to a voice and named', async ({ page }) => {
  const id = await seedTranscript('Merging', [
    [1, 1, 'I will take the notes today.'],
    [4, 2, 'Fine, I have the agenda here.'],
    [7, 3, 'Sorry, I am a little late.'],
    [10, 2, 'No problem, we just started.'],
    [13, 3, 'What did I miss?'],
    [16, 'Anna', 'Only the introductions.'],
  ]);
  await page.goto(`/history/${id}`);
  await expect(chips(page)).toHaveText(['Speaker 2 · 2', 'Speaker 3 · 2', 'Speaker 1 · 1', 'Anna · 1']);
  const dialog = page.locator('#speaker-dialog');

  // Speaker 3 is the same person as Speaker 2: all their lines.
  await blockNames(page).filter({ hasText: 'Speaker 3' }).first().click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('All 2 lines of Speaker 3 in this transcript').check();
  await dialog.locator('#others').getByRole('button', { name: /Speaker 2/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toHaveText('Changed 2 lines.');
  await expect(chips(page)).toHaveText(['Speaker 2 · 4', 'Speaker 1 · 1', 'Anna · 1']);
  await expect(blockNames(page)).toHaveText(['Speaker 1', 'Speaker 2', 'Anna']);

  // One line to a saved voice.
  await page.locator('.hline').first().getByRole('button', { name: 'Change who said this line' }).click();
  await dialog.locator('#choices').getByRole('button', { name: 'Anna' }).click();
  await expect(chips(page)).toHaveText(['Speaker 2 · 4', 'Anna · 2']);

  // A typed name for a whole speaker.
  await blockNames(page).filter({ hasText: 'Speaker 2' }).click();
  await expect(dialog.locator('#scope input')).toHaveCount(0); // the block holds all their lines
  await dialog.getByPlaceholder('Name').fill('Petra');
  await dialog.getByRole('button', { name: 'Use this name' }).click();
  await expect(chips(page)).toHaveText(['Petra · 4', 'Anna · 2']);

  await page.reload();
  await expect(blockNames(page)).toHaveText(['Anna', 'Petra', 'Anna']);
});

test('a line can be fixed, its edit cancelled, and deleted after asking', async ({ page }) => {
  const id = await seedTranscript('Editing', [
    [1, 1, 'The meating starts at ten.'],
    [4, 2, 'This line will be deleted.'],
    [7, 1, 'See you there.'],
  ]);
  await page.goto(`/history/${id}`);
  const lines = page.locator('.hline');
  await expect(lines).toHaveCount(3);

  await lines.first().getByRole('button', { name: 'Fix the text' }).click();
  const editor = page.getByRole('textbox', { name: 'Line text' });
  await expect(editor).toBeFocused();
  await editor.fill('The meeting starts at ten.');
  await editor.press('Enter');
  await expect(lines.first().locator('.text')).toHaveText('The meeting starts at ten. (edited)');

  await lines.nth(2).getByRole('button', { name: 'Fix the text' }).click();
  await editor.fill('Something else');
  await editor.press('Escape');
  await expect(lines.nth(2).locator('.text')).toHaveText('See you there.');

  // The question is answered "Cancel" first, then "OK".
  const answers = [false, true];
  const asked = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    return answers.shift() ? d.accept() : d.dismiss();
  });
  const remove = lines.nth(1).getByRole('button', { name: 'Delete the line' });
  await remove.click();
  await expect(lines).toHaveCount(3);
  await remove.click();
  await expect(lines).toHaveCount(2);
  expect(asked[0]).toBe('Delete this line?\n\n“This line will be deleted.”');

  // The title.
  await page.getByRole('textbox', { name: 'Title' }).fill('Fixed meeting');
  await page.getByRole('textbox', { name: 'Title' }).press('Enter');
  await expect(page.locator('#toast')).toHaveText('Title saved.');
  await expect(page).toHaveTitle('Fixed meeting · VoiceRecon');
});

test('exports download as files', async ({ page }) => {
  const id = await seedTranscript('Exports', MEETING);
  await page.goto(`/history/${id}`);
  const download = async (button) => {
    const [file] = await Promise.all([page.waitForEvent('download'), page.locator(`#${button}`).click()]);
    return { name: file.suggestedFilename(), body: fs.readFileSync(await file.path()) };
  };
  const vtt = await download('export-vtt');
  expect(vtt.name).toMatch(new RegExp(`^transcript-${id}-\\d{4}-\\d{2}-\\d{2}\\.vtt$`));
  expect(vtt.body.toString()).toMatch(/^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:03\.500\n<v Speaker 1>Good morning/);
  const docx = await download('export-docx');
  expect(docx.name).toMatch(/\.docx$/);
  expect(docx.body.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004'); // a zip archive
  const wav = await download('export-wav');
  expect(wav.name).toMatch(/\.wav$/);
  expect(wav.body.length).toBe(44 + 14 * 32000);
  const opus = await download('export-opus');
  expect(opus.name).toMatch(new RegExp(`^transcript-${id}-\\d{4}-\\d{2}-\\d{2}\\.opus$`));
  expect(opus.body.subarray(0, 4).toString('latin1')).toBe('OggS');
  expect(opus.body.length).toBeLessThan(wav.body.length / 5);
});

test('the list filters by voice and by date, and a transcript leads back to the filtered list', async ({ page }) => {
  // Days no other test uses, so that repeated runs do not see each other's transcripts.
  const first = Date.UTC(2040 + Math.floor(Math.random() * 50), 2, 2, 9);
  const later = first + 3 * 24 * 3600 * 1000;
  const day = (ms) => new Date(ms).toLocaleDateString('sv-SE'); // YYYY-MM-DD, as date fields take it
  const withAnna = await seedTranscript('Filter Anna', [[1, 1, 'Shall we start?'], [4, 'Anna', 'Yes, with the budget.'], [7, 'Anna', 'Then travel.']], { startedAt: first });
  await seedTranscript('Filter others', [[1, 1, 'Nobody else here.']], { startedAt: later });
  await page.goto('/history');
  const items = page.locator('.history-item');
  await page.getByLabel('From', { exact: true }).fill(day(first));
  await page.getByLabel('To', { exact: true }).fill(day(later));
  await expect(items.locator('.history-title')).toHaveText(['Filter others', 'Filter Anna']);
  await expect(page.locator('#note')).toHaveText('2 transcripts found.');

  // Everything Anna said in that time.
  await page.getByLabel('Speaker', { exact: true }).selectOption({ label: 'Anna' });
  await expect(items.locator('.history-title')).toHaveText(['Filter Anna']);
  await expect(items.first()).toContainText('Anna: 2 lines');
  await expect(items.first().locator('.snippet')).toHaveText(['Yes, with the budget.', 'Then travel.']);
  await expect(page).toHaveURL(new RegExp(`\\?voice=\\d+&from=${day(first)}&to=${day(later)}$`));

  // A transcript leads back to the list as it was.
  await items.first().locator('.history-title').click();
  await expect(page).toHaveURL(new RegExp(`/history/${withAnna}\\?voice=\\d+&from=`));
  await page.locator('#back').click();
  await expect(items.locator('.history-title')).toHaveText(['Filter Anna']);
  await expect(page.getByLabel('From', { exact: true })).toHaveValue(day(first));

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByLabel('Speaker', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeHidden();
});
