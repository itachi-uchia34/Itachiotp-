const fs = require('fs');
const path = require('path');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
fs.mkdirSync(dataDir, { recursive: true });
const statePath = path.join(dataDir, 'runtime-status.json');
const baseState = () => ({
  startedAt: new Date().toISOString(),
  lastPollAt: null,
  lastSendAt: null,
  lastResult: 'starting',
  sentCount: 0,
  error: null,
});

function readAllStates() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && parsed.users && typeof parsed.users === 'object') return parsed;
    return { users: { default: { ...baseState(), ...parsed } } };
  } catch {
    return { users: {} };
  }
}

function readState(username = 'default') {
  const all = readAllStates();
  return { ...baseState(), ...(all.users[String(username)] || {}) };
}

function readStates() {
  return readAllStates().users || {};
}

function updateState(patch, username = 'default') {
  const all = readAllStates();
  all.users[String(username)] = { ...readState(username), ...patch };
  const temporaryPath = `${statePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, statePath);
  fs.chmodSync(statePath, 0o600);
  return all.users[String(username)];
}

module.exports = { readAllStates, readState, readStates, updateState };
