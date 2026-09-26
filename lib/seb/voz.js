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
    // Va DIRECTO al puente (enviarWA con origen 'sb'): un aviso no es un chat delegado, así que no pasa por la puerta de mensajes ni deja chat.
    try {
        const DEMO = require('./demo.js'); if (DEMO.esDemo(tenant)) return { ok: true, simulado: true };
        const telV = String(tenant.telefono || '').replace(/\D/g, ''); if (telV.length < 12) return { ok: false, error: 'el universo no tiene WhatsApp de vendedor' };
        await chatDeAvisos(tenant, telV, 'Avisos');
        const { enviarWA } = require('./citas-vivas.js');
        return await enviarWA(telV, texto, Number(tenant.id), 'sb');
    } catch (e) { return { ok: false, error: e.message }; }
}

/** El chat de AVISOS con un vendedor nace ANTES de mandar y queda marcado canal='avisos': el puente lo actualiza al enviar, pero el inbox lo excluye (jamás aparece como "chat" del lote). */
async function chatDeAvisos(tenant, tel, nombre) {
    try {
        const U = require('./universo.js');
        const ch = await U.chatDe(Number(tenant.id), tel, { crear: true, visible: false, nombre });
        if (ch && ch.id) await run("UPDATE conversaciones SET canal = 'avisos', nombre = COALESCE(nombre, ?) WHERE id = ?", [nombre, Number(ch.id)]);
        return ch;
    } catch (e) { return null; }
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
    // Aviso al WhatsApp PERSONAL del miembro desde el número del lote, directo al puente (sin chat ni delegación).
    try {
        const DEMO = require('./demo.js'); if (DEMO.esDemo(tenant)) return { ok: true, simulado: true };
        const telM = String(miembro.telefono || '').replace(/\D/g, ''); if (telM.length < 12) return { ok: false, error: 'miembro sin WhatsApp' };
        await chatDeAvisos(tenant, telM, 'Avisos · ' + String(miembro.nombre || '').split(/\s+/)[0]);
        const { enviarWA } = require('./citas-vivas.js');
        const r = await enviarWA(telM, texto, Number(tenant.id), 'sb');
        if (!r || !r.ok) console.error('[voz aviso miembro]', miembro.id, r && r.error);
        return r;
    } catch (e) { return { ok: false, error: e.message }; }
}
// ESCALAR = ENTREGAR LA VOZ. Idempotente: solo el primer cambio avisa (UPDATE ... WHERE no era humano).
async function entregar({ tenant, chat, motivo, avisar = true, fuente = 'seb', miembro = null }) {
    // RECLAMO: si un vendedor (miembro) contesta un chat que no tenía dueño, el chat pasa a ser suyo (las escaladas siguientes le llegan a él)
    if (fuente === 'vendedor' && miembro && miembro.id) { try { await run('UPDATE conversaciones SET miembro_id = ? WHERE id = ? AND miembro_id IS NULL', [Number(miembro.id), Number(chat.id)]); } catch (e) { } }
    const r = await run("UPDATE conversaciones SET estado_bot = 'humano', voz_gen = COALESCE(voz_gen, 0) + 1, estado_ts = ? WHERE id = ? AND COALESCE(estado_bot, 'seb') <> 'humano'", [Date.now(), Number(chat.id)]);
    const cambio = Number(r.rowsAffected) > 0;
    if (cambio) {
        try { await run('CREATE TABLE IF NOT EXISTS escalas_log (id INTEGER PRIMARY KEY AUTOINCREMENT, telefono TEXT, motivo TEXT, ts INTEGER)'); await run('INSERT INTO escalas_log (telefono, motivo, ts) VALUES (?,?,?)', [String(chat.telefono || ''), String(motivo || '').slice(0, 300), Date.now()]); } catch (e) { }
        await nota(tenant, chat, fuente === 'vendedor' ? '👤 Estás atendiendo tú (contestaste a mano). Seb no interviene hasta que le devuelvas la voz.' : '👤 Seb te entregó la voz: ' + String(motivo || '') + '. Estás atendiendo tú.');
        if (avisar) {
            let tresP = false; try { const cfT = tenant.config || JSON.parse(tenant.config_json || '{}'); tresP = Number(cfT.tres_partes) === 1; } catch (e) { }
            const txtA = '👤 ' + nombreDe(chat) + ' necesita tu ayuda — ' + String(motivo || '').replace(/^[\s🔴🔥💰🧠]+/, '') + '\n' + linkChat(tenant.id, chat.id) + (tresP ? '\nPuedes contestarle directo desde tu WhatsApp; cuando ya no lo necesites, pícale "Devolver a Seb" en su chat de FyraChat.' : '');
            // HUMAN-ON-THE-LOOP (orden owner 2026-09-23): el aviso va al WhatsApp PERSONAL del vendedor responsable; si el chat no tiene
            // vendedor, a TODOS los vendedores activos del lote (el primero que conteste se lo queda); sin vendedores → al número del lote.
            // ORDEN OWNER 2026-09-24: cada escalada va a SU responsable. Chat con vendedor → su WhatsApp personal.
            // Chat sin vendedor → el responsable es el WhatsApp vinculado del lote (nada de avisar a todos los vendedores).
            const mDue = await miembroDelChat(chat);
            if (mDue) await avisarMiembro(tenant, mDue, txtA);
            else await avisarVendedor(tenant, txtA);
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
