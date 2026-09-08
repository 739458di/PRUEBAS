// lib/seb/canal-messenger.js — CANAL DE DISTRIBUCIÓN: MESSENGER (orden owner 2026-08-24)
// El owner saca teléfonos de Messenger y ÉL inicia el WhatsApp. Su clave literal
// "soy Sebastian de facebook" (en su 1er/2do/3er mensaje MANUAL) marca el chat:
//   · lead COMPRADOR de canal Messenger → funnel adelantado: primer contacto y
//     calificación se dan por hechos (entradas manuales, medibles por canal:
//     raw_conversations.source='messenger')
//   · auto EN FOCO según lo que ÉL nombre en sus primeros mensajes (resolver de
//     inventario, único o nada — jamás adivinar)
//   · nombre del lead SOLO si él lo dice ("Hola Juan, ... soy Sebastian de facebook")
//   · el bot NO habla en ese chat (solo lee y registra; lo entrante se escala) —
//     el candado vive en seb-panel opener_auto, patrón del candado de campaña
//   · "cita confirmada ✅" sigue entrando por su timbre de siempre (no se toca)
// Todo casillas idempotentes; el barredor del cron registra aunque el lead no
// haya contestado todavía.
const { client, query, run } = require('./db.js');
const U = require('./universo.js');   // ETAPA 2: canal/foco viven en el chat del universo
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const CLAVE = 'soy sebastian de facebook';

// ¿Este chat trae la clave en un mensaje MANUAL del owner? (pura — sirve al sandbox)
function tieneClave(mensajes) {
    return (mensajes || []).some(m => m.direccion === 'out' && !m.ai && norm(m.mensaje || m.texto).includes(CLAVE));
}

// ¿El chat lo INICIÓ el owner? (orden owner 2026-08-25, caso Mauro): si el PRIMER
// mensaje del chat es SALIENTE MANUAL (ai=0), el lead es suyo — el bot no hace
// nada hasta que se agende la cita (y de ahí sigue la máquina de citas, no el bot).
// OJO: solo ve lo que pasó por el número del bot — un mensaje desde Messenger o
// el teléfono personal del owner es invisible para el puente.
function esChatIniciadoPorOwner(mensajes) {
    const primero = (mensajes || [])[0];
    return !!(primero && primero.direccion === 'out' && !primero.ai);
}

// RESPUESTA ATÍPICA (orden owner 2026-08-25, caso Arturo): si ANTES de que nadie
// haya escrito de este lado, el lead ya te nombra ("Qué tal Sebastian") — te conoce
// porque TÚ lo contactaste por fuera (Messenger/otro canal) y tu saliente no se pudo
// leer. Eso acredita chat del owner igual. Determinista: solo mira los entrantes
// PREVIOS al primer saliente del chat.
// ¿ARRANQUE ATÍPICO? (orden owner 2026-08-25, casos Mauro/Arturo/Roy): conversación
// donde NADIE ha salido (ni bot ni owner por el puente) y el lead entra contestando
// como si YA hubieran hablado — te conoce por nombre, pura afirmación corta, o
// referencia a algo acordado. Eso NO es un lead frío de anuncio: es un lead TUYO
// cuyo primer mensaje no pasó por el puente (teléfono personal / Messenger / sync
// caído). El bot NO abre y se acredita como tuyo. (Pura — sirve al sandbox.)
function esArranqueAtipico(mensajes) {
    const ms = mensajes || [];
    if (ms.some(m => m.direccion === 'out')) return false;   // por aquí ya salió algo → normal
    const ins = ms.filter(m => m.direccion === 'in').map(m => norm(m.mensaje || m.texto)).join(' ').trim();
    if (!ins) return false;
    if (/sebastian/.test(ins)) return true;                                            // te conocen por nombre
    if (/^(si|ok|okey|va|dale|claro|perfecto|listo|de acuerdo|sale)\b.{0,12}$/.test(ins)) return true;  // pura afirmación
    if (/(aceptas cambio|en donde lo tienes|donde lo tienes|el sabado|el domingo|nos vemos|como quedamos|te marco|te marque|hablamos|quedamos en|lo que hablamos|igual y el)/.test(ins)) return true;
    return false;
}

// Marca el chat como del owner (mudo persistente) sin etiqueta de Messenger.
async function marcarOwner(telRaw) {
    const tel = String(telRaw || '').replace(/\D/g, '');
    if (!tel) return false;
    try {
        await U.guardarEstado(0, tel, { canal_si_nulo: 'owner' });
        return true;
    } catch (e) { return false; }
}

// Nombre del lead SOLO si el owner lo dijo: "Hola Juan," / "Qué tal María buenas..."
// — palabra(s) tras el saludo, antes de la clave. Sin match confiable → null.
const STOP = new Set(['soy', 'buenas', 'buenos', 'buen', 'que', 'tal', 'hola', 'como', 'estas', 'esta', 'dia', 'dias', 'tardes', 'noches', 'disculpa', 'oye', 'mucho', 'gusto', 'amigo', 'amiga', 'hermano', 'joven', 'senor', 'senora', 'don', 'dona', 'sebastian', 'de', 'facebook', 'aqui', 'te', 'me', 'mi', 'el', 'la']);
function parseNombre(texto) {
    const t = norm(texto).split(CLAVE)[0];   // solo lo ANTERIOR a la clave
    const m = t.match(/(?:hola|que tal|buenas(?: tardes| noches)?|buen dia|buenos dias|saludos)[,!.\s]+([a-zn]{2,15})(?:\s+([a-zn]{2,15}))?/);
    if (!m) return null;
    const w1 = m[1], w2 = m[2] || '';
    if (STOP.has(w1)) return null;
    const cap = w => w.charAt(0).toUpperCase() + w.slice(1);
    return cap(w1) + (w2 && !STOP.has(w2) ? ' ' + cap(w2) : '');
}

// Registro completo del lead Messenger — casillas idempotentes.
async function detectarYRegistrar(telRaw) {
    const tel = String(telRaw || '').replace(/\D/g, '');
    const out = { messenger: false, canal_ok: false, nombre: null, foco: null, funnel_pasos: 0, lead: null };
    if (!tel) return out;

    const conv = await query("SELECT id, nombre FROM conversaciones WHERE channel_thread_id = ? LIMIT 1", ['whatsapp:' + tel]);
    if (!conv.length) return out;
    const ms = await query("SELECT direccion, texto, ts, ai_generated FROM mensajes WHERE conversacion_id=? ORDER BY ts ASC, id ASC LIMIT 60", [conv[0].id]);
    const manuales = ms.filter(m => m.direccion === 'out' && !Number(m.ai_generated));
    const claveMsg = manuales.find(m => norm(m.texto).includes(CLAVE));
    if (!claveMsg) return out;
    out.messenger = true;
    const now = Date.now();

    // CASILLA 1 — el canal (marca el chat: el bot se calla con esto)
    try {
        await U.guardarEstado(0, tel, { canal: 'messenger' });
        out.canal_ok = true;
    } catch (e) { }

    // CASILLA 2 — el nombre, SOLO si el owner lo dijo (clave primero, luego sus 3 primeros manuales)
    let nombre = parseNombre(claveMsg.texto);
    if (!nombre) for (const m of manuales.slice(0, 3)) { nombre = parseNombre(m.texto); if (nombre) break; }
    if (nombre) {
        out.nombre = nombre;
        try {
            const nomAct = String(conv[0].nombre || '').trim();
            if (!nomAct || /^\+?\d[\d\s-]*$/.test(nomAct)) await run("UPDATE conversaciones SET nombre=? WHERE id=?", [nombre, conv[0].id]);
        } catch (e) { }
    }

    // CASILLA 3 — el auto EN FOCO según lo que el owner nombró (único o nada)
    try {
        const { resolverAutoCierre } = require('./citas-vivas.js');
        const { memoQuery, INV_TTL } = require('./memo.js');   // CUOTA TURSO: inventario activo cacheado 15 s
        const autosAct = (await memoQuery(INV_TTL, "SELECT id, fyradrive_web_id, marca, modelo, version, anio FROM inventario_autos WHERE estado='activo'"))
            .map(a => ({ ...a, nombre: [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' ') }));
        let auto = null;
        for (const m of manuales.slice(0, 10)) { const r = resolverAutoCierre(String(m.texto || ''), autosAct); if (r.auto) { auto = r.auto; break; } }
        if (auto) {
            const focoId = auto.fyradrive_web_id || auto.id;
            if (!(await U.autoActivoDe(0, tel))) await U.guardarEstado(0, tel, { auto_id_activo: focoId, canal_si_nulo: 'messenger' }, { activado_por: 'messenger', auto_nombre: auto.nombre });
            out.foco = auto.nombre;
        }
    } catch (e) { }

    // CASILLA 4 — el registro MEDIBLE por canal (Sales Brain, misma DB):
    // conversación con source='messenger' + funnel adelantado a calificación
    let sbConvId = null;
    try {
        const ya = await query("SELECT id FROM raw_conversations WHERE channel_thread_id = ? ORDER BY id DESC LIMIT 1", ['whatsapp:' + tel]);
        if (ya.length) { sbConvId = ya[0].id; out.lead = 'ya_existia'; }
        else {
            const nota = 'Lead de CANAL MESSENGER: el owner lo contactó por WhatsApp (teléfono sacado de Messenger).\n' +
                'Primer contacto y calificación ocurrieron en Messenger — acreditados como pasos previos.' +
                (out.foco ? '\nAuto de interés: ' + out.foco : '');
            const ins = await client.execute({
                sql: 'INSERT INTO raw_conversations (title, raw_text, cleaned_text, source, status, participant_a, participant_b, message_count, created_at, channel_thread_id, last_ingested_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                args: [(nombre || 'Lead ' + tel.slice(-10)) + ' · Messenger' + (out.foco ? ' · ' + out.foco : ''), nota, nota, 'messenger', 'cleaned', 'Sebastián', nombre || tel.slice(-10), 0, now, 'whatsapp:' + tel, now]
            });
            sbConvId = Number(ins.lastInsertRowid);
            out.lead = 'nuevo';
        }
    } catch (e) { out.lead = 'error: ' + e.message; }
    if (sbConvId) {
        for (const stage of ['primer_contacto', 'calificacion']) {
            try {
                const ya2 = await query('SELECT id FROM funnel_manual_entries WHERE conv_id = ? AND stage = ? LIMIT 1', [sbConvId, stage]);
                if (ya2.length) continue;
                await run('INSERT INTO funnel_manual_entries (conv_id, stage, quote_text, created_at) VALUES (?,?,?,?)',
                    [sbConvId, stage, 'Acreditado por CANAL MESSENGER (el owner inició el contacto)' + (out.foco ? ' — ' + out.foco : ''), now]);
                out.funnel_pasos++;
            } catch (e) { }
        }
    }
    return out;
}

// ¿Este tel ya está marcado como chat del owner? (messenger u owner → bot mudo)
async function esMessenger(telRaw) {
    const tel = String(telRaw || '').replace(/\D/g, '');
    try {
        const c = (await U.leerEstado(0, tel)).canal;
        return c === 'messenger' || c === 'owner';
    } catch (e) { return false; }
}

// EL BARREDOR (cron cada 10 min): registra leads Messenger aunque no hayan
// contestado — busca la clave en tus mensajes manuales de las últimas 48h.
async function barrerMessenger() {
    const desde = Date.now() - 48 * 3600000;
    const rows = await query(
        "SELECT DISTINCT c.telefono FROM mensajes m JOIN conversaciones c ON c.id = m.conversacion_id " +
        "WHERE m.direccion='out' AND COALESCE(m.ai_generated,0)=0 AND m.ts > ? " +
        "AND (lower(m.texto) LIKE '%soy sebastian de facebook%' OR lower(m.texto) LIKE '%soy sebastián de facebook%')", [desde]);
    let registrados = 0;
    for (const r of rows) {
        try {
            const tel = String(r.telefono || '').replace(/\D/g, '');
            const yaCanal = await esMessenger(tel);
            const reg = await detectarYRegistrar(tel);
            if (reg.messenger && (!yaCanal || reg.lead === 'nuevo' || reg.funnel_pasos > 0)) registrados++;
        } catch (e) { }
    }
    return { revisados: rows.length, registrados };
}

module.exports = { CLAVE, tieneClave, parseNombre, detectarYRegistrar, esMessenger, barrerMessenger, esChatIniciadoPorOwner, marcarOwner, esArranqueAtipico };
