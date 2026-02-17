// WA-BRIDGE: Puente WhatsApp (Baileys) ↔ FyraDrive (Vercel)
// Corre en DigitalOcean 24/7
// Conecta WhatsApp via QR, recibe mensajes, los manda al cerebro (Claw en Vercel)

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

// Config
const BRIDGE_URL = 'https://pruebas-ruby.vercel.app/api/bridge';
const BRIDGE_KEY = process.env.BRIDGE_KEY || 'fyradrive-bridge-2026';
const AUTH_DIR = './auth_info_baileys';

// Control: evitar procesar mensajes viejos al reconectar
var startTimestamp = Math.floor(Date.now() / 1000);
var isReady = false;

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
            console.log('\n═══════════════════════════════════');
            console.log('📱 ESCANEA ESTE QR CON TU WHATSAPP');
            console.log('═══════════════════════════════════\n');
            qrcode.generate(qr, { small: true });
            console.log('\n═══════════════════════════════════\n');
        }

        if (connection === 'open') {
            isReady = true;
            startTimestamp = Math.floor(Date.now() / 1000);
            console.log('✅ WhatsApp conectado! FyraDrive Bridge activo.');
            console.log('🕐 Timestamp inicio:', new Date().toISOString());
        }

        if (connection === 'close') {
            isReady = false;
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

// Iniciar
startBridge().catch(function(err) {
    console.error('Error fatal:', err);
    process.exit(1);
});
