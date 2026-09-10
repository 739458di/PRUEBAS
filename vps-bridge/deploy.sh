#!/bin/bash
# ══ DEPLOY DEL PUENTE (Fase 0.3, 2026-09-07 · anti-hackeo 2026-09-10) — un solo comando, con verificación ══
# Flujo: repo → Vercel Blob → VPS (curl) → byte-match → node --check → ¿K_PUENTE en .env? → respaldo → pm2 restart → /status con llave
# Si cualquier verificación falla, NO se reinicia: el puente viejo sigue vivo.
# Uso: bash vps-bridge/deploy.sh                       (despliega wa-bridge-v3.js)
#      SRC=vps-bridge/wa-bridge-v2.js bash vps-bridge/deploy.sh   (rollback a v2: luego cambiar script en ecosystem)
#      RESTART=0 …                                       (solo copia, sin reiniciar)
# ANTES del primer deploy anti-hackeo: /root/wa-bridge/.env DEBE tener K_PUENTE=<llave> (y KEY_VIEJA=<llave vieja> mientras
# dure la rotación). El guion remoto aborta si K_PUENTE falta: el puente nuevo hace process.exit(1) sin ella.
# SECRETOS: ninguno vive aquí. VPS_PASS/VPS_EXEC_KEY vienen del entorno o de PRUEBAS/.vps-creds (gitignored).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${SRC:-$HERE/wa-bridge-v3.js}"          # archivo del repo a desplegar (v2 = rollback)
DEST="${DEST:-$(basename "$SRC")}"           # nombre en /root/wa-bridge
VPS_HOST="${VPS_HOST:-137.184.199.19}"
CREDS="$HERE/../.vps-creds"
VPS_PASS="${VPS_PASS:-$(grep -E "^VPS_PASSWORD=" "$CREDS" 2>/dev/null | cut -d= -f2- || true)}"
VPS_EXEC_KEY="${VPS_EXEC_KEY:-$(grep -E "^VPS_EXEC_KEY=" "$CREDS" 2>/dev/null | cut -d= -f2- || true)}"   # relay Vercel (canal 2); sin literal
[ -z "$VPS_PASS" ] && { echo "✗ falta VPS_PASS (env o PRUEBAS/.vps-creds)"; exit 1; }
node --check "$SRC" || { echo "✗ sintaxis inválida en el repo — no se despliega"; exit 1; }
# Guardia local: ningún literal de llave puede viajar al VPS (PERMITIR_LITERALES=1 solo para un rollback de emergencia a v2).
if [ "${PERMITIR_LITERALES:-0}" != "1" ] && grep -n -E "fyra-bridge-v2|fyradrive-sb-2026|fyra-cron-2026" "$SRC" | grep -v -E "^[0-9]+:[[:space:]]*//" >/dev/null; then
  echo "✗ el archivo contiene un literal de llave (fyra-bridge-v2 / fyradrive-sb-2026 / fyra-cron-2026) — no se despliega"; exit 1
fi
SIZE=$(wc -c < "$SRC" | tr -d ' ')
echo "① subiendo al Blob ($SIZE bytes)…"
URL=$(cd /Users/Shared/fyradrive-web && node -e "
require('dotenv').config({ path: '.env.local' });
const { put } = require('@vercel/blob'); const fs = require('fs');
put('deploy/wa-bridge-v2-' + Date.now() + '.js', fs.readFileSync(process.argv[1]), { access: 'public', contentType: 'text/plain' })
  .then(b => console.log(b.url)).catch(e => { console.error('BLOB-ERR ' + e.message); process.exit(1); });
" "$SRC")
echo "   $URL"
echo "② en el VPS: bajar → verificar → K_PUENTE en .env → respaldar → reiniciar (UNA sesión SSH)…"
STAMP=$(date +%Y%m%d-%H%M)
# El guion remoto viaja en base64: sin comillas anidadas ni corchetes que expect/Tcl malinterprete.
# Los \$ se escapan para que se expandan EN EL VPS, no aquí.
REMOTE=$(cat <<REM
cd /root/wa-bridge || exit 1
curl -s -o /tmp/wb-new.js '$URL' || { echo 'VPS: curl fallo'; exit 1; }
echo "VPS: destino $DEST"
S=\$(wc -c < /tmp/wb-new.js)
echo "VPS: bytes recibidos \$S (esperados $SIZE)"
[ "\$S" = "$SIZE" ] || { echo 'VPS: FALLO tamano — NO se reinicia'; exit 1; }
node --check /tmp/wb-new.js || { echo 'VPS: FALLO sintaxis — NO se reinicia'; exit 1; }
[ -f /root/wa-bridge/.env ] || { echo 'VPS: FALLO no existe /root/wa-bridge/.env — NO se despliega'; exit 1; }
K=\$(grep -E '^K_PUENTE=' /root/wa-bridge/.env | head -1 | cut -d= -f2-)
[ -n "\$K" ] || { echo 'VPS: FALLO falta K_PUENTE en /root/wa-bridge/.env — NO se despliega (el puente nuevo no arranca sin ella)'; exit 1; }
echo "VPS: K_PUENTE presente en .env (\${#K} chars)"
grep -qE '^KEY_VIEJA=.+' /root/wa-bridge/.env && echo 'VPS: KEY_VIEJA presente (transicion activa)' || echo 'VPS: sin KEY_VIEJA (solo K_PUENTE)'
[ -f $DEST ] && cp $DEST $DEST.bak-$STAMP
cp /tmp/wb-new.js $DEST
[ "${RESTART:-1}" = "0" ] && { echo 'VPS: copiado SIN reiniciar'; exit 0; }
pm2 restart fyra-bridge --update-env >/dev/null 2>&1
sleep 8
echo "VPS: pm2 \$(pm2 describe fyra-bridge 2>/dev/null | grep -i -m1 status | tr -s ' ' | tr -d '│')"
echo "VPS: status-sin-llave HTTP \$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/status) (esperado 401)"
echo "VPS: status \$(curl -s --max-time 5 -H "x-api-key: \$K" http://127.0.0.1:3000/status)"
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
if ! echo "$OUT" | grep -q -E 'VPS: (status|copiado|FALLO)'; then
  echo "   (SSH directo no respondió → relay de Vercel)"
  [ -z "$VPS_EXEC_KEY" ] && { echo "✗ falta VPS_EXEC_KEY (env o PRUEBAS/.vps-creds) para el relay — no se puede continuar"; exit 1; }
  BODY=$(python3 -c "import json,sys; print(json.dumps({'key':sys.argv[1],'cmd':'echo '+sys.argv[2]+' | base64 -d | bash'}))" "$VPS_EXEC_KEY" "$REM64")
  OUT=$(curl -s --max-time 90 -X POST https://fyrachat.vercel.app/api/vps-exec -H 'Content-Type: application/json' -d "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('stdout','')+('\n[error] '+str(d.get('error')) if not d.get('ok') else ''))")
fi
echo "$OUT"
# Veredicto: si el guion remoto abortó, que este comando también falle (para que no pase desapercibido).
echo "$OUT" | grep -q 'VPS: FALLO' && { echo "✗ deploy ABORTADO en el VPS (ver arriba); el puente anterior sigue vivo"; exit 1; }
exit 0
