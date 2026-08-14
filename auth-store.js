const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
fs.mkdirSync(dataDir, { recursive: true });
const usersPath = path.join(dataDir, 'auth-users.json');
const registrationPath = path.join(dataDir, 'registration-requests.json');
const REGISTRATION_TTL_MS = 30 * 60 * 1000;
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

function readRegistrationRequests() {
  try {
    const requests = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
    return Array.isArray(requests) ? requests : [];
  } catch {
    return [];
  }
}

function writeRegistrationRequests(requests) {
  fs.writeFileSync(registrationPath, JSON.stringify(requests, null, 2), { mode: 0o600 });
  fs.chmodSync(registrationPath, 0o600);
}

function activeRegistrationRequests() {
  const allRequests = readRegistrationRequests();
  const now = Date.now();
  const requests = allRequests.filter((request) => new Date(request.expiresAt).getTime() > now);
  if (requests.length !== allRequests.length) writeRegistrationRequests(requests);
  return requests;
}

function validateUsername(username) {
  const cleanUsername = String(username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(cleanUsername)) throw new Error('Username must be 3–32 letters, numbers, dots, underscores, or hyphens.');
  return cleanUsername;
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 10) throw new Error('Password must contain at least 10 characters.');
  return value;
}

function hashApprovalKey(key) {
  return crypto.createHash('sha256').update(String(key).trim().toUpperCase()).digest('hex');
}

function keysMatch(provided, storedHash) {
  const actual = Buffer.from(hashApprovalKey(provided), 'hex');
  const expected = Buffer.from(String(storedHash), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
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
  const cleanUsername = validateUsername(username);
  const validPassword = validatePassword(password);
  const users = ensureAdminFromEnvironment();
  if (users.some((user) => user.username.toLowerCase() === cleanUsername.toLowerCase())) throw new Error('Username already exists.');
  users.push({ username: cleanUsername, passwordHash: hashPassword(validPassword), role: 'user', createdAt: new Date().toISOString() });
  writeUsers(users);
  return { username: cleanUsername, role: 'user' };
}

function requestRegistration(username) {
  const cleanUsername = validateUsername(username);
  const users = ensureAdminFromEnvironment();
  if (users.some((user) => user.username.toLowerCase() === cleanUsername.toLowerCase())) throw new Error('Username already exists.');
  const requests = activeRegistrationRequests();
  if (requests.some((request) => request.username.toLowerCase() === cleanUsername.toLowerCase())) throw new Error('A registration request for this username is already pending.');
  const approvalKey = crypto.randomBytes(5).toString('hex').toUpperCase();
  const requestedAt = new Date();
  const request = { id: crypto.randomBytes(16).toString('hex'), username: cleanUsername, approvalKeyHash: hashApprovalKey(approvalKey), requestedAt: requestedAt.toISOString(), expiresAt: new Date(requestedAt.getTime() + REGISTRATION_TTL_MS).toISOString(), approvedAt: null };
  writeRegistrationRequests([...requests, request]);
  return { username: cleanUsername, approvalKey, requestedAt: request.requestedAt, expiresAt: request.expiresAt };
}

function approveRegistration(approvalKey) {
  const requests = activeRegistrationRequests();
  const request = requests.find((candidate) => keysMatch(approvalKey, candidate.approvalKeyHash));
  if (!request) throw new Error('Invalid or expired approval key.');
  if (request.approvedAt) return { username: request.username, approvedAt: request.approvedAt, alreadyApproved: true };
  request.approvedAt = new Date().toISOString();
  writeRegistrationRequests(requests);
  return { username: request.username, approvedAt: request.approvedAt, alreadyApproved: false };
}

function completeRegistration(username, password, approvalKey) {
  const cleanUsername = validateUsername(username);
  const validPassword = validatePassword(password);
  const requests = activeRegistrationRequests();
  const request = requests.find((candidate) => candidate.username.toLowerCase() === cleanUsername.toLowerCase());
  if (!request || !request.approvedAt || !keysMatch(approvalKey, request.approvalKeyHash)) throw new Error('This registration is not approved or the approval key is invalid.');
  const users = ensureAdminFromEnvironment();
  if (users.some((user) => user.username.toLowerCase() === cleanUsername.toLowerCase())) throw new Error('Username already exists.');
  users.push({ username: cleanUsername, passwordHash: hashPassword(validPassword), role: 'user', createdAt: new Date().toISOString() });
  writeUsers(users);
  writeRegistrationRequests(requests.filter((candidate) => candidate.id !== request.id));
  return { username: cleanUsername, role: 'user' };
}

function listRegistrationRequests() {
  return activeRegistrationRequests().map(({ approvalKeyHash, ...request }) => ({ ...request, status: request.approvedAt ? 'approved' : 'pending' }));
}

function listUsers() {
  return ensureAdminFromEnvironment().map(({ username, role, createdAt }) => ({ username, role, createdAt }));
}

module.exports = { approveRegistration, completeRegistration, createUser, ensureAdminFromEnvironment, getSession, listRegistrationRequests, listUsers, login, logout, requestRegistration };
