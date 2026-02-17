// WA-BRIDGE: Puente WhatsApp (Baileys) ↔ FyraDrive (Vercel)
// Corre en DigitalOcean 24/7
// Conecta WhatsApp via QR, recibe mensajes, los manda al cerebro (Claw en Vercel)

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');

// Config
const BRIDGE_URL = 'https://pruebas-ruby.vercel.app/api/bridge';
const BRIDGE_KEY = process.env.BRIDGE_KEY || 'fyradrive-bridge-2026';
const AUTH_DIR = './auth_info_baileys';
const QR_PORT = 3000;

// Control: evitar procesar mensajes viejos al reconectar
var startTimestamp = Math.floor(Date.now() / 1000);
var isReady = false;
var currentQR = null;
var connectionStatus = 'disconnected';

async function startBridge() {
    console.log('🚗 FyraDrive WA-Bridge iniciando...');
    console.log('📡 Bridge URL:', BRIDGE_URL);

    var { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    var { version } = await fetchLatestBaileysVersion();

    var sock = makeWASocket({
        version: version,
        auth: state,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    // QR code para conectar
    sock.ev.on('connection.update', function(update) {
        var qr = update.qr;
        var connection = update.connection;
        var lastDisconnect = update.lastDisconnect;

        if (qr) {
            currentQR = qr;
            connectionStatus = 'waiting_qr';
            console.log('\n═══════════════════════════════════');
            console.log('📱 ESCANEA QR EN: http://134.209.51.172:' + QR_PORT);
            console.log('═══════════════════════════════════\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            isReady = true;
            currentQR = null;
            connectionStatus = 'connected';
            startTimestamp = Math.floor(Date.now() / 1000);
            console.log('✅ WhatsApp conectado! FyraDrive Bridge activo.');
            console.log('🕐 Timestamp inicio:', new Date().toISOString());
        }

        if (connection === 'close') {
            isReady = false;
            connectionStatus = 'disconnected';
            var statusCode = lastDisconnect && lastDisconnect.error
                ? lastDisconnect.error.output && lastDisconnect.error.output.statusCode
                : null;
            var shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log('❌ Conexion cerrada. Status:', statusCode, '| Reconectar:', shouldReconnect);

            if (shouldReconnect) {
                console.log('🔄 Reconectando en 5 segundos...');
                setTimeout(startBridge, 5000);
            } else {
                console.log('⚠️  Sesion cerrada (logged out). Borra auth_info_baileys/ y reinicia para escanear QR de nuevo.');
            }
        }
    });

    // Guardar credenciales
    sock.ev.on('creds.update', saveCreds);

    // Mensajes entrantes
    sock.ev.on('messages.upsert', async function(m) {
        if (!isReady) return;

        var messages = m.messages || [];
        for (var i = 0; i < messages.length; i++) {
            var msg = messages[i];

            // Ignorar mensajes propios
            if (msg.key.fromMe) continue;

            // Ignorar mensajes de grupo
            if (msg.key.remoteJid.endsWith('@g.us')) continue;

            // Ignorar mensajes de status/broadcast
            if (msg.key.remoteJid === 'status@broadcast') continue;

            // Ignorar mensajes viejos (antes de que el bridge iniciara)
            var msgTimestamp = msg.messageTimestamp || 0;
            if (typeof msgTimestamp === 'object' && msgTimestamp.low) msgTimestamp = msgTimestamp.low;
            if (msgTimestamp < startTimestamp - 10) {
                continue;
            }

            // Extraer texto
            var texto = '';
            if (msg.message) {
                if (msg.message.conversation) {
                    texto = msg.message.conversation;
                } else if (msg.message.extendedTextMessage) {
                    texto = msg.message.extendedTextMessage.text || '';
                } else if (msg.message.imageMessage) {
                    texto = '[Imagen]';
                } else if (msg.message.audioMessage) {
                    texto = '[Audio]';
                } else if (msg.message.videoMessage) {
                    texto = '[Video]';
                } else if (msg.message.documentMessage) {
                    texto = '[Documento]';
                } else if (msg.message.stickerMessage) {
                    texto = '[Sticker]';
                } else if (msg.message.contactMessage) {
                    texto = '[Contacto]';
                } else if (msg.message.locationMessage) {
                    texto = '[Ubicacion]';
                }
            }

            if (!texto) continue;

            // Extraer telefono (quitar @s.whatsapp.net)
            var jid = msg.key.remoteJid || '';
            var telefono = jid.replace('@s.whatsapp.net', '');

            // Extraer nombre
            var nombre = msg.pushName || '';

            console.log('[MSG IN]', telefono, '(' + nombre + '):', texto.substring(0, 80));

            // Marcar como leido
            try {
                await sock.readMessages([msg.key]);
            } catch(e) {}

            // Enviar al cerebro (FyraDrive Vercel)
            try {
                var response = await fetch(BRIDGE_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-bridge-key': BRIDGE_KEY
                    },
                    body: JSON.stringify({
                        telefono: telefono,
                        nombre: nombre,
                        texto: texto
                    })
                });

                var data = await response.json();

                if (data.ok && data.respuestas && data.respuestas.length > 0) {
                    for (var r = 0; r < data.respuestas.length; r++) {
                        var respuesta = data.respuestas[r];
                        console.log('[MSG OUT]', telefono, ':', respuesta.substring(0, 80));

                        // Enviar respuesta por WhatsApp
                        await sock.sendMessage(jid, { text: respuesta });

                        // Pausa entre mensajes si hay varios
                        if (r < data.respuestas.length - 1) {
                            await new Promise(function(resolve) { setTimeout(resolve, 1000); });
                        }
                    }
                } else {
                    console.error('[BRIDGE ERROR]', response.status, JSON.stringify(data));
                }
            } catch (err) {
                console.error('[BRIDGE ERROR]', err.message);
            }
        }
    });
}

// Mini servidor HTTP para mostrar QR en navegador (server-side rendering)
http.createServer(async function(req, res) {
    // Ruta /qr.png — imagen directa del QR
    if (req.url === '/qr.png' && currentQR) {
        try {
            var pngBuffer = await QRCode.toBuffer(currentQR, { width: 400, margin: 2 });
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
            res.end(pngBuffer);
            return;
        } catch(e) {}
    }

    if (connectionStatus === 'connected') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="background:#111;color:#0f0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;font-size:2em"><div style="text-align:center">WhatsApp Conectado<br><br>FyraDrive Bridge Activo</div></body></html>');
        return;
    }
    if (!currentQR) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="background:#111;color:#ff0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;font-size:1.5em"><div style="text-align:center">Esperando QR...<br><br>Recarga en unos segundos</div></body></html>');
        return;
    }
    // Generar QR como imagen PNG del lado del servidor
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
        '<body style="background:#111;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:monospace">' +
        '<h1 style="margin-bottom:20px">Escanea con WhatsApp</h1>' +
        '<img src="/qr.png" style="width:300px;height:300px;border-radius:12px;background:#fff;padding:10px" />' +
        '<p style="color:#888;margin-top:20px">FyraDrive WA-Bridge</p>' +
        '<script>setTimeout(function(){location.reload()},25000);</script>' +
        '</body></html>');
}).listen(QR_PORT, '0.0.0.0', function() {
    console.log('QR Server: http://134.209.51.172:' + QR_PORT);
});

// Iniciar
startBridge().catch(function(err) {
    console.error('Error fatal:', err);
    process.exit(1);
});
