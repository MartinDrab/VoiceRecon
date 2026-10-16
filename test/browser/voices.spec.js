'use strict';

// The Voices page: voices and their settings, and (with the speech models) recordings added from
// files, their warnings, and testing recognition with a clip.

const path = require('path');
const { test, expect, FIXTURES, needsSpeech } = require('./fixtures');

/** The card of the voice with this name. */
const card = (page, name) => page.locator('.voice-card').filter({ has: page.locator(`input.voice-name[value="${name}"]`) });

/** Creates a voice through the "New voice" dialog. */
async function createVoice(page, name) {
  await page.getByRole('button', { name: 'New voice' }).click();
  const dialog = page.locator('#voice-dialog');
  await expect(dialog.getByLabel('Name')).toBeFocused();
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page, name)).toBeVisible();
}

/** Picks files with a button that opens the file picker, then confirms the length dialog. */
async function upload(page, button, files, action) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
  await chooser.setFiles(files);
  const dialog = page.locator('dialog.file-dialog');
  await expect(dialog.getByRole('button', { name: action })).toBeEnabled();
  await dialog.getByRole('button', { name: action }).click();
  await expect(dialog).toHaveCount(0);
}

// Voices a test created are deleted after it, also when it failed: a second Coqui with the same
// recording would make recognizing Coqui a tie. Anna (seeded) stays for the History tests.
test.afterEach(async ({ page }) => {
  const { voices } = await (await page.request.get('/api/voices')).json();
  for (const v of voices) if (v.name !== 'Anna') await page.request.delete(`/api/voices/${v.id}`);
});

test('a voice is created, renamed and deleted', async ({ page }) => {
  await page.goto('/voices');
  await createVoice(page, 'Klára');
  const klara = card(page, 'Klára');
  await expect(klara).toContainText('No recordings');
  await expect(klara).toContainText('Not recognizable yet: add a recording of this person speaking.');

  await klara.getByRole('textbox', { name: 'Voice name' }).fill('Klára N.');
  await klara.getByRole('textbox', { name: 'Voice name' }).press('Enter');
  await expect(card(page, 'Klára N.')).toBeVisible();
  await page.reload();
  const renamed = card(page, 'Klára N.');
  await expect(renamed).toBeVisible();

  page.once('dialog', (d) => {
    expect(d.message()).toBe('Delete the voice “Klára N.” and all its recordings?');
    return d.accept();
  });
  await renamed.getByRole('button', { name: 'Delete voice' }).click();
  await expect(page.locator('#toast')).toHaveText('Voice deleted.');
  await expect(renamed).toHaveCount(0);
});

test('an administrator saves the names and terms', async ({ page }) => {
  await page.goto('/voices');
  const words = page.getByPlaceholder('One per line, e.g. Kyjev');
  await words.fill('Kyjev\nFlagan');
  await page.locator('#vocabulary-save').click();
  await expect(page.locator('#toast')).toHaveText('Names and terms saved.');
  await page.reload();
  await expect(words).toHaveValue('Kyjev\nFlagan');
  await words.fill('');
  await page.locator('#vocabulary-save').click();
  await expect(page.locator('#toast')).toHaveText('Names and terms saved.');
});

test('recordings are added from files, warned about, played, and recognize their voice', async ({ page }) => {
  needsSpeech();
  test.setTimeout(120 * 1000);
  await page.goto('/voices');
  await expect(page.locator('#models-notice')).toBeHidden();
  for (const name of ['Jirka', 'Coqui']) {
    await createVoice(page, name);
    await upload(page, card(page, name).getByRole('button', { name: 'Upload' }), path.join(FIXTURES, 'voices', `${name.toLowerCase()}.wav`), 'Add the recording');
    await expect(page.locator('#toast')).toHaveText(`Added ${name.toLowerCase()}.wav.`, { timeout: 30 * 1000 });
    await expect(card(page, name)).toContainText(/1 recording · \d+ s of speech/);
  }

  // A clip of Coqui is recognized as Coqui.
  await upload(page, page.getByRole('button', { name: 'Upload clip' }), path.join(FIXTURES, 'voices', 'coqui.wav'), 'Test');
  await expect(page.locator('#test-status')).toHaveText('Recognized as Coqui.', { timeout: 30 * 1000 });
  await expect(page.locator('#test-scores .score-row')).toHaveCount(2);

  // Coqui's recording added to Jirka by mistake is pointed out, and deleted again.
  const jirka = card(page, 'Jirka');
  await upload(page, jirka.getByRole('button', { name: 'Upload' }), path.join(FIXTURES, 'voices', 'coqui.wav'), 'Add the recording');
  await expect(jirka.locator('.sample-warning').filter({ hasText: /It sounds like Coqui \(\d\.\d\d\): is it really Jirka\?/ })).toBeVisible({ timeout: 30 * 1000 });
  page.once('dialog', (d) => d.accept());
  await jirka.locator('.samples li').nth(1).getByRole('button', { name: 'Delete recording' }).click();
  await expect(jirka.locator('.samples li')).toHaveCount(1);
  await expect(jirka.locator('.sample-warning')).toHaveCount(0);

  // Playing a recording; its button stops it.
  const audio = page.waitForResponse((r) => /\/api\/voices\/\d+\/samples\/\d+\/audio$/.test(r.url()));
  await jirka.getByRole('button', { name: 'Play' }).click();
  expect([200, 206]).toContain((await audio).status()); // or a range of it
  await jirka.getByRole('button', { name: 'Stop' }).click();
  await expect(jirka.getByRole('button', { name: 'Play' })).toBeVisible();
});
