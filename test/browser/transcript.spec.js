'use strict';

// Live listening in the browser: the microphone (a fake one playing the test conversation, see
// playwright.config.js) through pcm-worklet.js and the WebSocket to the transcript on the page,
// saved in History with its audio.

const { test, expect, needsSpeech } = require('./fixtures');

test('live listening shows what is said and saves it with its audio', async ({ page }) => {
  needsSpeech();
  test.setTimeout(120 * 1000);
  const ids = async () => (await (await page.request.get('/api/transcripts?limit=100')).json()).transcripts.map((t) => t.id);
  const before = await ids();
  await page.goto('/transcript');
  const rec = page.locator('#rec');
  await expect(rec).toHaveText('Start', { timeout: 30 * 1000 });
  await expect(rec).toBeEnabled();
  await rec.click();
  await expect(page.locator('#status')).toHaveText('Listening (audio is saved)');

  // The conversation lasts 34 s; its speakers take turns.
  const turns = page.locator('#transcript .turn:not(.pending)');
  await expect.poll(() => turns.count(), { timeout: 60 * 1000 }).toBeGreaterThanOrEqual(4);
  await expect(turns.first()).toContainText(/ahoj/i);
  await rec.click();
  await expect(page.locator('#status')).toHaveText('Ready', { timeout: 30 * 1000 });

  // Saved in History, with these lines and its audio.
  const created = (await ids()).filter((id) => !before.includes(id));
  expect(created).toHaveLength(1);
  await page.goto(`/history/${created[0]}`);
  await expect(page.locator('.hline').first()).toContainText(/ahoj/i);
  await expect(page.locator('#export-wav')).toBeVisible();
});
