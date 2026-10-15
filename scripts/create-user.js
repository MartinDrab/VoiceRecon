'use strict';

/**
 * Creates a user (or resets the password of an existing one) from the command line, e.g. when
 * the administrator password is lost:
 *   npm run create-user -- <username> [--admin | --user]
 * New users are regular users unless --admin is given; an existing user keeps their role unless
 * --admin or --user is given. The password is read from the VOICERECON_PASSWORD environment
 * variable or asked for.
 */

const readline = require('readline');
const config = require('../src/config');
const { openDatabase } = require('../src/db');
const { Auth } = require('../src/auth');

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? s : '*'.repeat(s.length ? 1 : 0));
    rl.question(question, (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const username = args.find((a) => !a.startsWith('--'));
  if (!username) {
    console.error('Usage: npm run create-user -- <username> [--admin | --user]');
    process.exit(1);
  }
  const roleFlag = args.includes('--admin') ? 'admin' : args.includes('--user') ? 'user' : undefined;
  const password = process.env.VOICERECON_PASSWORD || (await ask('Password: '));

  const db = openDatabase(config.dataDir);
  const auth = new Auth(db, { sessionTtlHours: config.sessionTtlHours, secureCookies: false });
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    const u = await auth.updateUser(existing.id, { password, role: roleFlag });
    console.log(`Updated ${username} (${u.role}); the user was signed out everywhere.`);
  } else {
    const u = await auth.createUser({ username, password, role: roleFlag || 'user' });
    console.log(`Created ${username} (${u.role}).`);
  }
  db.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
