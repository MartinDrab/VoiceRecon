'use strict';

// The Czech translation is complete: every English text the pages and the server can show has a
// Czech text with the same placeholders, and no Czech text is left over from removed English text.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const JS = path.join(PUBLIC, 'static', 'js');
const SRC = path.join(ROOT, 'src');

const read = (file) => fs.readFileSync(file, 'utf8');
const STRING = String.raw`'((?:[^'\\]|\\.)*)'`;

/** The value of a single-quoted JavaScript string literal's body. */
function unescape(body) {
  return body.replace(/\\(.)/g, (m, c) => ({ n: '\n', t: '\t' })[c] || c);
}

/** The page dictionary (an ES module) without a module loader. */
function pageDictionary() {
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(read(path.join(JS, 'lang', 'cs.js')).replace(/^export default /m, 'module.exports = '), sandbox);
  return sandbox.module.exports;
}

function files(dir, filter) {
  return fs.readdirSync(dir, { recursive: true }).map(String).filter(filter).map((f) => path.join(dir, f));
}

/** Texts used by the page scripts: t('…') and plural(n, '…', '…') (keyed "one|other"). */
function scriptKeys() {
  const keys = new Map(); // key -> where it is used
  const scripts = files(JS, (f) => f.endsWith('.js') && !f.startsWith('lang') && f !== 'boot.js');
  for (const file of scripts) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const name = path.relative(ROOT, file);
    // i18n.js itself also translates the texts marked in the HTML, which pageKeys() collects.
    const dynamic = path.basename(file) === 'i18n.js' ? [] : code.matchAll(new RegExp(String.raw`\bt\((?!\s*')`, 'g'));
    for (const m of dynamic) {
      assert.fail(`${name}: t() must get a string literal, so that this test can find it (at ${code.slice(m.index, m.index + 40)})`);
    }
    for (const m of code.matchAll(new RegExp(String.raw`\bt\(\s*${STRING}`, 'g'))) keys.set(unescape(m[1]), name);
    for (const m of code.matchAll(new RegExp(String.raw`\bplural\([^,]+,\s*${STRING},\s*${STRING}`, 'g'))) {
      keys.set(`${unescape(m[1])}|${unescape(m[2])}`, name);
    }
  }
  return keys;
}

function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
}

/** Texts marked in the HTML with data-i18n and data-i18n-attr (see public/static/js/i18n.js). */
function pageKeys() {
  const keys = new Map();
  for (const file of files(PUBLIC, (f) => f.endsWith('.html'))) {
    const html = read(file);
    const name = path.relative(ROOT, file);
    const marked = /<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*?)\s+data-i18n(?:="([^"]*)")?(?=[\s>])([^>]*)>([^<]*)/g;
    for (const m of html.matchAll(marked)) {
      const key = m[3] !== undefined ? m[3] : m[5].trim().replace(/\s+/g, ' ');
      assert.ok(key, `${name}: empty data-i18n text in <${m[1]}${m[2]}>`);
      keys.set(decodeEntities(key), name);
    }
    for (const m of html.matchAll(/<\w+([^>]*)\sdata-i18n-attr="([^"]*)"/g)) {
      const tag = m[0] + html.slice(m.index + m[0].length, html.indexOf('>', m.index));
      for (const attr of m[2].split(',')) {
        const value = new RegExp(`\\s${attr}="([^"]*)"`).exec(tag);
        assert.ok(value && value[1], `${name}: data-i18n-attr names ${attr}, but the element has no ${attr} text`);
        keys.set(decodeEntities(value[1]), name);
      }
    }
  }
  return keys;
}

/** Messages the server sends to users: HttpError and Error texts, and translate(lang, '…'). */
function serverKeys() {
  const keys = new Map();
  // The evaluation tool, the configuration and restoring a backup only talk to the command line,
  // in English (a backup's download fails only with an internal error).
  const sources = files(SRC, (f) => f.endsWith('.js') && !f.startsWith('lang') && !['evaluation.js', 'config.js', 'backup.js'].includes(f));
  for (const file of sources) {
    const code = read(file);
    const name = path.relative(ROOT, file);
    const patterns = [
      new RegExp(String.raw`new HttpError\(\d+,\s*${STRING}`, 'g'),
      new RegExp(String.raw`new Error\(\s*${STRING}`, 'g'),
      new RegExp(String.raw`translate\(\w+,\s*${STRING}`, 'g'),
    ];
    for (const re of patterns) for (const m of code.matchAll(re)) keys.set(unescape(m[1]), name);
    assert.ok(!/new (Http)?Error\([^)]*`/.test(code), `${name}: messages must be templates with {placeholders}, not \`...\``);
  }
  return keys;
}

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** Every key has a Czech text with the same placeholders, and every Czech text has a key. */
function checkDictionary(dictionary, keys, name) {
  const missing = [...keys].filter(([key]) => !(key in dictionary)).map(([key, where]) => `  ${JSON.stringify(key)} (${where})`);
  assert.deepStrictEqual(missing, [], `${name} has no Czech text for:\n${missing.join('\n')}`);
  const unused = Object.keys(dictionary).filter((key) => !keys.has(key));
  assert.deepStrictEqual(unused, [], `${name} has texts that nothing uses any more`);
  for (const [key, value] of Object.entries(dictionary)) {
    if (key.includes('|')) {
      assert.ok(value && typeof value === 'object', `${name}: ${JSON.stringify(key)} needs the forms { one, few, other }`);
      for (const form of ['one', 'few', 'other']) assert.ok(value[form], `${name}: ${JSON.stringify(key)} has no "${form}" form`);
      const [one, other] = key.split('|');
      assert.deepStrictEqual(placeholders(value.one), placeholders(one), `${name}: placeholders of ${JSON.stringify(key)} (one)`);
      for (const form of ['few', 'many', 'other']) {
        if (value[form]) assert.deepStrictEqual(placeholders(value[form]), placeholders(other), `${name}: placeholders of ${JSON.stringify(key)} (${form})`);
      }
    } else {
      assert.strictEqual(typeof value, 'string', `${name}: ${JSON.stringify(key)}`);
      assert.deepStrictEqual(placeholders(value), placeholders(key), `${name}: placeholders of ${JSON.stringify(key)}`);
    }
  }
}

test('every text of the pages has a Czech translation', () => {
  const keys = new Map([...pageKeys(), ...scriptKeys()]);
  assert.ok(keys.size > 100, `found only ${keys.size} texts`);
  checkDictionary(pageDictionary(), keys, 'public/static/js/lang/cs.js');
});

test('every message of the server has a Czech translation', () => {
  const keys = serverKeys();
  keys.set('request entity too large', 'Express (body too large)');
  assert.ok(keys.size > 40, `found only ${keys.size} messages`);
  checkDictionary(require('../src/lang/cs'), keys, 'src/lang/cs.js');
});

test('Czech plural forms follow the Czech rules', () => {
  const rules = new Intl.PluralRules('cs');
  assert.deepStrictEqual([1, 2, 4, 5, 0, 22, 101].map((n) => rules.select(n)), ['one', 'few', 'few', 'other', 'other', 'other', 'other']);
});

test('the server picks the language from the cookie, then from the browser', () => {
  const { languageOf, translate } = require('../src/i18n');
  const req = (cookie, accept) => ({ headers: { cookie, 'accept-language': accept } });
  assert.strictEqual(languageOf(req('vr_lang=cs', 'en-US')), 'cs');
  assert.strictEqual(languageOf(req('a=1; vr_lang=en', 'cs-CZ')), 'en');
  assert.strictEqual(languageOf(req('vr_lang=de', 'sk-SK,en;q=0.5')), 'cs');
  assert.strictEqual(languageOf(req(undefined, 'de-DE,en;q=0.8,cs;q=0.5')), 'en');
  assert.strictEqual(languageOf(req(undefined, undefined)), 'en');
  assert.strictEqual(translate('cs', 'Password must be at least {min} characters long.', { min: 8 }), 'Heslo musí mít alespoň 8 znaků.');
  assert.strictEqual(translate('en', 'Password must be at least {min} characters long.', { min: 8 }), 'Password must be at least 8 characters long.');
  assert.strictEqual(translate('cs', 'Some new message.'), 'Some new message.');
});
