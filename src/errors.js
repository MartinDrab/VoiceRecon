'use strict';

const { format } = require('./i18n');

/**
 * An error whose message is safe to show to the user, with the HTTP status to answer with. The
 * message is an English template with {name} placeholders for `params`; it is translated into
 * the user's language when it is sent (see src/i18n.js and src/lang/cs.js).
 */
class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} template
   * @param {Record<string, string | number>} [params]
   */
  constructor(status, template, params) {
    super(format(template, params));
    this.status = status;
    this.template = template;
    this.params = params;
  }
}

module.exports = { HttpError };
