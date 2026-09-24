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
const RE_SQL_DETERMINISTA = /duplicate column|no such (table|column|function|index)|syntax error|already exists|constraint failed|UNIQUE constraint|NOT NULL constraint|CHECK constraint|FOREIGN KEY constraint|has no column|datatype mismatch|too many SQL variables|SQLITE_CONSTRAINT|SQLITE_MISMATCH|SQLITE_RANGE|SQLITE_TOOBIG/i;
function esErrorDeterminista(e) {
    const m = String((e && e.message) || '');
    if (/SQLITE_BUSY|database is locked|turso_timeout|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|getaddrinfo|socket|network|fetch failed|request to .* failed|stream|WebSocket|HRANA/i.test(m)) return false;   // transitorios: sí se reintentan
    return RE_SQL_DETERMINISTA.test(m);
}

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
            // RENDIMIENTO (2026-09-23): un error del PROPIO SQL (columna duplicada, tabla inexistente, sintaxis,
            // constraint) es determinista: reintentarlo jamás lo arregla y costaba 3 viajes + 1.5 s de pausas por
            // cada "ALTER TABLE ... ADD COLUMN" idempotente de los ensure* (2.1 s medidos vs 0.15 s). Solo se
            // reintentan los errores de red/tiempo (timeout, socket, stream, busy/locked).
            if (esErrorDeterminista(e)) break;
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
