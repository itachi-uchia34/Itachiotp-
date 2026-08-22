const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createForwarder,
  extractOtpValues,
  buildForwardingActivity,
  formatTelegramText,
  buildOtpRecords,
  maskPhoneNumber,
} = require('../fetch-and-send-otp.js');
const { readState } = require('../runtime-state');

test('extracts only numeric OTP values from OTP-labelled fields', () => {
  const values = extractOtpValues({ data: { otp: '482913', message: 'Your OTP is 7744', username: 'not-an-otp' } });
  assert.deepEqual(values.sort(), ['482913', '7744']);
});

test('returns no values for empty or unrelated API responses', () => {
  assert.deepEqual(extractOtpValues({ status: 'ok', data: [] }), []);
  assert.deepEqual(extractOtpValues({ message: 'request completed successfully' }), []);
  assert.equal(formatTelegramText([]), '');
});

test('formats a non-empty Telegram message only when OTP values have a number', () => {
  assert.equal(formatTelegramText(['1234', '987654']), '');
  const message = formatTelegramText(['1234', '987654'], '+923451237453');
  assert.match(message, /^OTP Update\nTime: .+\nNumber: \+923451237453\nOTP: 1234, 987654\nRange: Unknown range\nService: Unknown service$/);
});

test('builds no record when an OTP has no associated number', () => {
  assert.deepEqual(buildOtpRecords({ otp: '482913' }), []);
  assert.deepEqual(buildOtpRecords({ message: 'Your OTP is 482913. Reference 923451237453' }), []);
  assert.deepEqual(buildOtpRecords({ sender: '+923451237453', message: 'Your OTP is 482913' }, '2026-08-15T00:00:00.000Z'), [{ otp: '482913', phone: '923451237453', range: 'Unknown range', service: 'Unknown service', at: '2026-08-15T00:00:00.000Z' }]);
  assert.deepEqual(buildOtpRecords({ sender: '+923451237453', otp: '482913', active_range: '923450000000-923459999999', service_name: 'WhatsApp' }, '2026-08-15T00:00:00.000Z'), [{ otp: '482913', phone: '923451237453', range: '923450000000-923459999999', service: 'WhatsApp', at: '2026-08-15T00:00:00.000Z' }]);
});

test('does not forward an OTP when the source number is missing', async () => {
  let telegramCalls = 0;
  const worker = createForwarder({
    username: `missing-number-${Date.now()}`,
    settingsProvider: () => ({ CRAPI_TOKEN: 'token', TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_IDS: 'chat' }),
    fetchImpl: async (url) => {
      if (url.startsWith('https://api.telegram.org')) {
        telegramCalls += 1;
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, text: async () => JSON.stringify({ otp: '482913' }) };
    },
  });
  const result = await worker.runOnce();
  assert.deepEqual(result, { sent: false, reason: 'no-number' });
  assert.equal(telegramCalls, 0);
});

test('masks phone numbers and adds a country flag without exposing the full number', () => {
  const activity = buildForwardingActivity({ data: { sender: '+923451237453', message: 'Your OTP is 482913' } }, '2026-08-15T00:00:00.000Z');
  assert.equal(activity.flag, '🇵🇰');
  assert.equal(activity.phone, '92345xxx7453');
  assert.equal(activity.at, '2026-08-15T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(activity), /923451237453/);
  assert.equal(maskPhoneNumber(''), 'Unknown number');
});

test('worker activity contains only a masked number and flag', async () => {
  const username = `activity-${Date.now()}`;
  const mockFetch = async (url, options = {}) => {
    if (url.startsWith('https://api.telegram.org')) return { ok: true, json: async () => ({ ok: true }) };
    return { ok: true, text: async () => JSON.stringify({ sender: '+923451237453', otp: '482913' }) };
  };
  const worker = createForwarder({ username, settingsProvider: () => ({ CRAPI_TOKEN: 'token', TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_IDS: 'chat' }), fetchImpl: mockFetch });
  const result = await worker.runOnce();
  assert.equal(result.sent, true);
  assert.deepEqual(result.activity, { at: result.activity.at, flag: '🇵🇰', countryCode: 'PK', phone: '92345xxx7453' });
  assert.deepEqual(result.records, [{ otp: '482913', phone: '923451237453', range: 'Unknown range', service: 'Unknown service', at: result.records[0].at }]);
  const state = readState(username);
  assert.deepEqual(state.recentOtpRecords, [{ otp: '482913', phone: '923451237453', range: 'Unknown range', service: 'Unknown service', at: result.records[0].at }]);
  assert.doesNotMatch(JSON.stringify(state.recentActivity), /923451237453|482913/);
});

test('isolates two user workers and suppresses repeated OTPs', async () => {
  const deliveries = [];
  const responses = { tokenA: '1111', tokenB: '2222' };
  const mockFetch = async (url, options = {}) => {
    if (url.startsWith('https://api.telegram.org')) {
      deliveries.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true }) };
    }
    const token = new URL(url).searchParams.get('token');
    return { ok: true, text: async () => JSON.stringify({ sender: token === 'tokenA' ? '+923001111111' : '+923002222222', latest_otp: responses[token] }) };
  };
  const settings = {
    userA: { CRAPI_TOKEN: 'tokenA', TELEGRAM_BOT_TOKEN: 'botA', TELEGRAM_CHAT_IDS: 'chatA' },
    userB: { CRAPI_TOKEN: 'tokenB', TELEGRAM_BOT_TOKEN: 'botB', TELEGRAM_CHAT_IDS: 'chatB' },
  };
  const workerA = createForwarder({ username: `isolation-A-${Date.now()}`, settingsProvider: () => settings.userA, fetchImpl: mockFetch });
  const workerB = createForwarder({ username: `isolation-B-${Date.now()}`, settingsProvider: () => settings.userB, fetchImpl: mockFetch });

  assert.equal((await workerA.runOnce()).sent, true);
  assert.equal((await workerB.runOnce()).sent, true);
  assert.equal((await workerA.runOnce()).sent, false);
  assert.equal((await workerB.runOnce()).sent, false);
  assert.equal(deliveries.length, 2);
  assert.match(deliveries[0].url, /bot(botA|botB)\/sendMessage/);
  assert.match(deliveries[1].url, /bot(botA|botB)\/sendMessage/);
  const byChat = Object.fromEntries(deliveries.map((delivery) => [delivery.body.chat_id, delivery.body.text]));
  assert.match(byChat.chatA, /1111/);
  assert.doesNotMatch(byChat.chatA, /2222/);
  assert.match(byChat.chatB, /2222/);
  assert.doesNotMatch(byChat.chatB, /1111/);
});
