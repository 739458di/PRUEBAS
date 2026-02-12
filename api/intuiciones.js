// FYRADRIVE - Intuiciones personales de Sebastián
// GET  /api/intuiciones = leer intuiciones
// POST /api/intuiciones = guardar nueva intuición

const { createClient } = require('@libsql/client');

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzA4MjUwMDYsImlkIjoiYTczOTliMjctYWFlNi00YjhmLWJmYjktODQ2M2JmMWU1MzljIiwicmlkIjoiNWVhMDBiM2QtNzNiNS00Njg3LWFjN2YtMTNhMGQzZmJlZmM1In0.ZVnn2UF2WdEw_yvQYGGB9Eyvbh_JRniPhkByn6Vxiavki0FkHVM8Xb0cwu1Ijrhti_j3iiOxS5jtt2IwCRWvDA'
});

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.status(200).end();

    var apiKey = req.headers['x-api-key'];
    if (apiKey !== 'fyradrive2026') return res.status(401).json({ error: 'No autorizado' });

    // Asegurar tabla existe
    try {
        await client.execute(`
            CREATE TABLE IF NOT EXISTS intuiciones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telefono TEXT DEFAULT '',
                texto TEXT,
                tipo TEXT DEFAULT 'general',
                created_at INTEGER
            )
        `);
    } catch(e) {}

    // GET: Leer intuiciones
    if (req.method === 'GET') {
        try {
            var limite = req.query.limite || '20';
            var telefono = req.query.telefono || '';

            var result;
            if (telefono) {
                result = await client.execute({
                    sql: 'SELECT * FROM intuiciones WHERE telefono = ? ORDER BY created_at DESC LIMIT ?',
                    args: [telefono, parseInt(limite)]
                });
            } else {
                result = await client.execute({
                    sql: 'SELECT * FROM intuiciones ORDER BY created_at DESC LIMIT ?',
                    args: [parseInt(limite)]
                });
            }

            return res.status(200).json({ ok: true, intuiciones: result.rows });
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message });
        }
    }

    // POST: Guardar intuición
    if (req.method === 'POST') {
        try {
            var body = req.body || {};
            var texto = body.texto || '';
            var telefono = body.telefono || '';
            var tipo = body.tipo || 'general'; // general, cliente, mercado, producto, cierre, objecion

            if (!texto) return res.status(400).json({ error: 'Falta texto' });

            await client.execute({
                sql: 'INSERT INTO intuiciones (telefono, texto, tipo, created_at) VALUES (?,?,?,?)',
                args: [telefono, texto, tipo, Date.now()]
            });

            return res.status(200).json({ ok: true, message: 'Intuición guardada' });
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
