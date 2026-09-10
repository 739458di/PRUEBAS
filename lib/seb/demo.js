// lib/seb/demo.js — FYRACHAT DE PRUEBA (orden owner 2026-09-10): el universo "PRUEBAS#".
//
// Un tenant DEMO (WhatsApp 8888888888 → 5218888888888, config_json {"demo":1}) donde el owner prueba el flujo
// completo de un vendedor (delegar, forma de entrada, botones, soltar) SIN tocar WhatsApp ni el puente:
//   · el puente JAMÁS abre este universo (wa_sessions nace 'vinculado' con motivo 'demo' solo para que la UI no avise);
//   · el comprador es SIEMPRE un teléfono del carril de pruebas (5210000000009) → enviarWA ya simula;
//   · TODO envío se registra como renglón del hilo (mensajes) con prefijo "[prueba] " para verse en la UI;
//   · todo lo que escribe lleva tenant_id del demo (conversaciones / delegaciones / chats_activos / acciones);
//   · demo_reset deja el universo en cero.
// Regla de la casa: el código de acceso fijo '000000' solo vale para este tenant (acceso.js).
const { query, run } = require('./db.js');
const U = require('./universo.js');

const DEMO_TEL = '5218888888888';       // WhatsApp del "vendedor" PRUEBAS# (8888888888)
const DEMO_NOMBRE = 'PRUEBAS#';
const DEMO_CODIGO = '000000';           // código fijo de entrada (solo tenant demo)
const DEMO_COMPRADOR = '5210000000009'; // comprador de prueba (carril de pruebas: prefijo 52100000000)
const PREFIJO = '[prueba] ';
const esTelPrueba = t => /^52100000000/.test(String(t || '').replace(/\D/g, ''));

/** true si el tenant (fila con config_json, u objeto con config ya parseado) es el demo: config.demo === 1. */
function esDemo(tenant) {
    if (!tenant) return false;
    if (tenant.demo === true) return true;
    let cfg = tenant.config;
    if (!cfg || typeof cfg !== 'object') { try { cfg = JSON.parse(tenant.config_json || '{}') || {}; } catch (e) { cfg = {}; } }
    return Number(cfg.demo) === 1;
}
/** En el demo el comprador es SIEMPRE del carril de pruebas: lo que no empiece con 52100000000 se sustituye. */
function telComprador(tel) {
    // MODO PRUEBA: cada teléfono distinto que teclee el vendedor cae en un comprador de prueba DISTINTO (mismo teléfono → mismo
    // comprador), dentro del carril 52100000000xx. Antes todos caían en el mismo número y parecía que "se cruzaban" los clientes.
    const d = String(tel || '').replace(/\D/g, '');
    if (esTelPrueba(d)) return d.length === 10 ? '521' + d : d;
    if (!d) return DEMO_COMPRADOR;
    let h = 0; for (const ch of d) h = (h * 31 + ch.charCodeAt(0)) % 1000003;
    return '52100000000' + String(10 + (h % 90)).padStart(2, '0');   // 5210000000010 … 5210000000099
}

/** Crea (idempotente) el tenant demo + su fila wa_sessions. Devuelve la fila del tenant. */
async function asegurarTenantDemo() {
    let t = (await query("SELECT id, telefono, nombre, activo, config_json FROM tenants WHERE telefono = ? LIMIT 1", [DEMO_TEL]))[0];
    if (!t) {
        await run("INSERT INTO tenants (telefono, nombre, activo, config_json, created_at) VALUES (?,?,1,?,?)", [DEMO_TEL, DEMO_NOMBRE, JSON.stringify({ demo: 1 }), Date.now()]);
        t = (await query("SELECT id, telefono, nombre, activo, config_json FROM tenants WHERE telefono = ? LIMIT 1", [DEMO_TEL]))[0];
    } else {
        let cfg = {}; try { cfg = JSON.parse(t.config_json || '{}') || {}; } catch (e) { }
        if (Number(cfg.demo) !== 1 || Number(t.activo) !== 1 || t.nombre !== DEMO_NOMBRE) {
            cfg.demo = 1;
            await run("UPDATE tenants SET activo = 1, nombre = ?, config_json = ? WHERE id = ?", [DEMO_NOMBRE, JSON.stringify(cfg), t.id]);
            t = (await query("SELECT id, telefono, nombre, activo, config_json FROM tenants WHERE id = ? LIMIT 1", [t.id]))[0];
        }
    }
    const w = await query("SELECT tenant_id, estado FROM wa_sessions WHERE tenant_id = ? LIMIT 1", [Number(t.id)]);
    const now = Date.now();
    if (!w.length) await run("INSERT INTO wa_sessions (tenant_id, estado, motivo, ultimo_evento, ultimo_mensaje, qr_pendiente, updated) VALUES (?,?,?,?,?,0,?)", [Number(t.id), 'vinculado', 'demo', now, null, now]);
    else if (String(w[0].estado) !== 'vinculado') await run("UPDATE wa_sessions SET estado = 'vinculado', motivo = 'demo', updated = ? WHERE tenant_id = ?", [now, Number(t.id)]);
    return t;
}

// ── EL HILO: un renglón en `mensajes` + portada de `conversaciones` (lo mismo que escribe el puente) ──
let _seq = 0;
/** registrar({ tenant, tel, texto, direccion:'in'|'out', emisor, ai, tipo, nombre, ts }) → { ok, msg_id, ts, chat_id } */
async function registrar({ tenant, tel, texto, direccion, emisor, ai, tipo, nombre, ts }) {
    const tId = Number(tenant && tenant.id) || 0;
    if (!tId) return { ok: false, error: 'el demo exige tenant_id ≠ 0' };
    const p = telComprador(tel);
    const chat = await U.chatDe(tId, p, { crear: true, visible: true, nombre: nombre || null });
    if (!chat) return { ok: false, error: 'no pude crear el chat' };
    const when = Number(ts) || Date.now();
    const msgId = 'demo:' + tId + ':' + when + ':' + (++_seq) + ':' + Math.random().toString(36).slice(2, 7);
    const dir = direccion === 'in' ? 'in' : 'out';
    const txt = String(texto || '');
    await run("INSERT OR IGNORE INTO mensajes (conversacion_id, msg_id, ts, direccion, emisor, texto, tipo, ai_generated, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [chat.id, msgId, when, dir, emisor || null, txt, tipo || 'text', ai ? 1 : 0, Date.now()]);
    await run(`UPDATE conversaciones SET
                 nombre = COALESCE(?, nombre),
                 ult_texto = CASE WHEN ? >= COALESCE(ult_msg_ts, 0) THEN ? ELSE ult_texto END,
                 ult_dir   = CASE WHEN ? >= COALESCE(ult_msg_ts, 0) THEN ? ELSE ult_dir END,
                 ult_msg_ts = MAX(?, COALESCE(ult_msg_ts, 0))
               WHERE id = ?`, [nombre || null, when, (tipo === 'image' ? '📷 imagen' : tipo === 'location' ? '📍 ubicación' : txt).slice(0, 120), when, dir, when, chat.id]);
    return { ok: true, msg_id: msgId, ts: when, chat_id: Number(chat.id) };
}
/** Salida simulada (lo que habría ido a WhatsApp): emisor 'asistente' (bot) o 'dueno' (el vendedor a mano). */
async function salida(tenant, tel, texto, emisor, extra) {
    const esBot = emisor !== 'dueno';
    return registrar(Object.assign({ tenant, tel, texto: PREFIJO + String(texto || ''), direccion: 'out', emisor: esBot ? 'asistente' : 'dueno', ai: esBot ? 1 : 0, tipo: 'text' }, extra || {}));
}
/** Medio simulado (imagen / pin) en el hilo, para que la UI lo pinte como lo pinta en producción. */
async function salidaMedia(tenant, tel, tipo, texto, ts) {
    return registrar({ tenant, tel, texto: String(texto || ''), direccion: 'out', emisor: 'asistente', ai: 1, tipo, ts });
}
/** Renglón 'sistema' (como el "🤝 Chat delegado" del puente). */
async function sistema(tenant, tel, texto, nombre) {
    return registrar({ tenant, tel, texto, direccion: 'out', emisor: 'sistema', ai: 1, tipo: 'text', nombre: nombre || null });
}

// ── LO QUE EL PUENTE HARÍA AL DELEGAR / SOLTAR, hecho en local ──
/** delegar({ tenant, tel, auto_id, auto_nombre, nombre, opener, opener_emisor }) → { ok, chat_id, delegacion_id, opener_enviado, ya_delegado, simulado:true }
 *  FORMA DE ENTRADA (orden owner 2026-09-10): `opener` solo llega en modo texto/bot y se pinta UNA vez en ESTA llamada
 *  (aunque el chat ya estuviera delegado). opener_emisor 'dueno' = texto del vendedor (ai 0); 'asistente' = presentación (ai 1).
 *  Los modos de acción (info/fotos/ubicacion/cotizar/cita) NO pasan por aquí: los ejecuta ejecutarAccion en seb-panel.
 *  opener_pendiente ya no se escribe ni se lee (letra muerta): nada queda "pendiente" para dispararse después. */
async function delegar({ tenant, tel, auto_id, auto_nombre, nombre, opener, opener_emisor }) {
    const p = telComprador(tel);
    const chat = await U.chatDe(Number(tenant.id), p, { crear: true, visible: true, nombre: nombre || null });
    if (!chat) return { ok: false, error: 'no pude crear el chat de prueba' };
    const yaDelegado = !!(await U.focoDe(Number(tenant.id), p).catch(() => null));
    // delegación (verdad nueva) + espejo chats_activos (crear_ca) — la MISMA puerta que usa el resto del panel para el foco
    const d = await U.delegar(chat, { auto_id: auto_id || null, auto_nombre: auto_nombre || null, activado_por: 'fyrachat-demo', opener_texto: null, opener_pendiente: 0 });
    if (auto_id) await run('UPDATE conversaciones SET auto_id_activo=? WHERE id=?', [Number(auto_id), chat.id]).catch(() => { });
    if (!yaDelegado) await sistema(tenant, p, '🤝 Chat delegado (prueba)' + (auto_nombre ? ' · ' + auto_nombre : ''), nombre || null);   // como el puente: la nota nace una vez
    let opener_enviado = false;
    if (opener && String(opener).trim()) { const s = await salida(tenant, p, opener, opener_emisor === 'dueno' ? 'dueno' : 'asistente'); opener_enviado = !!s.ok; }
    return { ok: true, chat_id: Number(chat.id), delegacion_id: d && d.id ? Number(d.id) : null, opener_enviado, ya_delegado: yaDelegado, simulado: true, telefono: p };
}
/** soltar({ tenant, tel }) → cierra la delegación (y su espejo) + renglón 'sistema'. */
async function soltar({ tenant, tel }) {
    const p = telComprador(tel);
    const chat = await U.chatDe(Number(tenant.id), p);
    if (!chat) return { ok: false, error: 'no delegado' };
    const r = await U.soltar(chat, 'soltar-demo');
    await sistema(tenant, p, 'Chat soltado (prueba)');
    return { ok: true, cerradas: r.cerradas || 0, simulado: true };
}
/** El "comprador" contesta (lo teclea el owner): renglón ENTRANTE en el hilo. */
async function responder({ tenant, tel, texto, nombre }) {
    const txt = String(texto || '').trim();
    if (!txt) return { ok: false, error: 'texto requerido' };
    return registrar({ tenant, tel, texto: txt, direccion: 'in', emisor: 'comprador', ai: 0, tipo: 'text', nombre: nombre || null });
}

/** Deja el universo demo en cero. Solo borra filas con tenant_id del demo (jamás tenant 0). */
async function reset(tenant) {
    const tId = Number(tenant && tenant.id) || 0;
    if (!tId || !esDemo(tenant)) return { ok: false, error: 'solo el tenant demo' };
    const rep = {};
    const cuenta = async (sql, args) => { try { const r = await run(sql, args); return Number(r.rowsAffected) || 0; } catch (e) { return 'n/a'; } };
    rep.mensajes = await cuenta('DELETE FROM mensajes WHERE conversacion_id IN (SELECT id FROM conversaciones WHERE tenant_id = ?)', [tId]);
    rep.acciones = await cuenta('DELETE FROM acciones WHERE tenant_id = ?', [tId]);
    rep.delegaciones = await cuenta('DELETE FROM delegaciones WHERE tenant_id = ?', [tId]);
    rep.chats_activos = await cuenta('DELETE FROM chats_activos WHERE tenant_id = ?', [tId]);
    rep.citas_casillas = await cuenta('DELETE FROM cita_casillas WHERE tenant_id = ?', [tId]);
    rep.citas_match = await cuenta('DELETE FROM citas_match WHERE tenant_id = ?', [tId]);
    rep.programados = await cuenta('DELETE FROM mensajes_programados WHERE tenant_id = ?', [tId]);
    rep.conversaciones = await cuenta('DELETE FROM conversaciones WHERE tenant_id = ?', [tId]);
    return { ok: true, borrado: rep };
}

module.exports = { DEMO_TEL, DEMO_NOMBRE, DEMO_CODIGO, DEMO_COMPRADOR, PREFIJO, esDemo, esTelPrueba, telComprador, asegurarTenantDemo, registrar, salida, salidaMedia, sistema, delegar, soltar, responder, reset };
