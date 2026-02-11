// API para enviar mensajes de WhatsApp via Meta Cloud API
// POST /api/whatsapp
// Body: { telefono, mensaje, nombre? }
// Header: x-api-key = fyradrive2026

const { createClient } = require('@libsql/client');

const dbClient = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzA4MjUwMDYsImlkIjoiYTczOTliMjctYWFlNi00YjhmLWJmYjktODQ2M2JmMWU1MzljIiwicmlkIjoiNWVhMDBiM2QtNzNiNS00Njg3LWFjN2YtMTNhMGQzZmJlZmM1In0.ZVnn2UF2WdEw_yvQYGGB9Eyvbh_JRniPhkByn6Vxiavki0FkHVM8Xb0cwu1Ijrhti_j3iiOxS5jtt2IwCRWvDA'
});

const WA_TOKEN = process.env.WA_TOKEN || 'EAAcJmKFNOhYBQsJ7OsS0mmrutqcaiDPM7pZB0yBA8P3C97RWMyfHIttlqKFETTdvXqmOLOpGZBlGS2qrTLANNvkKJIJ4rySnB3retbc1sdjHlGV9ZCK0nVYbxI5B8GNcZCwzM05HctvpAQQZBhuVrXBlJVZB897e4m1zWErozWB1eBiD1nwiRw2xtnYR249oZC21XLnLsMZAKfup7CoR6qBdPmsYZCXZByyL238tUZBZBnx0iOqpFBEQN1Og4gypD2h4WibApKZCCzV35t3Nypj9QnVhl6qZCD';
const PHONE_NUMBER_ID = '968960759641278';
const API_KEY = 'fyradrive2026';
const WA_API_URL = 'https://graph.facebook.com/v21.0/' + PHONE_NUMBER_ID + '/messages';

async function initTable() {
    try {
        await dbClient.execute(`
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

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Solo POST' });

    // Auth
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEY) {
        return res.status(401).json({ error: 'API key invalida' });
    }

    const { telefono, mensaje, nombre } = req.body;

    // Validar
    if (!telefono) {
        return res.status(400).json({ error: 'telefono requerido' });
    }
    if (!mensaje) {
        return res.status(400).json({ error: 'mensaje requerido' });
    }

    // Limpiar telefono
    var clean = telefono.replace(/\D/g, '');
    if (clean.length === 10) {
        clean = '52' + clean;
    } else if (clean.length === 11 && clean.startsWith('1')) {
        clean = '52' + clean;
    } else if (clean.length === 13 && clean.startsWith('521')) {
        // ya tiene 521
    } else if (clean.length === 12 && clean.startsWith('52')) {
        // ya tiene 52
    }

    try {
        const response = await fetch(WA_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + WA_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: clean,
                type: 'text',
                text: {
                    preview_url: false,
                    body: mensaje
                }
            })
        });

        const data = await response.json();

        if (response.ok) {
            // Guardar mensaje enviado en la base de datos
            await initTable();
            await dbClient.execute({
                sql: `INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                    clean,
                    clean,
                    'FYRADRIVE',
                    mensaje,
                    'text',
                    'out',
                    Math.floor(Date.now() / 1000),
                    data.messages ? data.messages[0].id : '',
                    Date.now()
                ]
            });

            return res.status(200).json({
                enviado: true,
                mensaje_id: data.messages ? data.messages[0].id : null,
                telefono: clean,
                detalle: data
            });
        } else {
            return res.status(response.status).json({
                enviado: false,
                error: data.error ? data.error.message : 'Error desconocido',
                codigo: data.error ? data.error.code : null,
                detalle: data
            });
        }

    } catch (err) {
        return res.status(500).json({
            enviado: false,
            error: err.message
        });
    }
};
