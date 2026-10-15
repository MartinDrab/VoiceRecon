// Czech and English for the pages. The English text is the key, with {name} placeholders for
// values; lang/cs.js has the Czech text. boot.js has already chosen the language (<html lang>).
//
// Static text in the HTML is marked for translation:
//   <h1 data-i18n>History</h1>                          the text itself is the key
//   <p data-i18n="Press {0} or {1} to start."><kbd>…    a template; {0}, {1} are the child elements
//   <input data-i18n-attr="placeholder,title" …>         attributes whose values are keys
// test/i18n.test.js checks that every key used in the pages has a Czech text.

import CS from './lang/cs.js';

/** @type {'cs' | 'en'} */
export const lang = document.documentElement.lang === 'cs' ? 'cs' : 'en';

/** Locale for dates and numbers; English pages use the browser's own conventions. */
export const locale = lang === 'cs' ? 'cs-CZ' : undefined;

const pluralRules = new Intl.PluralRules(lang);

function format(text, params) {
  return String(text).replace(/\{(\w+)\}/g, (m, key) => (params && key in params ? String(params[key]) : m));
}

/**
 * The text in the page's language.
 * @param {string} text English text (the key)
 * @param {Record<string, string | number>} [params] values for {name} placeholders
 */
export function t(text, params) {
  const translated = lang === 'cs' && typeof CS[text] === 'string' ? CS[text] : text;
  return format(translated, params);
}

/**
 * A count with the right word form: plural(3, '{n} line', '{n} lines'). Czech has more forms
 * (1 řádek, 2 řádky, 5 řádků); lang/cs.js keys them as "one|other" -> { one, few, many, other }.
 */
export function plural(n, one, other, params) {
  const values = { n: formatNumber(n), ...params };
  const forms = lang === 'cs' ? CS[`${one}|${other}`] : null;
  if (forms && typeof forms === 'object') return format(forms[pluralRules.select(n)] || forms.other, values);
  return format(n === 1 ? one : other, values);
}

export function formatNumber(n, digits) {
  const options = digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  return new Intl.NumberFormat(locale, options).format(n);
}

/** Unknown speakers are stored as "Speaker 2"; this shows them in the page's language. */
export function speakerLabel(label) {
  const m = /^Speaker (\d+)$/.exec(label || '');
  return m ? t('Speaker {n}', { n: m[1] }) : label;
}

const templateChildren = new WeakMap(); // element -> its original child elements ({0}, {1}, …)

/** Translates the static text of the page (see the top of this file). */
export function translatePage(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const node = /** @type {HTMLElement} */ (el);
    if (!node.dataset.i18nKey) node.dataset.i18nKey = node.dataset.i18n || node.textContent.trim().replace(/\s+/g, ' ');
    const text = t(node.dataset.i18nKey);
    if (node.dataset.i18n && (node.children.length || templateChildren.has(node))) {
      if (!templateChildren.has(node)) templateChildren.set(node, [...node.children]);
      const kids = templateChildren.get(node);
      node.replaceChildren(...text.split(/\{(\d+)\}/).map((part, i) => (i % 2 ? kids[Number(part)] : part)));
    } else {
      node.textContent = text;
    }
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const attr of /** @type {HTMLElement} */ (el).dataset.i18nAttr.split(',')) {
      const keyAttr = `data-i18n-${attr}`;
      if (!el.hasAttribute(keyAttr)) el.setAttribute(keyAttr, el.getAttribute(attr) || '');
      el.setAttribute(attr, t(el.getAttribute(keyAttr)));
    }
  }
}

export const LANGUAGES = { en: 'English', cs: 'Čeština' };

/** Remembers the language (for the pages and the server) and reloads the page in it. */
export function setLanguage(next) {
  document.cookie = `vr_lang=${next}; path=/; max-age=31536000; samesite=lax`;
  location.reload();
}

translatePage();
document.documentElement.classList.remove('i18n-pending');
