// lib/seb/db.js
// Cliente Turso para Seb. SIN secretos hardcodeados: el token viene de env
// (en Vercel: variable de entorno; en local: .env cargado por quien ejecuta).
const { createClient } = require('@libsql/client');

const client = createClient({
    url: process.env.TURSO_URL || 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || ''
});

async function query(sql, args = []) {
    const r = await client.execute({ sql, args });
    return r.rows;
}

async function run(sql, args = []) {
    return client.execute({ sql, args });
}

module.exports = { client, query, run };
