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
    await run("ALTER TABLE mensajes_programados ADD COLUMN tenant_id INTEGER").catch(() => {});   // universo por el que sale (0 = Fyradrive)
    // POR UNIVERSO (2026-09-10): rescate.js pregunta "¿hay programado pendiente para este tel en el universo 0?" por
    // igualdad (telefono guardado SIEMPRE como 521+10) → índice (telefono, estado)
    await run("CREATE INDEX IF NOT EXISTS idx_prog_tel_estado ON mensajes_programados(telefono, estado)").catch(() => {});
    lista = true;
}

const t12 = tel => { let p = String(tel || '').replace(/\D/g, ''); if (p.length === 10) p = '521' + p; return p; };

// crear un programado — cuando_ts en epoch ms (la hora exacta que picó en el calendario)
async function crear({ tel, nombre, texto, cuandoTs, conFoto, tenantId }) {
    await ensure();
    const p = t12(tel);
    if (!/^521\d{10}$/.test(p)) return { ok: false, error: 'teléfono inválido' };
    if (!String(texto || '').trim()) return { ok: false, error: 'texto vacío' };
    if (!Number(cuandoTs)) return { ok: false, error: 'hora inválida' };
    // TOPE (orden owner 2026-09-10): máximo 2 recordatorios MANUALES pendientes por cliente y universo.
    // Los recordatorios de CITA van aparte (cita_casillas) y no cuentan aquí.
    const MAX_MANUALES = 2;
    const vivos = await query("SELECT COUNT(*) n FROM mensajes_programados WHERE telefono=? AND estado='pendiente' AND COALESCE(tenant_id,0)=?", [p, Number(tenantId) || 0]);
    if (Number(vivos[0] && vivos[0].n) >= MAX_MANUALES) return { ok: false, error: 'Este cliente ya tiene ' + MAX_MANUALES + ' recordatorios pendientes. Cancela uno antes de programar otro.', tope: MAX_MANUALES };
    const ins = await run("INSERT INTO mensajes_programados (telefono, nombre, texto, con_foto, cuando_ts, estado, creado, tenant_id) VALUES (?,?,?,?,?, 'pendiente', ?, ?)",
        [p, nombre || null, String(texto).trim(), conFoto ? 1 : 0, Number(cuandoTs), Date.now(), Number(tenantId) || 0]);
    await require('./timbre.js').tocar({ entidad: 'programado', id: Number(ins.lastInsertRowid), accion: 'creado' });
    return { ok: true, id: Number(ins.lastInsertRowid) };
}

// para el calendario: pendientes futuros + los de las últimas 48h (enviados/cancelados)
// tenantId (2026-09-10): el calendario de cada universo ve SOLO sus programados (null = todos, uso interno)
async function listar({ incluirPruebas, tenantId } = {}) {
    await ensure();
    let rows = tenantId == null
        ? await query("SELECT * FROM mensajes_programados WHERE cuando_ts > ? ORDER BY cuando_ts ASC LIMIT 200", [Date.now() - 48 * 3600000])
        : await query("SELECT * FROM mensajes_programados WHERE cuando_ts > ? AND COALESCE(tenant_id,0)=? ORDER BY cuando_ts ASC LIMIT 200", [Date.now() - 48 * 3600000, Number(tenantId) || 0]);
    if (!incluirPruebas) rows = rows.filter(r => !/^52100000000/.test(String(r.telefono)));
    return rows;
}

// tenantId (2026-09-10): un universo solo cancela LO SUYO (null = sin acotar, uso interno)
async function cancelar(id, tenantId) {
    await ensure();
    const u = tenantId == null
        ? await run("UPDATE mensajes_programados SET estado='cancelado', enviado_ts=? WHERE id=? AND estado='pendiente'", [Date.now(), Number(id)])
        : await run("UPDATE mensajes_programados SET estado='cancelado', enviado_ts=? WHERE id=? AND estado='pendiente' AND COALESCE(tenant_id,0)=?", [Date.now(), Number(id), Number(tenantId) || 0]);
    if (Number(u.rowsAffected) > 0) await require('./timbre.js').tocar({ entidad: 'programado', id: Number(id), accion: 'cancelado' });
    return { ok: true, cancelado: Number(u.rowsAffected) || 0 };
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
        enviar.push({ prog_id: r.id, telefono: r.telefono, segmentos, foto, tenant_id: Number(r.tenant_id) || 0 });
    }
    if (enviar.length) await require('./timbre.js').tocar({ entidad: 'programado', accion: 'enviados', n: enviar.length });
    return enviar;
}

module.exports = { crear, listar, cancelar, dueNow };
