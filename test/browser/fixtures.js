'use strict';

// What the browser tests share: the server global-setup.js started (the pages are opened signed in
// as its administrator), seeding transcripts into it, and whether the speech tests can run.

const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const path = require('path');
const seed = require('./seed');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

/**
 * Tests that transcribe or analyze voices need the speech models and the generated test audio
 * (npm run models -- --test && node scripts/make-test-audio.js); without them they skip, unless
 * VOICERECON_REQUIRE_MODELS=1 (then global-setup.js fails).
 */
function needsSpeech() {
  test.skip(process.env.VOICERECON_TEST_SPEECH !== '1', 'speech models or test audio missing');
}

/** A new transcript with audio in the test server: see seed.seedTranscript(). */
const seedTranscript = (title, lines, options) => seed.seedTranscript(process.env.VOICERECON_TEST_DATA, title, lines, options);

/** A word no other transcript contains, to search for. */
const uniqueWord = () => `zebra${crypto.randomBytes(4).toString('hex').replace(/\d/g, (d) => 'ghijklmnop'[Number(d)])}`;

module.exports = { test, expect, FIXTURES, needsSpeech, seedTranscript, uniqueWord, toneWav: seed.toneWav };
