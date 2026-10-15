'use strict';

/**
 * Server-side translation of user-facing messages (errors, export texts). The English text is
 * the key, with {name} placeholders for values; lang/cs.js has the Czech text. The language is
 * the one the user chose in the pages (cookie "vr_lang"), otherwise the browser's preference.
 */

const CS = require('./lang/cs');

const LANGUAGES = ['en', 'cs'];

function format(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (m, key) => (params && key in params ? String(params[key]) : m));
}

/** Translates an English template into `lang` and fills in the params. */
function translate(lang, template, params) {
  const text = lang === 'cs' && typeof CS[template] === 'string' ? CS[template] : template;
  return format(text, params);
}

/** "cs" for Czech or Slovak preferences, "en" otherwise (the same rule as public/static/js/boot.js). */
function fromAcceptLanguage(header) {
  for (const part of String(header || '').split(',')) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if (code === 'cs' || code === 'sk') return 'cs';
    if (code === 'en') return 'en';
  }
  return 'en';
}

/** The language for a request or WebSocket upgrade: the user's choice, else the browser's. */
function languageOf(req) {
  const m = /(?:^|;\s*)vr_lang=(\w+)/.exec(req.headers.cookie || '');
  if (m && LANGUAGES.includes(m[1])) return m[1];
  return fromAcceptLanguage(req.headers['accept-language']);
}

module.exports = { LANGUAGES, format, translate, languageOf, fromAcceptLanguage };
