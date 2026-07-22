#!/bin/bash
echo "=== PM2 STATUS ==="
pm2 list
echo "=== DEPS TEST ==="
cd /root/wa-bridge && node -e 'require("@whiskeysockets/baileys"); require("@libsql/client"); require("qrcode-terminal"); require("@hapi/boom"); console.log("DEPS_OK")' 2>&1 | tail -8
echo "=== OUT LOG ==="
tail -30 /root/.pm2/logs/fyra-bridge-out.log 2>/dev/null
echo "=== ERR LOG ==="
tail -30 /root/.pm2/logs/fyra-bridge-error.log 2>/dev/null
echo "DONE_MARKER"
