// lib/seb/campana.js — CANDADO DE CAMPAÑA 📢 (orden owner 2026-07-25):
// "asegúrate de que mandando ese mensaje el bot no diga una sola palabra".
// Los teléfonos de un blast quedan MUDOS para el bot: ni Seb, ni Ignacio, ni
// la máquina de rescate les dicen NADA — lo que contesten solo se escala al
// owner. El candado se LIBERA solo cuando el owner escribe a mano en ese chat
// (eco manual del teléfono → rescate_manual, o manual ai=0 posterior al candado).
// Única excepción deliberada: la máquina de CITAS VIVAS (cancelar / en camino)
// sigue operando — una cita real no se rompe por una campaña.
const { createClient } = require('@libsql/client');
const db = createClient({ url: process.env.TURSO_URL || 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io', authToken: process.env.TURSO_AUTH_TOKEN });
const query = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const run = async (sql, args = []) => db.execute({ sql, args });

let lista = false;
async function ensure() {
    if (lista) return;
    await run("CREATE TABLE IF NOT EXISTS campana_muda (telefono TEXT PRIMARY KEY, ts INTEGER, campana TEXT)");
    lista = true;
}

const t10 = tel => String(tel || '').replace(/\D/g, '').slice(-10);

// ¿este teléfono está mudo por campaña? → { telefono, ts, campana } | null
async function esMudo(tel) {
    try {
        await ensure();
        const r = await query("SELECT * FROM campana_muda WHERE telefono=?", [t10(tel)]);
        return r.length ? r[0] : null;
    } catch (e) { console.error('[campana esMudo]', e.message); return null; }
}

// el owner retomó el chat → se libera
async function liberar(tel) {
    try { await ensure(); await run("DELETE FROM campana_muda WHERE telefono=?", [t10(tel)]); } catch (e) { }
}

// el set completo (para filtrar el barredor de rescate sin N consultas)
async function setMudos() {
    try {
        await ensure();
        const r = await query("SELECT telefono FROM campana_muda", []);
        return new Set(r.map(x => String(x.telefono)));
    } catch (e) { return new Set(); }
}

// dar de alta una campaña (lista de teléfonos)
async function callar(tels, campana) {
    await ensure();
    const ts = Date.now();
    for (const tel of tels) {
        await run("INSERT OR REPLACE INTO campana_muda (telefono, ts, campana) VALUES (?, ?, ?)", [t10(tel), ts, String(campana || 'campana')]);
    }
    return tels.length;
}

module.exports = { esMudo, liberar, setMudos, callar, t10 };
