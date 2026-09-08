// lib/seb/universo.js — LA PUERTA ÚNICA a la dirección universo → chat → delegación.
// ORDEN del owner (2026-09-08): cada dato tiene DIRECCIÓN que empieza por el universo
// (tenant_id); dentro del universo solo existe lo suyo; el ÚNICO cruce permitido es el
// AUTO EN FOCO (delegación) dentro del mismo universo; nada se busca por teléfono suelto.
//
// ETAPA 2 (chats por universo + delegaciones) con DUAL-WRITE:
//   · el CHAT es la fila de `conversaciones` por (tenant_id, telefono) — 1 fila, por índice.
//   · el ESTADO DEL BOT vive en columnas nuevas de `conversaciones` (estado_json, canal,
//     estado_bot, auto_id_activo, platform, estado_ts) y se ESPEJEA a `wa_conversations`
//     (tenant 0, upsert por telefono, igual que hoy) mientras dure el dual-write.
//   · la DELEGACIÓN (chat → auto en foco, con historial) vive en `delegaciones` y se
//     ESPEJEA a `chats_activos` (tenant≠0) y a `conversaciones.auto_id_activo`
//     (+ wa_conversations si tenant 0) para que el puente y lo viejo sigan funcionando.
//   · NADA se borra. El apagado del espejo es la Etapa 3.
//
// CUOTA TURSO: todas las consultas son por índice y de 1 fila (o por lotes con IN); jamás
// "SELECT * y filtrar en JS".
const { query, run, client } = require('./db.js');

// ── teléfono canónico: 521 + 10 dígitos. 10 dígitos → 521+; 52+10 → 521+10; 521+10 → igual.
// Lo que no tiene forma de teléfono MX (lid de 14-15 dígitos, 'fb_…', 'fyra_…') se devuelve
// tal cual (solo dígitos si los tiene) para no perderlo: se busca por exacto y nunca se crea.
function tel12(x) {
    const raw = String(x == null ? '' : x).trim();
    if (!raw) return '';
    const d = raw.replace(/\D/g, '');
    if (!d) return raw;
    if (d.length === 10) return '521' + d;
    if (d.length === 12 && d.startsWith('52')) return '521' + d.slice(2);
    if (d.length === 13 && d.startsWith('521')) return d;
    return /^[\d_a-z]+$/i.test(raw) && !/^\d+$/.test(raw) ? raw : d;
}
const esTelMX = p => /^521\d{10}$/.test(String(p || ''));
function hiloDe(tel, tenantId) { return 'whatsapp:' + tel + (Number(tenantId) ? '#t' + Number(tenantId) : ''); }

// ══ DDL idempotente — UNA vez por proceso ══
const COLS_NUEVAS = [
    ['estado_json', 'TEXT'], ['canal', 'TEXT'], ['estado_bot', 'TEXT'],
    ['auto_id_activo', 'INTEGER'], ['platform', 'TEXT'], ['estado_ts', 'INTEGER']
];
const DDL_DELEGACIONES = `CREATE TABLE IF NOT EXISTS delegaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    tenant_id INTEGER NOT NULL,
    auto_id INTEGER,
    auto_nombre TEXT,
    activado_por TEXT,
    desde INTEGER NOT NULL,
    hasta INTEGER,
    opener_pendiente INTEGER DEFAULT 0,
    opener_texto TEXT,
    motivo TEXT,
    created INTEGER
)`;
let _ensure = null;
function ensureUniverso() {
    if (_ensure) return _ensure;
    _ensure = (async () => {
        const info = await query('PRAGMA table_info(conversaciones)');
        const tiene = new Set(info.map(c => String(c.name)));
        for (const [col, tipo] of COLS_NUEVAS) {
            if (tiene.has(col)) continue;
            try { await run(`ALTER TABLE conversaciones ADD COLUMN ${col} ${tipo}`); } catch (e) { if (!/duplicate/i.test(String(e.message))) throw e; }
        }
        await run(DDL_DELEGACIONES);
        await run('CREATE INDEX IF NOT EXISTS idx_deleg_chat_hasta ON delegaciones(chat_id, hasta)');
        await run('CREATE INDEX IF NOT EXISTS idx_deleg_tenant_hasta ON delegaciones(tenant_id, hasta)');
        await run('CREATE INDEX IF NOT EXISTS idx_conv_tenant_tel ON conversaciones(tenant_id, telefono)');
        return true;
    })().catch(e => { _ensure = null; throw e; });
    return _ensure;
}

// ══ EL CHAT ══
const COLS_CHAT = 'id, channel_thread_id, telefono, nombre, tenant_id, ult_msg_ts, ult_dir, is_dueno_chat, source, estado_json, canal, estado_bot, auto_id_activo, platform, estado_ts';
// tenant 0 histórico trae tenant_id NULL (938 filas medidas 2026-09-08) → se acepta NULL como 0
// hasta que el backfill lo normalice. Ambas formas van por índice (idx_conv_tel / idx_conv_tenant_tel).
async function _selChat(t, p) {
    const rows = t
        ? await query(`SELECT ${COLS_CHAT} FROM conversaciones WHERE tenant_id=? AND telefono=? ORDER BY id LIMIT 1`, [t, p])
        : await query(`SELECT ${COLS_CHAT} FROM conversaciones WHERE telefono=? AND (tenant_id=0 OR tenant_id IS NULL) ORDER BY id LIMIT 1`, [p]);
    return rows[0] || null;
}
// chatDe(tenantId, tel, { crear, nombre, visible }) → fila del chat o null.
//   crear:   si no existe, la crea (solo teléfonos MX con forma 521+10).
//   visible: la fila nace con ult_msg_ts=ahora (aparece en la lista de chats). Sin visible →
//            ult_msg_ts NULL: existe para el estado del bot pero no se lista hasta que haya mensaje.
async function chatDe(tenantId, tel, opts) {
    await ensureUniverso();
    const t = Number(tenantId) || 0, p = tel12(tel);
    if (!p) return null;
    let chat = await _selChat(t, p);
    if (chat || !(opts && opts.crear) || !esTelMX(p)) return chat;
    const now = Date.now();
    const thread = hiloDe(p, t);
    // el hilo con sufijo se mantiene por compatibilidad (el puente y FyraChat lo usan) mientras dure el dual-write
    await run(`INSERT INTO conversaciones (channel_thread_id, telefono, nombre, ult_texto, ult_dir, ult_msg_ts, no_leidos, is_dueno_chat, source, created_at, tenant_id)
               VALUES (?,?,?,?,?,?,0,0,'whatsapp',?,?)
               ON CONFLICT(channel_thread_id) DO UPDATE SET telefono=COALESCE(telefono, excluded.telefono), tenant_id=COALESCE(tenant_id, excluded.tenant_id), nombre=COALESCE(nombre, excluded.nombre)`,
        [thread, p, (opts.nombre && String(opts.nombre).trim()) || null, '', 'out', opts.visible ? now : null, now, t]);
    chat = await _selChat(t, p);
    return chat;
}
async function chatPorId(chatId) {
    await ensureUniverso();
    if (chatId && typeof chatId === 'object' && chatId.id) return chatId;   // ya es la fila
    const rows = await query(`SELECT ${COLS_CHAT} FROM conversaciones WHERE id=?`, [Number(chatId)]);
    return rows[0] || null;
}

// ══ EL ESTADO DEL BOT ══
function _parseEj(s) { try { return JSON.parse(s || '{}') || {}; } catch (e) { return {}; } }
// estadoDe(chat) → lo que hoy devolvía la fila de wa_conversations.
//   existe = "hay estado" (equivale al `cur.length` de antes: la fila de wa_conversations solo
//   existía cuando alguien había escrito estado); el chat puede existir sin estado.
function estadoDe(chat) {
    if (!chat) return { existe: false, ej: {}, estado_json: null, auto_id_activo: null, canal: null, estado: null, platform: null, updated_at: 0 };
    const existe = chat.estado_json != null || chat.auto_id_activo != null || chat.canal != null || chat.estado_bot != null;
    return {
        existe, ej: _parseEj(chat.estado_json), estado_json: chat.estado_json == null ? null : String(chat.estado_json),
        auto_id_activo: chat.auto_id_activo == null ? null : (Number(chat.auto_id_activo) || null),
        canal: chat.canal == null ? null : String(chat.canal), estado: chat.estado_bot == null ? null : String(chat.estado_bot),
        platform: chat.platform == null ? null : String(chat.platform), updated_at: Number(chat.estado_ts) || 0
    };
}
// leerEstado(tenantId, tel) → { chat, ...estadoDe(chat) } — 1 fila por índice.
async function leerEstado(tenantId, tel) {
    const chat = await chatDe(tenantId, tel);
    return Object.assign({ chat }, estadoDe(chat));
}
// autoActivoDe(tenantId, tel) → el auto en foco del bot (columna) o null.
async function autoActivoDe(tenantId, tel) { return (await leerEstado(tenantId, tel)).auto_id_activo; }

// guardarEstado(tenantId, tel, patch, opts)
//   patch: { estado_json (obj|string), canal, canal_si_nulo, estado (solo si aún no hay: COALESCE, como los
//           INSERT de antes), estado_forzar, auto_id_activo (null = soltar la columna), platform }
//   opts:  { updated_at, nombre, activado_por (para la delegación que sigue al foco), sin_delegacion }
//   Crea el chat si no existe. Espejo a wa_conversations cuando tenant 0.
//   Si llega un auto_id_activo con valor y difiere de la delegación activa → cambiarFoco (historial).
async function guardarEstado(tenantId, tel, patch, opts) {
    patch = patch || {}; opts = opts || {};
    const t = Number(tenantId) || 0;
    const chat = await chatDe(t, tel, { crear: true, nombre: opts.nombre });
    if (!chat) return null;
    const p = chat.telefono;
    const ts = Number(opts.updated_at) || Date.now();
    const set = [], args = [], setW = [], argsW = [];
    if ('estado_json' in patch) {
        const s = patch.estado_json == null ? null : (typeof patch.estado_json === 'string' ? patch.estado_json : JSON.stringify(patch.estado_json));
        set.push('estado_json=?'); args.push(s); setW.push('estado_json=?'); argsW.push(s);
    }
    if ('canal' in patch) { set.push('canal=?'); args.push(patch.canal); setW.push('canal=?'); argsW.push(patch.canal); }
    else if ('canal_si_nulo' in patch) { set.push('canal=COALESCE(canal,?)'); args.push(patch.canal_si_nulo); setW.push('canal=COALESCE(canal,?)'); argsW.push(patch.canal_si_nulo); }
    if ('estado_forzar' in patch) { set.push('estado_bot=?'); args.push(patch.estado_forzar); setW.push('estado=?'); argsW.push(patch.estado_forzar); }
    else if ('estado' in patch && patch.estado != null) { set.push('estado_bot=COALESCE(estado_bot,?)'); args.push(patch.estado); setW.push('estado=COALESCE(estado,?)'); argsW.push(patch.estado); }
    if ('auto_id_activo' in patch) { const a = patch.auto_id_activo == null ? null : (Number(patch.auto_id_activo) || null); set.push('auto_id_activo=?'); args.push(a); setW.push('auto_id_activo=?'); argsW.push(a); }
    if ('platform' in patch) { set.push('platform=?'); args.push(patch.platform); setW.push('platform=?'); argsW.push(patch.platform); }
    if (!set.length) return chat;
    set.push('estado_ts=?'); args.push(ts); setW.push('updated_at=?'); argsW.push(ts);
    await run(`UPDATE conversaciones SET ${set.join(', ')} WHERE id=?`, args.concat([chat.id]));
    if (!t) await _espejoWa(p, setW, argsW, patch, ts);
    // el foco del bot también es una delegación (historial): solo cuando hay auto y cambia
    const auto = patch.auto_id_activo == null ? null : (Number(patch.auto_id_activo) || null);
    if (auto && !opts.sin_delegacion) {
        try { await cambiarFoco(chat, auto, opts.motivo || 'bot', { activado_por: opts.activado_por || 'bot', auto_nombre: opts.auto_nombre || null, sin_columna: true }); } catch (e) { console.error('[universo] foco→delegación', e.message); }
    }
    return chat;
}
// espejo a wa_conversations (tenant 0): UPDATE por telefono; si no había fila → INSERT (igual que antes)
async function _espejoWa(p, setW, argsW, patch, ts) {
    try {
        const u = await run(`UPDATE wa_conversations SET ${setW.join(', ')} WHERE telefono=?`, argsW.concat([p]));
        if (Number(u.rowsAffected) > 0) return;
        const cols = ['telefono'], vals = [p];
        if ('estado_json' in patch) { cols.push('estado_json'); vals.push(patch.estado_json == null ? null : (typeof patch.estado_json === 'string' ? patch.estado_json : JSON.stringify(patch.estado_json))); }
        if ('canal' in patch) { cols.push('canal'); vals.push(patch.canal); } else if ('canal_si_nulo' in patch) { cols.push('canal'); vals.push(patch.canal_si_nulo); }
        if ('estado_forzar' in patch) { cols.push('estado'); vals.push(patch.estado_forzar); } else if ('estado' in patch && patch.estado != null) { cols.push('estado'); vals.push(patch.estado); }
        if ('auto_id_activo' in patch) { cols.push('auto_id_activo'); vals.push(patch.auto_id_activo == null ? null : (Number(patch.auto_id_activo) || null)); }
        if ('platform' in patch) { cols.push('platform'); vals.push(patch.platform); }
        cols.push('updated_at'); vals.push(ts);
        await run(`INSERT INTO wa_conversations (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
    } catch (e) { console.error('[universo] espejo wa_conversations', e.message); }
}
// borrarEstado: el "DELETE FROM wa_conversations" del sandbox — deja el chat sin estado y cierra su delegación.
async function borrarEstado(tenantId, tel, motivo) {
    const t = Number(tenantId) || 0;
    const chat = await chatDe(t, tel);
    if (!chat) return false;
    await run('UPDATE conversaciones SET estado_json=NULL, canal=NULL, estado_bot=NULL, auto_id_activo=NULL, platform=NULL, estado_ts=NULL WHERE id=?', [chat.id]);
    await soltar(chat, motivo || 'reset');
    if (!t) await run('DELETE FROM wa_conversations WHERE telefono=?', [chat.telefono]).catch(() => { });
    return true;
}

// ══ LA DELEGACIÓN (chat → auto en foco, con historial) ══
async function delegacionActiva(chatId) {
    await ensureUniverso();
    const id = (chatId && typeof chatId === 'object') ? chatId.id : chatId;
    const rows = await query('SELECT * FROM delegaciones WHERE chat_id=? AND hasta IS NULL ORDER BY id DESC LIMIT 1', [Number(id)]);
    return rows[0] || null;
}
// espejo de la delegación a lo viejo: conversaciones.auto_id_activo (+ wa_conversations si t0) y chats_activos (t≠0)
async function _espejoDelegacion(chat, d, { sin_columna, crear_ca } = {}) {
    const t = Number(chat.tenant_id) || 0, p = chat.telefono, auto = d.auto_id == null ? null : Number(d.auto_id);
    if (!sin_columna) {
        await run('UPDATE conversaciones SET auto_id_activo=? WHERE id=?', [auto, chat.id]).catch(() => { });
        if (!t) {
            try {
                const u = await run('UPDATE wa_conversations SET auto_id_activo=? WHERE telefono=?', [auto, p]);
                if (!(Number(u.rowsAffected) > 0)) await run('INSERT INTO wa_conversations (telefono, auto_id_activo) VALUES (?,?)', [p, auto]);
            } catch (e) { }
        }
    }
    if (t) {
        try {
            const u = await run('UPDATE chats_activos SET car_id=?, car_nombre=COALESCE(?,car_nombre) WHERE tenant_id=? AND tel=? AND hasta IS NULL', [auto, d.auto_nombre || null, t, p]);
            if (!(Number(u.rowsAffected) > 0) && crear_ca) {
                await run('INSERT INTO chats_activos (tenant_id, tel, car_id, car_nombre, comprador_nombre, activado_por, desde, opener_pendiente, opener_texto, created) VALUES (?,?,?,?,?,?,?,?,?,?)',
                    [t, p, auto, d.auto_nombre || null, chat.nombre || null, d.activado_por || 'universo', d.desde, Number(d.opener_pendiente) || 0, d.opener_texto || null, d.created || d.desde]);
            }
        } catch (e) { console.error('[universo] espejo chats_activos', e.message); }
    }
}
async function _abrir(chat, { auto_id, auto_nombre, activado_por, opener_texto, opener_pendiente, desde, motivo }) {
    const now = Date.now();
    const d = {
        chat_id: chat.id, tenant_id: Number(chat.tenant_id) || 0, auto_id: auto_id == null ? null : Number(auto_id), auto_nombre: auto_nombre || null,
        activado_por: activado_por || 'universo', desde: Number(desde) || now, hasta: null,
        opener_pendiente: opener_pendiente != null ? (Number(opener_pendiente) ? 1 : 0) : (opener_texto ? 1 : 0), opener_texto: opener_texto || null, motivo: motivo || null, created: now
    };
    const r = await run('INSERT INTO delegaciones (chat_id, tenant_id, auto_id, auto_nombre, activado_por, desde, hasta, opener_pendiente, opener_texto, motivo, created) VALUES (?,?,?,?,?,?,NULL,?,?,?,?)',
        [d.chat_id, d.tenant_id, d.auto_id, d.auto_nombre, d.activado_por, d.desde, d.opener_pendiente, d.opener_texto, d.motivo, d.created]);
    d.id = Number(r.lastInsertRowid);
    return d;
}
// delegar(chat|chatId, {auto_id, auto_nombre, activado_por, opener_texto}) → { id, nueva, delegacion }
//   Idempotente: si ya hay delegación activa con el mismo auto → la refresca; con otro auto → cambiarFoco.
async function delegar(chatId, opts) {
    opts = opts || {};
    const chat = await chatPorId(chatId); if (!chat) return { ok: false, error: 'chat inexistente' };
    const act = await delegacionActiva(chat.id);
    if (act) {
        if (opts.auto_id && Number(act.auto_id) !== Number(opts.auto_id)) {
            const r = await cambiarFoco(chat, opts.auto_id, opts.motivo || 'delegar', { activado_por: opts.activado_por, auto_nombre: opts.auto_nombre, opener_texto: opts.opener_texto });
            return { ok: true, id: r.delegacion.id, nueva: true, delegacion: r.delegacion };
        }
        await run('UPDATE delegaciones SET auto_nombre=COALESCE(?,auto_nombre), opener_texto=COALESCE(?,opener_texto) WHERE id=?', [opts.auto_nombre || null, opts.opener_texto || null, act.id]).catch(() => { });
        await _espejoDelegacion(chat, Object.assign({}, act, { auto_nombre: opts.auto_nombre || act.auto_nombre }), { crear_ca: true });
        return { ok: true, id: Number(act.id), nueva: false, delegacion: act };
    }
    const d = await _abrir(chat, opts);
    await _espejoDelegacion(chat, d, { crear_ca: true });
    return { ok: true, id: d.id, nueva: true, delegacion: d };
}
// soltar(chat|chatId, motivo) → cierra la delegación activa (hasta=now) y su espejo en chats_activos.
//   La columna auto_id_activo NO se toca (el bot del tenant 0 la sigue usando; igual que hoy).
async function soltar(chatId, motivo) {
    const chat = await chatPorId(chatId); if (!chat) return { ok: false, error: 'chat inexistente' };
    const now = Date.now();
    const u = await run('UPDATE delegaciones SET hasta=?, motivo=COALESCE(motivo, ?) WHERE chat_id=? AND hasta IS NULL', [now, motivo || 'soltar', chat.id]);
    const t = Number(chat.tenant_id) || 0;
    if (t) await run('UPDATE chats_activos SET hasta=? WHERE tenant_id=? AND tel=? AND hasta IS NULL', [now, t, chat.telefono]).catch(() => { });
    return { ok: true, cerradas: Number(u.rowsAffected) || 0 };
}
// cambiarFoco(chat|chatId, auto_id, motivo, { activado_por, auto_nombre, opener_texto, solo_si_activa, sin_columna })
//   Cierra la activa (hasta=now, motivo) y abre otra → HISTORIAL. Mismo auto → sin cambio.
//   solo_si_activa: si el chat no tiene delegación activa NO crea una (tenant≠0 desde el panel: el puente
//   es quien delega; aquí solo se cambia el auto de una delegación viva — igual que el UPDATE de antes).
async function cambiarFoco(chatId, auto_id, motivo, opts) {
    opts = opts || {};
    const chat = await chatPorId(chatId); if (!chat) return { ok: false, error: 'chat inexistente' };
    const auto = Number(auto_id) || null;
    if (!auto) return { ok: false, error: 'auto_id requerido' };
    const act = await delegacionActiva(chat.id);
    if (act && Number(act.auto_id) === auto) {
        if (opts.auto_nombre && !act.auto_nombre) await run('UPDATE delegaciones SET auto_nombre=? WHERE id=?', [opts.auto_nombre, act.id]).catch(() => { });
        await _espejoDelegacion(chat, Object.assign({}, act, { auto_nombre: opts.auto_nombre || act.auto_nombre }), { sin_columna: opts.sin_columna });
        return { ok: true, sin_cambio: true, delegacion: act };
    }
    if (!act && opts.solo_si_activa) return { ok: false, error: 'sin delegación activa', sin_cambio: true };
    const now = Date.now();
    if (act) await run('UPDATE delegaciones SET hasta=?, motivo=? WHERE id=?', [now, motivo || 'cambio_foco', act.id]);
    const d = await _abrir(chat, {
        auto_id: auto, auto_nombre: opts.auto_nombre || null, activado_por: opts.activado_por || motivo || 'cambio_foco',
        opener_texto: opts.opener_texto || (act ? act.opener_texto : null), opener_pendiente: act ? act.opener_pendiente : (opts.opener_texto ? 1 : 0), desde: now, motivo: null
    });
    await _espejoDelegacion(chat, d, { sin_columna: opts.sin_columna, crear_ca: false });
    return { ok: true, anterior: act || null, delegacion: d };
}
// focoDe(tenantId, tel) → { auto_id, auto_nombre, delegacion_id } | null
//   tenant≠0: la delegación activa (lo que el puente considera "existe"); tenant 0: la columna (el bot la mueve).
async function focoDe(tenantId, tel) {
    const t = Number(tenantId) || 0;
    const chat = await chatDe(t, tel); if (!chat) return null;
    if (t) {
        const d = await delegacionActiva(chat.id);
        return d && d.auto_id ? { auto_id: Number(d.auto_id), auto_nombre: d.auto_nombre || null, delegacion_id: Number(d.id), chat_id: chat.id } : null;
    }
    const a = chat.auto_id_activo == null ? null : (Number(chat.auto_id_activo) || null);
    return a ? { auto_id: a, auto_nombre: null, delegacion_id: null, chat_id: chat.id } : null;
}
// delegacionesDe(tenantId) → activas del universo (por índice tenant_id, hasta) con el teléfono del chat
async function delegacionesDe(tenantId) {
    await ensureUniverso();
    return query(`SELECT d.*, c.telefono AS tel, c.nombre AS comprador_nombre FROM delegaciones d JOIN conversaciones c ON c.id=d.chat_id WHERE d.tenant_id=? AND d.hasta IS NULL ORDER BY d.id`, [Number(tenantId) || 0]);
}

// ══ BACKFILL idempotente (lo viejo → lo nuevo), por lotes con IN (...), sin N+1 ══
//   opts.telefonos: limitar a estos teléfonos (pruebas). opts.dry: solo contar.
//   1) wa_conversations → columnas de conversaciones (t0), creando el chat si falta
//      (solo si wa.updated_at > estado_ts o no había estado; el auto solo si la columna está vacía → re-ejecutable
//       como barredor de lo que SALES-BRAIN siga escribiendo en wa_conversations)
//   2) chats_activos abiertos → delegaciones (una por fila, misma fecha)
//   3) wa_conversations.auto_id_activo (t0) → delegaciones (activado_por='backfill') si el chat no tiene activa
const LOTE = 80;
function _chunks(a, n) { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }
async function _batchWrite(stmts) {
    if (!stmts.length) return 0;
    let n = 0;
    for (const ch of _chunks(stmts, 40)) {
        try { await client.batch(ch.map(s => ({ sql: s.sql, args: s.args })), 'write'); n += ch.length; }
        catch (e) { for (const s of ch) { await run(s.sql, s.args); n++; } }
    }
    return n;
}
function _variantesTel(p) { return esTelMX(p) ? [p, p.slice(3), '52' + p.slice(3)] : [p]; }
async function backfillUniverso(opts) {
    opts = opts || {};
    await ensureUniverso();
    const dry = !!opts.dry;
    const filtro = Array.isArray(opts.telefonos) && opts.telefonos.length ? opts.telefonos.map(tel12).filter(Boolean) : null;
    const rep = { dry, tenant_null_a_0: 0, wa_leidas: 0, wa_sin_forma: 0, wa_duplicadas_fusionadas: 0, chats_creados: 0, estados_copiados: 0, estados_ya_al_dia: 0, focos_copiados: 0, ca_abiertas: 0, ca_sin_chat: 0, deleg_desde_ca: 0, deleg_desde_wa: 0, deleg_ya_activas: 0 };
    const now = Date.now();
    // 0) tenant_id NULL → 0 (dirección obligatoria)
    if (!dry) {
        const u = filtro
            ? await run(`UPDATE conversaciones SET tenant_id=0 WHERE tenant_id IS NULL AND telefono IN (${filtro.map(() => '?').join(',')})`, filtro)
            : await run('UPDATE conversaciones SET tenant_id=0 WHERE tenant_id IS NULL');
        rep.tenant_null_a_0 = Number(u.rowsAffected) || 0;
    } else {
        const c = filtro
            ? await query(`SELECT COUNT(*) n FROM conversaciones WHERE tenant_id IS NULL AND telefono IN (${filtro.map(() => '?').join(',')})`, filtro)
            : await query('SELECT COUNT(*) n FROM conversaciones WHERE tenant_id IS NULL');
        rep.tenant_null_a_0 = Number(c[0].n) || 0;
    }
    // 1) wa_conversations → conversaciones (t0)
    let wa;
    if (filtro) {
        const vars = [].concat(...filtro.map(_variantesTel));
        wa = [];
        for (const ch of _chunks(vars, LOTE)) wa = wa.concat(await query(`SELECT telefono, estado, estado_json, canal, auto_id_activo, platform, updated_at FROM wa_conversations WHERE telefono IN (${ch.map(() => '?').join(',')})`, ch));
    } else wa = await query('SELECT telefono, estado, estado_json, canal, auto_id_activo, platform, updated_at FROM wa_conversations');
    rep.wa_leidas = wa.length;
    const porTel = new Map();   // tel canónico → fila más reciente
    for (const w of wa) {
        const p = tel12(w.telefono);
        if (!p) { rep.wa_sin_forma++; continue; }
        if (!esTelMX(p)) rep.wa_sin_forma++;
        const prev = porTel.get(p);
        if (prev) { rep.wa_duplicadas_fusionadas++; if (Number(w.updated_at || 0) <= Number(prev.updated_at || 0)) continue; }
        porTel.set(p, w);
    }
    const tels = [...porTel.keys()];
    const chats = new Map();   // tel → chat t0
    const selT0 = async lista => { for (const ch of _chunks(lista, LOTE)) for (const c of await query(`SELECT ${COLS_CHAT} FROM conversaciones WHERE telefono IN (${ch.map(() => '?').join(',')}) AND (tenant_id=0 OR tenant_id IS NULL)`, ch)) if (!chats.has(c.telefono)) chats.set(String(c.telefono), c); };
    await selT0(tels);
    const faltan = tels.filter(p => !chats.has(p) && esTelMX(p));
    rep.chats_creados = faltan.length;
    if (!dry && faltan.length) {
        await _batchWrite(faltan.map(p => ({ sql: `INSERT OR IGNORE INTO conversaciones (channel_thread_id, telefono, nombre, ult_texto, ult_dir, ult_msg_ts, no_leidos, is_dueno_chat, source, created_at, tenant_id) VALUES (?,?,NULL,'', 'out', NULL, 0, 0, 'whatsapp', ?, 0)`, args: [hiloDe(p, 0), p, now] })));
        await selT0(faltan);
    } else if (dry) for (const p of faltan) chats.set(p, { id: null, telefono: p, tenant_id: 0, estado_ts: null, auto_id_activo: null, ult_msg_ts: null, _virtual: true });   // dry: contar como si existieran
    const upd = [];
    for (const [p, w] of porTel) {
        const c = chats.get(p); if (!c) continue;
        const waTs = Number(w.updated_at || 0), cTs = Number(c.estado_ts || 0);
        const hayEstadoWa = w.estado_json != null || w.canal != null || w.estado != null || w.platform != null;
        const set = [], args = [];
        if (hayEstadoWa && (c.estado_ts == null || waTs > cTs)) {
            set.push('estado_json=COALESCE(?, estado_json)', 'canal=COALESCE(?, canal)', 'estado_bot=COALESCE(?, estado_bot)', 'platform=COALESCE(?, platform)', 'estado_ts=?');
            args.push(w.estado_json == null ? null : String(w.estado_json), w.canal == null ? null : String(w.canal), w.estado == null ? null : String(w.estado), w.platform == null ? null : String(w.platform), waTs || now);
            rep.estados_copiados++;
        } else if (hayEstadoWa) rep.estados_ya_al_dia++;
        if (w.auto_id_activo != null && Number(w.auto_id_activo) && c.auto_id_activo == null) { set.push('auto_id_activo=?'); args.push(Number(w.auto_id_activo)); rep.focos_copiados++; }
        if (set.length) { c._auto = w.auto_id_activo; upd.push({ sql: `UPDATE conversaciones SET ${set.join(', ')} WHERE id=?`, args: args.concat([c.id]) }); }
    }
    if (!dry) await _batchWrite(upd);
    // 2) chats_activos abiertos → delegaciones
    let ca;
    if (filtro) { ca = []; for (const ch of _chunks(filtro, LOTE)) ca = ca.concat(await query(`SELECT * FROM chats_activos WHERE hasta IS NULL AND tel IN (${ch.map(() => '?').join(',')})`, ch)); }
    else ca = await query('SELECT * FROM chats_activos WHERE hasta IS NULL');
    rep.ca_abiertas = ca.length;
    const chatsCa = new Map();   // 't:tel' → chat
    const telsCa = [...new Set(ca.map(r => tel12(r.tel)).filter(Boolean))];
    for (const ch of _chunks(telsCa, LOTE)) for (const c of await query(`SELECT ${COLS_CHAT} FROM conversaciones WHERE telefono IN (${ch.map(() => '?').join(',')})`, ch)) chatsCa.set((Number(c.tenant_id) || 0) + ':' + c.telefono, c);
    const crearCa = [];
    for (const r of ca) { const p = tel12(r.tel), t = Number(r.tenant_id) || 0; if (esTelMX(p) && !chatsCa.has(t + ':' + p)) crearCa.push({ t, p, nombre: r.comprador_nombre || null }); }
    if (dry) for (const x of crearCa) chatsCa.set(x.t + ':' + x.p, { id: null, telefono: x.p, tenant_id: x.t, auto_id_activo: null, _virtual: true });   // dry: contar como si existieran
    if (!dry && crearCa.length) {
        await _batchWrite(crearCa.map(x => ({ sql: `INSERT OR IGNORE INTO conversaciones (channel_thread_id, telefono, nombre, ult_texto, ult_dir, ult_msg_ts, no_leidos, is_dueno_chat, source, created_at, tenant_id) VALUES (?,?,?,'', 'out', ?, 0, 0, 'whatsapp', ?, ?)`, args: [hiloDe(x.p, x.t), x.p, x.nombre, now, now, x.t] })));
        for (const ch of _chunks(crearCa.map(x => x.p), LOTE)) for (const c of await query(`SELECT ${COLS_CHAT} FROM conversaciones WHERE telefono IN (${ch.map(() => '?').join(',')})`, ch)) chatsCa.set((Number(c.tenant_id) || 0) + ':' + c.telefono, c);
    }
    const activas = new Set();   // chat_id con delegación activa
    const cargarActivas = async ids => { for (const ch of _chunks([...new Set(ids.filter(Boolean))], LOTE)) for (const d of await query(`SELECT chat_id FROM delegaciones WHERE hasta IS NULL AND chat_id IN (${ch.map(() => '?').join(',')})`, ch)) activas.add(Number(d.chat_id)); };
    const idsCa = ca.map(r => { const c = chatsCa.get((Number(r.tenant_id) || 0) + ':' + tel12(r.tel)); return c ? c.id : null; }).filter(Boolean);
    await cargarActivas(idsCa);
    const insCa = [];
    for (const r of ca) {
        const c = chatsCa.get((Number(r.tenant_id) || 0) + ':' + tel12(r.tel));
        if (!c) { rep.ca_sin_chat++; continue; }
        if (activas.has(c.id)) { rep.deleg_ya_activas++; continue; }
        activas.add(c.id);
        insCa.push({ sql: 'INSERT INTO delegaciones (chat_id, tenant_id, auto_id, auto_nombre, activado_por, desde, hasta, opener_pendiente, opener_texto, motivo, created) VALUES (?,?,?,?,?,?,NULL,?,?,?,?)', args: [c.id, Number(r.tenant_id) || 0, r.car_id == null ? null : Number(r.car_id), r.car_nombre || null, r.activado_por || 'fyrachat', Number(r.desde) || Number(r.created) || now, Number(r.opener_pendiente) || 0, r.opener_texto || null, 'backfill:chats_activos#' + r.id, Number(r.created) || now] });
        // el foco también a la columna del chat (si estaba vacía)
        if (r.car_id != null && c.auto_id_activo == null) insCa.push({ sql: 'UPDATE conversaciones SET auto_id_activo=COALESCE(auto_id_activo, ?) WHERE id=?', args: [Number(r.car_id), c.id] });
    }
    rep.deleg_desde_ca = insCa.filter(s => /^INSERT/.test(s.sql)).length;
    if (!dry) await _batchWrite(insCa);
    // 3) foco del tenant 0 (wa_conversations.auto_id_activo) → delegaciones si el chat no tiene activa
    const conFoco = [];
    for (const [p, w] of porTel) { const c = chats.get(p); if (c && w.auto_id_activo != null && Number(w.auto_id_activo)) conFoco.push({ c, w }); }
    await cargarActivas(conFoco.map(x => x.c.id));
    const insWa = [];
    for (const { c, w } of conFoco) {
        if (activas.has(c.id)) { rep.deleg_ya_activas++; continue; }
        activas.add(c.id);
        insWa.push({ sql: 'INSERT INTO delegaciones (chat_id, tenant_id, auto_id, auto_nombre, activado_por, desde, hasta, opener_pendiente, opener_texto, motivo, created) VALUES (?,?,?,NULL,?,?,NULL,0,NULL,?,?)', args: [c.id, 0, Number(w.auto_id_activo), 'backfill', Number(c.ult_msg_ts) || Number(w.updated_at) || now, 'backfill:wa_conversations', now] });
    }
    rep.deleg_desde_wa = insWa.length;
    if (!dry) await _batchWrite(insWa);
    return rep;
}

module.exports = {
    tel12, esTelMX, hiloDe, ensureUniverso,
    chatDe, chatPorId, estadoDe, leerEstado, autoActivoDe, guardarEstado, borrarEstado,
    delegacionActiva, delegar, soltar, cambiarFoco, focoDe, delegacionesDe,
    backfillUniverso
};
