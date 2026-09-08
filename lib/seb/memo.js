// lib/seb/memo.js — CACHÉ EN MEMORIA DEL PROCESO (cuota Turso, 2026-09-08).
// Turso cobra por FILA LEÍDA. Las lecturas que se repiten muchas veces con el
// mismo resultado (inventario activo, teléfonos de dueños, set de campaña muda,
// estado de una conversación dentro de un mismo request) se sirven de aquí.
//
// Reglas:
//   - TTL corto (segundos) para lo que puede cambiar; 5 min solo para los dueños.
//   - Vercel atiende UNA invocación a la vez por instancia; el caché vive en la
//     instancia caliente y se comparte entre invocaciones consecutivas.
//   - `olvidar(prefijo)` invalida (p.ej. al inicio de un request para lo que es
//     "por request", o al escribir en la tabla cacheada).
//   - Las filas devueltas se COMPARTEN: los callers deben mapear, no mutar.
const { query } = require('./db.js');

const _c = new Map();   // key → { exp, val } | { p }

async function memo(key, ttlMs, fn) {
    const now = Date.now();
    const h = _c.get(key);
    if (h) {
        if (h.p) return h.p;                       // en vuelo → misma promesa
        if (h.exp > now) return h.val;
    }
    const p = Promise.resolve().then(fn);
    _c.set(key, { p });
    try {
        const val = await p;
        _c.set(key, { exp: Date.now() + ttlMs, val });
        return val;
    } catch (e) {
        _c.delete(key);
        throw e;
    }
}

// SELECT cacheado por (sql, args). Devuelve las MISMAS filas a todos los callers.
function memoQuery(ttlMs, sql, args = []) {
    return memo('q:' + sql + '|' + JSON.stringify(args), ttlMs, () => query(sql, args));
}

function olvidar(prefijo) {
    for (const k of [..._c.keys()]) if (!prefijo || k.startsWith(prefijo)) _c.delete(k);
}

// Inventario activo: cambia pocas veces al día; 15 s bastan para colapsar las
// 5-10 lecturas que hace UN solo mensaje entrante (clasificador, aparador, mesa…).
const INV_TTL = 15000;

// Teléfonos (últimos 10 dígitos) de TODOS los dueños del inventario — se usa en
// cada lista de chats y en cada mensaje entrante. TTL 5 min (orden 2026-09-08).
async function telefonosDueno() {
    return memo('duenos10', 5 * 60000, async () => {
        const rows = await query("SELECT DISTINCT dueno_telefono t FROM inventario_autos WHERE dueno_telefono IS NOT NULL");
        return new Set(rows.map(r => String(r.t).replace(/\D/g, '').slice(-10)).filter(x => x.length === 10));
    });
}

module.exports = { memo, memoQuery, olvidar, telefonosDueno, INV_TTL };
