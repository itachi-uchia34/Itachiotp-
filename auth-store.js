const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
fs.mkdirSync(dataDir, { recursive: true });
const usersPath = path.join(dataDir, 'auth-users.json');
const sessions = new Map();
const loginFailures = new Map();

function readUsers() {
  try {
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.chmodSync(usersPath, 0o600);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const expected = Buffer.from(hash, 'hex');
    const actual = crypto.scryptSync(password, salt, 64);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function ensureAdminFromEnvironment() {
  const users = readUsers();
  if (users.length) return users;
  const username = String(process.env.ADMIN_USERNAME || '').trim();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!username || password.length < 10) return users;
  const seeded = [{ username, passwordHash: hashPassword(password), role: 'admin', createdAt: new Date().toISOString() }];
  writeUsers(seeded);
  return seeded;
}

function login(username, password) {
  const key = String(username || '').trim().toLowerCase();
  const failures = loginFailures.get(key) || { count: 0, until: 0 };
  if (failures.until > Date.now()) throw new Error('Too many login attempts. Try again later.');
  const user = ensureAdminFromEnvironment().find((candidate) => candidate.username.toLowerCase() === key);
  if (!user || !verifyPassword(String(password || ''), user.passwordHash)) {
    failures.count += 1;
    if (failures.count >= 5) failures.until = Date.now() + 60_000;
    loginFailures.set(key, failures);
    throw new Error('Invalid username or password.');
  }
  loginFailures.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: user.username, role: user.role, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  return { token, user: { username: user.username, role: user.role } };
}

function getSession(token) {
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return session;
}

function logout(token) {
  if (token) sessions.delete(token);
}

function createUser(username, password) {
  const cleanUsername = String(username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(cleanUsername)) throw new Error('Username must be 3–32 letters, numbers, dots, underscores, or hyphens.');
  if (String(password || '').length < 10) throw new Error('Password must contain at least 10 characters.');
  const users = ensureAdminFromEnvironment();
  if (users.some((user) => user.username.toLowerCase() === cleanUsername.toLowerCase())) throw new Error('Username already exists.');
  users.push({ username: cleanUsername, passwordHash: hashPassword(password), role: 'user', createdAt: new Date().toISOString() });
  writeUsers(users);
  return { username: cleanUsername, role: 'user' };
}

function listUsers() {
  return ensureAdminFromEnvironment().map(({ username, role, createdAt }) => ({ username, role, createdAt }));
}

module.exports = { createUser, ensureAdminFromEnvironment, getSession, listUsers, login, logout };
