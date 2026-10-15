'use strict';

/** An error whose message is safe to show to the user, with the HTTP status to answer with. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { HttpError };
