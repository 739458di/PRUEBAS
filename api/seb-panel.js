// api/seb-panel.js — Backend del panel copiloto (el WhatsApp de Seb).
// GET  ?action=chats              → lista de conversaciones de COMPRADORES
// GET  ?action=chat&telefono=     → mensajes + borrador pendiente + estado
// POST {action:'sugerir', telefono}                  → corre entender+pensar y encola borrador
// POST {action:'resolver', queue_id, resolucion, texto_final} → aprueba/edita/manual + ENTRENAMIENTO
//
// Entrenamiento (medible, sin auto-mutación): cada resolución guarda borrador
// vs texto_final + similitud + intención en seb_entrenamiento. El análisis por
// lotes usa eso para afinar la biblioteca donde Seb falla.

const { query, run } = require('../lib/seb/db.js');
const { entender } = require('../lib/seb/clasificador.js');
const { pensar } = require('../lib/seb/loop.js');
const { responder: responderOpener, SENTINEL } = require('../lib/seb/opener.js');

// Similitud simple por tokens (1 = idéntico, 0 = nada en común)
function similitud(a, b) {
    const ta = new Set(String(a || '').toLowerCase().split(/\s+/).filter(Boolean));
    const tb = new Set(String(b || '').toLowerCase().split(/\s+/).filter(Boolean));
    if (ta.size === 0 && tb.size === 0) return 1;
    let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
    return Math.round((2 * inter / (ta.size + tb.size)) * 100) / 100;
}

async function telefonosDueno() {
    const rows = await query("SELECT DISTINCT dueno_telefono t FROM inventario_autos WHERE dueno_telefono IS NOT NULL");
    return new Set(rows.map(r => String(r.t).replace(/\D/g, '').slice(-10)).filter(x => x.length === 10));
}

// Convierte el "yyyy" string time de cleaned_text ("15/6/2026, 14:22:57") a epoch segundos.
function timeAEpoch(s, fallback) {
    if (!s) return fallback || 0;
    const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return fallback || 0;
    // El string "time" viene en hora de MONTERREY (UTC-6). Lo parseamos como tal —
    // no como hora del servidor (UTC) — para no correrlo 6 horas (bug del 3:55 a.m.).
    const iso = `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}T${String(m[4]).padStart(2, '0')}:${m[5]}:${String(m[6] || '0').padStart(2, '0')}-06:00`;
    const t = Math.floor(new Date(iso).getTime() / 1000);
    return isFinite(t) && t > 0 ? t : (fallback || 0);
}

// FUENTE ÚNICA: arma una conversación desde raw_conversations.cleaned_text.
// Devuelve { telefono, nombre, mensajes:[{mensaje,direccion,timestamp}] }.
// direccion: 'out' si el emisor es el vendedor (nosotros), 'in' si es el comprador.
// Maneja DOS formatos de cleaned_text:
//   nuevo: { messages:[{em,ds,t,time}], actores:[{nombre,lado,...}] }
//   viejo: [ {em,ds,t,time,_timestamp}, ... ]  (array directo, sin actores)
const VENDEDOR_COD = 'SRS010904';   // código fijo del vendedor (Sebastián)
function parseConversacion(row) {
    let data;
    try { data = JSON.parse(row.cleaned_text || '{}'); } catch (e) { data = {}; }
    const msgsRaw = Array.isArray(data) ? data : (Array.isArray(data.messages) ? data.messages : []);
    const actores = (!Array.isArray(data) && Array.isArray(data.actores)) ? data.actores : [];
    // lado del emisor: por actores, o por heurística (el vendedor es SRS010904)
    const ladoDe = (nombre) => {
        const a = actores.find(x => x.nombre === nombre);
        if (a) return a.lado;
        return nombre === VENDEDOR_COD ? 'vendedor' : 'comprador';
    };
    const comprador = actores.find(x => x.lado === 'comprador' && x.es_principal) || actores.find(x => x.lado === 'comprador');
    // nombre del comprador: de actores, o del primer emisor que no sea el vendedor
    let nombreComp = comprador ? comprador.nombre : null;
    if (!nombreComp) { const m = msgsRaw.find(x => x.em && x.em !== VENDEDOR_COD); nombreComp = m ? m.em : null; }
    if (nombreComp === '.' || nombreComp === VENDEDOR_COD) nombreComp = null;
    const fallbackTs = row.last_ingested_at ? Math.floor(Number(row.last_ingested_at) / 1000) : 0;
    const mensajes = msgsRaw.map(m => ({
        mensaje: m.t || '',
        direccion: (ladoDe(m.em) === 'vendedor') ? 'out' : 'in',
        timestamp: m._timestamp ? Math.floor(Number(m._timestamp) / 1000) : timeAEpoch(m.time, fallbackTs)
    }));
    const externalId = (row.channel_thread_id || '').split(':')[1]
        || (comprador && comprador.telefono) || '';
    return { telefono: externalId, nombre: nombreComp, mensajes };
}

// MODO PRUEBA: mapa telefono → reset_ts (ms). Solo se ven mensajes posteriores al reinicio.
async function cargarResets() {
    try {
        const r = await query("SELECT telefono, reset_ts FROM prueba_reset");
        const m = {}; r.forEach(x => { m[String(x.telefono)] = Number(x.reset_ts); }); return m;
    } catch (e) { return {}; }
}
// Filtra los mensajes de una conversación para mostrar solo los posteriores al reinicio.
function aplicarReset(c, resets) {
    const ms = resets[c.telefono];
    if (ms) c.mensajes = c.mensajes.filter(m => (m.timestamp * 1000) >= ms);
    return c;
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

        // ============ LISTA DE CHATS (solo compradores) ============
        // FASE 3 — lee de la LIBRETA NUEVA (conversaciones), ordenada por la HORA REAL
        // del último mensaje (ult_msg_ts). Orden correcto y sin duplicados.
        if (action === 'chats') {
            const duenos = await telefonosDueno();
            const rows = await query(
                "SELECT channel_thread_id, telefono, nombre, ult_texto, ult_dir, ult_msg_ts, is_dueno_chat " +
                "FROM conversaciones WHERE source='whatsapp' AND ult_msg_ts IS NOT NULL " +
                "ORDER BY ult_msg_ts DESC LIMIT 120");
            const pend = await query("SELECT telefono, COUNT(*) n FROM seb_queue WHERE estado='pendiente' GROUP BY telefono");
            const pendMap = {}; pend.forEach(p => pendMap[p.telefono] = p.n);
            const porTel = new Map();
            for (const row of rows) {
                if (row.is_dueno_chat === 1) continue;                 // chat de dueño → ocultar
                const tel = row.telefono || (row.channel_thread_id || '').split(':')[1] || '';
                if (!tel) continue;
                const tel10 = String(tel).replace(/\D/g, '').slice(-10);
                if (duenos.has(tel10)) continue;                       // dueño por teléfono → ocultar
                if (porTel.has(tel)) continue;
                porTel.set(tel, {
                    telefono: tel,
                    nombre: (row.nombre && row.nombre !== '.') ? row.nombre : ('+' + String(tel).slice(0, 3) + ' ' + String(tel).slice(-10)),
                    ult_msg: String(row.ult_texto || '').slice(0, 90),
                    ult_dir: row.ult_dir || 'in',
                    ult_ts: Math.floor(Number(row.ult_msg_ts || 0) / 1000),   // HORA REAL del último mensaje
                    pendientes: pendMap[tel] || 0
                });
                if (porTel.size >= 60) break;
            }
            return res.status(200).json({ ok: true, chats: [...porTel.values()] });
        }

        // ============ IMAGEN DEL PUNTO (para control en FyraChat) ============
        // Sirve la captura branded de punto_envio como JPEG, para que <img> la cargue.
        if (action === 'ubic_img') {
            const aid = Number(req.query.auto_id);
            if (!aid) { res.statusCode = 400; return res.end('auto_id requerido'); }
            const rows = await query("SELECT image_b64 FROM punto_envio WHERE auto_id = ?", [aid]);
            if (!rows.length || !rows[0].image_b64) { res.statusCode = 404; return res.end('sin imagen'); }
            const mm = String(rows[0].image_b64).match(/^data:(image\/[\w.+-]+);base64,([\s\S]*)$/);
            const mime = mm ? mm[1] : 'image/jpeg';
            const b64 = mm ? mm[2] : String(rows[0].image_b64).replace(/^data:[^,]+,/, '');
            const buf = Buffer.from(b64, 'base64');
            res.setHeader('Content-Type', mime);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.statusCode = 200;
            return res.end(buf);
        }

        // ============ UN CHAT COMPLETO ============
        // FASE 3 — arma los mensajes desde la LIBRETA NUEVA (mensajes), ordenados por
        // HORA REAL (ts). Cada uno trae su FOLIO (msg_id) para que el front deduplique bien.
        if (action === 'chat') {
            const tel = String(req.query.telefono || '');
            const resets = await cargarResets();
            const resetTs = Number(resets[tel] || 0);   // MODO PRUEBA: todo lo ANTERIOR a esto se ignora (lead nuevo)
            const conv = await query("SELECT id FROM conversaciones WHERE channel_thread_id = ? LIMIT 1", ['whatsapp:' + tel]);
            let mensajes = [];
            if (conv.length) {
                const rows = await query(
                    "SELECT direccion, texto, ts, msg_id, tipo FROM mensajes WHERE conversacion_id = ? ORDER BY ts ASC, id ASC",
                    [conv[0].id]);
                mensajes = rows.map(m => ({ mensaje: m.texto || '', direccion: m.direccion, timestamp: Math.floor(Number(m.ts) / 1000), msg_id: m.msg_id, tipo: m.tipo || 'text' }));
                // MODO PRUEBA: solo mensajes posteriores al reinicio
                if (resetTs) mensajes = mensajes.filter(m => (m.timestamp * 1000) >= resetTs);
            }
            const draft = await query(
                "SELECT id, borrador, intencion, creado_en FROM seb_queue WHERE telefono=? AND estado='pendiente' ORDER BY id DESC LIMIT 1",
                [tel]);
            let borrador = draft[0] || null;
            // La sugerencia se descarta si: (a) es anterior al reinicio de prueba, o
            // (b) llegó un mensaje ENTRANTE después de crearla (la conversación avanzó).
            if (borrador && resetTs && Number(borrador.creado_en) < resetTs) borrador = null;
            if (borrador && conv.length) {
                const nuevos = await query(
                    "SELECT COUNT(*) n FROM mensajes WHERE conversacion_id=? AND direccion='in' AND ts > ?",
                    [conv[0].id, Number(borrador.creado_en)]);
                if (nuevos[0] && nuevos[0].n > 0) borrador = null;
            }
            // ESTADO: si es ANTERIOR al reinicio de prueba, se ignora → arranca de 0
            // (sin enganche/plazo/auto_id/pregunta_pendiente arrastrados).
            const est = await query("SELECT estado_json, auto_id_activo, updated_at FROM wa_conversations WHERE telefono=?", [tel]);
            const estadoFresco = est[0] && Number(est[0].updated_at || 0) >= resetTs;
            return res.status(200).json({
                ok: true,
                mensajes,
                borrador,
                estado: estadoFresco ? { ...JSON.parse(est[0].estado_json || '{}'), auto_id_activo: est[0].auto_id_activo } : {}
            });
        }

        // ============ AGREGAR MENSAJE PERDIDO (manual) ============
        // Rescata a mano un mensaje que no llegó (p.ej. Bad MAC): lo inserta en la
        // conversación EN ORDEN por hora → se renderiza y Seb recupera el contexto.
        if (action === 'agregar_mensaje' && req.method === 'POST') {
            const tel = String(req.body.telefono || '').replace(/\D/g, '');
            const texto = String(req.body.texto || '').trim();
            const dir = req.body.direccion === 'out' ? 'out' : 'in';     // in = él te escribió, out = tú le escribiste
            const fecha = String(req.body.fecha || '').trim();           // YYYY-MM-DD (opcional → hoy)
            const hora = String(req.body.hora || '').trim();             // HH:MM (24h)
            if (!tel || !texto) return res.status(400).json({ ok: false, error: 'telefono y texto requeridos' });

            // epoch ms del mensaje (la hora se interpreta como Monterrey, UTC-6)
            let when = Date.now();
            if (/^\d{1,2}:\d{2}$/.test(hora)) {
                let y, mo, d;
                if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { [y, mo, d] = fecha.split('-').map(Number); }
                else { const n = new Date(Date.now() - 6 * 3600000); y = n.getUTCFullYear(); mo = n.getUTCMonth() + 1; d = n.getUTCDate(); }
                const [hh, mm] = hora.split(':').map(Number);
                const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-06:00`;
                const t = new Date(iso).getTime();
                if (isFinite(t) && t > 0) when = t;
            }
            // FASE 3 — escribe el rescate como RENGLÓN en la libreta nueva (orden automático por hora).
            const thread = 'whatsapp:' + tel;
            const conv = await query("SELECT id FROM conversaciones WHERE channel_thread_id=? LIMIT 1", [thread]);
            if (!conv.length) return res.status(404).json({ ok: false, error: 'sin_chat', motivo: 'Primero mándale un mensaje al comprador para crear el chat, luego agrega el perdido.' });
            const convId = conv[0].id;
            const folio = 'manual:' + tel + ':' + when;                   // folio sintético estable (dedup si lo agregas 2 veces)
            await run("INSERT OR IGNORE INTO mensajes (conversacion_id, msg_id, ts, direccion, emisor, texto, tipo, ai_generated, created_at) VALUES (?,?,?,?,?,?, 'text', 0, ?)",
                [convId, folio, when, dir, dir === 'out' ? VENDEDOR_COD : null, texto, Date.now()]);
            // si es el más NUEVO del chat, actualizar la portada (para la lista)
            await run(`UPDATE conversaciones SET
                  ult_texto = CASE WHEN ? >= ult_msg_ts THEN ? ELSE ult_texto END,
                  ult_dir   = CASE WHEN ? >= ult_msg_ts THEN ? ELSE ult_dir END,
                  ult_msg_ts = MAX(?, ult_msg_ts)
                WHERE id=?`, [when, texto.slice(0, 120), when, dir, when, convId]);
            return res.status(200).json({ ok: true, timestamp: Math.floor(when / 1000), direccion: dir });
        }

        // ============ OPENER AUTO (autopilot del PRIMER mensaje) ============
        // El bridge llama aquí cuando llega un primer contacto. Decide si aplica
        // (comprador, primer contacto, auto resuelto, no vendedor) y devuelve la
        // RÁFAGA del playbook. NO crea sugerencia pendiente: es para enviar solo.
        if (action === 'opener_auto' && req.method === 'POST') {
            const tel = String(req.body.telefono || '');
            if (!tel) return res.status(400).json({ ok: false, error: 'telefono requerido' });
            // Dueño/vendedor por teléfono → nunca autopilot.
            const duenos = await telefonosDueno();
            if (duenos.has(tel.replace(/\D/g, '').slice(-10))) return res.status(200).json({ ok: false, motivo: 'dueno' });

            const convRow = await query("SELECT id, nombre FROM conversaciones WHERE channel_thread_id = ? LIMIT 1", ['whatsapp:' + tel]);
            const convId = convRow.length ? convRow[0].id : null;
            const nombreChat = convRow.length ? convRow[0].nombre : null;
            // MODO PRUEBA: respeta el reinicio — todo lo ANTERIOR al reset se ignora, así
            // un número de prueba que contesta un anuncio cuenta como PRIMER CONTACTO fresco.
            const resetsOA = await cargarResets();
            const resetTsOA = Number(resetsOA[tel] || 0);
            let mensajes = [];
            if (convId) {
                const mr = await query("SELECT direccion, texto, ts FROM mensajes WHERE conversacion_id=? ORDER BY ts ASC, id ASC", [convId]);
                let rows = mr.map(m => ({ mensaje: m.texto || '', direccion: m.direccion, ts: Number(m.ts) }));
                if (resetTsOA) rows = rows.filter(m => m.ts >= resetTsOA);
                mensajes = rows;
            }
            // PRIMER CONTACTO: si ya hay un saliente nuestro, NO autopilot (lo maneja el flujo manual).
            if (mensajes.some(m => m.direccion === 'out')) return res.status(200).json({ ok: false, motivo: 'no_primer_contacto' });
            const entrantes = mensajes.filter(m => m.direccion === 'in');
            if (!entrantes.length) return res.status(200).json({ ok: false, motivo: 'sin_entrantes' });

            const lastMsg = entrantes[entrantes.length - 1].mensaje;
            const textoFamilia = entrantes.map(e => e.mensaje).join(' ');   // junta la ráfaga del comprador (combo info+crédito en mensajes separados)
            const historial = mensajes.slice(-8).map(h => ({ direccion: h.direccion, mensaje: h.mensaje }));
            let mensajeCerebro = lastMsg;
            try {
                const adRow = await query("SELECT ad_context FROM ad_por_telefono WHERE telefono=?", [tel]);
                if (adRow[0] && adRow[0].ad_context) mensajeCerebro = '[DESC: ' + adRow[0].ad_context + ']\n' + lastMsg;
            } catch (e) { /* sin anuncio */ }

            const clasif = await entender({ mensaje: mensajeCerebro, historial, estado: {} });
            const op = await responderOpener({
                texto: textoFamilia, nombre: nombreChat,
                auto_id: clasif.auto_id, intencion: clasif.intencion_principal
            });
            if (!op || !op.segmentos || !op.segmentos.length) return res.status(200).json({ ok: false, motivo: 'no_aplica' });
            return res.status(200).json({ ok: true, segmentos: op.segmentos, tipo: op.tipo });
        }

        // ============ SUGERIR (corre el cerebro on-demand) ============
        // FUENTE ÚNICA: el cerebro también lee de raw_conversations.
        if (action === 'sugerir' && req.method === 'POST') {
            const tel = String(req.body.telefono || '');
            // FASE 3 — el cerebro también lee de la LIBRETA NUEVA (mensajes), limpio y ordenado.
            const convRow = await query("SELECT id, nombre FROM conversaciones WHERE channel_thread_id = ? LIMIT 1", ['whatsapp:' + tel]);
            const convId = convRow.length ? convRow[0].id : null;
            const nombreChat = convRow.length ? convRow[0].nombre : null;
            const resets = await cargarResets();
            let conv = { mensajes: [] };
            if (convId) {
                const mr = await query("SELECT direccion, texto, ts, msg_id FROM mensajes WHERE conversacion_id=? ORDER BY ts ASC, id ASC", [convId]);
                let msgs = mr.map(m => ({ mensaje: m.texto || '', direccion: m.direccion, timestamp: Math.floor(Number(m.ts) / 1000), msg_id: m.msg_id }));
                const ms = resets[tel];
                if (ms) msgs = msgs.filter(m => (m.timestamp * 1000) >= ms);
                conv = { mensajes: msgs };
            }
            const entrantes = conv.mensajes.filter(m => m.direccion === 'in');
            // BUG 9: usar el texto EXACTO que el front ya tiene en pantalla (evita el lag de ingesta).
            const ultimoInBody = String((req.body && req.body.ultimo_in) || '').trim();
            // "RESPONDER A": el front puede mandar un mensaje OBJETIVO específico del cliente
            // (por folio msg_id, o por texto). Seb clasifica y responde a ESE, no al último.
            const objetivoMid = String((req.body && req.body.objetivo_msgid) || '').trim();
            const objetivoTxt = String((req.body && req.body.objetivo) || '').trim();
            if (entrantes.length === 0 && !ultimoInBody && !objetivoTxt) return res.status(400).json({ error: 'sin mensajes entrantes' });

            let lastMsg, historial;
            let idxObj = -1;
            if (objetivoMid) idxObj = conv.mensajes.findIndex(m => m.msg_id === objetivoMid);
            if (idxObj < 0 && objetivoTxt) idxObj = conv.mensajes.map(m => m.mensaje).lastIndexOf(objetivoTxt);
            if (idxObj >= 0) {
                // Objetivo = ese mensaje. Si es del CLIENTE (in) = "responder a" (incluirlo de
                // contexto). Si es TUYO (out) = INSTRUCCIÓN a ejecutar (cita/cotizar/etc.): NO lo
                // metas al historial, es el mensaje a procesar.
                const obj = conv.mensajes[idxObj];
                lastMsg = obj.mensaje;
                const fin = obj.direccion === 'out' ? idxObj : idxObj + 1;
                historial = conv.mensajes.slice(Math.max(0, idxObj - 7), fin).map(h => ({ direccion: h.direccion, mensaje: h.mensaje }));
            } else if (objetivoTxt) {
                // El objetivo no se encontró en la libreta (raro) → úsalo directo.
                lastMsg = objetivoTxt;
                historial = conv.mensajes.slice(-8).map(h => ({ direccion: h.direccion, mensaje: h.mensaje }));
            } else {
                // NORMAL (sin selección): el último mensaje entrante, como siempre.
                lastMsg = ultimoInBody || entrantes[entrantes.length - 1].mensaje;
                historial = conv.mensajes.slice(-8).map(h => ({ direccion: h.direccion, mensaje: h.mensaje }));
            }
            // dedupe_key estable por conversación → una sola sugerencia "viva" por chat.
            const dedupe = tel + ':' + (convId || 'x');
            const resetTs = Number(resets[tel] || 0);
            const convEstado = await query("SELECT estado_json, auto_id_activo, updated_at FROM wa_conversations WHERE telefono=?", [tel]);
            // MODO PRUEBA: si el estado es ANTERIOR al reinicio (contestaste un anuncio nuevo),
            // se IGNORA → lead nuevo de 0 (sin enganche/plazo/auto_id/pregunta arrastrados).
            const estado = (convEstado[0] && Number(convEstado[0].updated_at || 0) >= resetTs)
                ? { ...JSON.parse(convEstado[0].estado_json || '{}'), auto_id_activo: convEstado[0].auto_id_activo }
                : {};

            // Meter el AUTO DEL ANUNCIO a la mochila: si el comprador vino de un anuncio,
            // se lo pasamos al cerebro como bloque [DESC:] para que resuelva el auto correcto.
            let mensajeCerebro = lastMsg;
            try {
                const adRow = await query("SELECT ad_context FROM ad_por_telefono WHERE telefono=?", [tel]);
                if (adRow[0] && adRow[0].ad_context) mensajeCerebro = '[DESC: ' + adRow[0].ad_context + ']\n' + lastMsg;
            } catch (e) { /* tabla aún no existe → sin anuncio */ }

            const clasif = await entender({ mensaje: mensajeCerebro, historial, estado });

            // ===== MENSAJE INICIAL → BANCO DE FRASES (fuente única de verdad) =====
            // Si Seb AÚN NO ha respondido en esta conversación (post-reset) y NO es un
            // "responder a/ejecutar", el opener lo arma el BANCO como SECUENCIA de
            // mensajes exactos (no el loop de IA). El front la parte para enviarlos uno
            // por uno. ubicacion/credito/sin-auto → null → cae al loop normal.
            const esOpener = !conv.mensajes.some(m => m.direccion === 'out') && !objetivoTxt && !objetivoMid;
            let r = null;
            if (esOpener) {
                try {
                    const op = await responderOpener({
                        texto: lastMsg, nombre: nombreChat,
                        auto_id: clasif.auto_id, intencion: clasif.intencion_principal
                    });
                    if (op && op.segmentos && op.segmentos.length) {
                        r = {
                            ok: true,
                            borrador: op.segmentos.join('\n' + SENTINEL + '\n'),
                            tools_usadas: [],
                            estado_nuevo: { ...estado, auto_id_activo: clasif.auto_id || estado.auto_id_activo || null }
                        };
                    }
                } catch (e) { /* si el banco falla, cae al loop normal */ }
            }

            if (!r) {
                r = await pensar({ telefono: tel, mensaje: lastMsg, clasificacion: clasif, estado });
            }
            if (!r.ok) {
                return res.status(200).json({ ok: false, escalar: true, motivo: r.motivo, intencion: clasif.intencion_principal });
            }
            // UPSERT: si ya existe esa dedupe_key (de un intento previo resuelto), la
            // REGENERA en vez de tronar con UNIQUE constraint.
            await run(
                `INSERT INTO seb_queue (telefono, borrador, estado, intencion, tools_usadas, dedupe_key, creado_en)
                 VALUES (?, ?, 'pendiente', ?, ?, ?, ?)
                 ON CONFLICT(dedupe_key) DO UPDATE SET borrador=excluded.borrador, estado='pendiente',
                   intencion=excluded.intencion, tools_usadas=excluded.tools_usadas, creado_en=excluded.creado_en`,
                [tel, r.borrador, clasif.intencion_principal,
                 JSON.stringify({ tools: r.tools_usadas.map(t => t.tool), estado_nuevo: r.estado_nuevo, auto_id: clasif.auto_id }),
                 dedupe, Date.now()]);
            // Limpieza: descarta cualquier OTRA sugerencia pendiente vieja de este chat
            // (acumuladas con dedupe_keys distintos) — solo vive la recién creada.
            await run("UPDATE seb_queue SET estado='descartado' WHERE telefono=? AND estado='pendiente' AND dedupe_key<>?", [tel, dedupe]);
            const qrow = await query("SELECT id FROM seb_queue WHERE dedupe_key=?", [dedupe]);
            return res.status(200).json({ ok: true, queue_id: qrow[0] ? qrow[0].id : null, borrador: r.borrador, intencion: clasif.intencion_principal });
        }

        // ============ RESOLVER (aprobar / editar / manual) + ENTRENAMIENTO ============
        if (action === 'resolver' && req.method === 'POST') {
            const { queue_id, resolucion, texto_final } = req.body;
            if (!queue_id || !['aprobado', 'editado', 'manual'].includes(resolucion)) {
                return res.status(400).json({ error: 'queue_id y resolucion válida requeridos' });
            }
            const q = await query("SELECT * FROM seb_queue WHERE id=?", [Number(queue_id)]);
            if (!q.length) return res.status(404).json({ error: 'no existe' });
            const item = q[0];
            const meta = JSON.parse(item.tools_usadas || '{}');
            // SE ENVÍA SIEMPRE lo que está en el textarea (texto_final) — sea editado o no.
            // Antes 'aprobado' mandaba item.borrador (el BASE) e ignoraba tu edición →
            // salía el base y la burbuja optimista mostraba el editado (doble + equivocado).
            // El tipo (aprobado/editado) es solo etiqueta de entrenamiento, NO decide el texto.
            const final = String((texto_final != null && String(texto_final).trim()) ? texto_final : item.borrador || '');
            if (!final.trim()) return res.status(400).json({ error: 'texto_final vacío' });

            // 0) CANDADO ATÓMICO anti doble-envío: solo UNA llamada gana el derecho
            //    a enviar este queue_id. Permite reintentar un envío FALLIDO
            //    ('aprobado_sin_enviar'), pero NUNCA re-enviar uno ya 'enviado'.
            //    (Sin esto, "Enviar"+"Enviar editado" o un reintento de red mandaban doble.)
            const claim = await run(
                "UPDATE seb_queue SET estado='enviando' WHERE id=? AND estado IN ('pendiente','aprobado_sin_enviar')",
                [Number(queue_id)]);
            if (!claim.rowsAffected) {
                // Ya se resolvió/envió antes. NO reportar enviado:true (causaba PÉRDIDA
                // SILENCIOSA si el front reusaba un QID viejo: la burbuja quedaba con ✓✓
                // pero nada se mandaba). enviado:false → el front quita la burbuja y avisa.
                return res.status(200).json({ ok: true, enviado: false, ya_enviado: true, error_envio: 'esa sugerencia ya se había enviado (escríbelo de nuevo y se manda directo)' });
            }

            // 1) ENTRENAMIENTO: registrar la decisión humana (la materia prima del lote)
            const sim = similitud(item.borrador, final); // exacta: 1 si no se editó, <1 si sí
            await run(
                `INSERT INTO seb_entrenamiento (queue_id, telefono, intencion, auto_id, borrador, texto_final, accion, similitud, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [item.id, item.telefono, item.intencion, meta.auto_id || null, item.borrador, final, resolucion, sim, Date.now()]);

            // 2) Persistir estado nuevo de la conversación
            if (meta.estado_nuevo) {
                const upd = await run("UPDATE wa_conversations SET estado_json=?, auto_id_activo=?, updated_at=? WHERE telefono=?",
                    [JSON.stringify(meta.estado_nuevo), meta.estado_nuevo.auto_id_activo || null, Date.now(), item.telefono]);
                if (!upd.rowsAffected) {
                    await run("INSERT INTO wa_conversations (telefono, estado, platform, estado_json, auto_id_activo, updated_at) VALUES (?, 'seb', 'whatsapp', ?, ?, ?)",
                        [item.telefono, JSON.stringify(meta.estado_nuevo), meta.estado_nuevo.auto_id_activo || null, Date.now()]);
                }
            }

            // 3) Intentar envío por el bridge (si está configurado y vivo)
            let enviado = false, error_envio = null;
            const bridgeUrl = process.env.BRIDGE_SEND_URL, bridgeKey = process.env.BRIDGE_API_KEY;
            // PAQUETE DE UBICACIÓN: si la sugerencia usó la herramienta ubicacion, adjunta la
            // captura branded + el pin guardados (punto_envio del auto). El bridge los manda
            // junto con el texto formal. Si no hay paquete, va solo el texto.
            let extra = {};
            try {
                if (meta.tools && meta.tools.includes('ubicacion') && meta.auto_id) {
                    const pe = await query("SELECT image_b64, name, lat, lng, maps_link FROM punto_envio WHERE auto_id = ?", [Number(meta.auto_id)]);
                    if (pe[0]) {
                        if (pe[0].image_b64) extra.image = pe[0].image_b64;
                        if (pe[0].lat != null && pe[0].lng != null) extra.location = { lat: pe[0].lat, lng: pe[0].lng, name: pe[0].name || null, maps_link: pe[0].maps_link || null };
                    }
                }
            } catch (e) { /* sin paquete → solo texto */ }
            if (bridgeUrl && bridgeKey) {
                try {
                    let phone = String(item.telefono).replace(/\D/g, '');
                    if (phone.length === 10) phone = '521' + phone;
                    const r = await fetch(bridgeUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': bridgeKey },
                        body: JSON.stringify({ phone, text: final, ...extra })
                    });
                    const d = await r.json().catch(() => ({}));
                    enviado = r.ok && d.ok !== false;
                    if (!enviado) error_envio = d.error || ('bridge ' + r.status);
                } catch (e) { error_envio = e.message; }
            } else { error_envio = 'bridge no configurado (BRIDGE_SEND_URL/BRIDGE_API_KEY)'; }

            // 4) El saliente ya llega a raw_conversations vía el bridge (/api/send → SALES-BRAIN).
            //    Fuente única: NO se escribe wa_messages aquí.
            await run("UPDATE seb_queue SET estado=?, texto_final=?, resuelto_en=? WHERE id=?",
                [enviado ? 'enviado' : 'aprobado_sin_enviar', final, Date.now(), item.id]);

            // 5) CONTROL: si fue paquete de ubicación, deja en FyraChat la CAPTURA + el PIN
            //    renderizables (no como "[imagen]"). La imagen se sirve por action=ubic_img.
            if (enviado && meta.auto_id && (extra.image || extra.location)) {
                try {
                    const cr = await query("SELECT id FROM conversaciones WHERE channel_thread_id = ? LIMIT 1", ['whatsapp:' + String(item.telefono)]);
                    const cid = cr.length ? cr[0].id : null;
                    if (cid) {
                        const t0 = Date.now();
                        if (extra.image) {
                            await run("INSERT OR IGNORE INTO mensajes (conversacion_id, msg_id, ts, direccion, emisor, texto, tipo, ai_generated, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                                [cid, 'pkgimg:' + item.id, t0, 'out', 'SRS010904', 'ubic-img:' + meta.auto_id, 'image', 1, t0]);
                        }
                        if (extra.location) {
                            const L = extra.location;
                            const txt = [L.name || '', L.lat, L.lng, L.maps_link || ''].join('|||');
                            await run("INSERT OR IGNORE INTO mensajes (conversacion_id, msg_id, ts, direccion, emisor, texto, tipo, ai_generated, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                                [cid, 'pkgloc:' + item.id, t0 + 1, 'out', 'SRS010904', txt, 'location', 1, t0 + 1]);
                        }
                    }
                } catch (e) { /* control no crítico */ }
            }

            return res.status(200).json({ ok: true, enviado, error_envio, similitud: sim });
        }

        // ============ MANUAL DIRECTO (escribes sin borrador pendiente) ============
        if (action === 'manual_directo' && req.method === 'POST') {
            const tel = String(req.body.telefono || '');
            const texto = String(req.body.texto || '').trim();
            // consume_qid: en una SECUENCIA del banco, el PRIMER mensaje "consume" la
            // sugerencia encolada (marca enviado + avanza estado), sin re-enviar nada.
            const consumeQid = Number(req.body.consume_qid || 0) || null;
            if (!tel || !texto) return res.status(400).json({ error: 'telefono y texto requeridos' });
            let enviado = false, error_envio = null;
            const bridgeUrl = process.env.BRIDGE_SEND_URL, bridgeKey = process.env.BRIDGE_API_KEY;
            if (bridgeUrl && bridgeKey) {
                try {
                    let phone = tel.replace(/\D/g, '');
                    if (phone.length === 10) phone = '521' + phone;
                    const r = await fetch(bridgeUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': bridgeKey },
                        body: JSON.stringify({ phone, text: texto })
                    });
                    const d = await r.json().catch(() => ({}));
                    enviado = r.ok && d.ok !== false;
                    if (!enviado) error_envio = d.error || ('bridge ' + r.status);
                } catch (e) { error_envio = e.message; }
            } else { error_envio = 'bridge no configurado'; }

            // CONSUMIR la sugerencia de secuencia UNA sola vez (atómico: WHERE estado='pendiente').
            // No re-envía: solo marca 'enviado', avanza el estado de la conversación y deja
            // rastro de entrenamiento. Así el pendiente no queda colgado tras enviar el opener.
            if (consumeQid && enviado) {
                try {
                    const claim = await run("UPDATE seb_queue SET estado='enviado', resuelto_en=? WHERE id=? AND estado='pendiente'", [Date.now(), consumeQid]);
                    if (claim.rowsAffected) {
                        const q = await query("SELECT * FROM seb_queue WHERE id=?", [consumeQid]);
                        if (q.length) {
                            const meta = JSON.parse(q[0].tools_usadas || '{}');
                            if (meta.estado_nuevo) {
                                const upd = await run("UPDATE wa_conversations SET estado_json=?, auto_id_activo=?, updated_at=? WHERE telefono=?",
                                    [JSON.stringify(meta.estado_nuevo), meta.estado_nuevo.auto_id_activo || null, Date.now(), q[0].telefono]);
                                if (!upd.rowsAffected) await run("INSERT INTO wa_conversations (telefono, estado, platform, estado_json, auto_id_activo, updated_at) VALUES (?, 'seb', 'whatsapp', ?, ?, ?)",
                                    [q[0].telefono, JSON.stringify(meta.estado_nuevo), meta.estado_nuevo.auto_id_activo || null, Date.now()]);
                            }
                            await run("INSERT INTO seb_entrenamiento (queue_id, telefono, intencion, auto_id, borrador, texto_final, accion, similitud, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                                [q[0].id, q[0].telefono, q[0].intencion, meta.auto_id || null, q[0].borrador, texto, 'secuencia', 0, Date.now()]);
                        }
                    }
                } catch (e) { /* consumo no crítico */ }
            }
            // Fuente única: el saliente llega a raw_conversations vía el bridge, no se escribe wa_messages.
            return res.status(200).json({ ok: true, enviado, error_envio });
        }

        return res.status(400).json({ error: 'action inválida' });
    } catch (err) {
        console.error('[SEB-PANEL]', err);
        return res.status(500).json({ error: err.message });
    }
};
