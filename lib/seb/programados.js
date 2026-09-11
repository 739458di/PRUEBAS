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
    // PUERTA DE MENSAJES (FyraChat v2, 2026-09-10): el envío ya NO se marca antes de salir. Si el puente falla,
    // el renglón sigue 'pendiente' con intentos+1 y el cron lo reintenta (máx. 3 → 'error', visible en el calendario).
    await run("ALTER TABLE mensajes_programados ADD COLUMN intentos INTEGER DEFAULT 0").catch(() => {});
    await run("ALTER TABLE mensajes_programados ADD COLUMN ultimo_error TEXT").catch(() => {});
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

const MAX_INTENTOS = 3;
// LOS QUE TOCAN AHORA — lectura PURA (no muta nada): pendientes vencidos con menos de 3 intentos.
// Cada renglón del texto = una burbuja. El envío y la marca los hace `despachar` (puerta de mensajes).
async function dueNow(ahora, opts) {
    await ensure();
    ahora = ahora || Date.now();
    const rows = opts && opts.tel
        ? await query("SELECT * FROM mensajes_programados WHERE telefono=? AND estado='pendiente' AND cuando_ts <= ? AND COALESCE(intentos,0) < ?", [t12(opts.tel), ahora, MAX_INTENTOS])
        : await query("SELECT * FROM mensajes_programados WHERE estado='pendiente' AND cuando_ts <= ? AND COALESCE(intentos,0) < ? LIMIT 50", [ahora, MAX_INTENTOS]);
    const lista = [];
    for (const r of rows) {
        const segmentos = String(r.texto || '').split('\n').map(s => s.trim()).filter(Boolean);
        let foto = null;
        if (Number(r.con_foto)) {
            try { const ctx = await require('./rescate.js').ctxDe(r.telefono, 1, ahora); foto = ctx.foto || null; } catch (e) { }
        }
        lista.push({ prog_id: r.id, telefono: r.telefono, nombre: r.nombre || null, segmentos, foto, tenant_id: Number(r.tenant_id) || 0, intentos: Number(r.intentos) || 0 });
    }
    return lista;
}

// EL DESPACHO (cron cada 10 min + ghost_scan del puente; misma puerta idempotente): PRIMERO la puerta de
// mensajes, LUEGO el estado. Clave 'prog:<id>' → el reintento devuelve/continúa el mismo recibo en `envios`.
//   ok      → estado='enviado' (también los del carril de pruebas: la puerta los simula)
//   falla   → intentos+1 + ultimo_error; al 3er fallo → estado='error' (el owner lo ve en el calendario y re-agenda)
async function despachar({ ahora, tel } = {}) {
    ahora = ahora || Date.now();
    const MSJ = require('./mensajeria.js');
    const U = require('./universo.js');
    const rep = { vencidos: 0, enviados: 0, simulados: 0, fallidos: 0, agotados: 0, detalle: [] };
    const lista = await dueNow(ahora, { tel });
    rep.vencidos = lista.length;
    for (const p of lista) {
        let r;
        try {
            // el chat del universo por (tenant, tel): en el universo 0 se crea si falta (visible); en universos de vendedor debe existir y estar delegado
            const chat = await U.chatDe(p.tenant_id, p.telefono, { crear: !p.tenant_id, visible: true, nombre: p.nombre || null });
            if (!chat) r = { ok: false, error: 'sin chat en el universo ' + p.tenant_id };
            else r = await MSJ.enviar({ tenantId: p.tenant_id, chatId: chat.id, origen: 'programado', clave: 'prog:' + p.prog_id, segmentos: p.segmentos, fotos: p.foto ? [p.foto] : [], actor: 'bot', accion: 'programado_enviado', refId: p.prog_id, meta: { prog_id: p.prog_id } });
        } catch (e) { r = { ok: false, error: e.message }; }
        if (r && r.ok) {
            await run("UPDATE mensajes_programados SET estado='enviado', enviado_ts=?, ultimo_error=NULL WHERE id=? AND estado='pendiente'", [ahora, p.prog_id]);
            rep.enviados++; if (r.simulado) rep.simulados++;
            rep.detalle.push({ id: p.prog_id, ok: true, simulado: !!r.simulado, repetido: !!r.repetido });
            await require('./timbre.js').tocar({ entidad: 'programado', id: p.prog_id, accion: 'enviado', tenant_id: p.tenant_id, chat_id: r.chat_id || null });
        } else {
            const n = p.intentos + 1;
            const err = String((r && r.error) || 'sin detalle').slice(0, 250);
            // SOLO POR BOTÓN (auditoría H, 2026-09-12): universo desconectado → NO se marca enviado ni se agota: queda pendiente
            // (intentos+1 solo como bitácora) hasta que el vendedor vuelva a vincular su WhatsApp.
            if (r && r.no_conectado) {
                await run("UPDATE mensajes_programados SET intentos=?, ultimo_error=? WHERE id=? AND estado='pendiente'", [Math.min(n, MAX_INTENTOS - 1), err, p.prog_id]);
                rep.fallidos++; rep.no_conectados = (rep.no_conectados || 0) + 1;
                rep.detalle.push({ id: p.prog_id, ok: false, no_conectado: true, error: err });
                continue;
            }
            if (n >= MAX_INTENTOS) {
                await run("UPDATE mensajes_programados SET intentos=?, ultimo_error=?, estado='error' WHERE id=? AND estado='pendiente'", [n, err, p.prog_id]);
                rep.agotados++;
                await require('./timbre.js').tocar({ entidad: 'programado', id: p.prog_id, accion: 'error', tenant_id: p.tenant_id, chat_id: (r && r.chat_id) || null });
            } else {
                await run("UPDATE mensajes_programados SET intentos=?, ultimo_error=? WHERE id=? AND estado='pendiente'", [n, err, p.prog_id]);
            }
            rep.fallidos++;
            rep.detalle.push({ id: p.prog_id, ok: false, intentos: n, error: err });
        }
    }
    return rep;
}

module.exports = { crear, listar, cancelar, dueNow, despachar, MAX_INTENTOS };
