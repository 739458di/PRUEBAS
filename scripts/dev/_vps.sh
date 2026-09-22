#!/bin/bash
# Ayudante: corre un comando en el VPS via SSH con password (expect).
# Uso: ./_vps.sh "comando remoto"
# Uso archivo: ./_vps.sh --put localpath remotepath   (sube un archivo via scp)
set -e
CREDS="$(dirname "$0")/../../.vps-creds"
export $(grep -E '^VPS_' "$CREDS" | xargs)

if [ "$1" == "--put" ]; then
  expect <<EXP
set timeout 120
spawn scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$2" root@$VPS_IP:"$3"
expect { "password:" { send "$VPS_PASSWORD\r"; exp_continue } eof }
EXP
  exit 0
fi

expect <<EXP
set timeout 600
spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@$VPS_IP "$1"
expect { "password:" { send "$VPS_PASSWORD\r"; exp_continue } eof }
EXP
