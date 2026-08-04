// lib/seb/programados.js — MENSAJES PROGRAMADOS A MANO (orden owner 2026-08-03):
// las promesas automáticas murieron. Ahora el owner agenda el recordatorio como
// en Google Calendar: pica el HORARIO en el Calendar (🛟 MENSAJES), pone teléfono
// y texto (editable, prellenado con el machote), y ESE momento es el envío.
// El canal de salida es el MISMO ghost_scan que ya recorre el puente cada ~15 min
// (granularidad real: el minuto exacto + hasta ~15 min del barredor).
const { createClient } = require('@libsql/client');
const db = createClient({ url: process.env.TURSO_URL || 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io', authToken: process.env.TURSO_AUTH_TOKEN });
const query = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const run = async (sql, args = []) => db.execute({ sql, args });

let lista = false;
async function ensure() {
    if (lista) return;
    await run(`CREATE TABLE IF NOT EXISTS mensajes_programados (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telefono TEXT, nombre TEXT, texto TEXT,
        con_foto INTEGER DEFAULT 1,
        cuando_ts INTEGER,
        estado TEXT DEFAULT 'pendiente',
        creado INTEGER, enviado_ts INTEGER)`);
    lista = true;
}

const t12 = tel => { let p = String(tel || '').replace(/\D/g, ''); if (p.length === 10) p = '521' + p; return p; };

// crear un programado — cuando_ts en epoch ms (la hora exacta que picó en el calendario)
async function crear({ tel, nombre, texto, cuandoTs, conFoto }) {
    await ensure();
    const p = t12(tel);
    if (!/^521\d{10}$/.test(p)) return { ok: false, error: 'teléfono inválido' };
    if (!String(texto || '').trim()) return { ok: false, error: 'texto vacío' };
    if (!Number(cuandoTs)) return { ok: false, error: 'hora inválida' };
    const ins = await run("INSERT INTO mensajes_programados (telefono, nombre, texto, con_foto, cuando_ts, estado, creado) VALUES (?,?,?,?,?, 'pendiente', ?)",
        [p, nombre || null, String(texto).trim(), conFoto ? 1 : 0, Number(cuandoTs), Date.now()]);
    return { ok: true, id: Number(ins.lastInsertRowid) };
}

// para el calendario: pendientes futuros + los de las últimas 48h (enviados/cancelados)
async function listar({ incluirPruebas } = {}) {
    await ensure();
    let rows = await query("SELECT * FROM mensajes_programados WHERE cuando_ts > ? ORDER BY cuando_ts ASC LIMIT 200", [Date.now() - 48 * 3600000]);
    if (!incluirPruebas) rows = rows.filter(r => !/^52100000000/.test(String(r.telefono)));
    return rows;
}

async function cancelar(id) {
    await ensure();
    await run("UPDATE mensajes_programados SET estado='cancelado', enviado_ts=? WHERE id=? AND estado='pendiente'", [Date.now(), Number(id)]);
    return { ok: true };
}

// LOS QUE TOCAN AHORA — el barredor (ghost_scan) los recoge y el puente los manda.
// Cada renglón del texto = una burbuja. Marca 'enviado' ANTES de regresar (casilla
// idempotente: si el puente truena, el owner lo ve en el calendario y lo re-agenda).
async function dueNow(ahora) {
    await ensure();
    ahora = ahora || Date.now();
    const rows = await query("SELECT * FROM mensajes_programados WHERE estado='pendiente' AND cuando_ts <= ?", [ahora]);
    const enviar = [];
    for (const r of rows) {
        await run("UPDATE mensajes_programados SET estado='enviado', enviado_ts=? WHERE id=? AND estado='pendiente'", [ahora, r.id]);
        if (/^52100000000/.test(String(r.telefono))) continue;   // pruebas: se consume (simulado) pero JAMÁS sale a WhatsApp
        const segmentos = String(r.texto || '').split('\n').map(s => s.trim()).filter(Boolean);
        let foto = null;
        if (Number(r.con_foto)) {
            try { const ctx = await require('./rescate.js').ctxDe(r.telefono, 1, ahora); foto = ctx.foto || null; } catch (e) { }
        }
        enviar.push({ prog_id: r.id, telefono: r.telefono, segmentos, foto });
    }
    return enviar;
}

module.exports = { crear, listar, cancelar, dueNow };
