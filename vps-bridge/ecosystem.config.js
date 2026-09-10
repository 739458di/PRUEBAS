// PM2 del puente. SECRETOS FUERA DEL REPO: viven en /root/wa-bridge/.env del VPS
// (TURSO_AUTH_TOKEN, K_PUENTE, KEY_VIEJA…). Este archivo solo dice qué correr.
// Anti-hackeo 2026-09-10: K_PUENTE es OBLIGATORIA (el puente hace process.exit(1) sin ella); KEY_VIEJA solo en rotación.
// El puente además lee /root/wa-bridge/.env por sí mismo (rellena lo que pm2 no inyecte), así que un
// `pm2 restart fyra-bridge` sin --update-env tampoco lo deja sin llave. BRIDGE_API_KEY y SALESBRAIN_KEY ya no se leen.
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
      K_PUENTE: process.env.K_PUENTE,                 // llave única del puente (entrada x-api-key y salidas a fyrachat/SB)
      KEY_VIEJA: process.env.KEY_VIEJA || '',         // transición: llave anterior aceptada/mandada; borrar al terminar la rotación
      SALESBRAIN_UPLOAD_URL: process.env.SALESBRAIN_UPLOAD_URL || 'https://sales-brain-theta.vercel.app/api/upload'
    }
  }]
};
