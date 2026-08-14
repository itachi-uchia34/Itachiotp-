const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itachi-registration-'));
process.env.DATA_DIR = dataDir;
process.env.ADMIN_USERNAME = 'test-admin';
process.env.ADMIN_PASSWORD = 'TestAdminPassword123!';
const auth = require('../auth-store');

 test('requires admin approval before completing a registration', () => {
  const request = auth.requestRegistration('team-member');
  assert.match(request.approvalKey, /^[A-F0-9]{10}$/);
  const stored = fs.readFileSync(path.join(dataDir, 'registration-requests.json'), 'utf8');
  assert.doesNotMatch(stored, new RegExp(request.approvalKey));
  assert.equal(auth.listRegistrationRequests()[0].status, 'pending');
  assert.throws(() => auth.completeRegistration('team-member', 'TeamPassword123!', request.approvalKey), /not approved/);

  const approved = auth.approveRegistration(request.approvalKey);
  assert.equal(approved.username, 'team-member');
  assert.equal(auth.listRegistrationRequests()[0].status, 'approved');

  const user = auth.completeRegistration('team-member', 'TeamPassword123!', request.approvalKey);
  assert.deepEqual(user, { username: 'team-member', role: 'user' });
  assert.equal(auth.listRegistrationRequests().length, 0);
  assert.equal(auth.login('team-member', 'TeamPassword123!').user.role, 'user');
});

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
