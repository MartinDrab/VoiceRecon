'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const { HttpError } = require('./errors');

const scrypt = promisify(crypto.scrypt);

const COOKIE = 'vr_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const MIN_PASSWORD = 8;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, actual);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = safeDecode(part.slice(i + 1).trim());
  }
  return out;
}

// Cookies set by other apps on the same host may contain a stray '%'; never let that throw.
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new HttpError(400, 'Username must be 3–32 characters: letters, digits, dot, dash or underscore.');
  }
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 200) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters long.`);
  }
}

function validateRole(role) {
  if (role !== 'admin' && role !== 'user') throw new HttpError(400, 'Role must be "admin" or "user".');
}

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** User accounts, login sessions and the Express middleware that guards pages and APIs. */
class Auth {
  constructor(db, { sessionTtlHours, secureCookies }) {
    this.db = db;
    this.ttlMs = sessionTtlHours * 3600 * 1000;
    this.secureCookies = secureCookies;
    this.failures = new Map(); // ip -> { count, until }
    // Checked against when a username does not exist, so both cases take the same time.
    this.dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  }

  publicUser(row) {
    return row && { id: row.id, username: row.username, role: row.role, createdAt: row.created_at };
  }

  countUsers() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  countAdmins() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  }

  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY username').all().map((u) => this.publicUser(u));
  }

  getUser(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  /** With onlyIfNoUsers, creation fails once any user exists (first-run setup). */
  async createUser({ username, password, role }, { onlyIfNoUsers = false } = {}) {
    validateUsername(username);
    validatePassword(password);
    validateRole(role);
    const hash = await hashPassword(password);
    // Check and insert with no await in between, so concurrent requests cannot both pass.
    if (onlyIfNoUsers && this.countUsers() > 0) throw new HttpError(409, 'The application is already set up.');
    if (this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      throw new HttpError(409, `User "${username}" already exists.`);
    }
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, hash, role);
    return this.publicUser(this.getUser(Number(lastInsertRowid)));
  }

  async updateUser(id, { password, role }, { keepToken } = {}) {
    const user = this.getUser(id);
    if (!user) throw new HttpError(404, 'User not found.');
    if (role !== undefined) {
      validateRole(role);
      if (user.role === 'admin' && role !== 'admin' && this.countAdmins() <= 1) {
        throw new HttpError(400, 'The last administrator cannot be demoted.');
      }
      this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    }
    if (password !== undefined) {
      validatePassword(password);
      const hash = await hashPassword(password);
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
      // A password change signs the user out everywhere except the current browser.
      this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(id, keepToken ? sha256(keepToken) : '');
    }
    return this.publicUser(this.getUser(id));
  }

  deleteUser(id) {
    const user = this.getUser(id);
    if (!user) throw new HttpError(404, 'User not found.');
    if (user.role === 'admin' && this.countAdmins() <= 1) {
      throw new HttpError(400, 'The last administrator cannot be deleted.');
    }
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  checkThrottle(ip) {
    const f = this.failures.get(ip);
    if (f && f.count >= 10 && f.until > Date.now()) {
      throw new HttpError(429, 'Too many failed login attempts. Try again in a few minutes.');
    }
  }

  noteAttempt(ip) {
    const now = Date.now();
    if (this.failures.size > 10000) {
      for (const [k, v] of this.failures) if (v.until < now) this.failures.delete(k);
    }
    const f = this.failures.get(ip);
    if (!f || f.until < now) this.failures.set(ip, { count: 1, until: now + 15 * 60 * 1000 });
    else f.count++;
  }

  async login(username, password, ip) {
    this.checkThrottle(ip);
    // Counted before the (slow) password check, so parallel attempts cannot exceed the limit;
    // a successful login clears the count.
    this.noteAttempt(ip);
    const user = typeof username === 'string' ? this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) : undefined;
    const hash = user ? user.password_hash : await this.dummyHash;
    const valid = await verifyPassword(typeof password === 'string' ? password : '', hash);
    if (!user || !valid) throw new HttpError(401, 'Wrong username or password.');
    this.failures.delete(ip);
    return { user, token: this.createSession(user.id) };
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), userId, Date.now() + this.ttlMs);
    return token;
  }

  destroySession(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  userFromToken(token) {
    if (!token) return null;
    const row = this.db.prepare(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
    ).get(sha256(token), Date.now());
    return row ? this.publicUser(row) : null;
  }

  /** Resolves the user from the session cookie of a request (HTTP or WebSocket upgrade). */
  userFromRequest(req) {
    return this.userFromToken(parseCookies(req.headers.cookie)[COOKIE]);
  }

  tokenFromRequest(req) {
    return parseCookies(req.headers.cookie)[COOKIE];
  }

  setCookie(res, token) {
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.secureCookies,
      maxAge: this.ttlMs,
      path: '/',
    });
  }

  clearCookie(res) {
    res.clearCookie(COOKIE, { path: '/' });
  }

  // ---- middleware ----

  attach() {
    return (req, _res, next) => {
      req.user = this.userFromRequest(req);
      next();
    };
  }

  requireUser() {
    return (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Please log in.')));
  }

  requireAdmin() {
    return (req, _res, next) => {
      if (!req.user) return next(new HttpError(401, 'Please log in.'));
      if (req.user.role !== 'admin') return next(new HttpError(403, 'Administrator rights are required.'));
      next();
    };
  }

  /** For HTML pages: redirects anonymous visitors to the login page. */
  requirePageUser() {
    return (req, res, next) => {
      if (req.user) return next();
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    };
  }
}

module.exports = { Auth, hashPassword, verifyPassword, parseCookies, isLoopback };
