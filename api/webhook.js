// WhatsApp Webhook - Recibe mensajes entrantes de clientes
// Meta envía notificaciones aquí cuando un cliente responde
// GET  /api/webhook = verificación del webhook (Meta lo valida)
// POST /api/webhook = mensaje entrante

const { createClient } = require('@libsql/client');

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzA4MjUwMDYsImlkIjoiYTczOTliMjctYWFlNi00YjhmLWJmYjktODQ2M2JmMWU1MzljIiwicmlkIjoiNWVhMDBiM2QtNzNiNS00Njg3LWFjN2YtMTNhMGQzZmJlZmM1In0.ZVnn2UF2WdEw_yvQYGGB9Eyvbh_JRniPhkByn6Vxiavki0FkHVM8Xb0cwu1Ijrhti_j3iiOxS5jtt2IwCRWvDA'
});

const VERIFY_TOKEN = 'fyradrive_webhook_2026';

// Inicializar tabla de mensajes si no existe
async function initTable() {
    try {
        await client.execute(`
            CREATE TABLE IF NOT EXISTS wa_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                wa_id TEXT,
                telefono TEXT,
                nombre TEXT,
                mensaje TEXT,
                tipo TEXT DEFAULT 'text',
                direccion TEXT DEFAULT 'in',
                timestamp INTEGER,
                mensaje_id TEXT,
                leido INTEGER DEFAULT 0,
                created_at INTEGER
            )
        `);
    } catch (err) {
        console.error('initTable error:', err);
    }
}

// Guardar mensaje entrante
async function saveMessage(data) {
    try {
        await initTable();
        await client.execute({
            sql: `INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                data.wa_id || '',
                data.telefono || '',
                data.nombre || '',
                data.mensaje || '',
                data.tipo || 'text',
                data.direccion || 'in',
                data.timestamp || Math.floor(Date.now() / 1000),
                data.mensaje_id || '',
                Date.now()
            ]
        });
    } catch (err) {
        console.error('saveMessage error:', err);
    }
}

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // GET = Verificación del webhook por Meta
    if (req.method === 'GET') {
        var mode = req.query['hub.mode'];
        var token = req.query['hub.verify_token'];
        var challenge = req.query['hub.challenge'];

        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('Webhook verificado!');
            return res.status(200).send(challenge);
        } else {
            return res.status(403).send('Token invalido');
        }
    }

    // POST = Mensaje entrante de WhatsApp
    if (req.method === 'POST') {
        var body = req.body;

        // Meta siempre manda object con entry[]
        if (body.object === 'whatsapp_business_account') {
            var entries = body.entry || [];
            for (var i = 0; i < entries.length; i++) {
                var changes = entries[i].changes || [];
                for (var j = 0; j < changes.length; j++) {
                    var value = changes[j].value;

                    // Mensajes recibidos
                    if (value.messages) {
                        for (var k = 0; k < value.messages.length; k++) {
                            var msg = value.messages[k];
                            var contacto = value.contacts && value.contacts[0] ? value.contacts[0] : {};

                            var messageData = {
                                wa_id: msg.from || '',
                                telefono: msg.from || '',
                                nombre: contacto.profile ? contacto.profile.name : '',
                                mensaje: '',
                                tipo: msg.type || 'text',
                                direccion: 'in',
                                timestamp: parseInt(msg.timestamp) || Math.floor(Date.now() / 1000),
                                mensaje_id: msg.id || ''
                            };

                            // Extraer contenido según tipo
                            if (msg.type === 'text' && msg.text) {
                                messageData.mensaje = msg.text.body || '';
                            } else if (msg.type === 'image') {
                                messageData.mensaje = '[Imagen]';
                            } else if (msg.type === 'audio') {
                                messageData.mensaje = '[Audio]';
                            } else if (msg.type === 'video') {
                                messageData.mensaje = '[Video]';
                            } else if (msg.type === 'document') {
                                messageData.mensaje = '[Documento]';
                            } else if (msg.type === 'location') {
                                messageData.mensaje = '[Ubicacion]';
                            } else if (msg.type === 'sticker') {
                                messageData.mensaje = '[Sticker]';
                            } else if (msg.type === 'reaction') {
                                messageData.mensaje = '[Reaccion]';
                            } else {
                                messageData.mensaje = '[' + msg.type + ']';
                            }

                            await saveMessage(messageData);
                            console.log('Mensaje guardado:', messageData.telefono, messageData.mensaje);
                        }
                    }

                    // Status updates (delivered, read, etc)
                    if (value.statuses) {
                        for (var s = 0; s < value.statuses.length; s++) {
                            var status = value.statuses[s];
                            console.log('Status:', status.id, status.status);
                        }
                    }
                }
            }
        }

        // Meta espera 200 OK siempre
        return res.status(200).send('OK');
    }

    return res.status(405).send('Method not allowed');
};
