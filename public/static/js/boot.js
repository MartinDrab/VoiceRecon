// Runs before the page is drawn: loaded as an ordinary (blocking) script in <head>, so there is no
// flash of the wrong theme or language.
//
// Theme: "system" (the default) follows the operating system; "light" and "dark" override it via
// <html data-theme>. See the theme tokens in app.css.
//
// Language: the user's choice (cookie "vr_lang", also read by the server), otherwise Czech for
// browsers that prefer Czech or Slovak, otherwise English. Sets <html lang>; for Czech the body
// stays hidden (class i18n-pending) until i18n.js has translated the page.
(() => {
  'use strict';

  // ---------- theme ----------

  const KEY = 'voicerecon.theme';
  const MODES = ['system', 'light', 'dark'];

  const read = () => {
    try {
      const v = localStorage.getItem(KEY);
      return MODES.includes(v) ? v : 'system';
    } catch {
      return 'system';
    }
  };

  const apply = (mode) => {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    window.dispatchEvent(new CustomEvent('voicerecon-theme', { detail: mode }));
  };

  apply(read());

  window.voiceReconTheme = {
    modes: MODES,
    get: read,
    set(mode) {
      if (!MODES.includes(mode)) return;
      try {
        localStorage.setItem(KEY, mode);
      } catch { /* not remembered, but still applied */ }
      apply(mode);
    },
    /** system -> light -> dark -> system */
    next() {
      this.set(MODES[(MODES.indexOf(read()) + 1) % MODES.length]);
      return read();
    },
  };

  // Keep other open tabs in step.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) apply(read());
  });

  // ---------- language ----------

  const chosen = /(?:^|;\s*)vr_lang=(cs|en)(?:;|$)/.exec(document.cookie);
  let lang = chosen ? chosen[1] : 'en';
  if (!chosen) {
    for (const l of navigator.languages || [navigator.language || '']) {
      const code = String(l).slice(0, 2).toLowerCase();
      if (code === 'cs' || code === 'sk') {
        lang = 'cs';
        break;
      }
      if (code === 'en') break;
    }
  }
  document.documentElement.lang = lang;
  if (lang !== 'en') document.documentElement.classList.add('i18n-pending');
})();
