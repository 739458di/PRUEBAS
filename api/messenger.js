// FYRADRIVE - Webhook de Facebook Messenger
// GET  /api/messenger = verificación del webhook
// POST /api/messenger = mensaje entrante de Messenger
// Usa las mismas funciones compartidas de webhook.js

const { procesarMensaje, saveMessage, initTables, cleanPhone } = require('./webhook.js');
const { initAITables } = require('./ai-sales.js');

const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN || '';
const VERIFY_TOKEN = 'fyradrive_webhook_2026';

// ===== OBTENER NOMBRE DEL USUARIO DE MESSENGER =====
async function getNombreMessenger(psid) {
    if (!FB_PAGE_TOKEN) return '';
    try {
        var response = await fetch('https://graph.facebook.com/v21.0/' + psid + '?fields=first_name,last_name&access_token=' + FB_PAGE_TOKEN);
        var data = await response.json();
        if (data.first_name) {
            return data.first_name + (data.last_name ? ' ' + data.last_name : '');
        }
        return '';
    } catch (err) {
        console.error('[FYRA-FB] Error obteniendo nombre:', err.message);
        return '';
    }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // GET = Verificación del webhook por Meta
    if (req.method === 'GET') {
        var mode = req.query['hub.mode'];
        var token = req.query['hub.verify_token'];
        var challenge = req.query['hub.challenge'];
        console.log('[FYRA-FB] Webhook verify:', mode, token);
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('[FYRA-FB] Webhook verificado OK');
            return res.status(200).send(challenge);
        }
        return res.status(403).send('Token invalido');
    }

    // POST = Mensaje entrante de Messenger
    if (req.method === 'POST') {
        try {
            await initTables();
            var body = req.body;

            // Messenger envía object === 'page'
            if (body.object === 'page') {
                var entries = body.entry || [];
                for (var i = 0; i < entries.length; i++) {
                    var messaging = entries[i].messaging || [];
                    for (var j = 0; j < messaging.length; j++) {
                        var event = messaging[j];
                        var senderPSID = event.sender ? event.sender.id : '';

                        if (!senderPSID) continue;

                        // Ignorar mensajes del bot (echo)
                        if (event.message && event.message.is_echo) {
                            console.log('[FYRA-FB] Ignorando echo del bot');
                            continue;
                        }

                        // Construir contactId con prefijo fb_
                        var contactId = 'fb_' + senderPSID;

                        // Obtener nombre del usuario
                        var nombre = '';
                        try {
                            nombre = await getNombreMessenger(senderPSID);
                        } catch(ne) {
                            console.error('[FYRA-FB] Error nombre:', ne.message);
                        }

                        // Procesar mensaje de texto
                        if (event.message && event.message.text) {
                            var texto = event.message.text;
                            var messageId = event.message.mid || '';

                            console.log('[FYRA-FB] Mensaje recibido de', contactId, '(' + nombre + '):', texto.substring(0, 50));

                            // Guardar mensaje entrante
                            await saveMessage({
                                wa_id: contactId,
                                telefono: contactId,
                                nombre: nombre,
                                mensaje: texto,
                                tipo: 'text',
                                direccion: 'in',
                                timestamp: Math.floor(Date.now() / 1000),
                                mensaje_id: messageId,
                                platform: 'messenger'
                            });

                            // Procesar con el chatbot
                            try { await initAITables(); } catch(e) {}
                            await procesarMensaje(contactId, nombre, texto, 'messenger');

                        } else if (event.message && event.message.attachments) {
                            // Mensaje con adjuntos (imagen, video, audio, etc.)
                            var attachments = event.message.attachments;
                            var tipo = attachments[0] ? attachments[0].type : 'unknown';
                            var textoAdj = '[' + tipo.charAt(0).toUpperCase() + tipo.slice(1) + ']';

                            console.log('[FYRA-FB] Adjunto recibido de', contactId, ':', textoAdj);

                            await saveMessage({
                                wa_id: contactId,
                                telefono: contactId,
                                nombre: nombre,
                                mensaje: textoAdj,
                                tipo: tipo,
                                direccion: 'in',
                                timestamp: Math.floor(Date.now() / 1000),
                                mensaje_id: event.message.mid || '',
                                platform: 'messenger'
                            });

                        } else if (event.postback) {
                            // Postback de botones de Messenger
                            var payload = event.postback.payload || '';
                            var titulo = event.postback.title || '';
                            console.log('[FYRA-FB] Postback de', contactId, ':', titulo, payload);

                            await saveMessage({
                                wa_id: contactId,
                                telefono: contactId,
                                nombre: nombre,
                                mensaje: titulo || payload || '[Postback]',
                                tipo: 'postback',
                                direccion: 'in',
                                timestamp: Math.floor(Date.now() / 1000),
                                mensaje_id: '',
                                platform: 'messenger'
                            });

                            // Tratar postback como texto para el chatbot
                            if (payload === 'GET_STARTED' || titulo) {
                                try { await initAITables(); } catch(e) {}
                                await procesarMensaje(contactId, nombre, titulo || 'Hola', 'messenger');
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error('[FYRA-FB] Webhook error:', err);
        }

        // Messenger SIEMPRE espera 200 rapido
        return res.status(200).send('EVENT_RECEIVED');
    }

    return res.status(405).send('Method not allowed');
};
