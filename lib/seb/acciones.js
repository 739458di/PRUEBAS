// lib/seb/acciones.js — ACCIONES POR CHAT (Etapa 2c, orden owner 2026-09-08).
// Cada acción del sistema de citas y de los botones deja UNA fila con DIRECCIÓN completa
// (tenant_id → chat_id → delegacion_id) y toca el timbre. FyraChat las podrá pintar como
// parte del chat leyendo por índice (chat_id, ts). Nada se busca por teléfono.
//
// tipo: 'entrada' | 'boton_info' | 'boton_fotos' | 'boton_ubicacion' | 'boton_cotizar' |
//       'cita_agendada' | 'cita_solicitud' | 'cita_match' | 'cita_movida' | 'cita_cancelada' |
//       'cita_pausada' | 'cita_realizada' | 'foco_cambiado' | 'delegacion' | 'recordatorio' |
//       'en_camino' | 'staff_invitado' | 'staff_confirmado' | 'staff_rechazo' | 'post_cita' | …
// actor: 'vendedor' | 'bot' | 'comprador' | 'owner' | 'sistema'
const { query, run } = require('./db.js');

let _ens = null;
function ensureAcciones() {
    if (_ens) return _ens;
    _ens = (async () => {
        await run(`CREATE TABLE IF NOT EXISTS acciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id INTEGER NOT NULL DEFAULT 0,
            chat_id INTEGER,
            delegacion_id INTEGER,
            tipo TEXT NOT NULL,
            ref_id INTEGER,
            meta_json TEXT,
            ts INTEGER NOT NULL,
            actor TEXT)`);
        await run('CREATE INDEX IF NOT EXISTS idx_acciones_chat_ts ON acciones(chat_id, ts)');
        await run('CREATE INDEX IF NOT EXISTS idx_acciones_tenant_ts ON acciones(tenant_id, ts)');
        return true;
    })().catch(e => { _ens = null; throw e; });
    return _ens;
}

// registrar({ tenant_id, chat_id, delegacion_id, tipo, ref_id, meta, actor, ts }) → id | null
// Best-effort: jamás tumba la acción que la llama. 1 INSERT + timbre (sin lecturas).
async function registrar(a) {
    try {
        await ensureAcciones();
        const ts = Number(a.ts) || Date.now();
        const meta = a.meta == null ? null : (typeof a.meta === 'string' ? a.meta : JSON.stringify(a.meta));
        const ins = await run('INSERT INTO acciones (tenant_id, chat_id, delegacion_id, tipo, ref_id, meta_json, ts, actor) VALUES (?,?,?,?,?,?,?,?)',
            [Number(a.tenant_id) || 0, a.chat_id == null ? null : Number(a.chat_id), a.delegacion_id == null ? null : Number(a.delegacion_id),
             String(a.tipo || 'accion'), a.ref_id == null ? null : Number(a.ref_id), meta, ts, a.actor || 'sistema']);
        const id = Number(ins.lastInsertRowid);
        await require('./timbre.js').tocar({ entidad: 'accion', id, tenant_id: Number(a.tenant_id) || 0, chat_id: a.chat_id == null ? null : Number(a.chat_id), tipo: String(a.tipo || 'accion'), accion: String(a.tipo || 'accion') });
        return id;
    } catch (e) { console.error('[acciones]', e.message); return null; }
}

// listar({ chat_id, desde, limite }) → filas por índice (chat_id, ts)
async function listar({ chat_id, desde, limite }) {
    await ensureAcciones();
    return query('SELECT id, tenant_id, chat_id, delegacion_id, tipo, ref_id, meta_json, ts, actor FROM acciones WHERE chat_id=? AND ts>=? ORDER BY ts ASC, id ASC LIMIT ?',
        [Number(chat_id), Number(desde) || 0, Math.min(Number(limite) || 200, 500)]);
}

module.exports = { ensureAcciones, registrar, listar };
