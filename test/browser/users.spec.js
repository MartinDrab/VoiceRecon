'use strict';

// The Users page: restoring a backup at the next start (backup.js), and restarting for it
// (restart.js). The test server is never restarted (test/launch.test.js restarts a real one, and
// test/backup.test.js tests the restore); here the upload, the waiting backup, cancelling it, a
// refused file, how a finished restore is shown, and the restart button's questions.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

/** Picks `file` with the "Restore a backup…" button and answers its question with OK. */
async function restore(page, file) {
  page.once('dialog', (d) => d.accept());
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restore a backup…' }).click()]);
  await chooser.setFiles(file);
}

test('a backup uploaded on the Users page waits for the next start and can be cancelled', async ({ page }, testInfo) => {
  const file = testInfo.outputPath('backup.tar');
  fs.writeFileSync(file, await (await page.request.get('/api/backup')).body());
  await page.goto('/users');
  await restore(page, file);
  const status = page.locator('#restore-status');
  await expect(status).toContainText(/Waiting to be restored when VoiceRecon starts next: the backup of .+ \(1 user, \d+ voices?, \d+ transcripts?\)\./);
  await expect(page.locator('#toast')).toHaveText('The backup will be restored when VoiceRecon starts next.');
  await page.reload();
  await expect(status).toContainText('Waiting to be restored');
  // No launcher started this server, so nothing would start it again: no restart offered.
  await expect(status.getByRole('button', { name: 'Restart now' })).toHaveCount(0);
  expect((await page.request.post('/api/restart')).status()).toBe(409);
  await status.getByRole('button', { name: 'Cancel the restore' }).click();
  await expect(page.locator('#toast')).toHaveText('The restore is cancelled.');
  await expect(status).toBeEmpty();
  expect(fs.existsSync(path.join(process.env.VOICERECON_TEST_DATA, 'restore-pending.tar'))).toBe(false);
});

test('Restart now says who would be interrupted, and reloads the page once VoiceRecon is back', async ({ page }, testInfo) => {
  // As if the launcher had started the server, which then goes away for a moment.
  let restarted = false;
  let down = 0;
  await page.route('**/api/restart', (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { available: true, listening: 2, transcribing: 1 } });
    restarted = true;
    return route.fulfill({ json: { restarting: true } });
  });
  await page.route('**/api/setup', (route) => (restarted && down++ < 3 ? route.abort() : route.continue()));
  const file = testInfo.outputPath('backup.tar');
  fs.writeFileSync(file, await (await page.request.get('/api/backup')).body());
  await page.goto('/users');
  await restore(page, file);
  const status = page.locator('#restore-status');

  let asked = '';
  page.once('dialog', (d) => {
    asked = d.message();
    return d.accept();
  });
  const reloaded = page.waitForEvent('load');
  await status.getByRole('button', { name: 'Restart now' }).click();
  await expect(status).toContainText('Restarting VoiceRecon… This page reloads once it is back.');
  await reloaded;
  expect(asked).toBe('Restart VoiceRecon now and restore the backup? Everyone signs in again afterwards.\n\n'
    + '2 people are listening now: listening stops, and what was said so far stays saved.\n\n'
    + '1 recording is being transcribed: it stops, and the lines done so far stay.');
  expect(down).toBeGreaterThanOrEqual(3);
  await status.getByRole('button', { name: 'Cancel the restore' }).click(); // nothing was really restarted
  await expect(status).toBeEmpty();
});

test('a file that is no backup is refused', async ({ page }, testInfo) => {
  const file = testInfo.outputPath('notes.tar');
  fs.writeFileSync(file, 'not a backup at all '.repeat(100));
  await page.goto('/users');
  await restore(page, file);
  await expect(page.locator('#toast')).toHaveText('This file is not a VoiceRecon backup, or it is damaged or from a newer version.');
  await expect(page.locator('#restore-status')).toBeEmpty();
});

test('how the last restore went is shown until dismissed', async ({ page }) => {
  const note = path.join(process.env.VOICERECON_TEST_DATA, 'restore-result.json');
  fs.writeFileSync(note, JSON.stringify({ ok: true, at: Date.now(), createdAt: '2026-10-16T08:00:00.000Z', previous: 'D:/voicerecon-data.before-restore-1' }));
  await page.goto('/users');
  const status = page.locator('#restore-status');
  await expect(status).toContainText('was restored when VoiceRecon started. The previous data are in D:/voicerecon-data.before-restore-1;');
  await status.getByRole('button', { name: 'OK' }).click();
  await expect(status).toBeEmpty();
  expect(fs.existsSync(note)).toBe(false);
});
