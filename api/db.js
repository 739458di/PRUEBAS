// CRM Database API - Turso (LibSQL) - Permanent cloud database
// Both Sebastian and Mario can read/write the same data in real time

const { createClient } = require('@libsql/client');

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzA4MjUwMDYsImlkIjoiYTczOTliMjctYWFlNi00YjhmLWJmYjktODQ2M2JmMWU1MzljIiwicmlkIjoiNWVhMDBiM2QtNzNiNS00Njg3LWFjN2YtMTNhMGQzZmJlZmM1In0.ZVnn2UF2WdEw_yvQYGGB9Eyvbh_JRniPhkByn6Vxiavki0FkHVM8Xb0cwu1Ijrhti_j3iiOxS5jtt2IwCRWvDA'
});

const EMPTY_DATA = { vendedores: [], compradores: [], proyectos: [], eventos: [] };

async function getData() {
    try {
        const result = await client.execute("SELECT data FROM crm_data WHERE id = 'main'");
        if (result.rows.length === 0) {
            // No data yet, initialize
            await client.execute({
                sql: 'INSERT INTO crm_data (id, data, updated_at) VALUES (?, ?, ?)',
                args: ['main', JSON.stringify(EMPTY_DATA), Date.now()]
            });
            return EMPTY_DATA;
        }
        return JSON.parse(result.rows[0].data);
    } catch (err) {
        console.error('getData error:', err);
        return EMPTY_DATA;
    }
}

async function putData(data) {
    try {
        await client.execute({
            sql: 'UPDATE crm_data SET data = ?, updated_at = ? WHERE id = ?',
            args: [JSON.stringify(data), Date.now(), 'main']
        });
        return { success: true };
    } catch (err) {
        console.error('putData error:', err);
        throw err;
    }
}

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        if (req.method === 'GET') {
            const data = await getData();
            return res.status(200).json(data);
        }

        if (req.method === 'PUT') {
            const result = await putData(req.body);
            return res.status(200).json(result);
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
