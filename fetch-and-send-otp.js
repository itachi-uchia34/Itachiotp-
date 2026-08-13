#!/usr/bin/env node

const API_URL = process.env.CRAPI_URL || 'http://147.135.212.197/crapi/had/viewstats';
const POLL_INTERVAL_MS = 30_000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function buildApiUrl() {
  const token = requireEnv('CRAPI_TOKEN');
  const params = new URLSearchParams({ token });

  const optionalParams = ['dt1', 'dt2', 'records', 'filternum', 'filtercli'];
  for (const key of optionalParams) {
    const envKey = `CRAPI_${key.toUpperCase()}`;
    if (process.env[envKey]) {
      params.set(key, process.env[envKey]);
    }
  }

  return `${API_URL}?${params.toString()}`;
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
      const joined = nextPath.join('.').toLowerCase();

      if (joined.includes('otp') && (typeof nested === 'string' || typeof nested === 'number')) {
        found.add(String(nested));
      }

      deepCollectOtpValues(nested, nextPath, found);
    }
    return found;
  }

  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower.includes('otp')) {
      found.add(value);
    }

    const codeRegex = /\b\d{4,8}\b/g;
    const matches = value.match(codeRegex);
    if (matches && lower.includes('otp')) {
      matches.forEach((code) => found.add(code));
    }
  }

  return found;
}

function formatTelegramText(apiResponse) {
  const otpValues = [...deepCollectOtpValues(apiResponse)];

  const lines = [
    'OTP Update',
    `Time: ${new Date().toISOString()}`,
    otpValues.length ? otpValues.join(', ') : 'OTP not found',
  ];

  return lines.join('\n').slice(0, 3900);
}

function getChatIds() {
  const raw = process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID;
  if (!raw) {
    throw new Error('Missing required environment variable: TELEGRAM_CHAT_IDS (or TELEGRAM_CHAT_ID)');
  }

  const ids = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!ids.length) {
    throw new Error('No valid Telegram chat IDs found in TELEGRAM_CHAT_IDS/TELEGRAM_CHAT_ID');
  }

  return ids;
}

async function sendTelegramMessageToChat(chatId, text) {
  const botToken = requireEnv('TELEGRAM_BOT_TOKEN');

  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram send failed (${res.status}): ${body}`);
  }

  return res.json();
}

async function sendTelegramMessage(text) {
  const chatIds = getChatIds();
  const results = await Promise.allSettled(chatIds.map((chatId) => sendTelegramMessageToChat(chatId, text)));
  const failures = results.filter((result) => result.status === 'rejected');

  if (failures.length) {
    const reasons = failures.map((failure) => failure.reason?.message || String(failure.reason)).join('; ');
    throw new Error(`Failed to send to ${failures.length}/${chatIds.length} chat IDs: ${reasons}`);
  }
}

async function fetchApiResponse() {
  const url = buildApiUrl();

  const apiResponse = await fetch(url);
  if (!apiResponse.ok) {
    const body = await apiResponse.text();
    throw new Error(`CR API request failed (${apiResponse.status}): ${body}`);
  }

  const raw = await apiResponse.text();
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

async function runOnce() {
  const parsed = await fetchApiResponse();
  const message = formatTelegramText(parsed);
  await sendTelegramMessage(message);
  console.log(`[${new Date().toISOString()}] API response fetched and OTP sent to Telegram chat IDs.`);
}

async function main() {
  await runOnce();

  setInterval(() => {
    runOnce().catch((error) => {
      console.error(error.message || error);
    });
  }, POLL_INTERVAL_MS);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
