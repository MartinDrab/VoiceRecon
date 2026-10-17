'use strict';

/**
 * Restarting VoiceRecon from the Users page, e.g. to restore an uploaded backup: the server exits
 * with RESTART_CODE and whatever started it starts it again. scripts/launch.js (behind start.cmd and
 * start.sh) does that and says so with VOICERECON_SUPERVISED=1; another supervisor (a service that
 * restarts the server when it exits with 75) may set the variable too. Without it the server cannot
 * come back by itself, so it does not offer to restart.
 */

const RESTART_CODE = 75;

const supervised = () => process.env.VOICERECON_SUPERVISED === '1';

module.exports = { RESTART_CODE, supervised };
