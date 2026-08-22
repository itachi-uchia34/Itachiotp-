const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itachi-dashboard-test-'));
process.env.DATA_DIR = dataDir;
process.env.ADMIN_USERNAME = 'dashboard-admin';
process.env.ADMIN_PASSWORD = 'DashboardPassword123!';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';

const auth = require('../auth-store');
const { updateState } = require('../runtime-state');
const { startDashboardServer } = require('../dashboard-server');

test('authenticated users can retrieve only their own OTP records', async (t) => {
  auth.ensureAdminFromEnvironment();
  auth.createUser('record-user', 'RecordPassword123!');
  updateState({ recentOtpRecords: [{ otp: '482913', phone: '923451237453', range: '923450000000-923459999999', service: 'WhatsApp', at: '2026-08-22T00:00:00.000Z' }] }, 'record-user');

  const server = await startDashboardServer();
  t.after(() => server.close());
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const loginResponse = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'record-user', password: 'RecordPassword123!' }),
  });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];

  const recordsResponse = await fetch(`${baseUrl}/api/otp-records`, { headers: { Cookie: cookie } });
  assert.equal(recordsResponse.status, 200);
  assert.deepEqual(await recordsResponse.json(), {
    records: [{ otp: '482913', phone: '923451237453', range: '923450000000-923459999999', service: 'WhatsApp', at: '2026-08-22T00:00:00.000Z' }],
  });

  const unauthenticatedResponse = await fetch(`${baseUrl}/api/otp-records`);
  assert.equal(unauthenticatedResponse.status, 401);
});
