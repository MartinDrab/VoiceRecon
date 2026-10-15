// Lengths of audio as people type them. No imports, so test/ui.test.js can run it in Node.

/**
 * "90" (seconds), "1:30", "1:02:03" or "0:45.5" (also "0:45,5") -> seconds; NaN for anything else.
 * @param {string} text
 * @returns {number}
 */
export function parseLength(text) {
  const parts = String(text).trim().replace(',', '.').split(':');
  if (parts.length > 3) return NaN;
  const last = parts.length - 1;
  for (let i = 0; i <= last; i++) {
    // Only the last part may have decimals; minutes and seconds after the first part stay below 60.
    if (!(i === last ? /^\d+(\.\d+)?$/ : /^\d+$/).test(parts[i])) return NaN;
    if (i > 0 && Number(parts[i]) >= 60) return NaN;
  }
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}
