'use strict';

// The Users page: restoring a backup at the next start (backup.js). The test server is never
// restarted, so the restore itself is tested in test/backup.test.js; here the upload, the waiting
// backup, cancelling it, a refused file, and how a finished restore is shown.

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
  await status.getByRole('button', { name: 'Cancel the restore' }).click();
  await expect(page.locator('#toast')).toHaveText('The restore is cancelled.');
  await expect(status).toBeEmpty();
  expect(fs.existsSync(path.join(process.env.VOICERECON_TEST_DATA, 'restore-pending.tar'))).toBe(false);
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
