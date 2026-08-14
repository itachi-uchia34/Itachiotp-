#!/usr/bin/env node

require('dotenv').config();
const crypto = require('crypto');
const { updateState, readState } = require('./runtime-state');

const DEFAULT_API_URL = process.env.CRAPI_URL || 'http://147.135.212.197/crapi/had/viewstats';
const DEFAULT_POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30_000);

function requireConfig(config, name) {
  const value = config?.[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

function buildApiUrl(config = process.env) {
  const token = requireConfig(config, 'CRAPI_TOKEN');
  const params = new URLSearchParams({ token });
  for (const key of ['dt1', 'dt2', 'records', 'filternum', 'filtercli']) {
    const envKey = `CRAPI_${key.toUpperCase()}`;
    if (config[envKey]) params.set(key, config[envKey]);
  }
  return `${config.CRAPI_URL || DEFAULT_API_URL}?${params.toString()}`;
}

function collectCodesFromText(value) {
  if (value == null) return [];
  return [...new Set(String(value).match(/\b\d{4,8}\b/g) || [])];
}

function deepCollectOtpValues(value, path = [], found = new Set()) {
  if (value == null) return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => deepCollectOtpValues(item, [...path, String(index)], found));
    return found;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const nextPath = [...path, key];
      if (nextPath.join('.').toLowerCase().includes('otp')) collectCodesFromText(nested).forEach((code) => found.add(code));
      deepCollectOtpValues(nested, nextPath, found);
    }
    return found;
  }
  if (typeof value === 'string') { const context = path.join('.').toLowerCase(); const text = value.toLowerCase(); if (context.includes('otp') || ((context.endsWith('message') || context.endsWith('msg') || context.endsWith('text')) && text.includes('otp'))) collectCodesFromText(value).forEach((code) => found.add(code)); }
  return found;
}

function extractOtpValues(apiResponse) {
  return [...deepCollectOtpValues(apiResponse)].filter((code) => /^\d{4,8}$/.test(code));
}

function formatTelegramText(otpValues) {
  if (!otpValues.length) return '';
  return ['OTP Update', `Time: ${new Date().toISOString()}`, otpValues.join(', ')].join('\n');
}

function getChatIds(config) {
  const raw = config.TELEGRAM_CHAT_IDS || config.TELEGRAM_CHAT_ID;
  if (!raw) throw new Error('Missing required setting: TELEGRAM_CHAT_IDS');
  const ids = String(raw).split(',').map((value) => value.trim()).filter(Boolean);
  if (!ids.length) throw new Error('No valid Telegram chat IDs found.');
  return ids;
}

async function sendTelegramMessageToChat(config, chatId, text, fetchImpl) {
  const botToken = requireConfig(config, 'TELEGRAM_BOT_TOKEN');
  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`Telegram send failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function sendTelegramMessage(config, text, fetchImpl) {
  if (!text || !text.trim()) return false;
  const chatIds = getChatIds(config);
  const results = await Promise.allSettled(chatIds.map((chatId) => sendTelegramMessageToChat(config, chatId, text, fetchImpl)));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) throw new Error(`Failed to send to ${failures.length}/${chatIds.length} chat IDs: ${failures.map((item) => item.reason?.message || String(item.reason)).join('; ')}`);
  return true;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function createForwarder({ username = 'default', settingsProvider = () => process.env, fetchImpl = globalThis.fetch, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API is unavailable.');
  const stateKey = String(username);
  const previous = readState(stateKey);
  const seenCodeHashes = new Set(Array.isArray(previous.seenCodeHashes) ? previous.seenCodeHashes : []);
  let timer = null;
  let polling = false;

  async function fetchApiResponse(config) {
    const response = await fetchImpl(buildApiUrl(config));
    if (!response.ok) throw new Error(`CR API request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const raw = await response.text();
    try { return JSON.parse(raw); } catch { return { raw }; }
  }

  async function runOnce() {
    if (polling) return { sent: false, reason: 'already-running' };
    polling = true;
    updateState({ lastPollAt: new Date().toISOString(), error: null }, stateKey);
    try {
      const config = settingsProvider(stateKey) || {};
      const allCodes = extractOtpValues(await fetchApiResponse(config));
      const newCodes = allCodes.filter((code) => !seenCodeHashes.has(hashCode(code)));
      if (!newCodes.length) {
        updateState({ lastResult: allCodes.length ? 'duplicate' : 'no-otp' }, stateKey);
        return { sent: false, reason: allCodes.length ? 'duplicate' : 'no-otp' };
      }
      const message = formatTelegramText(newCodes);
      if (!message) {
        updateState({ lastResult: 'no-otp' }, stateKey);
        return { sent: false, reason: 'empty-message' };
      }
      await sendTelegramMessage(config, message, fetchImpl);
      newCodes.forEach((code) => seenCodeHashes.add(hashCode(code)));
      updateState({ lastSendAt: new Date().toISOString(), lastResult: 'sent', sentCount: Number(readState(stateKey).sentCount || 0) + 1, seenCodeHashes: [...seenCodeHashes].slice(-1000) }, stateKey);
      return { sent: true, reason: null, count: newCodes.length };
    } catch (error) {
      updateState({ lastResult: 'error', error: error.message || String(error) }, stateKey);
      return { sent: false, reason: 'error', error: error.message || String(error) };
    } finally {
      polling = false;
    }
  }

  async function start() {
    await runOnce();
    timer = setInterval(() => runOnce(), pollIntervalMs);
    if (timer.unref) timer.unref();
    return { username: stateKey, pollIntervalMs };
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop };
}

const defaultForwarder = createForwarder();
async function runOnce() { return defaultForwarder.runOnce(); }
async function startForwarder() { return defaultForwarder.start(); }

module.exports = { buildApiUrl, collectCodesFromText, createForwarder, deepCollectOtpValues, extractOtpValues, formatTelegramText, runOnce, sendTelegramMessage, startForwarder };

if (require.main === module) startForwarder().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
