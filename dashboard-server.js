const http = require('http');
const fs = require('fs');
const path = require('path');
const auth = require('./auth-store');
const { publicUserSettings, saveUserSettings } = require('./settings-store');
const workers = require('./worker-manager');

const indexPath = path.join(__dirname, 'index.html');
const sessionCookie = 'itachi_session';

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }));
}

function currentUser(req) {
  const session = auth.getSession(parseCookies(req)[sessionCookie]);
  if (session) return session;
  const expected = process.env.DASHBOARD_TOKEN;
  if (expected && req.headers.authorization === `Bearer ${expected}`) return { username: 'dashboard-token', role: 'admin' };
  return null;
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function cookieHeader(token, req) {
  const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
  return `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? '; Secure' : ''}`;
}

function publicStatus(user) {
  return {
    ...workers.getUserStatus(user.username),
    dashboardProtected: Boolean(process.env.DASHBOARD_TOKEN || process.env.ADMIN_USERNAME || auth.listUsers().length),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 20_000) reject(new Error('Request body is too large.'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) { sendJson(res, 401, { error: 'Authentication required.' }); return null; }
  return user;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin') { sendJson(res, 403, { error: 'Administrator access required.' }); return null; }
  return user;
}

async function startDashboardServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, { ok: true, service: 'itachi-otp-forwarder' });
      }
      if (req.method === 'POST' && req.url === '/api/register/request') {
        const body = await readJsonBody(req);
        const request = auth.requestRegistration(body.username);
        return sendJson(res, 201, { requested: true, request, whatsappNumber: '923110470403' });
      }
      if (req.method === 'POST' && req.url === '/api/register/complete') {
        const body = await readJsonBody(req);
        const user = auth.completeRegistration(body.username, body.password, body.approvalKey);
        return sendJson(res, 201, { registered: true, user });
      }
      if (req.method === 'POST' && req.url === '/api/login') {
        const body = await readJsonBody(req);
        const result = auth.login(body.username, body.password);
        return sendJson(res, 200, { authenticated: true, user: result.user }, { 'Set-Cookie': cookieHeader(result.token, req) });
      }
      if (req.method === 'POST' && req.url === '/api/logout') {
        auth.logout(parseCookies(req)[sessionCookie]);
        return sendJson(res, 200, { loggedOut: true }, { 'Set-Cookie': `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (req.method === 'GET' && req.url === '/api/me') {
        const user = requireUser(req, res);
        return user ? sendJson(res, 200, { authenticated: true, user }) : undefined;
      }
      if (req.method === 'GET' && req.url === '/api/status') {
        const user = requireUser(req, res);
        return user ? sendJson(res, 200, publicStatus(user)) : undefined;
      }
      if (req.method === 'GET' && (req.url === '/api/settings' || req.url === '/api/my-settings')) {
        const user = requireUser(req, res);
        return user ? sendJson(res, 200, publicUserSettings(user.username)) : undefined;
      }
      if (req.method === 'POST' && (req.url === '/api/settings' || req.url === '/api/my-settings')) {
        const user = requireUser(req, res);
        if (!user) return;
        const body = await readJsonBody(req);
        saveUserSettings(user.username, { TELEGRAM_BOT_TOKEN: body.telegramBotToken, TELEGRAM_CHAT_IDS: body.telegramChatIds });
        await workers.configureUser(user.username);
        return sendJson(res, 200, { saved: true, settings: publicUserSettings(user.username), status: publicStatus(user) });
      }
      if (req.method === 'GET' && req.url === '/api/users') {
        if (!requireAdmin(req, res)) return;
        return sendJson(res, 200, { users: auth.listUsers() });
      }
      if (req.method === 'GET' && req.url === '/api/registration-requests') {
        if (!requireAdmin(req, res)) return;
        return sendJson(res, 200, { requests: auth.listRegistrationRequests() });
      }
      if (req.method === 'POST' && req.url === '/api/registration-requests/approve') {
        if (!requireAdmin(req, res)) return;
        const body = await readJsonBody(req);
        return sendJson(res, 200, { approved: true, request: auth.approveRegistration(body.approvalKey) });
      }
      if (req.method === 'POST' && req.url === '/api/users') {
        if (!requireAdmin(req, res)) return;
        const body = await readJsonBody(req);
        return sendJson(res, 201, { created: true, user: auth.createUser(body.username, body.password) });
      }
      if (req.method === 'POST' && req.url === '/api/poll') {
        const user = requireUser(req, res);
        if (!user) return;
        const result = await workers.pollUser(user.username);
        return sendJson(res, 200, { sent: result.sent, reason: result.reason || null, status: publicStatus(user) });
      }
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        const html = fs.readFileSync(indexPath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      const message = error.message || 'Internal server error';
      const status = /Invalid username|Too many login/.test(message) ? 401 : /required|invalid|already|must|pending|approved/i.test(message) ? 400 : 500;
      return sendJson(res, status, { error: message });
    }
  });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      console.log(`Dashboard listening on ${host}:${port}`);
      resolve();
    });
  });
  return server;
}

module.exports = { publicStatus, startDashboardServer };
