// lib/seb/mensajeria.js — LA PUERTA ÚNICA DE MENSAJES (FyraChat v2, contrato 2026-09-10).
//
// INTENCIÓN → UNA PUERTA → VALIDACIÓN → IDEMPOTENCIA → EJECUCIÓN → RESULTADO → REINTENTO.
// TODO envío que nace en el servidor (manual del vendedor, sugerencia aprobada, botones, opener de delegar
// en el universo 0, programados, rescates) entra por `enviar(...)`. La UI nunca decide el destino: manda
// `chat_id` + `clave`; aquí se resuelve DE NUEVO el chat del universo, el teléfono real (jamás un @lid),
// la delegación viva (universo ≠ 0), el carril de pruebas (se simula) y la idempotencia por `clave`.
//
// Lo que nace DENTRO del puente (auto-opener, respuestas de citas, avisos al owner) NO pasa por aquí.
//
// Tabla `envios` (clave PK): el recibo de cada intención. Repetir la clave devuelve el resultado guardado
// sin ejecutar dos veces; un fallo deja `estado='error'` y la MISMA clave se puede reintentar (el cron lo
// hace para programados/rescates). Un envío de varias burbujas guarda cuántas ya salieron para que el
// reintento no repita las primeras.
//
// CUOTA TURSO: por envío ≈ 1 lectura del chat (por id), 1 de delegación (índice), 1 INSERT/UPDATE del
// recibo, 1 acción. Nada de barridos.
const { query, run } = require('./db.js');
const U = require('./universo.js');
const ACC = require('./acciones.js');
const { tocar } = require('./timbre.js');

const esTelPrueba = t => /^52100000000/.test(String(t || '').replace(/\D/g, ''));   // PREFIJO, jamás largo exacto (ley de la casa)
const BRIDGE_URL = () => process.env.BRIDGE_SEND_URL || 'http://137.184.199.19:3000/api/send';
const BRIDGE_KEY = () => process.env.K_PUENTE || process.env.BRIDGE_API_KEY || '';
const EN_VUELO_MS = 2 * 60000;       // un 'enviando' más viejo que esto se considera muerto → se puede reintentar
const GAP_BURBUJAS_MS = 800;         // entre burbujas reales (mismo ritmo que el auto-opener)
const sleep = ms => new Promise(r => setTimeout(r, ms));
// ── ORIGEN PARA EL PUENTE (regla "SOLO POR BOTÓN", auditoría H 2026-09-12): en universos ≠0 el puente exige `origen` ∈
//    {manual, boton, casilla, maquina_cita, programado, delegar, sb} en /api/send y /api/send-fotos (403 si falta).
//    Aquí se traduce el origen interno ('boton:<acc>', 'sugerencia', 'rescate', 'cita'…) a esa etiqueta. Se manda SIEMPRE (t0 lo ignora).
const ORIGENES_PUENTE = ['manual', 'boton', 'casilla', 'maquina_cita', 'programado', 'delegar', 'sb'];
function origenPuente(origen) {
    const o = String(origen || 'manual');
    if (/^boton(:|$)/.test(o) || o === 'sugerencia') return 'boton';
    if (o === 'cita') return 'maquina_cita';
    if (o === 'rescate') return 'programado';
    return ORIGENES_PUENTE.includes(o) ? o : 'manual';
}

// ── SEAM DE PRUEBAS (solo afecta teléfonos del carril 52100000000x): simula que el puente está caído ──
const _prueba = { fallarPuente: false };

let _ens = null;
function ensureEnvios() {
    if (_ens) return _ens;
    _ens = (async () => {
        await run(`CREATE TABLE IF NOT EXISTS envios (
            clave TEXT PRIMARY KEY,
            tenant_id INTEGER NOT NULL DEFAULT 0,
            chat_id INTEGER,
            accion TEXT,
            origen TEXT,
            estado TEXT,
            resultado_json TEXT,
            intentos INTEGER DEFAULT 0,
            ts INTEGER,
            updated INTEGER,
            sesion_id INTEGER)`);
        await run('CREATE INDEX IF NOT EXISTS idx_envios_chat_ts ON envios(chat_id, ts)');
        return true;
    })().catch(e => { _ens = null; throw e; });
    return _ens;
}

const parseJ = s => { try { return JSON.parse(s || 'null'); } catch (e) { return null; } };

// ── RECLAMO ATÓMICO DE LA CLAVE ──
// → { modo:'nuevo' } | { modo:'reintento', previo } | { modo:'repetido', previo } | { modo:'en_vuelo', previo }
async function reclamar(clave, { tenantId, chatId, accion, origen, sesionId }) {
    await ensureEnvios();
    const now = Date.now();
    const ins = await run(`INSERT INTO envios (clave, tenant_id, chat_id, accion, origen, estado, resultado_json, intentos, ts, updated, sesion_id)
                           VALUES (?,?,?,?,?,'enviando',NULL,1,?,?,?) ON CONFLICT(clave) DO NOTHING`,
        [clave, Number(tenantId) || 0, chatId == null ? null : Number(chatId), accion || 'envio', origen || null, now, now, sesionId == null ? null : Number(sesionId)]);
    if (Number(ins.rowsAffected) > 0) return { modo: 'nuevo' };
    const prev = (await query('SELECT clave, estado, resultado_json, intentos, updated FROM envios WHERE clave=?', [clave]))[0];
    if (!prev) return { modo: 'nuevo' };   // carrera rarísima: se borró entre medio → seguir
    const previo = parseJ(prev.resultado_json) || {};
    if (prev.estado === 'enviado' || prev.estado === 'simulado' || prev.estado === 'hecho') return { modo: 'repetido', previo };
    if (prev.estado === 'enviando' && Number(prev.updated || 0) > now - EN_VUELO_MS) return { modo: 'en_vuelo', previo };
    // error o 'enviando' muerto → re-reclamar (solo UNO gana)
    const u = await run("UPDATE envios SET estado='enviando', intentos=intentos+1, updated=? WHERE clave=? AND estado NOT IN ('enviado','simulado','hecho') AND (estado<>'enviando' OR updated<=?)",
        [now, clave, now - EN_VUELO_MS]);
    if (Number(u.rowsAffected) > 0) return { modo: 'reintento', previo };
    return { modo: 'en_vuelo', previo };
}
async function cerrar(clave, estado, resultado) {
    try { await run('UPDATE envios SET estado=?, resultado_json=?, updated=? WHERE clave=?', [estado, JSON.stringify(resultado || {}).slice(0, 8000), Date.now(), clave]); } catch (e) { console.error('[mensajeria] cerrar', e.message); }
}

// ── DESTINO: chat del universo → teléfono real → delegación viva ──
async function resolverDestino(tenantId, chatId) {
    const t = Number(tenantId) || 0;
    const chat = await U.chatPorId(chatId);
    if (!chat) return { error: 'chat inexistente', status: 404 };
    if ((Number(chat.tenant_id) || 0) !== t) return { error: 'ese chat no es de este universo', status: 403 };
    let tel = String(chat.telefono || '').replace(/\D/g, '');
    let tel_via = 'chat';
    if (!U.esTelMX(tel)) {
        // identidad @lid: SOLO se manda si el mapa @lid→teléfono lo conoce; jamás al lid
        const m = (await query('SELECT phone FROM lid_phone_map WHERE lid=? LIMIT 1', [String(chat.telefono || '')]).catch(() => []))[0];
        const ph = m ? U.tel12(m.phone) : '';
        if (!U.esTelMX(ph)) return { error: 'chat sin teléfono real (identidad @lid sin mapa) — no se puede mandar', status: 409, chat };
        tel = ph; tel_via = 'lid_phone_map';
    }
    let delegacion = null, tenant = null, demo = false;
    try { delegacion = await U.delegacionActiva(chat.id); } catch (e) { delegacion = null; }
    if (t) {
        if (!delegacion) return { error: 'chat no delegado en este universo', status: 403, chat };
        // tenant + estado de su WhatsApp (wa_sessions) en UNA lectura: un universo desconectado NO puede mandar (queda pendiente/reintento)
        tenant = (await query('SELECT t.id, t.telefono, t.nombre, t.config_json, s.estado AS ses_estado FROM tenants t LEFT JOIN wa_sessions s ON s.tenant_id = t.id WHERE t.id=? AND t.activo=1', [t]))[0] || null;
        if (!tenant) return { error: 'universo inexistente o inactivo', status: 404, chat };
        try { demo = Number((JSON.parse(tenant.config_json || '{}') || {}).demo) === 1; } catch (e) { demo = false; }
        if (!demo && !esTelPrueba(tel) && tenant.ses_estado !== 'vinculado') return { error: 'universo ' + t + ' no conectado (' + (tenant.ses_estado || 'sin sesión') + ')', status: 503, chat, no_conectado: true };
    }
    return { chat, tel, tel_via, delegacion, tenant, demo };
}

// ── EL PUENTE ──
async function puenteSend(body) {
    const key = BRIDGE_KEY();
    if (!key) return { ok: false, error: 'K_PUENTE no configurada' };
    try {
        const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 25000);
        const r = await fetch(BRIDGE_URL(), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body), signal: ctl.signal });
        clearTimeout(tm);
        const d = await r.json().catch(() => ({}));
        return { ok: r.ok && d.ok !== false, msg_id: d.messageId || null, error: (r.ok && d.ok !== false) ? null : (d.error || ('bridge ' + r.status)) };
    } catch (e) { return { ok: false, error: e.message }; }
}
async function puenteFotos(body) {
    const key = BRIDGE_KEY();
    if (!key) return { ok: false, error: 'K_PUENTE no configurada' };
    try {
        const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 60000);
        const r = await fetch(BRIDGE_URL().replace(/\/api\/send$/, '/api/send-fotos'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body), signal: ctl.signal });
        clearTimeout(tm);
        const d = await r.json().catch(() => ({}));
        return { ok: r.ok && d.ok !== false, n: d.n || 0, error: (r.ok && d.ok !== false) ? null : (d.error || ('bridge ' + r.status)) };
    } catch (e) { return { ok: false, error: e.message }; }
}

// ── TIMBRE de un mensaje que NO pasó por el puente (simulado): el puente lo rebota a las pantallas ──
async function timbreMensaje(ev) {
    try {
        const key = BRIDGE_KEY(); if (!key) return;
        const url = BRIDGE_URL().replace(/\/api\/send$/, '/api/emit');
        const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 2500);
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify(Object.assign({ tipo: 'mensaje' }, ev)), signal: ctl.signal });
        clearTimeout(tm);
    } catch (e) { /* el timbre jamás rompe el envío */ }
}
function emisorNorm(direccion, emisor, ai) {
    if (direccion === 'in') return 'comprador';
    if (emisor === 'sistema') return 'sistema';
    return Number(ai) ? 'bot' : 'dueno';
}

// ── SIMULADO (carril de pruebas / universo demo): el renglón se escribe aquí (el puente no participa) ──
async function persistirSimulado({ chat, tenantId, demo, tenant, tel, textos, fotos, imagen_ref, location, manual, clave }) {
    const t = Number(tenantId) || 0;
    const ai = manual ? 0 : 1;
    let ultimo = { msg_id: null, ts: Date.now(), id: null };
    if (demo && tenant) {
        // universo PRUEBAS#: la misma pinta que ya usa el simulador (prefijo [prueba], emisor dueno/asistente)
        const DEMO = require('./demo.js');
        const tn = { id: t, telefono: tenant.telefono, nombre: tenant.nombre, demo: true };
        let i = 0; const base = Date.now();
        if (imagen_ref) { await DEMO.salidaMedia(tn, tel, 'image', String(imagen_ref), base + (i++)); }
        for (const tx of textos) { const s = await DEMO.salida(tn, tel, tx, manual ? 'dueno' : 'asistente', { ts: base + (i++) }); if (s && s.ok) ultimo = { msg_id: s.msg_id, ts: s.ts, id: null }; }
        if (location && location.lat != null) { await DEMO.salidaMedia(tn, tel, 'location', [location.name || '', location.lat, location.lng, location.maps_link || ''].join('|||'), base + (i++)); }
        for (const f of fotos) { const s = await DEMO.salidaMedia(tn, tel, 'image', f, base + (i++)); if (s && s.ok) ultimo = { msg_id: s.msg_id, ts: s.ts, id: null }; }
        return ultimo;
    }
    const emisor = t ? (manual ? 'dueno' : 'asistente') : 'SRS010904';
    const filas = [];
    if (imagen_ref) filas.push({ texto: String(imagen_ref), tipo: 'image' });
    for (const tx of textos) filas.push({ texto: tx, tipo: 'text' });
    if (location && location.lat != null) filas.push({ texto: [location.name || '', location.lat, location.lng, location.maps_link || ''].join('|||'), tipo: 'location' });
    for (const f of fotos) filas.push({ texto: '[imagen] ' + f, tipo: 'image' });
    const base = Date.now();
    for (let i = 0; i < filas.length; i++) {
        const f = filas[i], ts = base + i, msgId = 'sim:' + clave + ':' + i;
        await run("INSERT OR IGNORE INTO mensajes (conversacion_id, msg_id, ts, direccion, emisor, texto, tipo, ai_generated, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            [chat.id, msgId, ts, 'out', emisor, f.texto, f.tipo, ai, Date.now()]);
        const portada = f.tipo === 'image' ? '📷 imagen' : f.tipo === 'location' ? '📍 ubicación' : f.texto;
        await run(`UPDATE conversaciones SET ult_texto = CASE WHEN ? >= COALESCE(ult_msg_ts,0) THEN ? ELSE ult_texto END,
                   ult_dir = CASE WHEN ? >= COALESCE(ult_msg_ts,0) THEN 'out' ELSE ult_dir END, ult_msg_ts = MAX(?, COALESCE(ult_msg_ts,0)) WHERE id=?`,
            [ts, String(portada).slice(0, 120), ts, ts, chat.id]);
        ultimo = { msg_id: msgId, ts, id: null };
        await timbreMensaje({ tenant_id: t, chat_id: Number(chat.id), telefono: tel, simulado: true, mensaje: { id: null, msg_id: msgId, dir: 'out', emisor: emisorNorm('out', emisor, ai), texto: f.texto, ts, media: null, estado: 'enviado' } });
    }
    return ultimo;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// enviar({ tenantId, chatId, origen, clave, texto|segmentos, fotos, imagen, imagen_ref, location, manual,
//          sesionId, accion, refId, meta, actor })
//   origen: 'manual' | 'boton:<acc>' | 'sugerencia' | 'delegar' | 'programado' | 'rescate' | 'cita' | 'sb'
//   texto: string | string[] (cada elemento = una burbuja); segmentos: string[] (alias)
//   fotos: urls públicas (van por /api/send-fotos DESPUÉS del texto)
//   imagen: base64 (captura del punto) · imagen_ref: cómo se persiste simulado ('ubic-img:<id>') · location: {lat,lng,name,maps_link}
//   manual: firma del mensaje (ai_generated=0). Default: origen==='manual'.
// → { ok, status, chat_id, telefono, clave, simulado, msg_id, mensaje:{id,msg_id,ts,estado}, error, repetido }
// ══════════════════════════════════════════════════════════════════════════════════════════════
async function enviar(opts) {
    opts = opts || {};
    const t = Number(opts.tenantId) || 0;
    const chatId = Number(opts.chatId) || 0;
    const origen = String(opts.origen || 'manual');
    const manual = opts.manual != null ? !!opts.manual : origen === 'manual';
    const textos = [].concat(opts.segmentos || [], opts.texto == null ? [] : (Array.isArray(opts.texto) ? opts.texto : [opts.texto])).map(s => String(s == null ? '' : s).trim()).filter(Boolean);
    const fotos = (Array.isArray(opts.fotos) ? opts.fotos : []).map(String).filter(u => /^https?:\/\//.test(u));
    const imagen = opts.imagen ? String(opts.imagen) : null;
    const location = opts.location && opts.location.lat != null && opts.location.lng != null ? opts.location : null;
    const R = (status, o) => Object.assign({ ok: false, status, chat_id: chatId || null, clave: opts.clave || null }, o);
    if (!chatId) return R(400, { error: 'chat_id requerido' });
    if (!textos.length && !fotos.length && !imagen && !location) return R(400, { error: 'nada que mandar (texto, fotos, imagen o ubicación)' });
    const clave = String(opts.clave || ('auto:' + t + ':' + chatId + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8)));

    const dest = await resolverDestino(t, chatId);
    if (dest.error) return R(dest.status || 400, { error: dest.error, telefono: dest.chat ? dest.chat.telefono : null, no_conectado: !!dest.no_conectado });
    const { chat, tel, delegacion, tenant, demo } = dest;

    const c = await reclamar(clave, { tenantId: t, chatId: chat.id, accion: opts.accion || 'envio', origen, sesionId: opts.sesionId });
    if (c.modo === 'repetido') return Object.assign({ ok: true, status: 200 }, c.previo, { repetido: true });
    if (c.modo === 'en_vuelo') return R(409, { error: 'ese envío ya va en curso', en_vuelo: true });
    const yaSalieron = c.modo === 'reintento' ? Number(c.previo && c.previo.enviados_textos) || 0 : 0;   // burbujas que SÍ salieron en el intento fallido

    const simulado = esTelPrueba(tel) || demo;
    const out = { ok: false, status: 200, chat_id: Number(chat.id), telefono: tel, clave, simulado, msg_id: null, mensaje: null, enviados_textos: yaSalieron, enviadas_fotos: 0, error: null, repetido: false };
    try {
        if (simulado) {
            if (_prueba.fallarPuente) throw new Error('puente simulado caído (seam de pruebas)');
            const u = await persistirSimulado({ chat, tenantId: t, demo, tenant, tel, textos: textos.slice(yaSalieron), fotos, imagen_ref: opts.imagen_ref || (imagen ? '[imagen]' : null), location, manual, clave });
            out.ok = true; out.msg_id = u.msg_id; out.enviados_textos = textos.length; out.enviadas_fotos = fotos.length;
            out.mensaje = { id: u.id, msg_id: u.msg_id, ts: u.ts, estado: 'enviado' };
        } else {
            const conTenant = b => Object.assign(b, { origen: origenPuente(origen) }, t ? { tenant_id: t } : {});
            let ultimoId = null;
            const pend = textos.slice(yaSalieron);
            if (!pend.length && (imagen || location) && !yaSalieron) {
                const r = await puenteSend(conTenant({ phone: tel, image: imagen || undefined, location: location || undefined, manual }));
                if (!r.ok) throw new Error(r.error || 'el puente no pudo mandar');
                ultimoId = r.msg_id || ultimoId;
            }
            for (let i = 0; i < pend.length; i++) {
                const body = conTenant({ phone: tel, text: pend[i], manual });
                if (i === 0 && !yaSalieron) { if (imagen) body.image = imagen; if (location) body.location = location; }   // el paquete (captura + texto + pin) va junto
                const r = await puenteSend(body);
                if (!r.ok) throw new Error(r.error || 'el puente no pudo mandar');
                ultimoId = r.msg_id || ultimoId;
                out.enviados_textos = yaSalieron + i + 1;
                if (i < pend.length - 1) await sleep(GAP_BURBUJAS_MS);
            }
            if (fotos.length) {
                const rf = await puenteFotos(conTenant({ phone: tel, urls: fotos }));
                if (!rf.ok) throw new Error(rf.error || 'el puente no pudo mandar las fotos');
                out.enviadas_fotos = fotos.length;
            }
            out.ok = true; out.msg_id = ultimoId;
            let id = null;
            if (ultimoId) { try { const m = (await query('SELECT id FROM mensajes WHERE conversacion_id=? AND msg_id=? LIMIT 1', [chat.id, ultimoId]))[0]; id = m ? Number(m.id) : null; } catch (e) { } }
            out.mensaje = { id, msg_id: ultimoId, ts: Date.now(), estado: 'enviado' };
        }
    } catch (e) {
        out.ok = false; out.error = e.message || String(e);
    }
    await cerrar(clave, out.ok ? (simulado ? 'simulado' : 'enviado') : 'error', out);
    if (out.ok) {
        await ACC.registrar({
            tenant_id: t, chat_id: Number(chat.id), delegacion_id: delegacion ? Number(delegacion.id) : null,
            tipo: opts.accion || 'envio', ref_id: opts.refId == null ? null : Number(opts.refId),
            meta: Object.assign({ origen, clave, msg_id: out.msg_id, simulado, textos: textos.length, fotos: fotos.length, manual }, opts.meta || {}),
            actor: opts.actor || (manual ? 'vendedor' : 'bot'), sesion_id: opts.sesionId
        });
    }
    return out;
}

// ── conClave(clave, ctx, fn): ejecuta fn UNA vez por clave y guarda su resultado en `envios` (para acciones
//    compuestas: delegar_v2, cotizar_v2, cita_v2, reactivar, auto_subir). Repetir la clave devuelve lo guardado. ──
async function conClave(clave, ctx, fn) {
    ctx = ctx || {};
    if (!clave) return fn();
    const c = await reclamar(String(clave), { tenantId: ctx.tenantId, chatId: ctx.chatId, accion: ctx.accion || 'accion', origen: ctx.origen || ctx.accion || null, sesionId: ctx.sesionId });
    if (c.modo === 'repetido') return Object.assign({}, c.previo, { repetido: true });
    if (c.modo === 'en_vuelo') return { ok: false, status: 409, error: 'esa acción ya va en curso', en_vuelo: true };
    let r;
    try { r = await fn(c); } catch (e) { r = { ok: false, error: e.message || String(e) }; }
    await cerrar(String(clave), r && r.ok ? 'hecho' : 'error', r);
    return r;
}

// recibo de un envío (para depurar / UI): 1 fila por PK
async function recibo(clave) {
    await ensureEnvios();
    const r = (await query('SELECT * FROM envios WHERE clave=?', [String(clave)]))[0];
    return r ? Object.assign({}, r, { resultado: parseJ(r.resultado_json) }) : null;
}

module.exports = { enviar, conClave, recibo, ensureEnvios, resolverDestino, esTelPrueba, emisorNorm, origenPuente, ORIGENES_PUENTE, tocar, _prueba };
