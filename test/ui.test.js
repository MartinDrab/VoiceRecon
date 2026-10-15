'use strict';

// Static checks of the web pages that are easy to break without noticing in one theme.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(PUBLIC, 'static', 'css', 'app.css'), 'utf8');

test('every page applies the saved theme before its stylesheet (no flash of the wrong theme)', () => {
  const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length >= 6);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    const theme = html.indexOf('<script src="/static/js/boot.js"></script>');
    const style = html.indexOf('<link rel="stylesheet" href="/static/css/app.css">');
    assert.ok(theme > 0 && style > theme, `${page} must load boot.js (not as a module) before app.css`);
  }
});

/** Declarations of the first rule block that follows `selector`. */
function block(selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `missing ${selector}`);
  const open = css.indexOf('{', start);
  const body = css.slice(open + 1, css.indexOf('}', open)).replace(/\/\*[\s\S]*?\*\//g, '');
  return body.split(';').map((d) => d.trim()).filter(Boolean);
}

test('the dark theme is defined identically for the system setting and the manual choice', () => {
  const system = block(':root:not([data-theme="light"])');
  const manual = block(':root[data-theme="dark"]');
  assert.deepStrictEqual(system, manual);
});

test('both themes define every color token', () => {
  const names = (decls) => decls.filter((d) => d.startsWith('--')).map((d) => d.split(':')[0]).sort();
  const light = names(block(':root {')).filter((n) => !['--radius', '--font'].includes(n));
  assert.deepStrictEqual(names(block(':root[data-theme="dark"]')), light);
});

test('lengths of audio are read as seconds, minutes:seconds or hours:minutes:seconds', () => {
  const sandbox = {};
  const source = fs.readFileSync(path.join(PUBLIC, 'static', 'js', 'duration.js'), 'utf8');
  require('vm').runInNewContext(source.replace(/^export /gm, ''), sandbox);
  const { parseLength } = sandbox;
  const cases = { '90': 90, '1:30': 90, ' 0:45 ': 45, '0:45.5': 45.5, '0:45,5': 45.5, '1:02:03': 3723, '10:00': 600, '0': 0 };
  for (const [text, seconds] of Object.entries(cases)) assert.strictEqual(parseLength(text), seconds, text);
  for (const text of ['', '1:', ':30', '1:60', '1:2:3:4', '1.5:00', 'abc', '-5', '1:30 min']) {
    assert.ok(Number.isNaN(parseLength(text)), text);
  }
});
