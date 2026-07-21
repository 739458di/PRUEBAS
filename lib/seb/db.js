// lib/seb/db.js
// Cliente Turso para Seb. SIN secretos hardcodeados: el token viene de env
// (en Vercel: variable de entorno; en local: .env cargado por quien ejecuta).
const { createClient } = require('@libsql/client');

const client = createClient({
    url: process.env.TURSO_URL || 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || ''
});

// Ejecuta con timeout + reintento. En redes inestables (hotspot) una conexión
// a Turso se cuelga; sin esto la petición muere a los 35s. Con esto: aborta a
// los 9s y reintenta hasta 3 veces. En Vercel (red estable) nunca se dispara.
async function _exec(sql, args, intentos = 3) {
    let ultimoError;
    for (let i = 0; i < intentos; i++) {
        try {
            return await Promise.race([
                client.execute({ sql, args }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('turso_timeout_9s')), 9000))
            ]);
        } catch (e) {
            ultimoError = e;
            if (i < intentos - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
        }
    }
    throw ultimoError;
}

async function query(sql, args = []) {
    const r = await _exec(sql, args);
    return r.rows;
}

async function run(sql, args = []) {
    return _exec(sql, args);
}

module.exports = { client, query, run };
