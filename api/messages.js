// API para leer mensajes de WhatsApp almacenados
// GET /api/messages?telefono=528120066355 = mensajes de un cliente
// GET /api/messages = todos los mensajes recientes
// Header: x-api-key = fyradrive2026

const { createClient } = require('@libsql/client');

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzA4MjUwMDYsImlkIjoiYTczOTliMjctYWFlNi00YjhmLWJmYjktODQ2M2JmMWU1MzljIiwicmlkIjoiNWVhMDBiM2QtNzNiNS00Njg3LWFjN2YtMTNhMGQzZmJlZmM1In0.ZVnn2UF2WdEw_yvQYGGB9Eyvbh_JRniPhkByn6Vxiavki0FkHVM8Xb0cwu1Ijrhti_j3iiOxS5jtt2IwCRWvDA'
});

const API_KEY = 'fyradrive2026';

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

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Solo GET' });

    var apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEY) return res.status(401).json({ error: 'API key invalida' });

    await initTable();

    var telefono = req.query.telefono;
    var limit = parseInt(req.query.limit) || 50;

    try {
        var result;
        if (telefono) {
            // Messenger: lookup directo con fb_ prefix
            if (telefono.startsWith('fb_')) {
                result = await client.execute({
                    sql: 'SELECT * FROM wa_messages WHERE telefono = ? ORDER BY timestamp DESC LIMIT ?',
                    args: [telefono, limit]
                });
            } else {
                // WhatsApp: buscar con variantes de telefono
                var clean = telefono.replace(/\D/g, '');
                var variants = [clean];
                if (clean.length === 10) {
                    variants.push('52' + clean);
                    variants.push('521' + clean);
                } else if (clean.length === 12 && clean.startsWith('52')) {
                    variants.push(clean.substring(2));
                    variants.push('521' + clean.substring(2));
                } else if (clean.length === 13 && clean.startsWith('521')) {
                    variants.push(clean.substring(3));
                    variants.push('52' + clean.substring(3));
                }

                var placeholders = variants.map(function() { return '?'; }).join(',');
                result = await client.execute({
                    sql: 'SELECT * FROM wa_messages WHERE telefono IN (' + placeholders + ') ORDER BY timestamp DESC LIMIT ?',
                    args: variants.concat([limit])
                });
            }
        } else {
            // Todos los mensajes recientes
            result = await client.execute({
                sql: 'SELECT * FROM wa_messages ORDER BY timestamp DESC LIMIT ?',
                args: [limit]
            });
        }

        var messages = result.rows.map(function(row) {
            return {
                id: row.id,
                telefono: row.telefono,
                nombre: row.nombre,
                mensaje: row.mensaje,
                tipo: row.tipo,
                direccion: row.direccion,
                timestamp: row.timestamp,
                mensaje_id: row.mensaje_id,
                leido: row.leido,
                ai_generated: row.ai_generated || 0,
                platform: row.platform || 'whatsapp',
                created_at: row.created_at
            };
        });

        return res.status(200).json({ messages: messages, total: messages.length });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
