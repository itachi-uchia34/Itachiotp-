const auth = require('./auth-store');
const { createForwarder } = require('./fetch-and-send-otp');
const { getUserSettings, hasUserSettings } = require('./settings-store');
const { readState } = require('./runtime-state');

const workers = new Map();

function sanitizedStatus(username) {
  const state = readState(username);
  const { seenCodeHashes, ...publicState } = state;
  const settings = getUserSettings(username);
  return {
    ...publicState,
    workerActive: workers.has(username),
    configured: {
      telegramBotToken: Boolean(settings.TELEGRAM_BOT_TOKEN),
      telegramChatIds: Boolean(settings.TELEGRAM_CHAT_IDS),
    },
  };
}

async function stopUser(username) {
  const worker = workers.get(username);
  if (worker) worker.stop();
  workers.delete(username);
}

async function configureUser(username) {
  const key = String(username);
  await stopUser(key);
  if (!hasUserSettings(key)) return { active: false, reason: 'not-configured' };
  const worker = createForwarder({ username: key, settingsProvider: (user) => ({ ...process.env, ...getUserSettings(user) }) });
  workers.set(key, worker);
  await worker.start();
  return { active: true };
}

async function startAll() {
  for (const user of auth.listUsers()) {
    configureUser(user.username).catch((error) => console.error(`Worker ${user.username} failed to start: ${error.message || error}`));
  }
}

async function pollUser(username) {
  const key = String(username);
  if (!hasUserSettings(key)) return { sent: false, reason: 'not-configured' };
  if (!workers.has(key)) await configureUser(key);
  return workers.get(key).runOnce();
}

function getUserStatus(username) {
  return sanitizedStatus(String(username));
}

function activeUsernames() {
  return [...workers.keys()];
}

module.exports = { activeUsernames, configureUser, getUserStatus, pollUser, startAll, stopUser };
