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
const { responder: responderOpener, SENTINEL, necesitaCerebro } = require('../lib/seb/opener.js');
const { responderCont } = require('../lib/seb/continuacion.js');
// ══ CITAS VIVAS (WhatsApp REAL) — el MISMO cerebro del sandbox (lib/seb/citas-vivas.js):
// dueño responde → IA interpreta → match/contrapropuesta; comprador en match →
// cancelación/en-camino; señal manual del owner; recordatorios via cron.
const citasVivas = require('../lib/seb/citas-vivas.js');
// 🚩fyrachat#7: al confirmarse una cita, la fecha/hora del CERRADOR quedan como
// CANÓNICAS (deterministas, sin IA) — el cita-extractor las usa tal cual.
// ══ BITÁCORA DE ESCALADAS (opción A del owner, 2026-07-13): las escaladas de
// CRITERIO abren la puerta a que su primer manual tome posesión (ver doctrina).
// ══ APARADOR DE CARRUSEL (orden owner 2026-07-20) — la lógica vive en la FUENTE
// ÚNICA lib/seb/aparador.js (el sandbox usa LA MISMA): aquí solo se importa.
const { intentarEleccionAparador, arranqueCarrusel, opcionesEnFlujo } = require('../lib/seb/aparador.js');

async function logEscala(tel, motivo) {
    try {
        await run("CREATE TABLE IF NOT EXISTS escalas_log (id INTEGER PRIMARY KEY AUTOINCREMENT, telefono TEXT, motivo TEXT, ts INTEGER)");
        await run("INSERT INTO escalas_log (telefono, motivo, ts) VALUES (?,?,?)", [String(tel), String(motivo || ''), Date.now()]);
    } catch (e) { }
}

async function regCanonica(tel, r) {
    try {
        if (r && r.cita_confirmada && r.cita_datos) {
            await citasVivas.registrarCitaCanonica({ telefono: tel, fecha: r.cita_datos.fecha, hora: r.cita_datos.hora, lugar: r.cita_datos.lugar || null });
        }
    } catch (e) { console.error('[canonica]', e.message); }
}

// Similitud simple por tokens (1 = idéntico, 0 = nada en común)
function similitud(a, b) {
    const ta = new Set(String(a || '').toLowerCase().split(/\s+/).filter(Boolean));
    const tb = new Set(String(b || '').toLowerCase().split(/\s+/).filter(Boolean));
    if (ta.size === 0 && tb.size === 0) return 1;
    let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
    return Math.round((2 * inter / (ta.size + tb.size)) * 100) / 100;
}

// 🚩fyrachat#5: el borrador del CEREBRO sale EN RÁFAGA (burbujas cortas, estilo del
// owner), no en un solo bloque. Se parte por SENTINEL y por líneas en blanco; las
// tarjetas (multilínea con saltos simples) se conservan enteras.
function partirRafaga(borrador) {
    return String(borrador || '')
        .split(/\|\|SEQ\|\||\n\s*\n/)
        .map(x => x.trim())
        .filter(Boolean);
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

        // ══════════ 🚩 BANDERITAS EN FYRACHAT (training sobre mensajes REALES) ══════════
        // El owner marca cualquier burbuja → queda en fyrachat_flags con el contexto de la
        // conversación; "procesa el training" las lee junto con las del sandbox y la retro.
        if (action === 'flag_msg' && req.method === 'POST') {
            const tel = String(req.body.telefono || '').trim();
            const texto = String(req.body.texto || '').slice(0, 1500);
            if (!tel || !texto) return res.status(400).json({ ok: false, error: 'telefono y texto requeridos' });
            await run(`CREATE TABLE IF NOT EXISTS fyrachat_flags (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, telefono TEXT, nombre TEXT,
                direccion TEXT, texto TEXT, nota TEXT, contexto TEXT, procesado INTEGER DEFAULT 0)`);
            let nombre = null, ctx = [];
            try {
                const cRow = await query("SELECT id, nombre FROM conversaciones WHERE channel_thread_id=? LIMIT 1", ['whatsapp:' + tel]);
                if (cRow.length) {
                    nombre = cRow[0].nombre || null;
                    const ms = await query("SELECT direccion, texto FROM mensajes WHERE conversacion_id=? ORDER BY ts DESC, id DESC LIMIT 12", [cRow[0].id]);
                    ctx = ms.reverse().map(m => ({ d: m.direccion, t: String(m.texto || '').slice(0, 200) }));
                }
            } catch (e) { }
            const ins = await run("INSERT INTO fyrachat_flags (ts, telefono, nombre, direccion, texto, nota, contexto) VALUES (?,?,?,?,?,?,?)",
                [Date.now(), tel, nombre, String(req.body.direccion || ''), texto, String(req.body.nota || '').slice(0, 500), JSON.stringify(ctx)]);
            return res.status(200).json({ ok: true, id: Number(ins.lastInsertRowid) || null });
        }
        if (action === 'flags_msgs') {
            await run(`CREATE TABLE IF NOT EXISTS fyrachat_flags (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, telefono TEXT, nombre TEXT,
                direccion TEXT, texto TEXT, nota TEXT, contexto TEXT, procesado INTEGER DEFAULT 0)`).catch(() => {});
            const fl = await query("SELECT * FROM fyrachat_flags WHERE procesado=0 ORDER BY id ASC").catch(() => []);
            return res.status(200).json({ ok: true, flags: fl });
        }
        if (action === 'flags_msgs_done' && req.method === 'POST') {
            const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(n => n > 0);
            if (ids.length) await run("UPDATE fyrachat_flags SET procesado=1 WHERE id IN (" + ids.join(',') + ")");
            return res.status(200).json({ ok: true, n: ids.length });
        }

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

        // ============ GHOST SCAN (etapa 3 · toque de 3 horas) ============
        // El bridge llama aquí cada ~15 min. Devuelve los recordatorios de ghosting
        // que tocan AHORA (con todos los candados adentro de ghosting.js) + la lista
        // para el personal del owner. dry=1 → solo muestra, no registra ni envía.
        if (action === 'ghost_scan' && req.method === 'POST') {
            const { ghostScan } = require('../lib/seb/ghosting.js');
            const duenos = await telefonosDueno();
            const r = await ghostScan({ duenos, dry: !!(req.body && req.body.dry) });
            return res.status(200).json({ ok: true, ...r });
        }

        // ============ CIERRE TIMBRE (lógica del timbre, orden owner 2026-07-16) ============
        // El puente VPS toca aquí EN EL INSTANTE en que el owner manda "cita confirmada ✅"
        // a un comprador. Misma puerta que el barredor del cron (ejecutarCierre es
        // idempotente): el timbre da la velocidad, el cron la garantía.
        if (action === 'cierre_timbre' && req.method === 'POST') {
            if (String(req.body.key || '') !== (process.env.SELLER_BRIDGE_KEY || 'fyra-bridge-v2-2026')) {
                return res.status(401).json({ ok: false, error: 'key invalida' });
            }
            const telT = String(req.body.telefono || '');
            const textoT = String(req.body.texto || '');
            if (!telT || !textoT) return res.status(400).json({ ok: false, error: 'telefono y texto requeridos' });
            const rT = await citasVivas.ejecutarCierre({ tel: telT, texto: textoT, ts: Number(req.body.ts) || Date.now(), origen: 'timbre' });
            return res.status(200).json(rT);
        }

        // ============ CANCELAR MATCH MANUAL (orden owner 2026-07-18) ============
        // El botón ✕ del Calendar entra por LA MISMA máquina que la cancelación por
        // WhatsApp del comprador (ejecutarCancelacion): marca la fila y le avisa al
        // DUEÑO con el mismo texto. Distinto timbre, mismo funcionamiento.
        if (action === 'cancelar_match_manual' && req.method === 'POST') {
            if (String(req.body.key || '') !== (process.env.SELLER_BRIDGE_KEY || 'fyra-bridge-v2-2026')) {
                return res.status(401).json({ ok: false, error: 'key invalida' });
            }
            const telCM = String(req.body.telefono || '').replace(/\D/g, '').slice(-10);
            if (!telCM) return res.status(400).json({ ok: false, error: 'telefono requerido' });
            const filas = await query("SELECT * FROM citas_match WHERE estado IN ('solicitud','contrapropuesta','esperando_horario','match') ORDER BY updated DESC");
            const MCM = filas.find(r => String(r.comprador_tel || '').replace(/\D/g, '').slice(-10) === telCM);
            if (!MCM) return res.status(200).json({ ok: true, avisado: false, motivo: 'sin fila activa de match' });
            await citasVivas.ejecutarCancelacion(MCM);
            return res.status(200).json({ ok: true, avisado: true, match_id: MCM.id });
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
            if (duenos.has(tel.replace(/\D/g, '').slice(-10))) {
                // ══ LADO VENDEDOR REAL: si este dueño tiene una SOLICITUD DE CITA viva,
                // su respuesta entra a la máquina del match (idéntica al sandbox).
                try {
                    const convD = await query("SELECT id FROM conversaciones WHERE channel_thread_id = ? LIMIT 1", ['whatsapp:' + tel]);
                    let ultimoD = '';
                    if (convD.length) {
                        const mD = await query("SELECT texto FROM mensajes WHERE conversacion_id=? AND direccion='in' ORDER BY ts DESC, id DESC LIMIT 1", [convD[0].id]);
                        ultimoD = mD.length ? String(mD[0].texto || '') : '';
                    }
                    if (ultimoD) {
                        const segsD = await citasVivas.manejarMensajeDueno(tel, ultimoD);
                        if (segsD && segsD.length) return res.status(200).json({ ok: true, modo: 'vendedor_match', tipo: 'cita_vendedor', segmentos: segsD });
                    }
                } catch (e) { console.error('[citas-vivas] dueno:', e.message); }
                return res.status(200).json({ ok: false, motivo: 'dueno' });
            }

            const convRow = await query("SELECT id, nombre FROM conversaciones WHERE channel_thread_id = ? LIMIT 1", ['whatsapp:' + tel]);
            const convId = convRow.length ? convRow[0].id : null;
            const nombreChat = convRow.length ? convRow[0].nombre : null;
            // MODO PRUEBA: respeta el reinicio — todo lo ANTERIOR al reset se ignora, así
            // un número de prueba que contesta un anuncio cuenta como PRIMER CONTACTO fresco.
            const resetsOA = await cargarResets();
            const resetTsOA = Number(resetsOA[tel] || 0);
            let mensajes = [];
            if (convId) {
                const mr = await query("SELECT direccion, texto, ts, ai_generated FROM mensajes WHERE conversacion_id=? ORDER BY ts ASC, id ASC", [convId]);
                let rows = mr.map(m => ({ mensaje: m.texto || '', direccion: m.direccion, ts: Number(m.ts), ai: Number(m.ai_generated) || 0 }));
                if (resetTsOA) rows = rows.filter(m => m.ts >= resetTsOA);
                mensajes = rows;
            }
            const entrantes = mensajes.filter(m => m.direccion === 'in');
            if (!entrantes.length) return res.status(200).json({ ok: false, motivo: 'sin_entrantes' });
            // ══ COMPRADOR CON MATCH VIVO (WhatsApp real): cancelación / "ya voy en camino"
            // se interpretan ANTES del pipeline (idéntico al sandbox).
            try {
                // 🚩 caso Mazda 2026-07-13 ("llano estoi interesado" + "Grsias"): la cancelación
                // llega en RÁFAGA — se evalúa la ráfaga entrante COMPLETA, no solo la última burbuja.
                let lastOutIdxC = -1; mensajes.forEach((m, i) => { if (m.direccion === 'out') lastOutIdxC = i; });
                const rafagaIn = (lastOutIdxC >= 0 ? mensajes.slice(lastOutIdxC + 1) : mensajes).filter(m => m.direccion === 'in').map(m => m.mensaje).join(' ') || (entrantes[entrantes.length - 1].mensaje || '');
                const segsM = await citasVivas.manejarMensajeComprador(tel, rafagaIn);
                if (segsM && segsM.length) return res.status(200).json({ ok: true, modo: 'cita_match', tipo: 'cita_comprador', segmentos: segsM });
            } catch (e) { console.error('[citas-vivas] comprador:', e.message); }

            // ══ CANDADO STANDBY (🚩fyrachat#8, caso Gustavo 2026-07-12): si TU último mensaje
            // MANUAL (ai_generated=0, escrito por ti desde el teléfono o FyraChat) es un
            // "espera/te confirmo", el bot NO toca este chat — ni propone horas ni cierra
            // citas — hasta que TÚ vuelvas a escribir a mano. Acusa recibo UNA sola vez;
            // todo lo que llegue del comprador mientras tanto se te escala.
            try {
                const { esStandby, ACUSE_STANDBY } = require('../lib/seb/doctrina.js');
                const manualesSb = mensajes.filter(m => m.direccion === 'out' && !m.ai);
                const ultManualSb = manualesSb.length ? manualesSb[manualesSb.length - 1] : null;
                if (ultManualSb && esStandby(ultManualSb.mensaje) && (Date.now() - Number(ultManualSb.ts)) < 7 * 86400000) {
                    // ── EXCEPCIÓN RECEPCIÓN (orden owner 2026-07-16): en un chat de VENDEDOR
                    // (sesión de recepción activa) la palabra del owner NO pausa ni da posesión —
                    // Ignacio sigue juntando la ficha para que el auto nazca.
                    let enRecepcionSb = false;
                    // auditoría #13: también exime al DUEÑO CONOCIDO que vuelve por otro
                    // auto (aún sin sesión) — tu standby no congela la recepción.
                    try {
                        const recSb = require('../lib/seb/recepcion.js');
                        enRecepcionSb = !!(await recSb.sesionActiva(tel)) || !!(await recSb.duenoConocido(tel));
                    } catch (e) { }
                    if (!enRecepcionSb) {
                        const idxSb = mensajes.lastIndexOf(ultManualSb);
                        const acuseYa = mensajes.slice(idxSb + 1).some(m => m.direccion === 'out' && m.ai);
                        const nomSb = (convRow.length && convRow[0].nombre) || null;
                        const motivoSb = 'STANDBY 🔒 — tú quedaste de confirmar ("' + String(ultManualSb.mensaje).slice(0, 50) + '"): el bot no toca este chat hasta que escribas tú';
                        const ultInSb = entrantes[entrantes.length - 1].mensaje;
                        if (!acuseYa) return res.status(200).json({ ok: true, modo: 'standby', tipo: 'standby', segmentos: [ACUSE_STANDBY], escalar_owner: true, escala_motivo: motivoSb, escala_nombre: nomSb, escala_ultimo: ultInSb });
                        return res.status(200).json({ ok: false, escalar_owner: true, escala_motivo: motivoSb, escala_nombre: nomSb, escala_ultimo: ultInSb });
                    }
                }
            } catch (e) { console.error('[standby]', e.message); }

            // 🚩fyrachat#2: si en la ventana reciente hay un MENSAJE NO DESCIFRADO (Baileys),
            // el bot NO sabe qué no vio → JAMÁS el fallback genérico: escala al owner.
            const ventanaIn = entrantes.slice(-4).map(m => m.mensaje).join(' ');
            if (/no descifrado|no se pudo descifrar|mensaje cifrado|⚠️/.test(ventanaIn)) {
                const nomEsc = (convRow.length && convRow[0].nombre) || null;
                return res.status(200).json({ ok: false, escalar_owner: true, escala_motivo: 'hay un MENSAJE NO DESCIFRADO en la conversación (el bot no sabe qué no vio) — revísala tú', escala_nombre: nomEsc, escala_ultimo: entrantes[entrantes.length - 1].mensaje });
            }
            // ESTADO por # de RÁFAGAS salientes nuestras (respeta el reset).
            let bursts = 0, prevDir = null, lastOutIdx = -1;
            mensajes.forEach((m, i) => { if (m.direccion === 'out') { if (prevDir !== 'out') bursts++; lastOutIdx = i; } prevDir = m.direccion; });
            const lastDir = mensajes[mensajes.length - 1].direccion;

            // ══ IGNACIO RECEPCIÓN EN VIVO (orden owner 2026-07-16): agente para VENDEDORES
            // ("quiero vender mi auto"). Despierta SOLO en primer contacto claro (bursts 0 +
            // regex + doble candado IA) o si el chat YA tiene sesión de recepción abierta.
            // El trade-in a media compra NO despierta (sigue escalando como siempre).
            // Interruptor global: IGNACIO_RECEPCION=0. Cerebro: lib/seb/recepcion.js (paridad sandbox).
            try {
                if (process.env.IGNACIO_RECEPCION !== '0') {
                    const recepcion = require('../lib/seb/recepcion.js');
                    // ══ FUENTE ÚNICA (orden owner 2026-07-16): el turno COMPLETO de Ignacio
                    // (ráfaga, historial, último manual, compuerta de despertar) vive en
                    // turnoIgnacio (lib/seb/recepcion.js) — el sandbox llama LA MISMA función.
                    const rIg = await recepcion.turnoIgnacio({ telefono: tel, convId, desdeTs: resetTsOA });
                    if (rIg.activo) {
                        if (rIg.avisoOwner) { try { await citasVivas.enviarWA('5218120066355', rIg.avisoOwner); } catch (e) { } }
                        return res.status(200).json({ ok: true, modo: 'recepcion', tipo: 'ignacio_recepcion', segmentos: rIg.segmentos || [] });
                    }
                    // no despertó / doble candado dijo NO (era comprador) → sigue el pipeline normal
                }
            } catch (e) { console.error('[recepcion]', e.message); }

            let adCtx = null;
            try { const adRow = await query("SELECT ad_context FROM ad_por_telefono WHERE telefono=?", [tel]); if (adRow[0]) adCtx = adRow[0].ad_context; } catch (e) { /* sin anuncio */ }
            // ══ AD-ESPÍA + SANEAMIENTO (Patricio 2026-07-15, Daniel/Cavalier 2026-07-16):
            // el contexto de un clic de CARRUSEL trae la tarjeta de PORTADA, no la clickeada.
            // sanearContexto (cerebro único en lib/seb/ad-espia.js): espía la publicación y
            // la tarjeta clickeada MANDA; sin confirmación, la portada se PODA y el opener
            // pregunta el auto en vez de afirmar uno equivocado. Persiste; todas las etapas
            // (opener/continuación/etapa3) lo heredan vía [DESC: …].
            try {
                const { sanearContexto } = require('../lib/seb/ad-espia.js');
                adCtx = await sanearContexto(tel, adCtx, mensajes.filter(m => m.direccion === 'in').slice(0, 3).map(m => m.mensaje).join(' '));
            } catch (e) { console.error('[ad-espia]', e.message); }
            const histCorto = mensajes.slice(-8).map(h => ({ direccion: h.direccion, mensaje: h.mensaje }));

            // ══ POSESIÓN = CONTROL TUYO EN ETAPA 3 (human in the loop, 2026-07-13):
            // el bot es piloto normal en opener/continuación/etapa 3 HASTA que tú tomas
            // CONTROL (pregunta/promesa tuya, entrada sin nada que rescatar, o ping-pong).
            // Un RESCATE (dato pelón a una escalada) NO toma posesión. En control el bot
            // es puro DADOR: cotizar/fotos/ubicación+horarios/ficha secos, sin gancho;
            // el CIERRE es tuyo ("cita confirmada + día + hora + auto + precio" — el cron
            // lo interpreta determinista y ejecuta la máquina); lo demás = SILENCIO.
            try {
                const { herramientaPura, posesionOwner } = require('../lib/seb/doctrina.js');
                let escalasPos = [];
                try { escalasPos = (await query("SELECT motivo, ts FROM escalas_log WHERE telefono=? AND ts > ?", [tel, Date.now() - 24 * 3600000])).map(e => ({ motivo: e.motivo, ts: Number(e.ts) })); } catch (e) { }
                if (bursts >= 2 && posesionOwner(mensajes, escalasPos)) {
                    // en posesión el silencio es NORMAL → el backlog de entrantes crece; la
                    // herramienta se evalúa sobre la ÚLTIMA ráfaga (2 min), no el acumulado
                    // (bug sandbox: "agendar cita" viejo ahogaba al "cotizar" nuevo).
                    const insP = (lastOutIdx >= 0 ? mensajes.slice(lastOutIdx + 1) : mensajes).filter(m => m.direccion === 'in');
                    const ultTsP = insP.length ? Number(insP[insP.length - 1].ts) : 0;
                    // CASCADA: 1º el ÚLTIMO mensaje solo (cada pregunta vale por sí misma);
                    // 2º la ráfaga de 2 min (burbujas partidas "me mandas"+"fotos"). Sin esto,
                    // un "agendar cita" viejo del backlog ahogaba al "cotízame" nuevo.
                    const ultimoSolo = insP.length ? String(insP[insP.length - 1].mensaje || '') : (entrantes[entrantes.length - 1].mensaje || '');
                    const rafagaP = insP.filter(m => ultTsP - Number(m.ts) < 2 * 60000).map(m => m.mensaje).join(' ') || ultimoSolo;
                    let followupP = ultimoSolo;
                    const mcP = adCtx ? '[DESC: ' + adCtx + ']\n' + ultimoSolo : ultimoSolo;
                    const clasifP = await entender({ mensaje: mcP, historial: histCorto, estado: {} });
                    let autoP = clasifP.auto_id;
                    if (!autoP) { try { const wcP = await query("SELECT auto_id_activo FROM wa_conversations WHERE telefono=?", [tel]); if (wcP[0] && wcP[0].auto_id_activo) autoP = Number(wcP[0].auto_id_activo); } catch (e) { } }
                    const { responderEtapa3 } = require('../lib/seb/etapa3.js');
                    let eP = await responderEtapa3({ texto: ultimoSolo, auto_id: autoP, conv_id: convId, clasif: clasifP });
                    let hP = herramientaPura(eP);
                    if (!hP && rafagaP !== ultimoSolo) {
                        followupP = rafagaP;
                        const eP2 = await responderEtapa3({ texto: rafagaP, auto_id: autoP, conv_id: convId, clasif: clasifP });
                        const hP2 = herramientaPura(eP2);
                        if (hP2) { eP = eP2; hP = hP2; }
                        else if (!eP || !eP.escalar) eP = eP2 && eP2.escalar ? eP2 : eP;
                    }
                    if (hP) return res.status(200).json({ ok: true, modo: 'posesion_herramienta', tipo: 'herr_' + (hP.universo || ''), segmentos: hP.segmentos, ubicacion_auto_id: hP.ubicacion_auto_id || null, pin_primero: !!hP.pin_primero, pin_after_index: (hP.pin_after_index != null ? hP.pin_after_index : (hP.ubicacion_auto_id ? 0 : null)), fotos: hP.fotos || null, fotos_after_index: (hP.fotos_after_index != null ? hP.fotos_after_index : 0) });
                    // la herramienta QUISO servir pero le falta un dato (ej. punto de venta
                    // sin configurar) → eso SÍ se te escala con la causa, no silencio mudo.
                    // (el wrapper poda el universo en escaladas → se detecta por MOTIVO)
                    const RE_HERR_SIN_DATOS = /(punto de venta configurado|no se pudo cotizar|arma t[uú] la cotizaci[oó]n|hey no lo financia)/i;
                    if (eP && eP.escalar && RE_HERR_SIN_DATOS.test(String(eP.motivo || ''))) {
                        const nomPos = (convRow.length && convRow[0].nombre) || null;
                        return res.status(200).json({ ok: false, escalar_owner: true, escala_motivo: '🔧 herramienta sin datos: ' + (eP.motivo || ''), escala_nombre: nomPos, escala_ultimo: followupP });
                    }
                    return res.status(200).json({ ok: false, motivo: 'posesion_owner — chat en tus manos; no es herramienta → silencio' });
                }
            } catch (e) { console.error('[posesion]', e.message); }

            // ===== EN_CURSO: PRIMERA respuesta del comprador al opener (1 ráfaga nuestra + último=entrante) =====
            // Solo financiamiento / ubicación (sus manuales). Lo demás → silencio (lo ve el owner).
            if (bursts === 1 && lastDir === 'in') {
                const followup = mensajes.slice(lastOutIdx + 1).filter(m => m.direccion === 'in').map(m => m.mensaje).join(' ');
                // ══ ELECCIÓN DEL APARADOR (carrusel 2026-07-20): si mostramos aparador y
                // aún no hay foco, este mensaje puede ser la elección (hecho duro) o "más opciones"
                const elA = await intentarEleccionAparador(tel, followup, convId);
                if (elA) return res.status(200).json({ ok: true, modo: 'aparador', ...elA });
                // "¿qué más opciones?" → relacionados al interés · necesidad → filtro duro
                const opF = await opcionesEnFlujo({ tel, texto: followup });
                if (opF) {
                    if (opF.escalar_owner) await logEscala(tel, opF.escala_motivo);
                    return res.status(200).json({ ok: true, modo: 'aparador', ...opF, escala_ultimo: opF.escalar_owner ? followup : undefined });
                }
                const mcC = adCtx ? '[DESC: ' + adCtx + ']\n' + followup : followup;
                const clasifC = await entender({ mensaje: mcC, historial: histCorto, estado: {} });
                // fix raíz: la inferencia de la IA no cambia el auto — el estado manda
                clasifC.auto_id = await require('../lib/seb/mesa.js').alinearAuto({ tel, texto: followup, clasif: clasifC });
                // ══ LA MESA (owner 2026-07-21): nombró un auto explícito → entra en juego;
                // con 2-3 en mesa lo general se contesta para todos, lo de uno en ese.
                const mesaC = await require('../lib/seb/mesa.js').responderMesa({ tel, texto: followup, clasif: clasifC, convId });
                if (mesaC && mesaC.segmentos) return res.status(200).json({ ok: true, modo: 'mesa', tipo: mesaC.tipo, segmentos: mesaC.segmentos, fotos: mesaC.fotos || null, fotos_after_index: (mesaC.fotos_after_index != null ? mesaC.fotos_after_index : null) });
                if (mesaC && mesaC.auto_id) clasifC.auto_id = mesaC.auto_id;
                // ══ EL PERRO (owner 2026-07-21): Haiku elige herramientas (combinadas o
                // no), el código ejecuta con machotes — mata el parche-por-parche.
                {
                    const histTxt = histCorto.map(h => (h.direccion === 'in' ? 'COMPRADOR: ' : 'SEB: ') + h.mensaje).join('\n');
                    const perroC = await require('../lib/seb/ruteador.js').rutear({ tel, texto: followup, historial: histTxt, convId });
                    if (perroC && perroC.escalar_owner) {
                        await logEscala(tel, perroC.escala_motivo);
                        return res.status(200).json({ ok: !!(perroC.segmentos && perroC.segmentos.length), modo: 'perro', tipo: perroC.tipo, segmentos: perroC.segmentos || [], escalar_owner: true, escala_motivo: perroC.escala_motivo, escala_ultimo: followup });
                    }
                    if (perroC) return res.status(200).json({ ok: true, modo: 'perro', tipo: perroC.tipo, segmentos: perroC.segmentos, fotos: perroC.fotos || null, fotos_after_index: (perroC.fotos_after_index != null ? perroC.fotos_after_index : null) });
                }
                const cont = await responderCont({ texto: followup, nombre: nombreChat, auto_id: clasifC.auto_id, enganche: clasifC.datos && clasifC.datos.enganche, plazo: clasifC.datos && clasifC.datos.plazo_meses, intencion: clasifC.intencion_principal, conv_id: convId, clasif: clasifC });
                const escNomC = require('../lib/seb/opener.js').nombreReal(nombreChat) || nombreChat || null;
                // DOCTRINA: la continuación también escala (momentos de gol / fuera de lista blanca).
                if (cont && cont.escalar) {
                    await logEscala(tel, cont.motivo);
                    if (cont.puente) return res.status(200).json({ ok: true, modo: 'continuacion', segmentos: [cont.puente], escalar_owner: true, escala_motivo: cont.motivo, escala_nombre: escNomC, escala_ultimo: followup });
                    return res.status(200).json({ ok: false, escalar_owner: true, escala_motivo: cont.motivo, escala_nombre: escNomC, escala_ultimo: followup });
                }
                if (cont && cont.silencio) return res.status(200).json({ ok: false, motivo: 'cortesia_silencio' });
                if (cont && cont.segmentos && cont.segmentos.length) {
                    if (cont.cita_confirmada && cont.cita_datos) {
                        await regCanonica(tel, cont);
                        try { await citasVivas.intentarMatchDirecto(tel, cont.cita_datos.fecha, cont.cita_datos.hora); } catch (e) { }
                    }
                    return res.status(200).json({ ok: true, modo: 'continuacion', tipo: 'cont_' + cont.universo, segmentos: cont.segmentos, ubicacion_auto_id: cont.ubicacion_auto_id || null, pin_primero: !!cont.pin_primero, pin_after_index: (cont.pin_after_index != null ? cont.pin_after_index : null), fotos: cont.fotos || null, fotos_after_index: (cont.fotos_after_index != null ? cont.fotos_after_index : null) });
                }
                // DESAMBIGUAR (orden owner 2026-07-15): contestó la pregunta del opener
                // con una FAMILIA ("el mazda" y hay 2 Mazda) → se le presentan y se
                // pregunta cuál — esto NO es "fuera de lista blanca", es leer inventario.
                try {
                    const { candidatosDeAuto } = require('../lib/seb/clasificador.js');
                    const aActC = await query("SELECT id, marca, modelo, version, anio, precio FROM inventario_autos WHERE estado='activo'");
                    const candC = candidatosDeAuto(followup, aActC.map(a => ({ id: a.id, nombre: [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' '), precio: a.precio })));
                    if (candC) {
                        return res.status(200).json({
                            ok: true, modo: 'continuacion', tipo: 'cont_desambiguar', segmentos: [
                                'Claro, de esos tenemos estos disponibles:\n' + candC.map(a => '• ' + a.nombre + (a.precio ? ' — $' + Number(a.precio).toLocaleString('es-MX') : '')).join('\n'),
                                'Cuál te interesa?'
                            ]
                        });
                    }
                } catch (e) { console.error('[desambiguar cont]', e.message); }
                // Nada aplicó → fuera de la lista blanca → lo ves tú (antes: silencio mudo).
                return res.status(200).json({ ok: false, escalar_owner: true, escala_motivo: 'fuera de la lista blanca (continuación, no claro) — lo ves tú', escala_nombre: escNomC, escala_ultimo: followup });
            }
            // ===== ETAPA 3 AUTOMÁTICO (turno 3+): CONTESTABLE lo manda solo; lo que no es
            // claro / no maximiza la venta → ESCALA al owner (NO improvisa con Sonnet). =====
            const AUTO_ETAPA3 = process.env.AUTO_ETAPA3 !== '0';   // interruptor maestro (default ON)
            if (AUTO_ETAPA3 && bursts >= 2 && lastDir === 'in') {
                const followupE = mensajes.slice(lastOutIdx + 1).filter(m => m.direccion === 'in').map(m => m.mensaje).join(' ') || (entrantes.length ? entrantes[entrantes.length - 1].mensaje : '');
                // elección tardía del aparador (preguntó algo en medio y luego eligió)
                const elA2 = await intentarEleccionAparador(tel, followupE, convId);
                if (elA2) return res.status(200).json({ ok: true, modo: 'aparador', ...elA2 });
                // "¿qué más opciones?" → relacionados al interés · necesidad → filtro duro
                const opF2 = await opcionesEnFlujo({ tel, texto: followupE });
                if (opF2) {
                    if (opF2.escalar_owner) await logEscala(tel, opF2.escala_motivo);
                    return res.status(200).json({ ok: true, modo: 'aparador', ...opF2, escala_ultimo: opF2.escalar_owner ? followupE : undefined });
                }
                const mcE = adCtx ? '[DESC: ' + adCtx + ']\n' + followupE : followupE;
                const clasifE = await entender({ mensaje: mcE, historial: histCorto, estado: {} });
                // fix raíz: la inferencia de la IA no cambia el auto — el estado manda
                clasifE.auto_id = await require('../lib/seb/mesa.js').alinearAuto({ tel, texto: followupE, clasif: clasifE });
                // ══ LA MESA (owner 2026-07-21) — misma capa que en continuación
                const mesaE = await require('../lib/seb/mesa.js').responderMesa({ tel, texto: followupE, clasif: clasifE, convId });
                if (mesaE && mesaE.segmentos) return res.status(200).json({ ok: true, modo: 'mesa', tipo: mesaE.tipo, segmentos: mesaE.segmentos, fotos: mesaE.fotos || null, fotos_after_index: (mesaE.fotos_after_index != null ? mesaE.fotos_after_index : null) });
                if (mesaE && mesaE.auto_id) clasifE.auto_id = mesaE.auto_id;
                // ══ EL PERRO (owner 2026-07-21) — misma capa que en continuación
                {
                    const histTxtE = histCorto.map(h => (h.direccion === 'in' ? 'COMPRADOR: ' : 'SEB: ') + h.mensaje).join('\n');
                    const perroE = await require('../lib/seb/ruteador.js').rutear({ tel, texto: followupE, historial: histTxtE, convId });
                    if (perroE && perroE.escalar_owner) {
                        await logEscala(tel, perroE.escala_motivo);
                        return res.status(200).json({ ok: !!(perroE.segmentos && perroE.segmentos.length), modo: 'perro', tipo: perroE.tipo, segmentos: perroE.segmentos || [], escalar_owner: true, escala_motivo: perroE.escala_motivo, escala_ultimo: followupE });
                    }
                    if (perroE) return res.status(200).json({ ok: true, modo: 'perro', tipo: perroE.tipo, segmentos: perroE.segmentos, fotos: perroE.fotos || null, fotos_after_index: (perroE.fotos_after_index != null ? perroE.fotos_after_index : null) });
                }
                let autoE = clasifE.auto_id;
                if (!autoE) { try { const wc = await query("SELECT auto_id_activo FROM wa_conversations WHERE telefono=?", [tel]); if (wc[0] && wc[0].auto_id_activo) autoE = Number(wc[0].auto_id_activo); } catch (e) { } }
                const { responderEtapa3 } = require('../lib/seb/etapa3.js');
                const { nombreReal } = require('../lib/seb/opener.js');
                const e3 = await responderEtapa3({ texto: followupE, auto_id: autoE, conv_id: convId, clasif: clasifE });
                const escNom = nombreReal(nombreChat) || nombreChat || null;
                if (e3 && e3.escalar) {
                    await logEscala(tel, e3.motivo);
                    // Escala: si hay PUENTE, se lo mandamos al comprador (no queda colgado) y te avisamos;
                    // si no hay puente, solo te avisamos (tú contestas).
                    if (e3.puente) return res.status(200).json({ ok: true, modo: 'etapa3', segmentos: [e3.puente], escalar_owner: true, escala_motivo: e3.motivo, escala_nombre: escNom, escala_ultimo: followupE });
                    return res.status(200).json({ ok: false, escalar_owner: true, escala_motivo: e3.motivo, escala_nombre: escNom, escala_ultimo: followupE });
                }
                if (e3 && e3.silencio) return res.status(200).json({ ok: false, motivo: 'cortesia_silencio' });
                if (e3 && e3.segmentos && e3.segmentos.length) {
                    // MATCH DIRECTO real: si esta confirmación empata con la CONTRAPROPUESTA
                    // viva del dueño → match sin re-preguntarle (se le avisa "confirmó ✅").
                    if (e3.cita_confirmada && e3.cita_datos) {
                        await regCanonica(tel, e3);
                        try { await citasVivas.intentarMatchDirecto(tel, e3.cita_datos.fecha, e3.cita_datos.hora); } catch (e) { }
                    }
                    return res.status(200).json({ ok: true, modo: 'etapa3', tipo: 'e3_' + (e3.universo || ''), segmentos: e3.segmentos, ubicacion_auto_id: e3.ubicacion_auto_id || null, pin_primero: !!e3.pin_primero, pin_after_index: (e3.pin_after_index != null ? e3.pin_after_index : (e3.ubicacion_auto_id ? 0 : null)), fotos: e3.fotos || null, fotos_after_index: (e3.fotos_after_index != null ? e3.fotos_after_index : 0) });
                }
                // responderEtapa3 = null → LONG-TAIL / no es claro → ESCALA al owner (jamás Sonnet suelto).
                return res.status(200).json({ ok: false, escalar_owner: true, escala_motivo: 'mensaje fuera de banco (no claro / requiere tu criterio)', escala_nombre: escNom, escala_ultimo: followupE });
            }

            // Ya hablamos (opener + continuación, o más turnos) → SILENCIO total (modo manual).
            if (bursts >= 1) return res.status(200).json({ ok: false, motivo: 'en_curso_silencio' });

            // ===== PRIMER CONTACTO (bursts === 0) → OPENER =====
            const lastMsg = entrantes[entrantes.length - 1].mensaje;
            const textoFamilia = entrantes.map(e => e.mensaje).join(' ');   // junta la ráfaga del comprador
            const historial = histCorto;
            const mensajeCerebro = adCtx ? '[DESC: ' + adCtx + ']\n' + lastMsg : lastMsg;
            const clasif = await entender({ mensaje: mensajeCerebro, historial, estado: {} });
            // red team r2 #2: el auto resuelto viene NEGADO ("NO me interesa el Mustang…")
            // → no es interés: se anula para que jamás se pitchee ni se siente
            if (clasif.auto_id) {
                try {
                    const apNeg = require('../lib/seb/aparador.js');
                    const rowsNeg = await query("SELECT marca, modelo, version, anio FROM inventario_autos WHERE id=?", [Number(clasif.auto_id)]);
                    if (rowsNeg.length && apNeg.esNegado(textoFamilia, [rowsNeg[0].marca, rowsNeg[0].modelo, rowsNeg[0].version, rowsNeg[0].anio].filter(Boolean).join(' '))) clasif.auto_id = null;
                    // GEMELOS también en el opener (red team r2 #4): dos altas casi
                    // idénticas → jamás elegir una en silencio, se pregunta con precios
                    if (clasif.auto_id) {
                        const autosG = await apNeg.inventarioActivo();
                        const rowG = autosG.find(a => a.id === Number(clasif.auto_id));
                        const gemG = rowG ? apNeg.gemelosDe(rowG, autosG) : [];
                        if (gemG.length) {
                            const listaG = [rowG].concat(gemG);
                            return res.status(200).json({ ok: true, modo: 'mesa', tipo: 'mesa_gemelos', segmentos: ['Tenemos dos así, nada más cambia el precio:\n' + listaG.map((x, i) => `${i + 1}) ${apNeg.fichaBreve(x)}`).join('\n'), '¿Cuál de los dos te interesa?'] });
                        }
                    }
                } catch (e) { }
            }

            // ══ PUERTA 2 — CLIC GENÉRICO DE CARRUSEL (orden owner 2026-07-20): el clic
            // pelón ("Me interesa un auto" + link) SIEMPRE abre el APARADOR. Si el ojo
            // (espía texto+visión) identificó un auto, entra como ANCLA en posición 1
            // con "¿Te refieres a este?" — HIPÓTESIS, jamás afirmado (lección Daniel:
            // la tarjeta puede ser la portada). Si el comprador NOMBRA el auto él
            // mismo, eso es Puerta 1 y sigue el flujo normal de abajo.
            try {
                const arrC = await arranqueCarrusel({ tel, textoRaw: textoFamilia, textoFamilia, adCtx, textosIn: entrantes.slice(0, 3).map(m => m.mensaje).join(' '), nombre: nombreChat, esClick: true });
                if (arrC) return res.status(200).json({ ok: true, ...arrC });
            } catch (e) { console.error('[aparador clic]', e.message); }

            // ══ ENTRADA MÚLTIPLE (red team #3): abre nombrando 2-3 autos → todos a la
            // mesa desde el saludo (ficha + portada + punto de cada uno → a la cita)
            try {
                const emP = await require('../lib/seb/mesa.js').entradaMultiple({ tel, texto: textoFamilia, nombre: nombreChat });
                if (emP) return res.status(200).json({ ok: true, modo: 'mesa', tipo: emP.tipo, segmentos: emP.segmentos, fotos: emP.fotos || null, fotos_after_index: (emP.fotos_after_index != null ? emP.fotos_after_index : null) });
            } catch (e) { console.error('[mesa multi opener]', e.message); }

            // MULTI-PREGUNTA o pregunta RARA/long-tail → que conteste el CEREBRO (loop) en la
            // voz del owner (nucleo), en vez de deflectar a "info" genérico.
            if (clasif.auto_id && !clasif.escalar && necesitaCerebro(textoFamilia)) {
                try {
                    const p = await pensar({ telefono: tel, mensaje: textoFamilia, clasificacion: clasif, estado: {} });
                    if (p && p.ok && p.borrador) return res.status(200).json({ ok: true, segmentos: partirRafaga(p.borrador), tipo: 'cerebro' });
                } catch (e) { /* si el cerebro falla, cae al opener */ }
            }

            // Opener determinístico (familias claras, voz exacta).
            const op = await responderOpener({
                texto: textoFamilia, nombre: nombreChat,
                auto_id: clasif.auto_id, intencion: clasif.intencion_principal
            });
            if (op && op.segmentos && op.segmentos.length) return res.status(200).json({ ok: true, segmentos: op.segmentos, tipo: op.tipo, fotos: op.fotos || null, fotos_after_index: (op.fotos_after_index != null ? op.fotos_after_index : null) });
            // El opener no supo (vendedor → null) → si es vendedor/junk, no autopilot.
            if (clasif.escalar) return res.status(200).json({ ok: false, motivo: 'escala_vendedor' });
            // Hay auto y es comprador, pero el opener no tiene familia → al CEREBRO (voz del owner).
            if (clasif.auto_id) {
                try {
                    const p = await pensar({ telefono: tel, mensaje: textoFamilia, clasificacion: clasif, estado: {} });
                    if (p && p.ok && p.borrador) return res.status(200).json({ ok: true, segmentos: partirRafaga(p.borrador), tipo: 'cerebro' });
                } catch (e) { /* sin cerebro → no_aplica */ }
            }
            // FALLBACK UNIVERSAL (caso Sahara): es COMPRADOR pero no se pudo resolver QUÉ auto
            // (anuncio viejo, texto raro, sin [DESC]). Antes → silencio (apagón). Ahora se
            // contesta SIEMPRE con la pregunta del owner (su frase real de la data) — cualquier
            // opener de comprador recibe respuesta.
            {
                const intOk = ['info_inicial', 'disponibilidad', 'estado_auto', 'cotizar_credito', 'cita_ubicacion', 'precio_negociacion', 'fotos_videos', 'otro'].includes(clasif.intencion_principal);
                if (intOk && !clasif.escalar) {
                    const { nombreReal, saludoHora } = require('../lib/seb/opener.js');
                    const nm = nombreReal(nombreChat);
                    // DESAMBIGUAR (orden owner 2026-07-15): nombró una FAMILIA con varios
                    // ("el mazda" y hay 2 Mazda) → se le presentan y se pregunta cuál.
                    try {
                        const { candidatosDeAuto } = require('../lib/seb/clasificador.js');
                        const aAct = await query("SELECT id, marca, modelo, version, anio, precio FROM inventario_autos WHERE estado='activo'");
                        const cand = candidatosDeAuto(textoFamilia, aAct.map(a => ({ id: a.id, nombre: [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' '), precio: a.precio })));
                        if (cand) {
                            return res.status(200).json({
                                ok: true, tipo: 'opener_desambiguar', segmentos: [
                                    `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}!`,
                                    'Mucho gusto, mi nombre es Sebastián Romero, para servirte',
                                    'Claro, de esos tenemos estos disponibles:\n' + cand.map(a => '• ' + a.nombre + (a.precio ? ' — $' + Number(a.precio).toLocaleString('es-MX') : '')).join('\n'),
                                    'Cuál te interesa?'
                                ]
                            });
                        }
                    } catch (e) { console.error('[desambiguar]', e.message); }
                    // ══ PUERTAS 2 y 3 — ARRANQUE DE CARRUSEL (fuente única aparador.js):
                    // criterio → buscar_inventario; link de anuncio → ancla-hipótesis;
                    // sin nada → null y cae a la pregunta clásica del owner.
                    try {
                        const esDuda = ['cotizar_credito', 'cita_ubicacion', 'fotos_videos', 'estado_auto', 'precio_negociacion'].includes(clasif.intencion_principal);
                        const arrF = await arranqueCarrusel({ tel, textoRaw: textoFamilia, textoFamilia, adCtx, textosIn: entrantes.slice(0, 3).map(m => m.mensaje).join(' '), nombre: nombreChat, esClick: false, duda: esDuda ? String(textoFamilia).slice(0, 200) : null });
                        if (arrF) return res.status(200).json({ ok: true, ...arrF });
                    } catch (e) { console.error('[aparador]', e.message); }
                    // red de seguridad: la pregunta clásica del owner
                    return res.status(200).json({
                        ok: true, tipo: 'opener_sin_auto', segmentos: [
                            `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}!`,
                            'Mucho gusto, mi nombre es Sebastián Romero, para servirte',
                            'Claro que sí, de qué auto buscas información? Para poderte ayudar'
                        ]
                    });
                }
            }
            return res.status(200).json({ ok: false, motivo: 'no_aplica' });
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
                if (adRow[0] && adRow[0].ad_context) {
                    // mismo saneamiento que opener_auto (portada de carrusel NO afirma el auto)
                    let ctxOk = adRow[0].ad_context;
                    try {
                        const { sanearContexto } = require('../lib/seb/ad-espia.js');
                        ctxOk = await sanearContexto(tel, ctxOk, conv.mensajes.filter(m => m.direccion === 'in').slice(0, 3).map(m => m.mensaje).join(' '));
                    } catch (eSan) { console.error('[ad-espia sugerir]', eSan.message); }
                    if (ctxOk) mensajeCerebro = '[DESC: ' + ctxOk + ']\n' + lastMsg;
                }
            } catch (e) { /* tabla aún no existe → sin anuncio */ }

            const clasif = await entender({ mensaje: mensajeCerebro, historial, estado });

            // ===== MENSAJE INICIAL → BANCO DE FRASES (fuente única de verdad) =====
            // Si Seb AÚN NO ha respondido en esta conversación (post-reset) y NO es un
            // "responder a/ejecutar", el opener lo arma el BANCO como SECUENCIA de
            // mensajes exactos (no el loop de IA). El front la parte para enviarlos uno
            // por uno. ubicacion/credito/sin-auto → null → cae al loop normal.
            const esOpener = !conv.mensajes.some(m => m.direccion === 'out') && !objetivoTxt && !objetivoMid;
            let r = null;
            // Si es multi-pregunta o rareza, NO uses el banco determinístico → deja que el
            // cerebro (loop, voz del owner) lo conteste abajo en pensar().
            if (esOpener && !necesitaCerebro(lastMsg)) {
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
                            estado_nuevo: { ...estado, auto_id_activo: clasif.auto_id || estado.auto_id_activo || null },
                            _fotos: op.fotos || null
                        };
                    }
                } catch (e) { /* si el banco falla, cae al loop normal */ }
            }

            // ===== EN_CURSO → BANCO DE CONTINUACIÓN (fin/ubic/info/precio/fotos) — MISMA lógica
            // que el autopilot, pero SUGIRIENDO (rápido, sin Sonnet). Solo la 1ra respuesta al opener.
            if (!r && !objetivoTxt && !objetivoMid) {
                let bursts = 0, prevDir = null, lastOutIdx = -1;
                conv.mensajes.forEach((m, i) => { if (m.direccion === 'out') { if (prevDir !== 'out') bursts++; lastOutIdx = i; } prevDir = m.direccion; });
                const lastDir = conv.mensajes.length ? conv.mensajes[conv.mensajes.length - 1].direccion : null;
                if (bursts === 1 && lastDir === 'in') {
                    const followup = conv.mensajes.slice(lastOutIdx + 1).filter(m => m.direccion === 'in').map(m => m.mensaje).join(' ') || lastMsg;
                    const cont = await responderCont({ texto: followup, nombre: nombreChat, auto_id: clasif.auto_id, enganche: clasif.datos && clasif.datos.enganche, plazo: clasif.datos && clasif.datos.plazo_meses, intencion: clasif.intencion_principal });
                    if (cont && cont.segmentos && cont.segmentos.length) {
                        r = {
                            ok: true,
                            borrador: cont.segmentos.join('\n' + SENTINEL + '\n'),
                            tools_usadas: [],
                            estado_nuevo: { ...estado, auto_id_activo: clasif.auto_id || estado.auto_id_activo || null },
                            _ubic: cont.ubicacion_auto_id || null,
                            _fotos: cont.fotos || null
                        };
                    }
                }
                // ===== ETAPA 3 (turno 3+) → EL JUEGO LIBRE, SOLO COPILOTO =====
                // Mismo motor que sería el automático (bancos + herramientas + CTA por estado,
                // ráfagas estratégicas), disparado por el click en sugerir. Las acciones (fotos/
                // pin) viajan en meta y se ejecutan AL APROBAR, idéntico al autopilot. Si el
                // motor no reconoce el universo → cae al cerebro (Sonnet, voz del owner) abajo.
                if (bursts >= 2 && lastDir === 'in') {
                    const followup = conv.mensajes.slice(lastOutIdx + 1).filter(m => m.direccion === 'in').map(m => m.mensaje).join(' ') || lastMsg;
                    const { responderEtapa3 } = require('../lib/seb/etapa3.js');
                    const e3 = await responderEtapa3({ texto: followup, auto_id: clasif.auto_id || estado.auto_id_activo || null, conv_id: convId, clasif });
                    if (e3 && e3.cita_confirmada && e3.cita_datos) await regCanonica(tel, e3);
                    if (e3 && e3.escalar) {
                        // ESCALA CON PUENTE: se PROPONE el puente como borrador (el comprador no
                        // se queda colgado) y se avisa que además escala al owner para lo que sigue.
                        if (e3.puente) return res.status(200).json({ ok: true, borrador: e3.puente, tools_usadas: [], escala_ademas: 'etapa 3: ' + e3.motivo, estado_nuevo: { ...estado, auto_id_activo: clasif.auto_id || estado.auto_id_activo || null } });
                        return res.status(200).json({ ok: false, escalar: true, intencion: clasif.intencion_principal, motivo: 'etapa 3: ' + e3.motivo });
                    }
                    if (e3 && e3.silencio) {
                        return res.status(200).json({ ok: false, silencio: true, intencion: clasif.intencion_principal, motivo: 'etapa 3: ' + e3.motivo });
                    }
                    if (e3 && e3.segmentos && e3.segmentos.length) {
                        r = {
                            ok: true,
                            borrador: e3.segmentos.join('\n' + SENTINEL + '\n'),
                            tools_usadas: [],
                            estado_nuevo: { ...estado, auto_id_activo: clasif.auto_id || estado.auto_id_activo || null },
                            _ubic: e3.ubicacion_auto_id || null,
                            _fotos: e3.fotos || null
                        };
                    }
                }
            }

            // ===== "RESPONDER A" un mensaje DEL COMPRADOR → el motor de etapa 3 TAMBIÉN aplica =====
            // Tocar el mensaje del cliente en FyraChat manda objetivo → antes eso brincaba TODOS
            // los bancos y caía a Sonnet (visto con Lucy: "que datos te tengo que enviar?" no dio
            // el banco de requisitos). Solo cuando el objetivo NO es un mensaje del comprador
            // (instrucción libre del owner) se va directo al cerebro.
            if (!r && (objetivoTxt || objetivoMid)) {
                const objMsg = idxObj >= 0 ? conv.mensajes[idxObj] : null;
                if (objMsg && objMsg.direccion === 'in') {
                    let bursts3 = 0, prevDir3 = null;
                    conv.mensajes.forEach(m => { if (m.direccion === 'out') { if (prevDir3 !== 'out') bursts3++; } prevDir3 = m.direccion; });
                    if (bursts3 >= 2) {
                        const { responderEtapa3 } = require('../lib/seb/etapa3.js');
                        const e3 = await responderEtapa3({ texto: objMsg.mensaje, auto_id: clasif.auto_id || estado.auto_id_activo || null, conv_id: convId, clasif });
                    if (e3 && e3.cita_confirmada && e3.cita_datos) await regCanonica(tel, e3);
                        if (e3 && e3.escalar) {
                            return res.status(200).json({ ok: false, escalar: true, intencion: clasif.intencion_principal, motivo: 'etapa 3: ' + e3.motivo });
                        }
                        if (e3 && e3.silencio) {
                            return res.status(200).json({ ok: false, silencio: true, intencion: clasif.intencion_principal, motivo: 'etapa 3: ' + e3.motivo });
                        }
                        if (e3 && e3.segmentos && e3.segmentos.length) {
                            r = {
                                ok: true,
                                borrador: e3.segmentos.join('\n' + SENTINEL + '\n'),
                                tools_usadas: [],
                                estado_nuevo: { ...estado, auto_id_activo: clasif.auto_id || estado.auto_id_activo || null },
                                _ubic: e3.ubicacion_auto_id || null,
                                _fotos: e3.fotos || null
                            };
                        }
                    }
                }
            }

            // GARANTÍA → ESCALA SIEMPRE (decisión del owner: sin política fija; que no la
            // invente Sonnet). Aplica en cualquier etapa cuando ningún banco la atrapó antes.
            if (!r && /garant/i.test(lastMsg || '')) {
                return res.status(200).json({ ok: false, escalar: true, intencion: clasif.intencion_principal, motivo: 'pregunta GARANTÍA (sin política fija — contéstala tú)' });
            }
            // Si el opener NO supo contestar Y es vendedor/fuera de alcance → ESCALAR (no es para
            // Seb). El opener ya cubre foráneo, así que esto solo pega a vendedores/junk reales.
            if (!r && clasif.escalar) {
                return res.status(200).json({ ok: false, escalar: true, intencion: clasif.intencion_principal, motivo: 'no es para Seb (venta de auto / fuera de alcance) — escalar a humano' });
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
                 JSON.stringify({ tools: r.tools_usadas.map(t => t.tool), estado_nuevo: r.estado_nuevo, auto_id: clasif.auto_id, ubic: r._ubic || null, fotos: r._fotos || null }),
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
        // ══ CONFIRMAR MATCH A MANO (botón en CALENDAR, 2026-07-13): el dueño confirmó
        // por teléfono / la solicitud no le llegó (caso tel mal capturado de Julio Torres)
        // → el owner aprieta el botón y se EJECUTA el match real: confianza al comprador
        // + plan de recordatorios. Misma máquina que la señal manual.
        if (action === 'confirmar_match' && req.method === 'POST') {
            const mid = Number(req.body.match_id || 0);
            if (!mid) return res.status(400).json({ ok: false, error: 'match_id requerido' });
            await citasVivas.ensureCitasMatch();
            const rows = await query("SELECT * FROM citas_match WHERE id = ?", [mid]);
            if (!rows.length) return res.status(404).json({ ok: false, error: 'match no encontrado' });
            const M = rows[0];
            if (!['solicitud', 'contrapropuesta', 'esperando_horario'].includes(String(M.estado))) {
                return res.status(200).json({ ok: false, error: 'estado ' + M.estado + ' — solo se confirma una solicitud viva' });
            }
            if (!M.cita_ts) return res.status(200).json({ ok: false, error: 'sin fecha/hora amarrada' });
            await citasVivas.ejecutarMatch(M);
            return res.status(200).json({ ok: true, match_id: mid, estado: 'match' });
        }

        // ══ CARGA DE LOTE (2026-07-13): el puente del VPS entrega cada pieza (texto o
        // foto ya subida a Blob) que el owner manda desde SU número. Ver carga-lote.js.
        // ═══ FYRADMIN · SOLICITUDES DE RECEPCIÓN (orden owner 2026-07-21) ═══
        // Las sesiones de Ignacio en REVISIÓN se enseñan en fyradrive.com/admin/pending
        // y el botón APROBAR ejecuta LA MISMA PUERTA que el "publícalo" de WhatsApp
        // (publicarSesion + recibo al owner + plantilla al vendedor + arrancar parqueado).
        if (action === 'recepcion_pendientes') {
            const rec = require('../lib/seb/recepcion.js');
            await rec.ensureRecepcion();
            const rsP = await query("SELECT telefono, datos, fotos, updated FROM recepcion_sesiones WHERE estado='revision' ORDER BY updated DESC");
            const pendientes = rsP.map(r => {
                let d = {}, f = [];
                try { d = JSON.parse(r.datos || '{}'); } catch (e) { }
                try { f = JSON.parse(r.fotos || '[]'); } catch (e) { }
                delete d._pendientes;
                return { telefono: r.telefono, datos: d, fotos: f, updated: Number(r.updated) || null };
            });
            return res.status(200).json({ ok: true, pendientes });
        }
        if (action === 'recepcion_publicar' && req.method === 'POST') {
            const telP = String(req.body.telefono || '').replace(/\D/g, '');
            if (!telP) return res.status(400).json({ ok: false, error: 'telefono requerido' });
            const rec = require('../lib/seb/recepcion.js');
            const { enviarWA } = require('../lib/seb/citas-vivas.js');
            const OWNER_WA = '5218120066355';
            const rP = await rec.publicarSesion(telP);
            if (!rP.ok) return res.status(200).json({ ok: false, error: rP.error || 'no se pudo publicar' });
            const aP = rP.auto || {};
            await enviarWA(OWNER_WA, `✅ Publicado (particular, desde fyradmin): ${aP.marca} ${aP.modelo} ${aP.anio} — $${Number(aP.precio || 0).toLocaleString('en-US')} — ${aP.photos} fotos${aP.template ? ' — diseño ✓' : ' — ⚠️ diseño pendiente'}`).catch(() => { });
            if (rP.sesion && rP.sesion.telefono) {
                for (const sgP of rec.plantillaPublicado()) await enviarWA(rP.sesion.telefono, sgP).catch(() => { });
            }
            if (rP.siguiente && rP.siguiente.segmentos && rP.sesion && rP.sesion.telefono) {
                for (const sgS of rP.siguiente.segmentos) await enviarWA(rP.sesion.telefono, sgS).catch(() => { });
                await enviarWA(OWNER_WA, `🅿️→🟢 Arranqué el siguiente auto parqueado del mismo vendedor`).catch(() => { });
            }
            return res.status(200).json({ ok: true, auto: aP });
        }
        if (action === 'recepcion_rechazar' && req.method === 'POST') {
            // rechazo MUDO: la sesión se descarta y nada le llega al vendedor — lo que
            // quieras decirle es tuyo (doctrina: el bot no da malas noticias solo).
            const telP = String(req.body.telefono || '').replace(/\D/g, '');
            if (!telP) return res.status(400).json({ ok: false, error: 'telefono requerido' });
            await run("UPDATE recepcion_sesiones SET estado='descartada', updated=? WHERE telefono=? AND estado='revision'", [Date.now(), telP]);
            return res.status(200).json({ ok: true });
        }

        // ═══ IGNACIO RECEPCIÓN — soporte del puente ═══
        // ¿Este teléfono tiene sesión de recepción abierta? (el puente pregunta antes
        // de descargar/subir una foto — así las fotos de compradores no se tocan)
        if (action === 'recepcion_activa') {
            const tR = String((req.query && req.query.telefono) || (req.body && req.body.telefono) || '').replace(/\D/g, '');
            if (!tR) return res.status(400).json({ ok: false, error: 'telefono requerido' });
            const recepcion = require('../lib/seb/recepcion.js');
            const sR = await recepcion.sesionActiva(tR).catch(() => null);
            let activa = !!(sR && sR.estado === 'recepcion');
            // ══ FOTOS COMO INICIADOR (orden owner 2026-07-16): en PRIMER contacto
            // (sin salientes nuestras) las fotos también pasan — agregarFotos
            // despierta a Ignacio a confirmar; si era comprador, el ESCAPE lo regresa.
            // Y un DUEÑO CONOCIDO (2026-07-17) pasa SIEMPRE: sus fotos son otro auto.
            if (!activa) {
                try {
                    const dcR = await recepcion.duenoConocido(tR);
                    if (dcR) activa = true;
                    else {
                        const cvR = await query("SELECT id FROM conversaciones WHERE channel_thread_id=? LIMIT 1", ['whatsapp:' + tR]);
                        if (!cvR.length) activa = true;
                        else {
                            const oR = await query("SELECT COUNT(*) n FROM mensajes WHERE conversacion_id=? AND direccion='out'", [cvR[0].id]);
                            activa = Number(oR[0].n) === 0;
                        }
                    }
                } catch (e) { }
            }
            return res.status(200).json({ ok: true, activa });
        }
        // Foto del VENDEDOR (ya subida al Blob por el puente) → pool de su sesión.
        // Silencio por foto (no spamear); solo al COMPLETAR el checklist se contesta.
        if (action === 'recepcion_foto' && req.method === 'POST') {
            if (String(req.body.key || '') !== (process.env.SELLER_BRIDGE_KEY || 'fyra-bridge-v2-2026')) {
                return res.status(401).json({ ok: false, error: 'key' });
            }
            const tF = String(req.body.telefono || '').replace(/\D/g, '');
            const urlF = String(req.body.url || '');
            if (!tF || !urlF) return res.status(400).json({ ok: false, error: 'telefono y url requeridos' });
            const recepcion = require('../lib/seb/recepcion.js');
            const rF = await recepcion.agregarFotos({ telefono: tF, urls: [urlF] });
            // auditoría #10: mandar SIEMPRE lo que el cerebro diga (el saludo del
            // fotos-iniciador se quedaba mudo en real — solo salía con nacimiento).
            // A media captura el cerebro regresa segmentos [] (silencio anti-spam).
            for (const sx of (rF.segmentos || [])) { try { await citasVivas.enviarWA(tF, sx); } catch (e) { } }
            if (rF.avisoOwner) { try { await citasVivas.enviarWA('5218120066355', rF.avisoOwner); } catch (e) { } }
            return res.status(200).json({ ok: true, activo: rF.activo, fotos: rF.checklist ? rF.checklist.fotos : null, nacimiento: !!rF.nacimiento });
        }

        if (action === 'carga_pieza' && req.method === 'POST') {
            if (String(req.body.key || '') !== (process.env.SELLER_BRIDGE_KEY || 'fyra-bridge-v2-2026')) {
                return res.status(401).json({ ok: false, error: 'key inválida' });
            }
            const { pieza } = require('../lib/seb/carga-lote.js');
            const rp = await pieza({ remitente: req.body.remitente, tipo: req.body.tipo, texto: req.body.texto, url: req.body.url });
            return res.status(200).json(rp || { ok: false });
        }

        if (action === 'manual_directo' && req.method === 'POST') {
            const tel = String(req.body.telefono || '');
            const texto = String(req.body.texto || '').trim();
            // ══ SEÑAL MANUAL (human-in-the-loop real): el owner escribe "cita confirmada"
            // (le confirmaron por teléfono) o "cita cancelada" en el chat del DUEÑO →
            // ejecuta el match/cancelación de verdad (confianza al comprador, recordatorios).
            try { citasVivas.senalManual(tel, texto).catch(() => {}); } catch (e) { }
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
                            // MEDIA del banco (pin de ubicación / fotos) — se manda al consumir el QID.
                            const bUrl = process.env.BRIDGE_SEND_URL, bKey = process.env.BRIDGE_API_KEY;
                            if (bUrl && bKey) {
                                let ph = String(q[0].telefono).replace(/\D/g, ''); if (ph.length === 10) ph = '521' + ph;
                                if (meta.ubic) {
                                    try {
                                        const pe = await query("SELECT image_b64, name, lat, lng, maps_link FROM punto_envio WHERE auto_id=?", [Number(meta.ubic)]);
                                        if (pe[0]) {
                                            const ex = {};
                                            if (pe[0].image_b64) ex.image = pe[0].image_b64;
                                            if (pe[0].lat != null && pe[0].lng != null) ex.location = { lat: pe[0].lat, lng: pe[0].lng, name: pe[0].name || null, maps_link: pe[0].maps_link || null };
                                            if (ex.image || ex.location) await fetch(bUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': bKey }, body: JSON.stringify({ phone: ph, ...ex }) }).catch(() => {});
                                        }
                                    } catch (e) { /* sin pin */ }
                                }
                                if (meta.fotos && meta.fotos.length) {
                                    try {
                                        await fetch(bUrl.replace(/\/api\/send$/, '/api/send-fotos'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': bKey }, body: JSON.stringify({ phone: ph, urls: meta.fotos }) }).catch(() => {});
                                    } catch (e) { /* sin fotos */ }
                                }
                            }
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
