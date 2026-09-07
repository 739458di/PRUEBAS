#!/bin/bash
# ══ DEPLOY DEL PUENTE (Fase 0.3, 2026-09-07) — un solo comando, con verificación ══
# Flujo: repo → Vercel Blob → VPS (curl) → byte-match → node --check → respaldo → pm2 restart → /status
# Si cualquier verificación falla, NO se reinicia: el puente viejo sigue vivo.
# Uso: bash vps-bridge/deploy.sh            (usa vps-bridge/wa-bridge-v2.js del repo)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/wa-bridge-v2.js"
VPS_HOST="${VPS_HOST:-137.184.199.19}"
VPS_PASS="${VPS_PASS:-$(grep -E '^VPS_PASS=' "$HERE/../.vps-creds" 2>/dev/null | cut -d= -f2- || true)}"
[ -z "$VPS_PASS" ] && { echo "✗ falta VPS_PASS (env o PRUEBAS/.vps-creds)"; exit 1; }
node --check "$SRC" || { echo "✗ sintaxis inválida en el repo — no se despliega"; exit 1; }
SIZE=$(wc -c < "$SRC" | tr -d ' ')
echo "① subiendo al Blob ($SIZE bytes)…"
URL=$(cd /Users/Shared/fyradrive-web && node -e "
require('dotenv').config({ path: '.env.local' });
const { put } = require('@vercel/blob'); const fs = require('fs');
put('deploy/wa-bridge-v2-' + Date.now() + '.js', fs.readFileSync(process.argv[1]), { access: 'public', contentType: 'text/plain' })
  .then(b => console.log(b.url)).catch(e => { console.error('BLOB-ERR ' + e.message); process.exit(1); });
" "$SRC")
echo "   $URL"
echo "② en el VPS: bajar → verificar → respaldar → reiniciar (UNA sesión SSH)…"
STAMP=$(date +%Y%m%d-%H%M)
expect <<EXP 2>/dev/null | tr -d '\r' | grep -E '^\[VPS\]'
set timeout 90
spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=20 root@$VPS_HOST "cd /root/wa-bridge && curl -s -o /tmp/wb.new '$URL' && S=\\\$(wc -c < /tmp/wb.new) && echo \"[VPS] bytes recibidos: \\\$S (esperados $SIZE)\" && [ \"\\\$S\" = \"$SIZE\" ] && node --check /tmp/wb.new && echo '[VPS] sintaxis ok' && cp wa-bridge-v2.js wa-bridge-v2.js.bak-$STAMP && cp /tmp/wb.new wa-bridge-v2.js && pm2 restart fyra-bridge >/dev/null && sleep 8 && echo \"[VPS] status: \\\$(curl -s --max-time 5 http://127.0.0.1:3000/status)\" || echo '[VPS] ✗ FALLÓ una verificación — NO se reinició'"
expect {
  "password:" { send "$VPS_PASS\r"; exp_continue }
  timeout { puts "[VPS] ✗ timeout" }
  eof {}
}
EXP
