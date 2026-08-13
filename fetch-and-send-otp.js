#!/usr/bin/env node

const API_URL = process.env.CRAPI_URL || 'http://147.135.212.197/crapi/had/viewstats';

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

function formatTelegramText(apiResponse, apiRequestUrl) {
  const otpValues = [...deepCollectOtpValues(apiResponse)];
  const safeUrl = apiRequestUrl.replace(/token=[^&]+/i, 'token=***');
  const responseSnippet = JSON.stringify(apiResponse).slice(0, 3000);

  const lines = [
    'CR API OTP Update',
    `URL: ${safeUrl}`,
    `Time: ${new Date().toISOString()}`,
    otpValues.length ? `OTP Values: ${otpValues.join(', ')}` : 'OTP Values: Not found',
    '',
    'Response:',
    responseSnippet,
  ];

  return lines.join('\n').slice(0, 3900);
}

async function sendTelegramMessage(text) {
  const botToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const chatId = requireEnv('TELEGRAM_CHAT_ID');

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

async function main() {
  const url = buildApiUrl();

  const apiResponse = await fetch(url);
  if (!apiResponse.ok) {
    const body = await apiResponse.text();
    throw new Error(`CR API request failed (${apiResponse.status}): ${body}`);
  }

  let parsed;
  try {
    parsed = await apiResponse.json();
  } catch {
    const text = await apiResponse.text();
    parsed = { raw: text };
  }

  const message = formatTelegramText(parsed, url);
  await sendTelegramMessage(message);

  console.log('API response fetched and forwarded to Telegram successfully.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
