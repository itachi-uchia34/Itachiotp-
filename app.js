require('dotenv').config();

function validateProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  const required = ['CRAPI_TOKEN', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'SETTINGS_ENCRYPTION_KEY'];
  const missing = required.filter((name) => !String(process.env[name] || '').trim());
  if (missing.length) throw new Error(`Missing required production environment variables: ${missing.join(', ')}`);
  const adminPasswordLength = String(process.env.ADMIN_PASSWORD || '').trim().length;
  if (adminPasswordLength < 10) {
    throw new Error(`ADMIN_PASSWORD must contain at least 10 characters (received ${adminPasswordLength}). Update the Railway variable and redeploy.`);
  }
}

try {
  validateProductionConfig();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}

const { startDashboardServer } = require('./dashboard-server');
const { startAll } = require('./worker-manager');

startDashboardServer().catch((error) => {
  console.error(`Dashboard startup failed: ${error.message || error}`);
  process.exit(1);
});

startAll().catch((error) => {
  console.error(`Worker registry startup failed: ${error.message || error}`);
});
