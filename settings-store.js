const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
fs.mkdirSync(dataDir, { recursive: true });
const settingsPath = path.join(dataDir, 'runtime-user-settings.json');
const keys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_IDS'];

function encryptionKey() {
  const secret = process.env.SETTINGS_ENCRYPTION_KEY || process.env.DASHBOARD_TOKEN || process.env.ADMIN_PASSWORD || 'change-this-development-key';
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') };
}

function decrypt(value) {
  if (!value || value.version !== 1) return {};
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
}

function readStoredSettings() {
  try { return decrypt(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); } catch { return {}; }
}

function writeStoredSettings(settings) {
  const temporaryPath = `${settingsPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(encrypt(settings), null, 2), { mode: 0o600 });
  fs.chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, settingsPath);
  fs.chmodSync(settingsPath, 0o600);
}

function sanitizeSettings(input) {
  return Object.fromEntries(keys.map((key) => [key, typeof input?.[key] === 'string' ? input[key].trim() : '']));
}

function getUserSettings(username) {
  const all = readStoredSettings();
  return sanitizeSettings(all[String(username || '').trim()] || {});
}

function saveUserSettings(username, input) {
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername) throw new Error('A username is required.');
  const all = readStoredSettings();
  const current = getUserSettings(cleanUsername);
  const incoming = sanitizeSettings(input);
  const next = { ...current };
  for (const key of keys) if (incoming[key]) next[key] = incoming[key];
  all[cleanUsername] = next;
  writeStoredSettings(all);
  return next;
}

function hasUserSettings(username) {
  const settings = getUserSettings(username);
  return Boolean(settings.TELEGRAM_BOT_TOKEN && settings.TELEGRAM_CHAT_IDS);
}

function publicUserSettings(username) {
  const settings = getUserSettings(username);
  return {
    configured: Object.fromEntries(keys.map((key) => [key, Boolean(settings[key])])),
    masked: Object.fromEntries(keys.map((key) => [key, settings[key] ? '••••••••' : ''])),
  };
}

function loadIntoEnv() {
  return getUserSettings(process.env.DEFAULT_SETTINGS_USER || '');
}

module.exports = { getUserSettings, hasUserSettings, loadIntoEnv, publicUserSettings, readStoredSettings, saveUserSettings };
