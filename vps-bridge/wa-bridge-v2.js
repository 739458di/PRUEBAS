// wa-bridge-v2.js — El cartero delgado de Fyradrive (Seb v2).
// Vive en el VPS. Hace:
//   1. Conecta WhatsApp por Baileys (muestra QR para vincular).
//   2. Cada mensaje (entrante y saliente tuyo) → lo reenvía a SALES-BRAIN /api/upload
//      (raw_conversations = fuente única) y guarda copia en wa_messages (respaldo).
//   3. Expone HTTP /api/send para que FyraChat mande mensajes SALIENTES.
//
// NO tiene agentes ni lógica de venta — el cerebro (Seb v2) vive aparte.
// Config por variables de entorno (nada hardcodeado).

const baileys = require('@whiskeysockets/baileys');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys;
const { createClient } = require('@libsql/client');
const qrcode = require('qrcode-terminal');
const http = require('http');
const { Boom } = require('@hapi/boom');
let NodeCache; try { NodeCache = require('node-cache'); } catch (e) { NodeCache = null; }

const TURSO_URL = process.env.TURSO_URL || 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const SEND_KEY = process.env.BRIDGE_API_KEY || 'fyra-bridge-v2';
const PORT = Number(process.env.PORT || 3000);
const PLATFORM = 'whatsapp';
const SB_UPLOAD_URL = process.env.SALESBRAIN_UPLOAD_URL || 'https://sales-brain-theta.vercel.app/api/upload';
const SB_KEY = process.env.SALESBRAIN_KEY || 'fyradrive-sb-2026';
// MODO PRUEBA: estos números (por últimos 10 dígitos), cuando contestan un anuncio,
// REINICIAN su conversación (contexto fresco, como comprador nuevo).
const TEST_NUMEROS = new Set((process.env.TEST_NUMEROS || '8120066355').split(',').map(s => s.trim()).filter(Boolean));
// AUTOPILOT del PRIMER mensaje: el bot contesta solo la ráfaga (default ON; AUTO_OPENER=0 lo apaga).
const AUTO_OPENER = process.env.AUTO_OPENER !== '0';
const OPENER_AUTO_URL = process.env.OPENER_AUTO_URL || 'https://fyrachat.vercel.app/api/seb-panel';
const AUTO_OPENER_DELAY = Number(process.env.AUTO_OPENER_DELAY || 9000);   // espera para juntar la ráfaga del comprador (info + pregunta pegada)
const AUTO_OPENER_GAP = Number(process.env.AUTO_OPENER_GAP || 1000);       // ~1s entre cada burbuja

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
let sock = null;
let estado = 'arrancando';
let ultimoQR = null;

// ── Cachés a NIVEL MÓDULO (sobreviven reconexiones) ──────────────────────────
// IDs/textos de mensajes que mandó FyraChat: para saltar su eco fromMe (no duplicar).
const enviadosPorPanel = new Set();
// Mensajes salientes propios, para responder los retry-receipts de Signal (getMessage).
const sentStore = new Map();
// Cuántas veces nos han pedido REENVIAR cada mensaje (si 2+, la sesión del destinatario
// está rota y el reenvío también fallaría → hay que resetear la sesión antes).
const getMsgRetries = new Map();
// Reintentos de descifrado (clave del arreglo #1: sin esto se pierden mensajes).
const msgRetryCounterCache = NodeCache ? new NodeCache() : undefined;

// AUTO-RECUPERACIÓN "Bad MAC / Esperando el mensaje": el tipo de mensaje que WhatsApp
// emite cuando NO se pudo descifrar (la sesión de cifrado de ese contacto se rompió).
const WAStub = baileys.WAMessageStubType || (baileys.proto && baileys.proto.WebMessageInfo && baileys.proto.WebMessageInfo.StubType) || {};
const STUB_CIPHERTEXT = (WAStub.CIPHERTEXT != null) ? WAStub.CIPHERTEXT : 2;
// Resetea la sesión Signal de un contacto → fuerza renegociar una llave limpia en el
// siguiente mensaje (así el cifrado se arregla solo y deja de salir "Esperando el mensaje").
const sesionReseteada = new Map();  // anti-spam: no resetear el mismo contacto a cada rato
async function resetearSesionContacto(jid) {
    try {
        if (!jid || !sock) return;
        const user = String(jid).split('@')[0].split(':')[0].split('.')[0];
        if (!user) return;
        const ahora = Date.now();
        if (sesionReseteada.get(user) && ahora - sesionReseteada.get(user) < 60000) return; // máx 1/min
        sesionReseteada.set(user, ahora);
        const updates = {};
        for (let d = 0; d <= 9; d++) updates[user + '.' + d] = null;  // borra sesiones de todos sus dispositivos
        await sock.authState.keys.set({ session: updates });
        console.log('[recuperación] sesión reseteada para ' + user + ' (Bad MAC) → renegocia sola');
    } catch (e) { console.error('[recuperación] no pude resetear sesión:', e.message); }
}
// Mapas @lid ↔ teléfono real (se persisten en Turso, ver más abajo).
const lidAPhone = new Map();   // lid → teléfono
const phoneALid = new Map();   // teléfono → lid  (para MANDAR al @lid, no al número)
// Cola de envío a SALES-BRAIN POR teléfono: garantiza ORDEN y evita lost-update.
const colasPorTel = new Map();
// EL TIMBRE (WebSocket): FyraChat se conecta y recibe empujones de mensajes nuevos.
let wss = null;   // servidor WebSocket; se crea junto al http server (abajo).
// Empuja un evento a todos los FyraChat conectados (estilo WhatsApp: avisar, no preguntar).
function emitir(obj) {
    if (!wss) return;
    const data = JSON.stringify(obj);
    for (const client of wss.clients) { if (client.readyState === 1) { try { client.send(data); } catch (e) {} } }
}
// Logger silencioso (Baileys lo pide; pino-like mínimo).
const logger = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };

// Encola fn por teléfono para que los mensajes del MISMO hilo se procesen en orden.
function encolar(tel, fn) {
    const prev = colasPorTel.get(tel) || Promise.resolve();
    const next = prev.then(fn).catch(e => console.error('[cola]', e && e.message));
    colasPorTel.set(tel, next);
    return next;
}

// Limpia el teléfono a solo dígitos (quita @s.whatsapp.net / @lid)
function limpiaTel(jid) {
    return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Persiste un mapeo @lid → teléfono (sobrevive reinicios).
function recordarLid(lid, phone) {
    if (!lid || !phone || lid === phone) return;
    const nuevo = lidAPhone.get(lid) !== phone;          // ¿mapeo que NO conocíamos?
    lidAPhone.set(lid, phone);
    phoneALid.set(phone, lid);
    db.execute({
        sql: 'INSERT INTO lid_phone_map (lid, phone, updated_at) VALUES (?, ?, ?) ON CONFLICT(lid) DO UPDATE SET phone=excluded.phone, updated_at=excluded.updated_at',
        args: [lid, phone, Date.now()]
    }).catch(() => {});
    // AUTO-CURACIÓN: si justo aprendimos este @lid↔teléfono, unir la conversación
    // huérfana (la que quedó bajo el @lid) con la del teléfono real. Evita el "split".
    if (nuevo) fusionarSiHuerfano(lid, phone).catch(() => {});
}

// Une la conversación que quedó bajo el @lid con la del teléfono real (cero pérdidas).
// - Mueve el contexto del anuncio (auto/link) al teléfono.
// - Si NO existe la del teléfono → re-apunta el huérfano al teléfono.
// - Si existen AMBAS → fusiona los mensajes (huérfano primero, es más viejo) y borra el huérfano.
// Fusiona la LIBRETA NUEVA (conversaciones + mensajes) cuando una conversación quedó bajo
// el @lid y luego se aprende su teléfono. Sin esto, la conversación se ve PARTIDA en FyraChat.
async function fusionarLibretaNueva(lid, phone) {
    const orfanoT = 'whatsapp:' + lid, canonT = 'whatsapp:' + phone;
    try {
        const L = await db.execute({ sql: 'SELECT id FROM conversaciones WHERE channel_thread_id=?', args: [orfanoT] });
        if (!L.rows.length) return;
        const lidId = L.rows[0].id;
        const P = await db.execute({ sql: 'SELECT id FROM conversaciones WHERE channel_thread_id=?', args: [canonT] });
        if (!P.rows.length) {                                          // no existe la del teléfono → re-apuntar
            await db.execute({ sql: 'UPDATE conversaciones SET channel_thread_id=?, telefono=? WHERE id=?', args: [canonT, phone, lidId] });
            console.log('[FUSION-nueva] re-apuntada conv ' + lidId + ' → ' + canonT);
            return;
        }
        const phoneId = P.rows[0].id;                                  // existen ambas → mover mensajes + borrar @lid
        await db.execute({ sql: 'UPDATE OR IGNORE mensajes SET conversacion_id=? WHERE conversacion_id=?', args: [phoneId, lidId] });
        await db.execute({ sql: 'DELETE FROM mensajes WHERE conversacion_id=?', args: [lidId] });
        await db.execute({ sql: 'DELETE FROM conversaciones WHERE id=?', args: [lidId] });
        const last = await db.execute({ sql: 'SELECT direccion, texto, ts FROM mensajes WHERE conversacion_id=? ORDER BY ts DESC, id DESC LIMIT 1', args: [phoneId] });
        if (last.rows.length) { const m = last.rows[0]; await db.execute({ sql: 'UPDATE conversaciones SET ult_texto=?, ult_dir=?, ult_msg_ts=? WHERE id=?', args: [String(m.texto || '').slice(0, 200), m.direccion, m.ts, phoneId] }); }
        console.log('[FUSION-nueva] fusionada conv ' + lidId + ' → ' + phoneId);
    } catch (e) { console.error('[FUSION-nueva] error:', e.message); }
}

async function fusionarSiHuerfano(lid, phone) {
    const orfanoT = 'whatsapp:' + lid, canonT = 'whatsapp:' + phone;
    fusionarLibretaNueva(lid, phone).catch(() => {});   // NUEVO: fusiona también la libreta nueva (FyraChat)
    // 1) el anuncio (qué auto + link) sigue al teléfono
    db.execute({
        sql: 'INSERT INTO ad_por_telefono (telefono, ad_context, updated_at) SELECT ?, ad_context, updated_at FROM ad_por_telefono WHERE telefono=? ON CONFLICT(telefono) DO UPDATE SET ad_context=excluded.ad_context, updated_at=excluded.updated_at',
        args: [phone, lid]
    }).catch(() => {});
    let o; try { o = await db.execute({ sql: 'SELECT * FROM raw_conversations WHERE channel_thread_id=? LIMIT 1', args: [orfanoT] }); } catch (e) { return; }
    if (!o.rows.length) return;                                   // no hay huérfano → nada que unir
    const orf = o.rows[0];
    const c = await db.execute({ sql: 'SELECT * FROM raw_conversations WHERE channel_thread_id=? LIMIT 1', args: [canonT] });
    if (!c.rows.length) {                                          // no existe la del teléfono → re-apuntar
        await db.execute({ sql: 'UPDATE raw_conversations SET channel_thread_id=? WHERE id=?', args: [canonT, orf.id] }).catch(() => {});
        console.log('[FUSION] re-apuntada conv ' + orf.id + ': ' + orfanoT + ' → ' + canonT);
        return;
    }
    const can = c.rows[0];                                         // existen ambas → fusionar mensajes
    let a = [], b = [];
    try { a = JSON.parse(orf.cleaned_text || '[]'); } catch (e) {}
    try { b = JSON.parse(can.cleaned_text || '[]'); } catch (e) {}
    const merged = a.concat(b).map((x, i) => ({ ...x, index: i + 1 }));
    const rawMerged = [orf.raw_text, can.raw_text].filter(Boolean).join('\n\n--- CONTINUACIÓN ---\n\n');
    await db.execute({ sql: 'UPDATE raw_conversations SET cleaned_text=?, raw_text=? WHERE id=?', args: [JSON.stringify(merged), rawMerged, can.id] }).catch(() => {});
    await db.execute({ sql: 'DELETE FROM raw_conversations WHERE id=?', args: [orf.id] }).catch(() => {});
    console.log('[FUSION] unida conv ' + orf.id + ' → ' + can.id + ' (' + merged.length + ' msgs)');
}

// Devuelve el TELÉFONO REAL del comprador (no el @lid). Aprende el mapeo de los entrantes.
function telefonoReal(m) {
    const jid = m.key.remoteJid || '';
    if (jid.endsWith('@s.whatsapp.net')) return limpiaTel(jid);   // ya es teléfono
    const lid = limpiaTel(jid);                                    // es @lid
    if (!m.key.fromMe) {                                           // ENTRANTE: senderPn = teléfono real
        // senderPn/participantPn YA son el teléfono real; remoteJidAlt lo es cuando es @s.whatsapp.net.
        let pn = m.key.senderPn || m.key.participantPn;
        if (!pn && String(m.key.remoteJidAlt || '').endsWith('@s.whatsapp.net')) pn = m.key.remoteJidAlt;
        if (pn) { const ph = limpiaTel(pn); if (ph) { recordarLid(lid, ph); return ph; } }
    }
    if (lidAPhone.has(lid)) return lidAPhone.get(lid);             // resolver por mapa persistido
    return lid;                                                    // último recurso: el @lid
}

// Saca el contexto del anuncio (auto + link) si el mensaje vino de un anuncio de Facebook.
function adContextDe(m) {
    const ci = m.message?.extendedTextMessage?.contextInfo;
    const ad = ci?.externalAdReply;
    if (!ad) return null;
    const partes = [ad.title, ad.body, ad.sourceUrl, ci?.matchedText].filter(Boolean);
    return partes.length ? partes.join(' | ').slice(0, 1200) : null;
}
// Saca SOLO el link del anuncio, para mostrarlo en FyraChat tal cual en WhatsApp.
function adLinkDe(m) {
    const ci = m.message?.extendedTextMessage?.contextInfo;
    return ci?.externalAdReply?.sourceUrl || ci?.matchedText || ci?.canonicalUrl || null;
}
// Saca el texto de CUALQUIER tipo de mensaje. NUNCA regresa vacío → cero pérdidas.
function textoDeMensaje(message) {
    if (!message) return '[mensaje]';
    // desenvolver mensajes "envueltos" (efímeros, ver-una-vez, editados, etc.)
    const wrap = message.ephemeralMessage?.message || message.viewOnceMessage?.message
        || message.viewOnceMessageV2?.message || message.viewOnceMessageV2Extension?.message
        || message.documentWithCaptionMessage?.message || message.editedMessage?.message;
    if (wrap) return textoDeMensaje(wrap);
    return message.conversation
        || message.extendedTextMessage?.text
        || message.imageMessage?.caption || (message.imageMessage ? '[imagen]' : null)
        || message.videoMessage?.caption || (message.videoMessage ? '[video]' : null)
        || message.documentMessage?.caption || (message.documentMessage ? '[documento]' : null)
        || (message.audioMessage ? (message.audioMessage.ptt ? '[nota de voz]' : '[audio]') : null)
        || (message.stickerMessage ? '[sticker]' : null)
        || (message.locationMessage ? '[ubicación]' : null)
        || (message.liveLocationMessage ? '[ubicación en vivo]' : null)
        || (message.contactMessage ? ('[contacto] ' + (message.contactMessage.displayName || '')).trim() : null)
        || (message.contactsArrayMessage ? '[contactos]' : null)
        || message.buttonsResponseMessage?.selectedDisplayText
        || message.listResponseMessage?.title
        || message.templateButtonReplyMessage?.selectedDisplayText
        || (message.reactionMessage ? (message.reactionMessage.text || '[reacción]') : null)
        || (message.pollCreationMessage ? ('[encuesta] ' + (message.pollCreationMessage.name || '')).trim() : null)
        || '[mensaje]';                                  // ÚLTIMO recurso: nunca vacío
}

// Guarda un mensaje (entrante o saliente) en wa_messages (respaldo).
async function guardar({ telefono, nombre, mensaje, direccion, tipo, mensaje_id, ai_generated }) {
    try {
        await db.execute({
            sql: `INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, leido, created_at, ai_generated, platform)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
            args: [mensaje_id || null, telefono, nombre || null, mensaje, tipo || 'text', direccion,
                   Math.floor(Date.now() / 1000), mensaje_id || null, Date.now(), ai_generated ? 1 : 0, PLATFORM]
        });
    } catch (e) { console.error('[GUARDAR]', e.message); }
}

// Deriva el tipo de mensaje para la libreta nueva.
function tipoDeMsg(message) {
    const w = message?.ephemeralMessage?.message || message?.viewOnceMessage?.message
        || message?.viewOnceMessageV2?.message || message?.documentWithCaptionMessage?.message || message || {};
    if (w.imageMessage) return 'image';
    if (w.videoMessage) return 'video';
    if (w.audioMessage) return 'audio';
    if (w.documentMessage) return 'document';
    if (w.stickerMessage) return 'sticker';
    if (w.locationMessage || w.liveLocationMessage) return 'location';
    if (w.contactMessage || w.contactsArrayMessage) return 'contact';
    return 'text';
}

// FASE 2 — escribe cada mensaje como RENGLÓN con FOLIO en la libreta nueva (conversaciones + mensajes).
// Dedup por (conversacion_id, msg_id): si llega 2 veces (re-entrega), INSERT OR IGNORE no lo duplica.
// Usa la HORA REAL del mensaje (ts en ms), no la de ingesta → arregla el desfase.
async function guardarMensajeNuevo({ tel, msgId, ts, direccion, emisor, texto, tipo, nombre, ai_generated }) {
    if (!tel || !msgId) return;
    const thread = 'whatsapp:' + tel;
    try {
        // 1) carpeta: crear si no existe; subir su actividad solo si este mensaje es el más nuevo
        await db.execute({
            sql: `INSERT INTO conversaciones (channel_thread_id, telefono, nombre, ult_texto, ult_dir, ult_msg_ts, no_leidos, source, created_at)
                  VALUES (?,?,?,?,?,?, 0, 'whatsapp', ?)
                  ON CONFLICT(channel_thread_id) DO UPDATE SET
                    nombre = COALESCE(excluded.nombre, nombre),
                    ult_texto = CASE WHEN excluded.ult_msg_ts >= ult_msg_ts THEN excluded.ult_texto ELSE ult_texto END,
                    ult_dir   = CASE WHEN excluded.ult_msg_ts >= ult_msg_ts THEN excluded.ult_dir ELSE ult_dir END,
                    ult_msg_ts = MAX(excluded.ult_msg_ts, ult_msg_ts)`,
            args: [thread, tel, nombre || null, String(texto || '').slice(0, 120), direccion, ts, ts]
        });
        const row = (await db.execute({ sql: 'SELECT id FROM conversaciones WHERE channel_thread_id=?', args: [thread] })).rows[0];
        if (!row) return;
        // 2) papelito con folio (dedup por folio → JAMÁS duplica)
        await db.execute({
            sql: 'INSERT OR IGNORE INTO mensajes (conversacion_id, msg_id, ts, direccion, emisor, texto, tipo, ai_generated, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
            args: [row.id, msgId, ts, direccion, emisor || null, texto || '', tipo || 'text', ai_generated ? 1 : 0, Date.now()]
        });
    } catch (e) { console.error('[mensajes-nuevo]', e.message); }
}

// Reenvía un mensaje a SALES-BRAIN /api/upload. El router de SALES-BRAIN decide
// solo: conversación nueva o append (por external_id = teléfono real).
async function mandarASalesBrain({ external_id, text, from_name, direction, ad_context, message_timestamp }) {
    if (!external_id) return;                              // sin identidad no hay dónde guardar
    if (!text) text = '[mensaje]';                         // jamás descartar por texto vacío
    const body = JSON.stringify({
        text, channel: 'whatsapp', external_id,
        from_name: from_name || null, from_phone: external_id,
        source: 'whatsapp', message_timestamp: message_timestamp || Date.now(),
        direction, ad_context: ad_context || null
    });
    // REINTENTOS: si SALES-BRAIN falla (red/timeout/5xx), reintenta. Así un mensaje
    // SIEMPRE termina en raw_conversations y jamás se pierde por un hipo de red.
    for (let intento = 1; intento <= 4; intento++) {
        try {
            const r = await fetch(SB_UPLOAD_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': SB_KEY },
                body
            });
            if (!r.ok) {
                console.error('[SALESBRAIN] HTTP ' + r.status + ' (intento ' + intento + '/4)');
                if (r.status >= 400 && r.status < 500) return;            // error del cliente → no insistir
                await sleep(1000 * intento); continue;                    // 5xx → reintentar
            }
            // Subir la fecha de ACTIVIDAD + la FICHA (último texto/dir/nombre) para que la
            // lista de FyraChat lea ligero y el chat brinque arriba.
            const d = await r.json().catch(() => null);
            if (d && d.conversation_id) {
                db.execute({
                    sql: 'UPDATE raw_conversations SET last_ingested_at=?, ult_texto=?, ult_dir=?, ult_nombre=COALESCE(?, ult_nombre) WHERE id=?',
                    args: [Date.now(), String(text || '').slice(0, 120), direction === 'inbound' ? 'in' : 'out', from_name || null, d.conversation_id]
                }).catch(() => {});
            }
            return;                                                        // éxito
        } catch (e) {
            console.error('[SALESBRAIN] ' + e.message + ' (intento ' + intento + '/4)');
            if (intento < 4) await sleep(1000 * intento);
        }
    }
    console.error('[SALESBRAIN] ⚠️ NO entregado tras 4 intentos: ' + external_id + ' "' + String(text).slice(0, 40) + '"');
}

let reintentos = 0;
async function conectar() {
    // Cargar el mapa @lid → teléfono desde Turso (sobrevive reinicios).
    try {
        await db.execute('CREATE TABLE IF NOT EXISTS lid_phone_map (lid TEXT PRIMARY KEY, phone TEXT, updated_at INTEGER)');
        // Anuncio (auto+link) por teléfono → el cerebro lo mete a la mochila como [DESC:]
        await db.execute('CREATE TABLE IF NOT EXISTS ad_por_telefono (telefono TEXT PRIMARY KEY, ad_context TEXT, updated_at INTEGER)');
        // Modo prueba: punto de reinicio por teléfono (solo se ven mensajes posteriores)
        await db.execute('CREATE TABLE IF NOT EXISTS prueba_reset (telefono TEXT PRIMARY KEY, reset_ts INTEGER)');
        const cached = await db.execute('SELECT lid, phone FROM lid_phone_map');
        for (const row of cached.rows) { lidAPhone.set(String(row.lid), String(row.phone)); phoneALid.set(String(row.phone), String(row.lid)); }
        console.log('[lid-map] cargados ' + lidAPhone.size + ' mapeos');
    } catch (e) { console.error('[lid-map] no pude cargar:', e.message); }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); console.log('WA version:', version?.join('.')); }
    catch (e) { console.log('No pude obtener versión WA, uso default:', e.message); }

    const keys = (typeof makeCacheableSignalKeyStore === 'function')
        ? makeCacheableSignalKeyStore(state.keys, logger) : state.keys;

    sock = makeWASocket({
        version,
        auth: { creds: state.creds, keys },
        logger,
        printQRInTerminal: false,
        syncFullHistory: false,
        browser: ['Fyradrive', 'Chrome', '120.0.0'],
        markOnlineOnConnect: true,
        msgRetryCounterCache,
        // ARREGLO #1: responder los retry-receipts de Signal con el mensaje original.
        getMessage: async (key) => {
            // Si nos piden reenviar el MISMO mensaje 2+ veces, el destinatario no lo pudo
            // descifrar (sesión rota) → resetea su sesión ANTES de reenviar para que renegocie.
            const n = (getMsgRetries.get(key.id) || 0) + 1;
            getMsgRetries.set(key.id, n);
            setTimeout(() => getMsgRetries.delete(key.id), 60 * 60000);
            if (n >= 2 && key.remoteJid) { await resetearSesionContacto(key.remoteJid).catch(() => {}); }
            const m = sentStore.get(key.id);
            return m ? m.message : undefined;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) {
            ultimoQR = qr; estado = 'esperando_qr';
            console.log('\n================ ESCANEA ESTE QR CON WHATSAPP ================\n');
            qrcode.generate(qr, { small: true });
            console.log('\nWhatsApp → Dispositivos vinculados → Vincular un dispositivo\n');
        }
        if (connection === 'open') { estado = 'conectado'; ultimoQR = null; reintentos = 0; console.log('\n✅ WHATSAPP CONECTADO\n'); }
        if (connection === 'close') {
            const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            const reconectar = code !== DisconnectReason.loggedOut;
            estado = 'cerrado';
            reintentos++;
            const espera = Math.min(30000, 3000 * reintentos);
            console.log('Conexión cerrada (code ' + code + '). ' + (reconectar ? 'Reconectando en ' + (espera / 1000) + 's…' : 'Sesión cerrada — re-vincular.'));
            if (reconectar) setTimeout(conectar, espera);
        }
    });

    // MENSAJES → guardar (ENTRANTES del comprador y SALIENTES tuyos), en orden.
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;
        for (const m of messages) {
            if (m.key.remoteJid?.endsWith('@g.us')) continue;     // ignorar grupos
            if (m.key.remoteJid === 'status@broadcast') continue; // ignorar estados
            // AUTO-RECUPERACIÓN: si este mensaje NO se pudo descifrar (Bad MAC / "Esperando el
            // mensaje"), resetea la sesión de ese contacto para que renegocie una llave limpia.
            if (m.messageStubType === STUB_CIPHERTEXT) { resetearSesionContacto(m.key.remoteJid).catch(() => {}); continue; }
            const esSaliente = !!m.key.fromMe;                    // lo mandaste TÚ
            // Eco de un mensaje que ya mandó FyraChat → ya quedó registrado, saltar
            if (esSaliente && enviadosPorPanel.has(m.key.id)) { enviadosPorPanel.delete(m.key.id); continue; }
            // Eco SALIENTE de MEDIA (imagen/pin/video/doc/audio): NO crear burbuja en FyraChat.
            // Lo que mandamos (p.ej. el paquete de ubicación) ya está representado por su texto;
            // el eco de la imagen/pin se vería como "[imagen]"/"[ubicación]". Race-proof: por TIPO,
            // no por folio (el anti-eco por folio falla por carrera de tiempos con media).
            if (esSaliente) {
                const w = m.message || {};
                if (w.imageMessage || w.videoMessage || w.documentMessage || w.audioMessage || w.stickerMessage || w.locationMessage || w.liveLocationMessage) continue;
            }
            // saltar SOLO mensajes de sistema sin contenido (distribución de llaves) — JAMÁS un mensaje real
            const mk = Object.keys(m.message || {});
            if (!m.message || (mk.length && mk.every(k => k === 'senderKeyDistributionMessage' || k === 'messageContextInfo'))) continue;
            let texto = textoDeMensaje(m.message);                // robusto: cualquier tipo, nunca vacío → cero pérdidas
            const tel = telefonoReal(m);                          // TELÉFONO REAL (no @lid)
            const adContext = esSaliente ? null : adContextDe(m); // contexto del anuncio (auto + link)
            const adLink = esSaliente ? null : adLinkDe(m);       // link del anuncio
            if (adLink && !texto.includes(adLink)) texto = '🔗 ' + adLink + '\n' + texto;  // mostrarlo en FyraChat como en WhatsApp
            // Guardar el anuncio por teléfono → el cerebro lo usará para saber QUÉ AUTO
            if (adContext) db.execute({
                sql: 'INSERT INTO ad_por_telefono (telefono, ad_context, updated_at) VALUES (?,?,?) ON CONFLICT(telefono) DO UPDATE SET ad_context=excluded.ad_context, updated_at=excluded.updated_at',
                args: [tel, adContext, Date.now()]
            }).catch(() => {});
            // MODO PRUEBA: si un número de prueba contesta un anuncio → REINICIAR contexto
            // (solo se verán los mensajes de aquí en adelante, como comprador nuevo).
            if (adContext && TEST_NUMEROS.has(tel.slice(-10))) {
                db.execute({
                    sql: 'INSERT INTO prueba_reset (telefono, reset_ts) VALUES (?,?) ON CONFLICT(telefono) DO UPDATE SET reset_ts=excluded.reset_ts',
                    args: [tel, Date.now() - 3000]
                }).catch(() => {});
                console.log('[PRUEBA] reinicio de contexto para ' + tel);
            }
            // HORA REAL del mensaje (Baileys m.messageTimestamp, segundos) — no la de ingesta.
            const msgTs = (() => { const t = m.messageTimestamp; const n = (t && typeof t.toNumber === 'function') ? t.toNumber() : Number(t); return (isFinite(n) && n > 1e9) ? n * 1000 : Date.now(); })();
            const tipoMsg = tipoDeMsg(m.message);
            await guardar({
                telefono: tel,
                nombre: esSaliente ? null : (m.pushName || null),
                mensaje: texto,
                direccion: esSaliente ? 'out' : 'in',
                tipo: tipoMsg,
                mensaje_id: m.key.id,
                ai_generated: 0
            });
            // FASE 2 — LIBRETA NUEVA: renglón con FOLIO + hora real (dedup por folio → JAMÁS duplica)
            guardarMensajeNuevo({
                tel, msgId: m.key.id, ts: msgTs,
                direccion: esSaliente ? 'out' : 'in',
                emisor: esSaliente ? 'SRS010904' : (m.pushName || null),
                texto, tipo: tipoMsg,
                nombre: esSaliente ? null : (m.pushName || null),
                ai_generated: 0
            }).catch(() => {});
            // Reenviar a SALES-BRAIN EN ORDEN por teléfono (cola). Sigue llenando lo VIEJO en paralelo.
            encolar(tel, () => mandarASalesBrain({
                external_id: tel,
                text: texto,
                from_name: esSaliente ? null : m.pushName,
                direction: esSaliente ? 'outbound' : 'inbound',
                ad_context: adContext
            }));
            // 🔔 TIMBRE: empuja el mensaje a FyraChat al instante (con FOLIO + hora real)
            emitir({ tipo: 'mensaje', telefono: tel, mensaje: texto, direccion: esSaliente ? 'out' : 'in', timestamp: Math.floor(msgTs / 1000), nombre: esSaliente ? null : (m.pushName || null), msg_id: m.key.id });
            console.log((esSaliente ? '→ ' : '← ') + tel + ': ' + String(texto).slice(0, 50) + (adContext ? '  [ANUNCIO]' : ''));
            // AUTOPILOT: primer mensaje de un COMPRADOR → el bot contesta solo (ráfaga).
            // El cerebro (/opener_auto, reset-aware) decide si aplica; aquí solo debounce.
            if (!esSaliente) programarAutoOpener(tel);
        }
    });
}

// ── AUTOPILOT DEL PRIMER MENSAJE ─────────────────────────────────────────────
// Cuando un comprador escribe por PRIMERA vez (no hemos respondido), el bot manda
// SOLO la ráfaga del playbook (1 burbuja por mensaje, ~1s de diferencia). Una vez
// por conversación. El cerebro (FyraChat /opener_auto) decide si aplica.
const autoOpenerTimers = new Map();   // tel → timeout (debounce: junta su ráfaga)
const autoOpenerEnVuelo = new Set();  // tel → procesando ahora (anti-concurrencia)

// Envía UN texto saliente del bot y lo registra/emite a FyraChat (igual que /api/send).
async function autoEnviarTexto(p, text) {
    const destino = phoneALid.has(p) ? (phoneALid.get(p) + '@lid') : (p + '@s.whatsapp.net');
    const r = await sock.sendMessage(destino, { text });
    if (r?.key?.id) {
        enviadosPorPanel.add(r.key.id);
        sentStore.set(r.key.id, r);
        setTimeout(() => { enviadosPorPanel.delete(r.key.id); sentStore.delete(r.key.id); }, 60 * 60000);
    }
    const ts = Date.now();
    await guardar({ telefono: p, mensaje: text, direccion: 'out', mensaje_id: r?.key?.id, ai_generated: 1 }).catch(() => {});
    if (r?.key?.id) guardarMensajeNuevo({ tel: p, msgId: r.key.id, ts, direccion: 'out', emisor: 'SRS010904', texto: text, tipo: 'text', nombre: null, ai_generated: 1 }).catch(() => {});
    emitir({ tipo: 'mensaje', telefono: p, mensaje: text, direccion: 'out', timestamp: Math.floor(ts / 1000), msg_id: r?.key?.id });
    encolar(p, () => mandarASalesBrain({ external_id: p, text, direction: 'outbound' }));
    return r;
}

// Debounce: cada entrante reinicia el reloj; al expirar (no llegaron más) dispara una vez.
function programarAutoOpener(tel) {
    if (!AUTO_OPENER) return;
    if (autoOpenerTimers.has(tel)) clearTimeout(autoOpenerTimers.get(tel));
    autoOpenerTimers.set(tel, setTimeout(() => {
        autoOpenerTimers.delete(tel);
        dispararAutoOpener(tel).catch(e => console.error('[auto-opener]', e && e.message));
    }, AUTO_OPENER_DELAY));
}

async function dispararAutoOpener(tel) {
    if (estado !== 'conectado' || autoOpenerEnVuelo.has(tel)) return;
    autoOpenerEnVuelo.add(tel);   // lock anti-concurrencia mientras procesa/envía
    try {
        // El cerebro (reset-aware) decide TODO: primer contacto, auto resuelto,
        // no dueño/vendedor. Si no aplica → no manda nada (queda en modo manual).
        let segmentos = null;
        try {
            const r = await fetch(OPENER_AUTO_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'opener_auto', telefono: tel })
            });
            const d = await r.json().catch(() => ({}));
            if (d && d.ok && Array.isArray(d.segmentos) && d.segmentos.length) segmentos = d.segmentos;
        } catch (e) { console.error('[auto-opener] cerebro:', e.message); }
        if (!segmentos) return;
        // Mandar la ráfaga: 1 burbuja por mensaje, ~1s de diferencia.
        let p = tel.replace(/\D/g, ''); if (p.length === 10) p = '521' + p;
        for (let i = 0; i < segmentos.length; i++) {
            try { await autoEnviarTexto(p, segmentos[i]); } catch (e) { console.error('[auto-opener] envío:', e.message); }
            if (i < segmentos.length - 1) await sleep(AUTO_OPENER_GAP);
        }
        console.log('[auto-opener] ráfaga enviada a ' + tel + ' (' + segmentos.length + ' msgs)');
    } finally { autoOpenerEnVuelo.delete(tel); }
}

// SERVIDOR HTTP: /status, /qr y /api/send (+ WebSocket "timbre" abajo)
const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/status') {
        return res.end(JSON.stringify({ ok: true, estado, conectado: estado === 'conectado', lid_map: lidAPhone.size }));
    }
    if (req.url === '/qr') {
        return res.end(JSON.stringify({ ok: true, estado, qr: ultimoQR }));
    }
    if (req.url === '/api/send' && req.method === 'POST') {
        if (req.headers['x-api-key'] !== SEND_KEY) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { phone, text, image, location } = JSON.parse(body || '{}');
                // Ahora se acepta texto Y/O imagen Y/O pin de ubicación (paquete de ubicación).
                if (!phone || (!text && !image && !location)) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'phone y (text|image|location) requeridos' })); }
                if (estado !== 'conectado') { res.statusCode = 503; return res.end(JSON.stringify({ ok: false, error: 'whatsapp no conectado' })); }
                let p = String(phone).replace(/\D/g, '');
                if (lidAPhone.has(p)) p = lidAPhone.get(p);        // si llegó un @lid, traducir a teléfono real
                if (p.length === 10) p = '521' + p;
                // MANDAR al @lid si lo conocemos (WhatsApp migró a direccionamiento LID).
                const destino = phoneALid.has(p) ? (phoneALid.get(p) + '@lid') : (p + '@s.whatsapp.net');

                // Envía UN mensaje. persistir=true → lo guarda/emite a FyraChat (texto).
                // persistir=false → SOLO lo manda a WhatsApp (imagen/pin del paquete: no se
                // muestran como burbuja en FyraChat; el texto formal ya representa el paquete).
                const enviarUno = async (content, repTexto, tipo, persistir) => {
                    const r = await sock.sendMessage(destino, content);
                    if (r?.key?.id) {
                        enviadosPorPanel.add(r.key.id);
                        sentStore.set(r.key.id, r);
                        setTimeout(() => { enviadosPorPanel.delete(r.key.id); sentStore.delete(r.key.id); }, 60 * 60000);  // 60 min: ventana amplia para reenviar en retry-receipts
                    }
                    if (persistir) {
                        const ts = Date.now();
                        await guardar({ telefono: p, mensaje: repTexto, direccion: 'out', mensaje_id: r?.key?.id, ai_generated: 1 }).catch(() => {});
                        if (r?.key?.id) guardarMensajeNuevo({ tel: p, msgId: r.key.id, ts, direccion: 'out', emisor: 'SRS010904', texto: repTexto, tipo: tipo || 'text', nombre: null, ai_generated: 1 }).catch(() => {});
                        emitir({ tipo: 'mensaje', telefono: p, mensaje: repTexto, direccion: 'out', timestamp: Math.floor(ts / 1000), msg_id: r?.key?.id });
                    }
                    return r;
                };

                let lastId = null;
                // 1) CAPTURA branded del mapa — SOLO a WhatsApp (no se muestra en FyraChat)
                if (image) {
                    const buf = Buffer.from(String(image).replace(/^data:[^,]+,/, ''), 'base64');
                    const r = await enviarUno({ image: buf, caption: undefined }, '', 'image', false);
                    lastId = r?.key?.id || lastId;
                }
                // 2) TEXTO (mensaje formal + cita) — este SÍ se muestra en FyraChat
                if (text) {
                    const r = await enviarUno({ text }, text, 'text', true);
                    lastId = r?.key?.id || lastId;
                    encolar(p, () => mandarASalesBrain({ external_id: p, text, direction: 'outbound' }));
                }
                // 3) PIN de ubicación nativo — SOLO a WhatsApp (no se muestra en FyraChat)
                if (location && location.lat != null && location.lng != null) {
                    const loc = { degreesLatitude: Number(location.lat), degreesLongitude: Number(location.lng) };
                    if (location.name) loc.name = String(location.name);
                    if (location.address) loc.address = String(location.address);
                    const r = await enviarUno({ location: loc }, '', 'location', false);
                    lastId = r?.key?.id || lastId;
                }
                res.end(JSON.stringify({ ok: true, messageId: lastId }));
            } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ ok: false }));
});
// EL TIMBRE: WebSocket sobre el mismo servidor/puerto. FyraChat se conecta aquí.
try {
    const { WebSocketServer } = require('ws');
    wss = new WebSocketServer({ server });
    wss.on('connection', (c) => { try { c.send(JSON.stringify({ tipo: 'hola' })); } catch (e) {} });
    console.log('🔔 Timbre WebSocket listo');
} catch (e) { console.error('ws no disponible:', e.message); }
server.listen(PORT, () => console.log('Bridge HTTP en puerto ' + PORT));

conectar().catch(e => { console.error('FATAL', e); process.exit(1); });
