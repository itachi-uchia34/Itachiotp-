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

const COUNTRY_CALLING_CODES = [
  ['1', 'US'], ['7', 'RU'], ['20', 'EG'], ['27', 'ZA'], ['30', 'GR'], ['31', 'NL'], ['32', 'BE'], ['33', 'FR'], ['34', 'ES'],
  ['36', 'HU'], ['39', 'IT'], ['40', 'RO'], ['41', 'CH'], ['43', 'AT'], ['44', 'GB'], ['45', 'DK'], ['46', 'SE'], ['47', 'NO'],
  ['48', 'PL'], ['49', 'DE'], ['51', 'PE'], ['52', 'MX'], ['53', 'CU'], ['54', 'AR'], ['55', 'BR'], ['56', 'CL'], ['57', 'CO'],
  ['58', 'VE'], ['60', 'MY'], ['61', 'AU'], ['62', 'ID'], ['63', 'PH'], ['64', 'NZ'], ['65', 'SG'], ['66', 'TH'], ['81', 'JP'],
  ['82', 'KR'], ['84', 'VN'], ['86', 'CN'], ['90', 'TR'], ['91', 'IN'], ['92', 'PK'], ['93', 'AF'], ['94', 'LK'], ['95', 'MM'],
  ['98', 'IR'], ['211', 'SS'], ['212', 'MA'], ['213', 'DZ'], ['216', 'TN'], ['218', 'LY'], ['220', 'GM'], ['221', 'SN'],
  ['222', 'MR'], ['223', 'ML'], ['224', 'GN'], ['225', 'CI'], ['226', 'BF'], ['227', 'NE'], ['228', 'TG'], ['229', 'BJ'],
  ['230', 'MU'], ['231', 'LR'], ['232', 'SL'], ['233', 'GH'], ['234', 'NG'], ['235', 'TD'], ['236', 'CF'], ['237', 'CM'],
  ['238', 'CV'], ['239', 'ST'], ['240', 'GQ'], ['241', 'GA'], ['242', 'CG'], ['243', 'CD'], ['244', 'AO'], ['245', 'GW'],
  ['248', 'SC'], ['249', 'SD'], ['250', 'RW'], ['251', 'ET'], ['252', 'SO'], ['253', 'DJ'], ['254', 'KE'], ['255', 'TZ'],
  ['256', 'UG'], ['257', 'BI'], ['258', 'MZ'], ['260', 'ZM'], ['261', 'MG'], ['262', 'RE'], ['263', 'ZW'], ['264', 'NA'],
  ['265', 'MW'], ['266', 'LS'], ['267', 'BW'], ['268', 'SZ'], ['269', 'KM'], ['290', 'SH'], ['291', 'ER'], ['297', 'AW'],
  ['298', 'FO'], ['299', 'GL'], ['350', 'GI'], ['351', 'PT'], ['352', 'LU'], ['353', 'IE'], ['354', 'IS'], ['355', 'AL'],
  ['356', 'MT'], ['357', 'CY'], ['358', 'FI'], ['359', 'BG'], ['370', 'LT'], ['371', 'LV'], ['372', 'EE'], ['373', 'MD'],
  ['374', 'AM'], ['375', 'BY'], ['376', 'AD'], ['377', 'MC'], ['378', 'SM'], ['380', 'VA'], ['381', 'RS'], ['382', 'ME'],
  ['383', 'XK'], ['385', 'HR'], ['386', 'SI'], ['387', 'BA'], ['389', 'MK'], ['420', 'CZ'], ['421', 'SK'], ['423', 'LI'],
  ['500', 'FK'], ['501', 'BZ'], ['502', 'GT'], ['503', 'SV'], ['504', 'HN'], ['505', 'NI'], ['506', 'CR'], ['507', 'PA'],
  ['508', 'PM'], ['509', 'HT'], ['590', 'GP'], ['591', 'BO'], ['592', 'GY'], ['593', 'EC'], ['594', 'GF'], ['595', 'PY'],
  ['596', 'MQ'], ['597', 'SR'], ['598', 'UY'], ['599', 'CW'], ['670', 'TL'], ['672', 'AQ'], ['673', 'BN'], ['674', 'NR'],
  ['675', 'PG'], ['676', 'TO'], ['677', 'SB'], ['678', 'VU'], ['679', 'FJ'], ['680', 'PW'], ['681', 'WF'], ['682', 'CK'],
  ['683', 'NU'], ['685', 'WS'], ['686', 'KI'], ['687', 'NC'], ['688', 'TV'], ['689', 'PF'], ['690', 'TK'], ['691', 'FM'],
  ['692', 'MH'], ['850', 'KP'], ['852', 'HK'], ['853', 'MO'], ['855', 'KH'], ['856', 'LA'], ['880', 'BD'], ['886', 'TW'],
  ['960', 'MV'], ['961', 'LB'], ['962', 'JO'], ['963', 'SY'], ['964', 'IQ'], ['965', 'KW'], ['966', 'SA'], ['967', 'YE'],
  ['968', 'OM'], ['970', 'PS'], ['971', 'AE'], ['972', 'IL'], ['973', 'BH'], ['974', 'QA'], ['975', 'BT'], ['976', 'MN'],
  ['977', 'NP'], ['992', 'TJ'], ['993', 'TM'], ['994', 'AZ'], ['995', 'GE'], ['996', 'KG'], ['998', 'UZ'],
].sort((a, b) => b[0].length - a[0].length);

function normalizePhoneNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}

function extractPhoneNumber(value, path = []) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    for (const item of value) { const found = extractPhoneNumber(item, path); if (found) return found; }
    return '';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    for (const [key, nested] of entries) {
      if (/(phone|mobile|msisdn|sender|from|caller|number|num|cli|recipient|destination)/i.test(key)) {
        const direct = normalizePhoneNumber(nested);
        if (direct) return direct;
      }
    }
    for (const [key, nested] of entries) {
      const found = extractPhoneNumber(nested, [...path, key]);
      if (found) return found;
    }
    return '';
  }
  const text = String(value);
  const candidates = text.match(/(?:\+|00)?\d[\d().\s-]{6,}\d/g) || [];
  return candidates.map(normalizePhoneNumber).find(Boolean) || '';
}

function countryCodeForPhone(phoneNumber) {
  const digits = normalizePhoneNumber(phoneNumber);
  const match = COUNTRY_CALLING_CODES.find(([code]) => digits.startsWith(code));
  return match ? match[1] : '';
}

function flagForCountryCode(countryCode) {
  if (!/^[A-Z]{2}$/.test(countryCode)) return '🌐';
  return [...countryCode].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('');
}

function maskPhoneNumber(phoneNumber) {
  const digits = normalizePhoneNumber(phoneNumber);
  if (!digits) return 'Unknown number';
  if (digits.length <= 8) return `${digits.slice(0, 3)}xxx${digits.slice(-2)}`;
  return `${digits.slice(0, 5)}xxx${digits.slice(-4)}`;
}

function buildForwardingActivity(apiResponse, at = new Date().toISOString()) {
  const phoneNumber = extractPhoneNumber(apiResponse);
  const countryCode = countryCodeForPhone(phoneNumber);
  return {
    at,
    flag: flagForCountryCode(countryCode),
    countryCode: countryCode || null,
    phone: maskPhoneNumber(phoneNumber),
  };
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
      const apiResponse = await fetchApiResponse(config);
      const allCodes = extractOtpValues(apiResponse);
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
      const activity = buildForwardingActivity(apiResponse);
      const currentState = readState(stateKey);
      const recentActivity = [activity, ...(Array.isArray(currentState.recentActivity) ? currentState.recentActivity : [])].slice(0, 20);
      updateState({ lastSendAt: activity.at, lastResult: 'sent', sentCount: Number(currentState.sentCount || 0) + 1, recentActivity, seenCodeHashes: [...seenCodeHashes].slice(-1000) }, stateKey);
      return { sent: true, reason: null, count: newCodes.length, activity };
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

module.exports = { buildApiUrl, buildForwardingActivity, collectCodesFromText, countryCodeForPhone, createForwarder, deepCollectOtpValues, extractOtpValues, extractPhoneNumber, flagForCountryCode, formatTelegramText, maskPhoneNumber, runOnce, sendTelegramMessage, startForwarder };

if (require.main === module) startForwarder().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
