// PM2 del puente. SECRETOS FUERA DEL REPO: viven en /root/wa-bridge/.env del VPS
// (TURSO_AUTH_TOKEN, BRIDGE_API_KEY, SALESBRAIN_KEY…). Este archivo solo dice qué correr.
require('dotenv').config({ path: '/root/wa-bridge/.env' });
module.exports = {
  apps: [{
    name: 'fyra-bridge',
    script: 'wa-bridge-v3.js',   // Fase 1: multi-universo (rollback: wa-bridge-v2.js)
    cwd: '/root/wa-bridge',
    node_args: '--max-old-space-size=512',
    max_memory_restart: '600M',
    env: {
      PORT: process.env.PORT || '3000',
      TURSO_URL: process.env.TURSO_URL || 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
      TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
      BRIDGE_API_KEY: process.env.BRIDGE_API_KEY,
      SALESBRAIN_UPLOAD_URL: process.env.SALESBRAIN_UPLOAD_URL || 'https://sales-brain-theta.vercel.app/api/upload',
      SALESBRAIN_KEY: process.env.SALESBRAIN_KEY
    }
  }]
};
