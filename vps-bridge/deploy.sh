#!/bin/bash
# ══ DEPLOY DEL PUENTE (Fase 0.3, 2026-09-07) — un solo comando, con verificación ══
# Flujo: repo → Vercel Blob → VPS (curl) → byte-match → node --check → respaldo → pm2 restart → /status
# Si cualquier verificación falla, NO se reinicia: el puente viejo sigue vivo.
# Uso: bash vps-bridge/deploy.sh                       (despliega wa-bridge-v3.js)
#      SRC=vps-bridge/wa-bridge-v2.js bash vps-bridge/deploy.sh   (rollback a v2: luego cambiar script en ecosystem)
#      RESTART=0 …                                       (solo copia, sin reiniciar)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${SRC:-$HERE/wa-bridge-v3.js}"          # archivo del repo a desplegar (v2 = rollback)
DEST="${DEST:-$(basename "$SRC")}"           # nombre en /root/wa-bridge
VPS_HOST="${VPS_HOST:-137.184.199.19}"
VPS_PASS="${VPS_PASS:-$(grep -E "^VPS_PASSWORD=" "$HERE/../.vps-creds" 2>/dev/null | cut -d= -f2- || true)}"
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
# El guion remoto viaja en base64: sin comillas anidadas ni corchetes que expect/Tcl malinterprete.
REMOTE=$(cat <<REM
cd /root/wa-bridge || exit 1
curl -s -o /tmp/wb-new.js '$URL' || { echo 'VPS: curl fallo'; exit 1; }
echo "VPS: destino $DEST"
S=\$(wc -c < /tmp/wb-new.js)
echo "VPS: bytes recibidos \$S (esperados $SIZE)"
[ "\$S" = "$SIZE" ] || { echo 'VPS: FALLO tamano — NO se reinicia'; exit 1; }
node --check /tmp/wb-new.js || { echo 'VPS: FALLO sintaxis — NO se reinicia'; exit 1; }
[ -f $DEST ] && cp $DEST $DEST.bak-$STAMP
cp /tmp/wb-new.js $DEST
[ "${RESTART:-1}" = "0" ] && { echo 'VPS: copiado SIN reiniciar'; exit 0; }
pm2 restart fyra-bridge >/dev/null 2>&1
sleep 8
echo "VPS: status \$(curl -s --max-time 5 http://127.0.0.1:3000/status)"
echo "VPS: respaldo $DEST.bak-$STAMP"
REM
)
REM64=$(printf '%s' "$REMOTE" | base64 | tr -d '\n')
# Canal 1: SSH directo desde la Mac. Canal 2 (si el puerto 22 no responde desde esta red):
# el relay de Vercel /api/vps-exec (solo key; la contraseña vive en Vercel).
OUT=$(expect <<EXP 2>/dev/null | tr -d '\r' | grep -E '^VPS:'
set timeout 120
spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=20 root@$VPS_HOST "echo $REM64 | base64 -d | bash"
expect {
  "password:" { send "$VPS_PASS\r"; exp_continue }
  timeout { puts "VPS: timeout" }
  eof {}
}
EXP
) || true
if ! echo "$OUT" | grep -q 'VPS: status'; then
  echo "   (SSH directo no respondió → relay de Vercel)"
  BODY=$(python3 -c "import json,sys; print(json.dumps({'key':sys.argv[1],'cmd':'echo '+sys.argv[2]+' | base64 -d | bash'}))" "${VPS_EXEC_KEY:-fyra-vpsexec-2026-0905}" "$REM64")
  OUT=$(curl -s --max-time 90 -X POST https://fyrachat.vercel.app/api/vps-exec -H 'Content-Type: application/json' -d "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('stdout','')+('\n[error] '+str(d.get('error')) if not d.get('ok') else ''))")
fi
echo "$OUT"
