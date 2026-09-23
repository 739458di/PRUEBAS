// lib/seb/voz.js — LA VOZ DEL CHAT (human-on-the-loop, orden owner 2026-09-22)
//
// Realidad simple: en cada chat habla UNA sola voz: Seb o el vendedor. Se guarda en conversaciones.estado_bot
// ('seb' | 'humano') y cambia SOLO por aquí. Cada cambio sube conversaciones.voz_gen (generación): un mensaje de Seb
// solo puede salir si nació en la generación vigente (mensajeria.enviar lo verifica) → una respuesta que Seb estaba
// armando antes de que la voz pasara al vendedor jamás sale después.
//
//   escalar (cualquier puerta)  → entregar(motivo)   : humano, gen+1, nota roja, WhatsApp al vendedor con link
//   el vendedor escribe a mano  → entregar(sin aviso): humano, gen+1
//   [DEVOLVER A SEB]            → devolver()          : seb, gen+1  (y luego quien llama decide: turno pendiente / gancho / nada)
//
// El vendedor responsable NO se guarda: el chat pertenece a un universo (tenant) y el universo tiene UN WhatsApp
// (tenants.telefono). Cuando haya varios vendedores por lote, se agrega a la delegación; no antes.
const { query, run } = require('./db.js');

const vozDe = chat => (chat && String(chat.estado_bot || '') === 'humano') ? 'humano' : 'seb';
const genDe = chat => Number(chat && chat.voz_gen) || 0;
const linkChat = (tenantId, chatId) => 'https://fyrachat.vercel.app/fyrachat.html?vendedor=' + Number(tenantId) + '&chat=' + Number(chatId);
const nombreDe = chat => { const n = String((chat && chat.nombre) || '').trim(); return (n && !/^\+?\d/.test(n)) ? n.split(/\s+/)[0] : ('+' + String((chat && chat.telefono) || '').replace(/\D/g, '')); };

// nota gris en el hilo (solo la ve el vendedor) — misma forma que las notas de Seb
async function nota(tenant, chat, txt) {
    try {
        const DEMO = require('./demo.js');
        if (DEMO.esDemo(tenant)) return await DEMO.sistema(tenant, String(chat.telefono), txt);
        const ts = Date.now();
        await run("INSERT OR IGNORE INTO mensajes (conversacion_id, msg_id, ts, direccion, emisor, texto, tipo, ai_generated, created_at) VALUES (?,?,?,?,?,?,?,?,?)", [Number(chat.id), 'voz-nota:' + ts + ':' + Math.random().toString(36).slice(2, 6), ts, 'out', 'sistema', txt, 'text', 1, ts]);
    } catch (e) { }
}

// WhatsApp al vendedor (tenants.telefono) por la puerta única de mensajes, en su chat oculto "Avisos". Sandbox (TERRA): solo la nota.
async function avisarVendedor(tenant, texto, clave) {
    try {
        const DEMO = require('./demo.js'); if (DEMO.esDemo(tenant)) return { ok: true, simulado: true };
        const telV = String(tenant.telefono || '').replace(/\D/g, ''); if (telV.length < 12) return { ok: false, error: 'el universo no tiene WhatsApp de vendedor' };
        const U = require('./universo.js'), MSJ = require('./mensajeria.js');
        const chV = await U.chatDe(Number(tenant.id), telV, { crear: true, visible: false, nombre: 'Avisos' }); if (!chV) return { ok: false, error: 'sin chat de avisos' };
        return await MSJ.enviar({ tenantId: Number(tenant.id), chatId: Number(chV.id), origen: 'sb', clave: clave || ('voz:aviso:' + Date.now() + ':' + Math.random().toString(36).slice(2, 6)), manual: false, accion: 'voz_aviso', texto });
    } catch (e) { return { ok: false, error: e.message }; }
}

/** Vendedor dueño del chat (conversaciones.miembro_id → vendedores_universo activo) o null. */
async function miembroDelChat(chat) {
    try {
        const c = (await query('SELECT miembro_id FROM conversaciones WHERE id = ?', [Number(chat.id)]))[0];
        if (!c || c.miembro_id == null) return null;
        const m = (await query('SELECT id, nombre, telefono FROM vendedores_universo WHERE id = ? AND activo = 1', [Number(c.miembro_id)]))[0];
        return m ? { id: Number(m.id), nombre: m.nombre, telefono: m.telefono } : null;
    } catch (e) { return null; }
}
/** Aviso al WhatsApp del MIEMBRO desde el número del lote (chat oculto 'Avisos · <nombre>'). */
async function avisarMiembro(tenant, miembro, texto) {
    try {
        const DEMO = require('./demo.js'); if (DEMO.esDemo(tenant)) return { ok: true, simulado: true };
        const telM = String(miembro.telefono || '').replace(/\D/g, ''); if (telM.length < 12) return { ok: false, error: 'miembro sin WhatsApp' };
        const U = require('./universo.js'), MSJ = require('./mensajeria.js');
        const chM = await U.chatDe(Number(tenant.id), telM, { crear: true, visible: false, nombre: 'Avisos · ' + String(miembro.nombre || '').split(/\s+/)[0] }); if (!chM) return { ok: false, error: 'sin chat de avisos' };
        return await MSJ.enviar({ tenantId: Number(tenant.id), chatId: Number(chM.id), origen: 'sb', clave: 'voz:aviso:m' + miembro.id + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 6), manual: false, accion: 'voz_aviso', texto });
    } catch (e) { return { ok: false, error: e.message }; }
}
// ESCALAR = ENTREGAR LA VOZ. Idempotente: solo el primer cambio avisa (UPDATE ... WHERE no era humano).
async function entregar({ tenant, chat, motivo, avisar = true, fuente = 'seb' }) {
    const r = await run("UPDATE conversaciones SET estado_bot = 'humano', voz_gen = COALESCE(voz_gen, 0) + 1, estado_ts = ? WHERE id = ? AND COALESCE(estado_bot, 'seb') <> 'humano'", [Date.now(), Number(chat.id)]);
    const cambio = Number(r.rowsAffected) > 0;
    if (cambio) {
        try { await run('CREATE TABLE IF NOT EXISTS escalas_log (id INTEGER PRIMARY KEY AUTOINCREMENT, telefono TEXT, motivo TEXT, ts INTEGER)'); await run('INSERT INTO escalas_log (telefono, motivo, ts) VALUES (?,?,?)', [String(chat.telefono || ''), String(motivo || '').slice(0, 300), Date.now()]); } catch (e) { }
        await nota(tenant, chat, fuente === 'vendedor' ? '👤 Estás atendiendo tú (contestaste a mano). Seb no interviene hasta que le devuelvas la voz.' : '👤 Seb te entregó la voz: ' + String(motivo || '') + '. Estás atendiendo tú.');
        if (avisar) {
            const txtA = '👤 ' + nombreDe(chat) + ' necesita tu ayuda — ' + String(motivo || '').replace(/^[\s🔴🔥💰🧠]+/, '') + '\n' + linkChat(tenant.id, chat.id);
            const mDue = await miembroDelChat(chat);
            if (mDue) await avisarMiembro(tenant, mDue, txtA); else await avisarVendedor(tenant, txtA);   // chat con vendedor dueño → a SU WhatsApp
        }
    }
    const c = (await query('SELECT voz_gen FROM conversaciones WHERE id = ?', [Number(chat.id)]))[0];
    return { cambio, voz: 'humano', gen: Number(c && c.voz_gen) || 0 };
}

// DEVOLVER A SEB. Idempotente. NO manda nada: quien llama decide qué corresponde (reanudar).
async function devolver({ tenant, chat }) {
    const r = await run("UPDATE conversaciones SET estado_bot = 'seb', voz_gen = COALESCE(voz_gen, 0) + 1, estado_ts = ? WHERE id = ? AND estado_bot = 'humano'", [Date.now(), Number(chat.id)]);
    const cambio = Number(r.rowsAffected) > 0;
    if (cambio) await nota(tenant, chat, '🤖 Le devolviste la voz a Seb.');
    const c = (await query('SELECT voz_gen FROM conversaciones WHERE id = ?', [Number(chat.id)]))[0];
    return { cambio, voz: 'seb', gen: Number(c && c.voz_gen) || 0 };
}

// ¿Quedó un turno del cliente sin atender? Por IDs: el último entrante es posterior al último saliente (de Seb o del vendedor; las notas grises no cuentan).
async function turnoPendiente(chatId) {
    const r = (await query("SELECT (SELECT MAX(id) FROM mensajes WHERE conversacion_id = ? AND direccion = 'in') AS ult_in, (SELECT MAX(id) FROM mensajes WHERE conversacion_id = ? AND direccion = 'out' AND COALESCE(emisor,'') <> 'sistema') AS ult_out", [Number(chatId), Number(chatId)]))[0] || {};
    const ultIn = Number(r.ult_in) || 0, ultOut = Number(r.ult_out) || 0;
    return { pendiente: ultIn > ultOut, ult_in: ultIn, ult_out: ultOut };
}

// Mientras la voz es del vendedor, cada mensaje del cliente se le reenvía UNA vez (clave por mensaje) con el link al chat.
async function reenviarAlVendedor({ tenant, chat, msgId, texto }) {
    const clave = 'voz:fwd:' + Number(chat.id) + ':' + String(msgId || '');
    return avisarVendedor(tenant, '💬 ' + nombreDe(chat) + ': ' + String(texto || '').slice(0, 400) + '\n' + linkChat(tenant.id, chat.id), clave);
}

module.exports = { vozDe, genDe, entregar, devolver, turnoPendiente, reenviarAlVendedor, avisarVendedor, linkChat };
