// wa-bridge-v3.js — El cartero MULTI-UNIVERSO de Fyradrive (Fase 1, 2026-09-07).
// Un universo = un WhatsApp de un vendedor (tenant): carpeta auth/<tenantId>, socket propio,
// memoria propia, handlers con el tenant capturado en closure. Mapa `universos`.
// Tenant 0 = el número principal: TODO su comportamiento v2 vive intacto dentro de su universo.
// Universos != 0: en Fase 1 NO procesan ni guardan nada (solo latido) — Ley 2 hasta la Fase 2.
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

const crypto = require('crypto');

// ── .env LOCAL (anti-hackeo 2026-09-10): el puente lee /root/wa-bridge/.env él mismo y rellena SOLO lo que pm2 no
//    haya inyectado. Así un `pm2 restart` sin --update-env jamás arranca sin K_PUENTE. Sin dependencia dotenv.
(function cargarEnvLocal() {
    try {
        const txt = require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8');
        for (const linea of txt.split(/\r?\n/)) {
            if (!linea.trim() || linea.trim().startsWith('#')) continue;
            const mm = linea.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (!mm) continue;
            let v = mm[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
            if (process.env[mm[1]] === undefined || process.env[mm[1]] === '') process.env[mm[1]] = v;
        }
    } catch (e) {}
})();

const TURSO_URL = process.env.TURSO_URL || 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const PORT = Number(process.env.PORT || 3000);
const PLATFORM = 'whatsapp';
const SB_UPLOAD_URL = process.env.SALESBRAIN_UPLOAD_URL || 'https://sales-brain-theta.vercel.app/api/upload';

// ── LLAVE ÚNICA DEL PUENTE (spec seguridad-acceso 2026-09-10, BLOQUE 4). JAMÁS un literal de llave en el código.
//    K_PUENTE  = la llave que el puente EXIGE en el header x-api-key de toda petición entrante, y la que él MANDA
//                en x-api-key a fyrachat (seb-panel) y a Sales Brain (/api/upload ingesta).
//    KEY_VIEJA = SOLO durante la rotación: se acepta además como x-api-key entrante (console.warn '[key-vieja]')
//                y se manda como body.key / ?key= de salida para que el fyrachat VIEJO siga aceptando hasta que se
//                despliegue el nuevo. Acepta varias separadas por coma (la primera es la que se manda). Vacía = fin.
//    BRIDGE_API_KEY / SEND_KEY / SALESBRAIN_KEY / CASILLA_KEY ya NO existen: si hay que aceptar la vieja, va en KEY_VIEJA.
//    Sin K_PUENTE el puente NO arranca (falla cerrada, invariante 1).
const K_PUENTE = String(process.env.K_PUENTE || '').trim();
if (!K_PUENTE) { console.error('FATAL: falta K_PUENTE en /root/wa-bridge/.env'); process.exit(1); }
const KEYS_VIEJAS = String(process.env.KEY_VIEJA || '').split(',').map(x => x.trim()).filter(Boolean);
const KEY_VIEJA_SALIDA = KEYS_VIEJAS[0] || '';
if (KEYS_VIEJAS.length) console.warn('[key-vieja] transición ACTIVA: se acepta/manda también la llave vieja (KEY_VIEJA). Bórrala al terminar la rotación.');
const sha256 = (x) => crypto.createHash('sha256').update(String(x)).digest();
const mismaLlave = (a, b) => !!(a && b) && crypto.timingSafeEqual(sha256(a), sha256(b));   // tiempo constante
// ¿La petición ENTRANTE trae llave válida? SOLO header x-api-key (nada por query ni body — invariante 2).
function llaveEntrante(req, ruta) {
    const hdr = String(req.headers['x-api-key'] || '');
    if (mismaLlave(hdr, K_PUENTE)) return true;
    for (const v of KEYS_VIEJAS) if (mismaLlave(hdr, v)) { console.warn('[key-vieja]', ruta); return true; }
    return false;
}
// SALIDAS del puente (fyrachat seb-panel, Sales Brain): header SIEMPRE; body.key / ?key= SOLO mientras dure la transición.
const HDR_PUENTE = Object.freeze({ 'Content-Type': 'application/json', 'x-api-key': K_PUENTE });
const cuerpoPanel = (o) => JSON.stringify(KEY_VIEJA_SALIDA ? Object.assign({ key: KEY_VIEJA_SALIDA }, o) : o);
const queryVieja = () => (KEY_VIEJA_SALIDA ? '&key=' + encodeURIComponent(KEY_VIEJA_SALIDA) : '');
// MODO PRUEBA: estos números (por últimos 10 dígitos), cuando contestan un anuncio,
// REINICIAN su conversación (contexto fresco, como comprador nuevo).
const TEST_NUMEROS = new Set((process.env.TEST_NUMEROS || '8120066355').split(',').map(s => s.trim()).filter(Boolean));
// AUTOPILOT del PRIMER mensaje: el bot contesta solo la ráfaga (default ON; AUTO_OPENER=0 lo apaga).
const AUTO_OPENER = process.env.AUTO_OPENER !== '0';
const OPENER_AUTO_URL = process.env.OPENER_AUTO_URL || 'https://fyrachat.vercel.app/api/seb-panel';
const AUTO_OPENER_DELAY = Number(process.env.AUTO_OPENER_DELAY || 6000);   // espera para juntar la ráfaga del comprador
const AUTO_OPENER_GAP = Number(process.env.AUTO_OPENER_GAP || 1000);       // ~1s entre cada burbuja

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ── CUOTA TURSO (2026-09-08): Turso cobra por FILA LEÍDA y se acabó la cuota → bloqueo total.
// Regla: lo que no cambia entre reconexiones vive en memoria a nivel PROCESO (sobrevive reconexiones
// y ciclos de QR); las lecturas por mensaje se limitan a 1 fila por índice. NADA de lo persistido se quita.
const lidMapPorTenant = new Map();     // tenantId → { lidAPhone, phoneALid, persistidos, cargado, ultimoIntento }
function lidMapDe(tenantId) {
    if (!lidMapPorTenant.has(tenantId)) lidMapPorTenant.set(tenantId, { lidAPhone: new Map(), phoneALid: new Map(), persistidos: new Set(), cargado: false, ultimoIntento: 0 });
    return lidMapPorTenant.get(tenantId);
}
const LID_MAP_REINTENTO_MS = 10 * 60000;   // carga fallida (base caída) → reintentar como máximo cada 10 min, no en cada ciclo de QR
let _ddlArranqueHecho = false;             // CREATE TABLE/ALTER de arranque: UNA vez por proceso
async function ddlArranque() {
    if (_ddlArranqueHecho) return;
    await db.execute('CREATE TABLE IF NOT EXISTS lid_phone_map (lid TEXT PRIMARY KEY, phone TEXT, updated_at INTEGER)');
    try { await db.execute('ALTER TABLE lid_phone_map ADD COLUMN tenant_id INTEGER'); } catch (e) {}
    // Anuncio (auto+link) por teléfono → el cerebro lo mete a la mochila como [DESC:]
    await db.execute('CREATE TABLE IF NOT EXISTS ad_por_telefono (telefono TEXT PRIMARY KEY, ad_context TEXT, updated_at INTEGER)');
    // Modo prueba: punto de reinicio por teléfono (solo se ven mensajes posteriores)
    await db.execute('CREATE TABLE IF NOT EXISTS prueba_reset (telefono TEXT PRIMARY KEY, reset_ts INTEGER)');
    // ETAPA 2 (orden owner 2026-09-08, base por universo): la DELEGACIÓN chat → auto vive en `delegaciones`
    // (con historial); `chats_activos` sigue en DUAL-WRITE hasta la Etapa 3. Mismo DDL que PRUEBAS/lib/seb/universo.js.
    await db.execute(`CREATE TABLE IF NOT EXISTS delegaciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL,
        auto_id INTEGER, auto_nombre TEXT, activado_por TEXT, desde INTEGER NOT NULL, hasta INTEGER,
        opener_pendiente INTEGER DEFAULT 0, opener_texto TEXT, motivo TEXT, created INTEGER)`);
    await db.execute('CREATE INDEX IF NOT EXISTS idx_deleg_chat_hasta ON delegaciones(chat_id, hasta)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_deleg_tenant_hasta ON delegaciones(tenant_id, hasta)');
    try { await db.execute('ALTER TABLE conversaciones ADD COLUMN auto_id_activo INTEGER'); } catch (e) {}   // el foco también como columna del chat (espejo)
    await db.execute('CREATE INDEX IF NOT EXISTS idx_conv_tenant_tel ON conversaciones(tenant_id, telefono)');
    _ddlArranqueHecho = true;
}
const adUltimo = new Map();                // tel → { ctx, ts }: mismo anuncio del mismo tel en <5 min → no re-upsert (se marca SOLO si la escritura tuvo éxito)
const AD_DEDUP_MS = 5 * 60000;
const pruebaResetUltimo = new Map();       // tel → ts: re-entrega de la misma ráfaga de prueba en <15 s → no re-upsert
const PRUEBA_RESET_DEDUP_MS = 15000;
const puntoEnvioCache = new Map();         // auto_id → { row, ts }: solo HITS, TTL 5 min (un miss se vuelve a consultar)
const PUNTO_TTL_MS = 5 * 60000;
const sesionReportada = new Map();         // tenantId → { estado, motivo, ts }: el MISMO estado no se re-escribe en <5 min (ciclos de QR)
const SESION_DEDUP_MS = 5 * 60000;
let _returningOk = true;                   // INSERT … RETURNING id ahorra el SELECT por mensaje; si el motor no lo acepta, cae al SELECT
let _sistemaConfigDDLHecho = false;        // CREATE TABLE sistema_config: una vez por proceso



// CANDADO DE CONEXIÓN ÚNICA (F1): cada socket lleva un número de GENERACIÓN.
// Un socket viejo ("zombi") que siga emitiendo eventos se ignora por completo —
// antes 2-3 sockets vivos procesaban lo mismo en paralelo, se pisaban las llaves
// Signal (→ epidemia de Bad MAC / mensajes ilegibles) y duplicaban envíos.




// ── Cachés a NIVEL MÓDULO (sobreviven reconexiones) ──────────────────────────
// IDs/textos de mensajes que mandó FyraChat: para saltar su eco fromMe (no duplicar).

// Mensajes salientes propios, para responder los retry-receipts de Signal (getMessage).

// Cuántas veces nos han pedido REENVIAR cada mensaje (si 2+, la sesión del destinatario
// está rota y el reenvío también fallaría → hay que resetear la sesión antes).

// Reintentos de descifrado (clave del arreglo #1: sin esto se pierden mensajes).
const msgRetryCounterCache = NodeCache ? new NodeCache() : undefined;

// AUTO-RECUPERACIÓN "Bad MAC / Esperando el mensaje": el tipo de mensaje que WhatsApp
// emite cuando NO se pudo descifrar (la sesión de cifrado de ese contacto se rompió).
const WAStub = baileys.WAMessageStubType || (baileys.proto && baileys.proto.WebMessageInfo && baileys.proto.WebMessageInfo.StubType) || {};
const STUB_CIPHERTEXT = (WAStub.CIPHERTEXT != null) ? WAStub.CIPHERTEXT : 2;
// Resetea la sesión Signal de un contacto → fuerza renegociar una llave limpia en el
// siguiente mensaje (así el cifrado se arregla solo y deja de salir "Esperando el mensaje").

// Mapas @lid ↔ teléfono real (se persisten en Turso, ver más abajo).


// Cola de envío a SALES-BRAIN POR teléfono: garantiza ORDEN y evita lost-update.

// EL TIMBRE (WebSocket): FyraChat se conecta y recibe empujones de mensajes nuevos.
let wss = null;   // servidor WebSocket; se crea junto al http server (abajo).
// Empuja un evento a todos los FyraChat conectados (estilo WhatsApp: avisar, no preguntar).
function emitir(obj) {
    if (!wss) return;
    const data = JSON.stringify(obj);
    for (const client of wss.clients) { if (client.readyState === 1) { try { client.send(data); } catch (e) {} } }
}
// ══ EVENTO `mensaje` DEL CONTRATO FyraChat v2 (2026-09-10): TODO evento lleva `tenant_id` y `chat_id` (conversaciones.id, el
// que devuelve guardarMensajeNuevo) y el objeto `mensaje` con la MISMA forma que el hilo ({ msg_id, dir, emisor, texto, ts, media,
// estado }). El cliente ignora lo que no sea de su universo y repinta SOLO ese chat_id.
// Campos legacy conservados en el mismo evento: telefono, texto (string), direccion, timestamp (s), msg_id, nombre, ai_generated.
// ⚠️ ROMPE compat con copilot.html v1, que leía `d.mensaje` como STRING: ahora el string va en `d.texto` (el front v2 lo sabe).
// Orígenes válidos de un envío en universos ≠0 (regla SOLO POR BOTÓN, auditoría H 2026-09-12)
const ORIGENES_OK = new Set(['manual', 'boton', 'casilla', 'maquina_cita', 'programado', 'delegar', 'sb']);
function emisorNorm(direccion, emisor, ai) {
    if (direccion === 'in') return 'comprador';
    if (emisor === 'sistema') return 'sistema';
    return Number(ai) ? 'bot' : 'dueno';
}
function mediaDeEvento(tipo, texto) {
    const tx = String(texto || ''), url = (tx.match(/https?:\/\/\S+/) || [])[0] || null;
    if (tipo === 'image') return { tipo: 'imagen', url };
    if (tipo === 'location') return { tipo: 'ubicacion', url };
    if (tipo === 'audio') return { tipo: 'audio', url };
    if (tipo === 'video' || tipo === 'document' || tipo === 'sticker' || tipo === 'contact') return { tipo, url };
    return null;
}
function evMensaje({ tenantId, chatId, tel, msgId, ts, direccion, emisor, texto, tipo, ai, nombre }) {
    const dir = direccion === 'out' ? 'out' : 'in';
    return {
        tipo: 'mensaje', tenant_id: Number(tenantId) || 0, chat_id: chatId == null ? null : Number(chatId),
        telefono: tel, texto: String(texto || ''), direccion: dir, timestamp: Math.floor(Number(ts) / 1000), msg_id: msgId || null, nombre: nombre || null, ai_generated: Number(ai) ? 1 : 0,
        mensaje: { id: null, msg_id: msgId || null, dir, emisor: emisorNorm(dir, emisor, ai), texto: String(texto || ''), ts: Number(ts), media: mediaDeEvento(tipo || 'text', texto), estado: 'enviado' }
    };
}
// Logger silencioso (Baileys lo pide; pino-like mínimo).
const logger = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };

// Identificador de chat para LOGS: hash corto, jamás el número (Fase 2: logs sin payload)
const jidHash = (t) => require('crypto').createHash('sha256').update(String(t || '')).digest('hex').slice(0, 8);
// Limpia el teléfono a solo dígitos (quita @s.whatsapp.net / @lid)
function limpiaTel(jid) {
    return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
// ¿Es un mensaje INVISIBLE de WhatsApp (protocolo/llaves/reacción/pin…)? Llegan al puente pero en
// el chat del teléfono no existen como burbuja → aquí tampoco (caso Mario 2026-09-07).
const TIPOS_INVISIBLES = new Set(['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'reactionMessage', 'encReactionMessage', 'pollUpdateMessage', 'keepInChatMessage', 'pinInChatMessage', 'stickerSyncRmrMessage', 'associatedChildMessage', 'encCommentMessage', 'bcallMessage', 'callLogMesssage', 'scheduledCallCreationMessage', 'scheduledCallEditMessage', 'placeholderMessage', 'secretEncryptedMessage']);
function esInvisible(message) {
    if (!message) return true;
    const wrap = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message.viewOnceMessageV2?.message || message.viewOnceMessageV2Extension?.message || message.deviceSentMessage?.message;
    if (wrap) return esInvisible(wrap);
    const keys = Object.keys(message);
    return keys.length > 0 && keys.every(k => TIPOS_INVISIBLES.has(k));
}
// Saca el texto de CUALQUIER tipo de mensaje. NUNCA regresa vacío → cero pérdidas.
function textoDeMensaje(message) {
    if (!message) return '[mensaje]';
    // desenvolver mensajes "envueltos" (efímeros, ver-una-vez, editados, etc.)
    const wrap = message.ephemeralMessage?.message || message.viewOnceMessage?.message
        || message.viewOnceMessageV2?.message || message.viewOnceMessageV2Extension?.message
        || message.documentWithCaptionMessage?.message || message.editedMessage?.message
        || message.deviceSentMessage?.message;   // lo que el dueño manda desde su teléfono viaja envuelto aquí
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
        || (console.log('[tipo-desconocido] ' + Object.keys(message).join(',')), '[mensaje]');   // ÚLTIMO recurso: nunca vacío (y aprendemos el tipo)
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
async function guardarMensajeNuevo({ tel, msgId, ts, direccion, emisor, texto, tipo, nombre, ai_generated, tenantId }) {
    if (!tel || !msgId) return;
    const tId = Number(tenantId) || 0;
    // Hilo por tenant (Ley 1): el tenant 0 conserva su llave histórica; los demás llevan sufijo #t<id>
    const thread = 'whatsapp:' + tel + (tId ? ('#t' + tId) : '');
    try {
        // 1) carpeta: crear si no existe; subir su actividad solo si este mensaje es el más nuevo
        const upsertSql = `INSERT INTO conversaciones (channel_thread_id, telefono, nombre, ult_texto, ult_dir, ult_msg_ts, no_leidos, source, created_at, tenant_id)
                  VALUES (?,?,?,?,?,?, 0, 'whatsapp', ?, ?)
                  ON CONFLICT(channel_thread_id) DO UPDATE SET
                    nombre = COALESCE(excluded.nombre, nombre),
                    ult_texto = CASE WHEN excluded.ult_msg_ts >= ult_msg_ts THEN excluded.ult_texto ELSE ult_texto END,
                    ult_dir   = CASE WHEN excluded.ult_msg_ts >= ult_msg_ts THEN excluded.ult_dir ELSE ult_dir END,
                    ult_msg_ts = MAX(excluded.ult_msg_ts, ult_msg_ts)`;
        const upsertArgs = [thread, tel, nombre || null, String(texto || '').slice(0, 120), direccion, ts, ts, tId];
        // CUOTA: el id de la carpeta sale del MISMO upsert (RETURNING) → cero SELECT por mensaje.
        // Si el motor no acepta RETURNING (se detecta una vez por proceso) → upsert + SELECT de 1 fila por índice UNIQUE.
        let convId = null;
        if (_returningOk) {
            try {
                const r = await db.execute({ sql: upsertSql + ' RETURNING id', args: upsertArgs });
                if (r.rows.length && r.rows[0].id != null) convId = Number(r.rows[0].id);
            } catch (e) {
                if (!/returning|syntax/i.test(String(e.message))) throw e;
                _returningOk = false; console.error('[mensajes-nuevo] RETURNING no soportado → SELECT id por mensaje');
            }
        }
        if (convId == null) {
            if (!_returningOk) await db.execute({ sql: upsertSql, args: upsertArgs });
            const row = (await db.execute({ sql: 'SELECT id FROM conversaciones WHERE channel_thread_id=?', args: [thread] })).rows[0];
            if (!row) return;
            convId = Number(row.id);
        }
        // 2) papelito con folio (dedup por folio → JAMÁS duplica)
        await db.execute({
            sql: 'INSERT OR IGNORE INTO mensajes (conversacion_id, msg_id, ts, direccion, emisor, texto, tipo, ai_generated, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
            args: [convId, msgId, ts, direccion, emisor || null, texto || '', tipo || 'text', ai_generated ? 1 : 0, Date.now()]
        });
        return convId;   // el chat_id del evento `mensaje` (contrato v2)
    } catch (e) {
        console.error('[mensajes-nuevo]', e.message);
        // CARRETE DE EMERGENCIA (2026-09-08, Turso bloqueado por cuota): el papelito se guarda en disco y
        // se reintenta cada minuto por la MISMA puerta (dedup por msg_id → jamás duplica). Cero pérdidas.
        if (!_desdeCarrete) {
            try { fs.appendFileSync(CARRETE_PATH, JSON.stringify({ tel, msgId, ts, direccion, emisor, texto, tipo, nombre, ai_generated, tenantId }) + '\n'); }
            catch (e2) { console.error('[carrete] no pude escribir:', e2.message); }
        }
        if (_desdeCarrete) throw e;   // solo el reintento necesita saber que falló; a los demás no se les revienta (sin rechazos sueltos)
        return null;
    }
}
const CARRETE_PATH = require('path').join(__dirname, 'carrete.jsonl');   // require inline: fs/path se declaran más abajo
let _desdeCarrete = false, _carreteEnCurso = false;
async function reintentarCarrete() {
    if (_carreteEnCurso || !fs.existsSync(CARRETE_PATH)) return;
    _carreteEnCurso = true;
    try {
        const lineas = fs.readFileSync(CARRETE_PATH, 'utf8').split('\n').filter(Boolean);
        if (!lineas.length) { fs.unlinkSync(CARRETE_PATH); return; }
        // sonda: si la base sigue bloqueada, ni intentamos (y no llenamos el log)
        try { await db.execute('SELECT 1'); } catch (e) { return; }
        const pendientes = [];
        for (const l of lineas) {
            let r; try { r = JSON.parse(l); } catch (e) { continue; }
            _desdeCarrete = true;
            try { await guardarMensajeNuevo(r); } catch (e) { pendientes.push(l); } finally { _desdeCarrete = false; }
        }
        fs.writeFileSync(CARRETE_PATH, pendientes.length ? pendientes.join('\n') + '\n' : '');
        if (!pendientes.length) fs.unlinkSync(CARRETE_PATH);
        console.log('[carrete] reintento: ' + (lineas.length - pendientes.length) + ' guardados, ' + pendientes.length + ' pendientes');
    } catch (e) { console.error('[carrete]', e.message); }
    finally { _carreteEnCurso = false; }
}
setInterval(reintentarCarrete, 60 * 1000);
// TIMBRE (2026-09-08): el túnel de Cloudflare (pm2 fyra-tunnel) cambia de URL en cada reinicio del VPS y FyraChat
// la tenía fija → "CONECTANDO…" eterno. El puente lee la URL viva del log del túnel y la publica en sistema_config;
// FyraChat la pide al conectar. Determinista, sin payloads.
let _timbreUrlPublicada = null;
async function publicarTimbreUrl() {
    try {
        const logF = process.env.TUNNEL_LOG || '/root/.pm2/logs/fyra-tunnel-error.log';
        if (!fs.existsSync(logF)) return;
        const st = fs.statSync(logF); const fd = fs.openSync(logF, 'r'); const len = Math.min(st.size, 64 * 1024);
        const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
        const m = buf.toString('utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
        if (!m || !m.length) return;
        const url = m[m.length - 1].replace('https://', 'wss://');
        if (url === _timbreUrlPublicada) return;
        if (!_sistemaConfigDDLHecho) { await db.execute('CREATE TABLE IF NOT EXISTS sistema_config (clave TEXT PRIMARY KEY, valor TEXT, updated INTEGER)'); _sistemaConfigDDLHecho = true; }
        await db.execute({ sql: 'INSERT INTO sistema_config (clave, valor, updated) VALUES (?,?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor, updated=excluded.updated', args: ['timbre_url', url, Date.now()] });
        _timbreUrlPublicada = url; console.log('[timbre] url publicada: ' + url);
    } catch (e) { console.error('[timbre] publicar:', e.message); }
}
setTimeout(publicarTimbreUrl, 15 * 1000); setInterval(publicarTimbreUrl, 60 * 1000);
setInterval(() => { for (const U of universos.values()) if (U.tenant.id !== 0 && !U.chatsCargados) cargarChatsActivos(U).catch(() => {}); }, 60 * 1000);   // MODO SIN BASE: recargar delegaciones cuando la base vuelva

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
                headers: HDR_PUENTE,
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
// ═══════════════════════ EL UNIVERSO (uno por tenant) ═══════════════════════
const universos = new Map();                      // tenantId → U
const fs = require('fs');
const path = require('path');
function authDirDe(tenant) {
    const dir = path.join(__dirname, 'auth', String(tenant.id));
    // MIGRACIÓN Fase 1: la carpeta vieja del número principal pasa a ser auth/0 (sin reescanear)
    if (tenant.id === 0 && !fs.existsSync(dir) && fs.existsSync(path.join(__dirname, 'auth_info_baileys'))) {
        fs.mkdirSync(path.join(__dirname, 'auth'), { recursive: true });
        fs.renameSync(path.join(__dirname, 'auth_info_baileys'), dir);
        try { fs.symlinkSync(dir, path.join(__dirname, 'auth_info_baileys')); } catch (e) {}   // v2 (rollback) sigue encontrando su carpeta
        console.log('[auth] migrada auth_info_baileys → auth/0 (+symlink de compatibilidad)');
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
// Limpia las credenciales de un universo NO registrado (vinculación fallida) para reintentar en limpio
function limpiarAuth(tenant) {
    try { const dir = path.join(__dirname, 'auth', String(tenant.id)); for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)); } catch (e) {}
}
// Estado REPORTADO del universo (lo que ve Sales Brain): memoria del proceso primero; si no hay (arranque fresco),
// UNA fila de wa_sessions. Lo usa codigoVinculacion() para respetar la invariante 6 (no limpiar creds registradas).
async function estadoSesion(tenantId) {
    const p = sesionReportada.get(tenantId);
    if (p && p.estado) return String(p.estado);
    try {
        const r = await db.execute({ sql: 'SELECT estado FROM wa_sessions WHERE tenant_id=?', args: [tenantId] });
        return r.rows.length ? String(r.rows[0].estado || '') : '';
    } catch (e) { return ''; }
}
// Estado de sesión → Sales Brain (Turso wa_sessions; la Fase 6 lo vuelve endpoint)
function reportarSesion(tenantId, estado, motivo) {
    // CUOTA: un universo esperando QR recibe un QR nuevo cada ~20 s → el MISMO estado+motivo no se
    // re-escribe si ya se escribió hace <5 min (el upsert lee 1 fila por PK cada vez). Un cambio real se escribe al instante.
    const prev = sesionReportada.get(tenantId), ahora = Date.now();
    const repetido = !!(prev && prev.estado === estado && prev.motivo === (motivo || null) && ahora - prev.ts < SESION_DEDUP_MS);
    if (!repetido) {
        sesionReportada.set(tenantId, { estado, motivo: motivo || null, ts: ahora });
        db.execute({ sql: 'INSERT INTO wa_sessions (tenant_id, estado, motivo, ultimo_evento, updated) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET estado=excluded.estado, motivo=excluded.motivo, ultimo_evento=excluded.ultimo_evento, updated=excluded.updated',
            args: [tenantId, estado, motivo || null, ahora, ahora] }).catch(() => { sesionReportada.delete(tenantId); });   // falló → el siguiente evento sí reintenta
    }
    console.log('[sesión] tenant ' + tenantId + ' → ' + estado + (motivo ? ' (' + motivo + ')' : '') + (repetido ? ' (sin re-escribir)' : ''));
}

function crearUniverso(tenant) {
    const U = {
        tenant, sock: null, estado: 'arrancando', ultimoQR: null, ultimoRecibido: 0,
        genConexion: 0, reconectTimer: null, conectando: false, ghostTimer: null, reintentos: 0,
        enviadosPorPanel: new Set(), sentStore: new Map(), getMsgRetries: new Map(), getMsgMemo: new Map(), sesionReseteada: new Map(),
        lidAPhone: lidMapDe(tenant.id).lidAPhone, phoneALid: lidMapDe(tenant.id).phoneALid, colasPorTel: new Map(),   // CUOTA: caché a nivel PROCESO (sobrevive reconexiones y re-aperturas)
        autoOpenerTimers: new Map(), autoOpenerEnVuelo: new Set(), autoOpenerPendiente: new Set(),
        ilegibleAvisado: new Map(), ghostEnCurso: false,
        chatsActivos: new Map(),                                     // tel → fila de chats_activos (Fase 2: delegación)
    };
const LM = lidMapDe(tenant.id);   // estado del mapa @lid (cargado / persistidos) de ESTE universo, a nivel proceso
async function resetearSesionContacto(jid) {
    try {
        if (!jid || !U.sock) return;
        const user = String(jid).split('@')[0].split(':')[0].split('.')[0];
        if (!user) return;
        const ahora = Date.now();
        if (U.sesionReseteada.get(user) && ahora - U.sesionReseteada.get(user) < 60000) return; // máx 1/min
        U.sesionReseteada.set(user, ahora);
        const updates = {};
        for (let d = 0; d <= 9; d++) updates[user + '.' + d] = null;  // borra sesiones de todos sus dispositivos
        await U.sock.authState.keys.set({ session: updates });
        console.log('[recuperación] sesión reseteada para ' + user + ' (Bad MAC) → renegocia sola');
    } catch (e) { console.error('[recuperación] no pude resetear sesión:', e.message); }
}

// Encola fn por teléfono para que los mensajes del MISMO hilo se procesen en orden.
function encolar(tel, fn) {
    const prev = U.colasPorTel.get(tel) || Promise.resolve();
    const next = prev.then(fn).catch(e => console.error('[cola]', e && e.message));
    U.colasPorTel.set(tel, next);
    return next;
}


// Persiste un mapeo @lid → teléfono (sobrevive reinicios).
function recordarLid(lid, phone) {
    if (!lid || !phone || lid === phone) return;
    const nuevo = U.lidAPhone.get(lid) !== phone;          // ¿mapeo que NO conocíamos?
    U.lidAPhone.set(lid, phone);
    U.phoneALid.set(phone, lid);
    // CUOTA: antes era un upsert (lee 1 fila por PK) por CADA entrante @lid. Ahora solo si el mapeo cambió
    // o aún no consta en Turso (si la escritura falla, el siguiente entrante lo reintenta → nada se pierde).
    if (nuevo) LM.persistidos.delete(lid);
    if (!LM.persistidos.has(lid)) {
        db.execute({
            sql: 'INSERT INTO lid_phone_map (lid, phone, updated_at, tenant_id) VALUES (?, ?, ?, ?) ON CONFLICT(lid) DO UPDATE SET phone=excluded.phone, updated_at=excluded.updated_at, tenant_id=excluded.tenant_id',
            args: [lid, phone, Date.now(), tenant.id]
        }).then(() => { if (U.lidAPhone.get(lid) === phone) LM.persistidos.add(lid); }).catch(() => {});
    }
    // AUTO-CURACIÓN: si justo aprendimos este @lid↔teléfono, unir la conversación
    // huérfana (la que quedó bajo el @lid) con la del teléfono real. Evita el "split".
    if (nuevo) fusionarSiHuerfano(lid, phone).catch(() => {});
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
    if (U.lidAPhone.has(lid)) return U.lidAPhone.get(lid);             // resolver por mapa persistido
    return lid;                                                    // último recurso: el @lid
}


async function conectar() {
    // ── CANDADO F1: una sola conexión viva, siempre ──
    if (U.conectando) { console.log('[conexión] ya hay un conectar() en curso — ignorado'); return; }
    U.conectando = true;
    setTimeout(() => { U.conectando = false; }, 30000);   // seguro: si algo truena a media conexión, el candado se libera solo
    const gen = ++U.genConexion;                       // este socket = generación N
    if (U.reconectTimer) { clearTimeout(U.reconectTimer); U.reconectTimer = null; }
    // Matar el socket anterior ANTES de crear el nuevo (si quedó medio vivo).
    try {
        if (U.sock) {
            try { U.sock.ev.removeAllListeners('messages.upsert'); } catch (e) {}
            try { U.sock.ev.removeAllListeners('connection.update'); } catch (e) {}
            try { U.sock.ev.removeAllListeners('creds.update'); } catch (e) {}
            try { U.sock.end(undefined); } catch (e) {}
        }
    } catch (e) { /* el viejo ya estaba muerto */ }

    // Cargar el mapa @lid → teléfono desde Turso (sobrevive reinicios).
    // CUOTA: UNA vez por proceso y universo (~600 filas). Antes se releía —junto con los CREATE TABLE— en
    // CADA reconexión, y un universo esperando QR reconecta cada ~1 min. Si la carga falló (base caída),
    // se reintenta como máximo cada 10 min; mientras, lo aprendido en vivo (senderPn) sigue en memoria.
    if (!LM.cargado && Date.now() - LM.ultimoIntento >= LID_MAP_REINTENTO_MS) {
        LM.ultimoIntento = Date.now();
        try {
            await ddlArranque();
            const cached = await db.execute({ sql: 'SELECT lid, phone FROM lid_phone_map WHERE COALESCE(tenant_id, 0) = ?', args: [tenant.id] });
            for (const row of cached.rows) {
                const l = String(row.lid), p = String(row.phone);
                LM.persistidos.add(l);
                if (U.lidAPhone.has(l)) continue;                      // lo aprendido en vivo en este proceso es más fresco: no pisarlo
                U.lidAPhone.set(l, p); U.phoneALid.set(p, l);
            }
            LM.cargado = true;
            console.log('[lid-map] cargados ' + U.lidAPhone.size + ' mapeos (tenant ' + tenant.id + ', una vez por proceso)');
        } catch (e) { console.error('[lid-map] no pude cargar (reintento en ' + (LID_MAP_REINTENTO_MS / 60000) + ' min):', e.message); }
    }
    U.sockDesde = Date.now();

    const { state, saveCreds } = await useMultiFileAuthState(authDirDe(tenant));
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); console.log('WA version:', version?.join('.')); }
    catch (e) { console.log('No pude obtener versión WA, uso default:', e.message); }

    const keys = (typeof makeCacheableSignalKeyStore === 'function')
        ? makeCacheableSignalKeyStore(state.keys, logger) : state.keys;

    U.sock = makeWASocket({
        version,
        auth: { creds: state.creds, keys },
        // VENTANA DE VINCULACIÓN (orden owner 2026-09-12): cada ref de QR vive 60 s (Baileys usaba 20 s en los siguientes) →
        // el código de 8 letras aguanta ~6 min mientras el vendedor abre WhatsApp y lo teclea; antes moría a los ~2 min.
        qrTimeout: 60000,
        logger,
        printQRInTerminal: false,
        syncFullHistory: false,
        browser: baileys.Browsers.ubuntu('Chrome'),   // código de vinculación: WhatsApp exige identidad estándar — TODOS los universos, incluido el 0 (orden owner 2026-09-12: Fyradrive es un lote más)
        shouldSyncHistoryMessage: () => false,   // Ley 2: nada de historial
        markOnlineOnConnect: true,
        msgRetryCounterCache,
        // LA PESTE DE LOS GRUPOS (2026-08-06): el lid 213400550379606 —participante
        // de un grupo— acumuló ~250 mil Bad MAC en DOS brotes y tumbó la recepción
        // dos veces (sobrevivió incluso al re-enlace por QR). El bot NO trabaja
        // grupos: se ignoran DE RAÍZ (ni se descifran) — y el dispositivo apestado
        // queda en LISTA NEGRA directa (también ataca como mensaje 1 a 1; su tráfico
        // es 100% indescifrable, no se pierde nada real).
        shouldIgnoreJid: jid => typeof jid === 'string' && (
            jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid === 'status@broadcast' || jid.endsWith('@newsletter') ||
            jid.startsWith('213400550379606@') || jid.includes('213400550379606:')
        ),
        // ARREGLO #1: responder los retry-receipts de Signal con el mensaje original.
        getMessage: async (key) => {
            // Si nos piden reenviar el MISMO mensaje 2+ veces, el destinatario no lo pudo
            // descifrar (sesión rota) → resetea su sesión ANTES de reenviar para que renegocie.
            const n = (U.getMsgRetries.get(key.id) || 0) + 1;
            U.getMsgRetries.set(key.id, n);
            setTimeout(() => U.getMsgRetries.delete(key.id), 60 * 60000);
            if (n >= 2 && key.remoteJid) { await resetearSesionContacto(key.remoteJid).catch(() => {}); }
            const m = U.sentStore.get(key.id);
            if (m) return m.message;
            // G1 (badmac 2026-08-03): U.sentStore es RAM — cada pm2 restart lo vacía y los
            // retry-receipts regresaban undefined → el saliente se quedaba en UNA palomita
            // para siempre. Respaldo: el TEXTO vive en Turso (wa_messages) — re-servirlo.
            // ⚠️ CAMISA DE FUERZA (2026-08-06): esta consulta corre DENTRO del tubo de
            // recepción de Baileys — si Turso se cuelga, el puente queda conectado pero
            // SORDO (así se murió la recepción 6 horas hoy). Máximo 1.5s y suelta.
            // CUOTA (2026-09-08): solo el tenant 0 escribe wa_messages; el resultado (hit o miss REAL) se
            // memoriza 1 h por folio; y la consulta va por el índice (telefono, timestamp) — buscar por
            // mensaje_id a secas era un SCAN COMPLETO de wa_messages en cada retry-receipt.
            if (tenant.id !== 0) return undefined;
            if (U.getMsgMemo.has(key.id)) return U.getMsgMemo.get(key.id);
            const jidK = String(key.remoteJid || '');
            let telK = limpiaTel(jidK);
            if (jidK.endsWith('@lid')) telK = U.lidAPhone.get(telK) || null;
            if (!telK) { console.error('[getMessage] retry-receipt sin teléfono (lid sin mapa) → sin fallback Turso'); return undefined; }
            const telsK = [telK];                                                 // el eco pudo guardarse con o sin el "1" mexicano
            if (/^521\d{10}$/.test(telK)) telsK.push('52' + telK.slice(3)); else if (/^52\d{10}$/.test(telK)) telsK.push('521' + telK.slice(2));
            try {
                const r = await Promise.race([
                    db.execute({ sql: "SELECT mensaje FROM wa_messages WHERE telefono IN (?,?) AND mensaje_id=? AND direccion='out' ORDER BY timestamp DESC LIMIT 1", args: [telsK[0], telsK[1] || telsK[0], key.id] }),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('turso_lento')), 1500))
                ]);
                let out;
                if (r.rows.length && r.rows[0].mensaje && !/^\[/.test(String(r.rows[0].mensaje))) out = { conversation: String(r.rows[0].mensaje) };
                U.getMsgMemo.set(key.id, out); setTimeout(() => U.getMsgMemo.delete(key.id), 60 * 60000);   // solo se memoriza un resultado REAL (un error se reintenta)
                return out;
            } catch (e) { console.error('[getMessage] fallback Turso:', e.message); }
            return undefined;
        }
    });

    // G3 (badmac 2026-08-03): si escribir el auth a disco FALLA, hay que verlo en el log —
    // llaves en RAM ≠ llaves en disco es la semilla de la epidemia de Bad MAC.
    U.sock.ev.on('creds.update', () => { Promise.resolve(saveCreds()).catch(e => console.error('[creds] ⚠️ NO pude guardar auth:', e.message)); });
    U.conectando = false;   // el socket de esta generación ya existe; liberar el candado

    U.sock.ev.on('connection.update', (u) => {
        if (gen !== U.genConexion) return;   // evento de un socket ZOMBI → ignorar por completo
        const { connection, lastDisconnect, qr } = u;
        if (qr) {
            U.ultimoQR = qr;
            // CÓDIGO PENDIENTE: mientras el código de 8 letras siga vivo (< 6 min) el estado NO regresa a 'esperando_qr' — el vendedor
            // lo está tecleando y la web/Sales Brain leen este estado; el QR nuevo solo se guarda por si alguien escanea.
            const codigoVivo = U.estado === 'esperando_codigo' && U.codigoTs && (Date.now() - U.codigoTs) < 6 * 60000;
            if (codigoVivo) { console.log('[sesión] tenant ' + tenant.id + ' → QR nuevo, código de vinculación sigue vivo'); return; }
            U.estado = 'esperando_qr'; reportarSesion(tenant.id, 'esperando_qr', 'escanea el QR');
            console.log('\n================ ESCANEA ESTE QR CON WHATSAPP ================\n');
            qrcode.generate(qr, { small: true });
            console.log('\nWhatsApp → Dispositivos vinculados → Vincular un dispositivo\n');
        }
        if (connection === 'open') { U.estado = 'conectado'; U.ultimoQR = null; U.reintentos = 0; reportarSesion(tenant.id, 'vinculado', 'open'); console.log('\n✅ WHATSAPP CONECTADO (gen ' + gen + ')\n'); }
        if (connection === 'close') {
            const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            const registrado = !!(U.sock && U.sock.authState && U.sock.authState.creds && U.sock.authState.creds.registered);
            const vinculacionFallida = code === DisconnectReason.loggedOut && !registrado;   // 401 sin haberse vinculado nunca
            const reconectar = code !== DisconnectReason.loggedOut || vinculacionFallida;
            if (vinculacionFallida) { limpiarAuth(tenant); U.ultimoQR = null; U.ultimoCodigo = null; }
            // 401 estando vinculado = el vendedor quitó el dispositivo desde su WhatsApp: las llaves viejas ya no sirven.
            // Se limpian aquí para que pueda volver a vincular (antes quedaba creds.registered=true → "ya está vinculado" eterno). 2026-09-10
            if (code === DisconnectReason.loggedOut && registrado) { limpiarAuth(tenant); U.ultimoQR = null; U.ultimoCodigo = null; }   // también el universo 0 (un lote más)
            // CUOTA: un universo SIN vincular que agota su set de QR cierra y reabre cada ~1 min; ese 'reconectando'
            // dura segundos y volvía a escribir wa_sessions en cada ciclo → se omite (sigue 'esperando_qr', que es la verdad útil).
            const cicloQR = reconectar && !vinculacionFallida && !registrado && U.estado === 'esperando_qr';
            if (!cicloQR) reportarSesion(tenant.id, reconectar ? (vinculacionFallida ? 'esperando_qr' : 'reconectando') : 'desvinculado', 'close code ' + code + (vinculacionFallida ? ' — vinculación fallida, se reabre limpio' : (reconectar ? '' : ' — requiere reescaneo')));
            else console.log('[sesión] tenant ' + tenant.id + ' → ciclo de QR agotado (code ' + code + '), se reabre sin re-escribir estado');
            U.estado = 'cerrado';
            U.reintentos++;
            const espera = Math.min(30000, 3000 * U.reintentos);
            console.log('Conexión cerrada (code ' + code + ', gen ' + gen + '). ' + (reconectar ? 'Reconectando en ' + (espera / 1000) + 's…' : 'Sesión cerrada — re-vincular.'));
            // UN solo reconnect agendado a la vez (el timer previo se cancela).
            if (reconectar) {
                if (U.reconectTimer) clearTimeout(U.reconectTimer);
                U.reconectTimer = setTimeout(conectar, espera);
            }
        }
    });

    // MENSAJES → guardar (ENTRANTES del comprador y SALIENTES tuyos), en orden.
    // ══ CARGA DE LOTE (owner 2026-07-13): piezas desde el número del OWNER →
    // fyrachat las acumula y publica en la web (lotes/agencias verificadas).
    // Imagen: descargar de WhatsApp → subir al Blob de la web → mandar la URL.
    let cargaCola = Promise.resolve();   // cola FIFO: una pieza a la vez, orden de WhatsApp intacto
    async function manejarPiezaCarga(m, texto, remitente) {
        try {
            const w = m.message || {};
            const post = (b) => fetch('https://fyrachat.vercel.app/api/seb-panel', { method: 'POST', headers: HDR_PUENTE, body: cuerpoPanel(Object.assign({ action: 'carga_pieza', remitente: remitente || '5218120066355' }, b)) }).catch(() => {});
            if (w.imageMessage) {
                const cap = String(w.imageMessage.caption || '').trim();
                if (cap) await post({ tipo: 'texto', texto: cap });
                const buff = await baileys.downloadMediaMessage(m, 'buffer', {});
                const fd = new FormData();
                fd.append('code', 'AUTOS LOZANO');
                fd.append('filename', 'carga-' + Date.now() + '.jpg');
                fd.append('file', new Blob([buff], { type: w.imageMessage.mimetype || 'image/jpeg' }));
                const up = await fetch('https://www.fyradrive.com/api/agency/upload-photo', { method: 'POST', body: fd });
                const du = await up.json().catch(() => ({}));
                if (du && du.ok && du.url) { await post({ tipo: 'foto', url: du.url }); console.log('[carga] foto subida'); }
                else console.error('[carga] upload-photo fallo:', du && du.error);
                return;
            }
            const t = String(texto || '').trim();
            if (t && t !== '[imagen]') await post({ tipo: 'texto', texto: t });
        } catch (e) { console.error('[carga pieza]', e && e.message); }
    }


    // ══ EL OJO DEL COMPRADOR (2026-07-22, caso 7721443373: contestó con una FOTO y el
    // bot quedó mudo): la imagen del comprador se sube y su URL viaja EN EL TEXTO —
    // el cerebro la lee (identifica el auto) y contesta como si nada.
    async function subirImagenComprador(m) {
        try {
            const w = m.message || {};
            const buff = await baileys.downloadMediaMessage(m, 'buffer', {});
            const fd = new FormData();
            fd.append('code', 'AUTOS LOZANO');
            fd.append('filename', 'comprador-' + Date.now() + '.jpg');
            fd.append('file', new Blob([buff], { type: (w.imageMessage && w.imageMessage.mimetype) || 'image/jpeg' }));
            const up = await fetch('https://www.fyradrive.com/api/agency/upload-photo', { method: 'POST', body: fd });
            const du = await up.json().catch(() => ({}));
            return (du && du.ok && du.url) ? du.url : null;
        } catch (e) { return null; }
    }

    // ══ IGNACIO RECEPCIÓN (2026-07-16): fotos de VENDEDORES particulares. El puente
    // pregunta a fyrachat si el chat tiene sesión de recepción ANTES de bajar nada —
    // así las fotos de compradores normales jamás se tocan.
    let recepCola = Promise.resolve();
    async function manejarFotoRecepcion(m, tel) {
        try {
            const t10 = String(tel).replace(/\D/g, '');
            const chk = await fetch('https://fyrachat.vercel.app/api/seb-panel?action=recepcion_activa&telefono=' + t10 + queryVieja(), { headers: HDR_PUENTE }).then(r => r.json()).catch(() => null);
            if (!chk || !chk.activa) return;
            const w = m.message || {};
            const buff = await baileys.downloadMediaMessage(m, 'buffer', {});
            const fd = new FormData();
            fd.append('code', 'AUTOS LOZANO');
            fd.append('filename', 'recepcion-' + Date.now() + '.jpg');
            fd.append('file', new Blob([buff], { type: (w.imageMessage && w.imageMessage.mimetype) || 'image/jpeg' }));
            const up = await fetch('https://www.fyradrive.com/api/agency/upload-photo', { method: 'POST', body: fd });
            const du = await up.json().catch(() => ({}));
            if (du && du.ok && du.url) {
                await fetch('https://fyrachat.vercel.app/api/seb-panel', { method: 'POST', headers: HDR_PUENTE, body: cuerpoPanel({ action: 'recepcion_foto', telefono: t10, url: du.url }) });
                console.log('[recepcion] foto subida ' + t10);
            } else console.error('[recepcion] upload-photo fallo:', du && du.error);
        } catch (e) { console.error('[recepcion foto]', e && e.message); }
    }

    U.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (gen !== U.genConexion) return;   // socket zombi → jamás procesar (doble proceso = Bad MAC + duplicados)
        if (type !== 'notify' && type !== 'append') return;
        for (const m of messages) {
            U.ultimoRecibido = Date.now();                                   // latido de la sesión
            if (tenant.id !== 0) {
                // ══ CAMINO ÚNICO (Fase 2, Ley 2): grupo/estado/broadcast → fin; delegado → persistir
                // (sin Seb hasta la Fase 5, sin Sales Brain); NO delegado → fin, sin log ni rastro.
                const jidD = String(m.key.remoteJid || '');
                if (jidD.endsWith('@g.us') || jidD.endsWith('@broadcast') || jidD === 'status@broadcast' || jidD.endsWith('@newsletter')) continue;
                if (m.messageStubType === STUB_CIPHERTEXT) continue;              // cifrado ilegible: ni siquiera se registra
                const telD = telefonoReal(m);
                const chatD = telD ? U.chatsActivos.get(String(telD)) : null;
                if (!chatD) continue;                                              // lo no delegado NO EXISTE
                const mkD = Object.keys(m.message || {});
                if (!m.message || esInvisible(m.message)) continue;               // protocolo/llaves/reacciones: sin burbuja
                const fromMeD = !!m.key.fromMe;
                if (fromMeD && U.enviadosPorPanel.has(m.key.id)) { U.enviadosPorPanel.delete(m.key.id); continue; }   // eco de lo que mandó el puente
                const textoD = textoDeMensaje(m.message);
                const tsD = (() => { const t = m.messageTimestamp; const n = (t && typeof t.toNumber === 'function') ? t.toNumber() : Number(t); return (isFinite(n) && n > 1e9) ? n * 1000 : Date.now(); })();
                if (fromMeD) chatD.ultimo_from_me = tsD; else chatD.ultimo_entrante = tsD;
                if (chatD.ca_id) db.execute({ sql: 'UPDATE chats_activos SET ' + (fromMeD ? 'ultimo_from_me' : 'ultimo_entrante') + '=? WHERE id=?', args: [tsD, chatD.ca_id] }).catch(() => {});   // dual-write (Etapa 2); conversaciones.ult_msg_ts/ult_dir ya lo llevan
                // TIMBRE con dirección (contrato v2): el chat_id sale del MISMO upsert que persiste el renglón (cero lecturas extra)
                guardarMensajeNuevo({ tel: telD, msgId: m.key.id, ts: tsD, direccion: fromMeD ? 'out' : 'in', emisor: fromMeD ? 'dueno' : (m.pushName || null), texto: textoD, tipo: tipoDeMsg(m.message), nombre: fromMeD ? null : (m.pushName || chatD.comprador_nombre || null), ai_generated: 0, tenantId: tenant.id })
                    .then(cid => emitir(evMensaje({ tenantId: tenant.id, chatId: cid, tel: telD, msgId: m.key.id, ts: tsD, direccion: fromMeD ? 'out' : 'in', emisor: fromMeD ? 'dueno' : (m.pushName || null), texto: textoD, tipo: tipoDeMsg(m.message), ai: 0, nombre: fromMeD ? null : (m.pushName || chatD.comprador_nombre || null) })))
                    .catch(() => {});
                console.log('[t' + tenant.id + '] ' + (fromMeD ? 'salida dueño' : 'entrada') + ' · chat ' + jidHash(telD) + ' · ' + tipoDeMsg(m.message));
                // ══ CITAS POR UNIVERSO (orden owner 2026-09-08): un ENTRANTE de un chat delegado toca la MISMA máquina
                // de citas que el tenant 0 (cita_entrante → procesarEntrante): "voy en camino", cancelación, desvío.
                // Debounce de la ráfaga (como el auto-opener); el cerebro solo lee si ese chat tiene cita viva.
                // Ley 5: se manda `vendedor_ultimo_ts` (memoria) → si el vendedor escribió a mano hace <N min, el bot calla.
                if (!fromMeD && textoD) programarCitaEntrante(telD, textoD, chatD);
                continue;
            }
            if (m.key.remoteJid?.endsWith('@g.us')) continue;     // ignorar grupos
            if (m.key.remoteJid === 'status@broadcast') continue; // ignorar estados
            // AUTO-RECUPERACIÓN: si este mensaje NO se pudo descifrar (Bad MAC / "Esperando el
            // mensaje"), resetea la sesión de ese contacto para que renegocie una llave limpia.
            // Y YA NO SE TIRA EN SILENCIO (mataba leads: Adrián, el 2061, el Sahara): se deja
            // burbuja visible en FyraChat, se le pide al comprador que lo reenvíe (con la sesión
            // ya reseteada, el reenvío SÍ descifra) y se avisa al personal del owner.
            if (m.messageStubType === STUB_CIPHERTEXT) {
                resetearSesionContacto(m.key.remoteJid).catch(() => {});
                if (!m.key.fromMe) manejarMensajeIlegible(m).catch(e => console.error('[ilegible]', e && e.message));
                else registrarManualIlegible(m).catch(e => console.error('[ilegible-out]', e && e.message));
                continue;
            }
            const esSaliente = !!m.key.fromMe;                    // lo mandaste TÚ
            // Eco de un mensaje que ya mandó FyraChat → ya quedó registrado, saltar
            if (esSaliente && U.enviadosPorPanel.has(m.key.id)) { U.enviadosPorPanel.delete(m.key.id); continue; }
            // 🛟 PIN MANUAL TUYO (máquina de rescate): el pin nativo que mandas desde tu
            // teléfono acredita carril ubicación (24h) — timbre y sigue el skip normal.
            if (esSaliente && (m.message?.locationMessage || m.message?.liveLocationMessage) && !U.enviadosPorPanel.has(m.key.id)) {
                const telPin = telefonoReal(m);
                if (telPin) fetch('https://fyrachat.vercel.app/api/seb-panel', { method: 'POST', headers: HDR_PUENTE, body: cuerpoPanel({ action: 'rescate_manual', telefono: telPin, texto: '', es_pin: true }) }).catch(() => {});
            }
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
            if (!m.message || esInvisible(m.message)) continue;                    // protocolo/llaves/reacciones: sin burbuja
            let texto = textoDeMensaje(m.message);                // robusto: cualquier tipo, nunca vacío → cero pérdidas
            const tel = telefonoReal(m);                          // TELÉFONO REAL (no @lid)
            // ══ CARGA DE LOTE: lo que mande el OWNER desde su número también se acarrea
            // al publicador (su flujo normal — posesión, señales — sigue intacto).
            const telCarga = String(tel).replace(/\D/g, '');
            if (!esSaliente && /(8120066355|8129405001)$/.test(telCarga)) {
                // OWNER o MARCELO (AUTOS LOZANO): sus piezas van al publicador de lote
                const remitCarga = telCarga.endsWith('8129405001') ? '5218129405001' : '5218120066355';
                cargaCola = cargaCola.then(() => manejarPiezaCarga(m, texto, remitCarga)).catch(() => {});
            } else if (!esSaliente && (m.message || {}).imageMessage) {
                // ══ IGNACIO RECEPCIÓN: foto de un posible VENDEDOR particular — solo se
                // procesa si fyrachat confirma sesión de recepción abierta para ese tel.
                recepCola = recepCola.then(() => manejarFotoRecepcion(m, tel)).catch(() => {});
                // ══ EL OJO DEL COMPRADOR (2026-07-22): la URL de la imagen entra al texto.
                // 8s máximo; si la subida falla queda '[imagen]' y el cerebro ESCALA al
                // owner (ley: una imagen jamás deja mudo al bot).
                try {
                    const urlImg = await Promise.race([subirImagenComprador(m), new Promise(r => setTimeout(() => r(null), 8000))]);
                    if (urlImg) texto = (texto && texto !== '[imagen]' ? texto + ' ' : '') + '[imagen] ' + urlImg;
                } catch (e) { }
            }
            const adContext = esSaliente ? null : adContextDe(m); // contexto del anuncio (auto + link)
            const adLink = esSaliente ? null : adLinkDe(m);       // link del anuncio
            if (adLink && !texto.includes(adLink)) texto = '🔗 ' + adLink + '\n' + texto;  // mostrarlo en FyraChat como en WhatsApp
            // Guardar el anuncio por teléfono → el cerebro lo usará para saber QUÉ AUTO
            // CUOTA: el upsert lee 1 fila por PK; el MISMO anuncio del MISMO tel en <5 min (re-entrega / ráfaga) no se re-escribe.
            // Se marca SOLO si la escritura tuvo éxito → con la base caída se comporta igual que antes (reintenta en cada mensaje).
            const adPrev = adContext ? adUltimo.get(tel) : null;
            if (adContext && !(adPrev && adPrev.ctx === adContext && Date.now() - adPrev.ts < AD_DEDUP_MS)) db.execute({
                sql: 'INSERT INTO ad_por_telefono (telefono, ad_context, updated_at) VALUES (?,?,?) ON CONFLICT(telefono) DO UPDATE SET ad_context=excluded.ad_context, updated_at=excluded.updated_at',
                args: [tel, adContext, Date.now()]
            }).then(() => { adUltimo.set(tel, { ctx: adContext, ts: Date.now() }); setTimeout(() => { const a = adUltimo.get(tel); if (a && a.ctx === adContext) adUltimo.delete(tel); }, AD_DEDUP_MS); }).catch(() => {});
            // MODO PRUEBA: si un número de prueba contesta un anuncio → REINICIAR contexto
            // (solo se verán los mensajes de aquí en adelante, como comprador nuevo).
            if (adContext && TEST_NUMEROS.has(tel.slice(-10))) {
                const prPrev = pruebaResetUltimo.get(tel) || 0;
                if (Date.now() - prPrev >= PRUEBA_RESET_DEDUP_MS) db.execute({
                    sql: 'INSERT INTO prueba_reset (telefono, reset_ts) VALUES (?,?) ON CONFLICT(telefono) DO UPDATE SET reset_ts=excluded.reset_ts',
                    args: [tel, Date.now() - 3000]
                }).then(() => pruebaResetUltimo.set(tel, Date.now())).catch(() => {});
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
            const pGuardado = guardarMensajeNuevo({
                tel, msgId: m.key.id, ts: msgTs,
                direccion: esSaliente ? 'out' : 'in',
                emisor: esSaliente ? 'SRS010904' : (m.pushName || null),
                texto, tipo: tipoMsg,
                nombre: esSaliente ? null : (m.pushName || null),
                ai_generated: 0
            }).catch(() => null);
            // 🛟 MANUAL TUYO (máquina de rescate): tu texto escrito a mano re-arma el
            // reloj del silencio (jamás toca una promesa del comprador).
            if (esSaliente) {
                fetch('https://fyrachat.vercel.app/api/seb-panel', { method: 'POST', headers: HDR_PUENTE, body: cuerpoPanel({ action: 'rescate_manual', telefono: tel, texto: String(texto || '') }) }).catch(() => {});
            }
            // ══ TIMBRE DE CIERRE (lógica del timbre, orden owner 2026-07-16): "cita
            // confirmada" MANUAL tuyo → fyrachat ejecuta la máquina AL INSTANTE (paquete
            // determinista + casillas CRM/Calendar/solicitud). El cron queda de barredor
            // de respaldo por la MISMA puerta idempotente — jamás duplica.
            if (esSaliente && /cita confirmada/i.test(texto)) {
                fetch('https://fyrachat.vercel.app/api/seb-panel?action=cierre_timbre', {
                    method: 'POST', headers: HDR_PUENTE,
                    body: cuerpoPanel({ telefono: String(tel).replace(/\D/g, ''), texto, ts: msgTs })
                }).then(r => r.json()).then(j => console.log('[timbre-cierre]', tel, JSON.stringify(j).slice(0, 120))).catch(e => console.error('[timbre-cierre]', e.message));
            }
            // Reenviar a SALES-BRAIN EN ORDEN por teléfono (cola). Sigue llenando lo VIEJO en paralelo.
            encolar(tel, () => mandarASalesBrain({
                external_id: tel,
                text: texto,
                from_name: esSaliente ? null : m.pushName,
                direction: esSaliente ? 'outbound' : 'inbound',
                ad_context: adContext
            }));
            // 🔔 TIMBRE: empuja el mensaje a FyraChat al instante (con FOLIO + hora real + dirección tenant_id/chat_id — contrato v2)
            pGuardado.then(cid => emitir(evMensaje({ tenantId: 0, chatId: cid, tel, msgId: m.key.id, ts: msgTs, direccion: esSaliente ? 'out' : 'in', emisor: esSaliente ? 'SRS010904' : (m.pushName || null), texto, tipo: tipoMsg, ai: 0, nombre: esSaliente ? null : (m.pushName || null) }))).catch(() => {});
            console.log('[t0] ' + (esSaliente ? 'salida' : 'entrada') + ' · chat ' + jidHash(tel) + ' · ' + tipoMsg + (adContext ? ' · anuncio' : ''));
            // AUTOPILOT: primer mensaje de un COMPRADOR → el bot contesta solo (ráfaga).
            // El cerebro (/opener_auto, reset-aware) decide si aplica; aquí solo debounce.
            if (!esSaliente) programarAutoOpener(tel);
        }
    });
}

// ── CITA ENTRANTE (universos ≠0): junta la ráfaga del comprador y toca la máquina de citas ──
U.citaEntrante = new Map();       // tel → { timer, textos: [] }
function programarCitaEntrante(tel, texto, chatD) {
    if (tenant.id === 0) return;
    const cur = U.citaEntrante.get(tel) || { timer: null, textos: [] };
    cur.textos.push(String(texto));
    if (cur.timer) clearTimeout(cur.timer);
    cur.timer = setTimeout(async () => {
        U.citaEntrante.delete(tel);
        const junto = cur.textos.join(' ').trim();
        if (!junto) return;
        try {
            const r = await fetch(OPENER_AUTO_URL, {
                method: 'POST', headers: HDR_PUENTE,
                body: cuerpoPanel({ action: 'cita_entrante', tenant_id: tenant.id, telefono: tel, texto: junto, vendedor_ultimo_ts: Number(chatD && chatD.ultimo_from_me) || 0 })
            });
            const d = await r.json().catch(() => ({}));
            if (d && d.handled) console.log('[t' + tenant.id + '] cita_entrante · chat ' + jidHash(tel) + ' · ' + (d.rol || '?') + (d.callado ? ' · callado (' + d.callado + ')' : '') + (d.enviados ? ' · ' + d.enviados + ' burbujas' : ''));
        } catch (e) { console.error('[t' + tenant.id + '] cita_entrante:', e.message); }
    }, AUTO_OPENER_DELAY);
    U.citaEntrante.set(tel, cur);
}

// ── AUTOPILOT DEL PRIMER MENSAJE ─────────────────────────────────────────────
// Cuando un comprador escribe por PRIMERA vez (no hemos respondido), el bot manda
// SOLO la ráfaga del playbook (1 burbuja por mensaje, ~1s de diferencia). Una vez
// por conversación. El cerebro (FyraChat /opener_auto) decide si aplica.
U.autoOpenerTimers = new Map();   // tel → timeout (debounce: junta su ráfaga)
U.autoOpenerEnVuelo = new Set();  // tel → procesando ahora (anti-concurrencia)
U.autoOpenerPendiente = new Set();// tel → llegó mensaje MIENTRAS respondíamos → reprocesar al terminar

// Envía UN texto saliente del bot y lo registra/emite a FyraChat (igual que /api/send).
// opts.manual = true (2026-09-10): el texto lo escribió el VENDEDOR (forma de entrada "con mi texto") → se firma como suyo
// (emisor 'dueno', ai_generated 0), no como asistente.
async function autoEnviarTexto(p, text, opts) {
    const manual = !!(opts && opts.manual);
    const aiFlag = manual ? 0 : 1;
    const destino = U.phoneALid.has(p) ? (U.phoneALid.get(p) + '@lid') : (p + '@s.whatsapp.net');
    const r = await U.sock.sendMessage(destino, { text });
    if (r?.key?.id) {
        U.enviadosPorPanel.add(r.key.id);
        U.sentStore.set(r.key.id, r);
        setTimeout(() => { U.enviadosPorPanel.delete(r.key.id); U.sentStore.delete(r.key.id); }, 60 * 60000);
    }
    const ts = Date.now();
    const emisor = tenant.id ? (manual ? 'dueno' : 'asistente') : 'SRS010904';
    if (!tenant.id) await guardar({ telefono: p, mensaje: text, direccion: 'out', mensaje_id: r?.key?.id, ai_generated: aiFlag }).catch(() => {});
    const emitirAuto = cid => emitir(evMensaje({ tenantId: tenant.id, chatId: cid, tel: p, msgId: r?.key?.id, ts, direccion: 'out', emisor, texto: text, tipo: 'text', ai: aiFlag, nombre: null }));
    if (r?.key?.id) guardarMensajeNuevo({ tel: p, msgId: r.key.id, ts, direccion: 'out', emisor, texto: text, tipo: 'text', nombre: null, ai_generated: aiFlag, tenantId: tenant.id }).then(emitirAuto).catch(() => emitirAuto(null));
    else emitirAuto(null);
    if (!tenant.id) encolar(p, () => mandarASalesBrain({ external_id: p, text, direction: 'outbound' }));
    return r;
}

// Debounce: cada entrante reinicia el reloj; al expirar (no llegaron más) dispara una vez.
function programarAutoOpener(tel) {
    if (!AUTO_OPENER) return;
    if (U.autoOpenerTimers.has(tel)) clearTimeout(U.autoOpenerTimers.get(tel));
    U.autoOpenerTimers.set(tel, setTimeout(() => {
        U.autoOpenerTimers.delete(tel);
        dispararAutoOpener(tel).catch(e => console.error('[auto-opener]', e && e.message));
    }, AUTO_OPENER_DELAY));
}

// Manda el PIN del punto (captura branded + ubicación nativa) — para la continuación de
// ubicación. No crea burbuja en FyraChat (el eco de media saliente se salta por tipo).
async function autoEnviarUbicacion(p, autoId) {
    try {
        // CUOTA: el punto de un auto casi no cambia → hit en memoria 5 min (un miss se vuelve a consultar: un punto recién configurado sale al instante)
        const pc = puntoEnvioCache.get(Number(autoId));
        let e;
        if (pc && Date.now() - pc.ts < PUNTO_TTL_MS) e = pc.row;
        else {
            const pe = await db.execute({ sql: "SELECT image_b64, name, lat, lng FROM punto_envio WHERE auto_id=?", args: [Number(autoId)] });
            if (!pe.rows.length) return;
            e = pe.rows[0];
            puntoEnvioCache.set(Number(autoId), { row: e, ts: Date.now() });
        }
        const destino = U.phoneALid.has(p) ? (U.phoneALid.get(p) + '@lid') : (p + '@s.whatsapp.net');
        const marca = (r) => { if (r && r.key && r.key.id) { U.enviadosPorPanel.add(r.key.id); U.sentStore.set(r.key.id, r); setTimeout(() => { U.enviadosPorPanel.delete(r.key.id); U.sentStore.delete(r.key.id); }, 60 * 60000); } };
        if (e.image_b64) { const buf = Buffer.from(String(e.image_b64).replace(/^data:[^,]+,/, ''), 'base64'); marca(await U.sock.sendMessage(destino, { image: buf })); }
        if (e.lat != null && e.lng != null) { const loc = { degreesLatitude: Number(e.lat), degreesLongitude: Number(e.lng) }; if (e.name) loc.name = String(e.name); marca(await U.sock.sendMessage(destino, { location: loc })); }
    } catch (err) { console.error('[auto-opener] pin:', err.message); }
}

// Descarga cada URL de foto (Vercel Blob, pública) y la manda como imagen por WhatsApp.
async function autoEnviarFotos(p, urls) {
    const destino = U.phoneALid.has(p) ? (U.phoneALid.get(p) + '@lid') : (p + '@s.whatsapp.net');
    for (const url of (urls || [])) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) continue;
            const buf = Buffer.from(await resp.arrayBuffer());
            const m = await U.sock.sendMessage(destino, { image: buf });
            if (m && m.key && m.key.id) { U.enviadosPorPanel.add(m.key.id); U.sentStore.set(m.key.id, m); setTimeout(() => { U.enviadosPorPanel.delete(m.key.id); U.sentStore.delete(m.key.id); }, 60 * 60000); }
            await sleep(900);
        } catch (e) { console.error('[auto-opener] foto:', e.message); }
    }
}

// ── AVISO DE ESCALA al WhatsApp personal del owner (como la lista de ghosting): cuando
// el bot en automático NO debe/puede contestar (long-tail, algo que necesita su criterio),
// le manda "🔔 Escaló Fulano — pidió: …" para que él conteste a mano. NO se persiste.
async function avisarEscalaOwner({ tel, nombre, motivo, ultimo }) {
    try {
        const tel10 = String(tel).replace(/\D/g, '').slice(-10);
        const txt = '🔔 Seb escaló contigo\n'
            + '• ' + (nombre || 'Sin nombre') + ' — ' + tel10 + '\n'
            + '• Motivo: ' + (motivo || 'requiere tu criterio') + '\n'
            + (ultimo ? '• Escribió: "' + String(ultimo).slice(0, 140) + '"\n' : '')
            + 'Contéstale tú directo en FyraChat.';
        const dest = U.phoneALid.has(OWNER_PERSONAL) ? (U.phoneALid.get(OWNER_PERSONAL) + '@lid') : (OWNER_PERSONAL + '@s.whatsapp.net');
        const rr = await U.sock.sendMessage(dest, { text: txt });
        if (rr?.key?.id) { U.enviadosPorPanel.add(rr.key.id); U.sentStore.set(rr.key.id, rr); setTimeout(() => { U.enviadosPorPanel.delete(rr.key.id); U.sentStore.delete(rr.key.id); }, 60 * 60000); }
        console.log('[escala-owner] avisado por', tel10, '·', motivo);
    } catch (e) { console.error('[escala-owner]', e.message); }
}

async function dispararAutoOpener(tel) {
    if (U.estado !== 'conectado') return;
    // Si ya estamos respondiendo a ESTE teléfono, NO tiramos este disparo: lo marcamos
    // pendiente para reprocesar en cuanto termine (así el 2º mensaje del comprador —el que
    // llegó a media respuesta— SÍ se contesta, con la respuesta al 1º ya en el contexto).
    if (U.autoOpenerEnVuelo.has(tel)) { U.autoOpenerPendiente.add(tel); return; }
    U.autoOpenerEnVuelo.add(tel);   // lock anti-concurrencia mientras procesa/envía
    try {
        // El cerebro (reset-aware) decide TODO: primer contacto (opener), primera respuesta
        // (continuación fin/ubic), o silencio. Si no aplica → no manda nada (queda manual).
        let d = null;
        try {
            const r = await fetch(OPENER_AUTO_URL, {
                method: 'POST', headers: HDR_PUENTE,
                body: cuerpoPanel({ action: 'opener_auto', telefono: tel })
            });
            d = await r.json().catch(() => ({}));
        } catch (e) { console.error('[auto-opener] cerebro:', e.message); }
        // ¿El cerebro escaló? → avísale al owner a su personal (con o sin puente al comprador).
        if (d && d.escalar_owner) await avisarEscalaOwner({ tel, nombre: d.escala_nombre, motivo: d.escala_motivo, ultimo: d.escala_ultimo });
        if (!(d && d.ok && Array.isArray(d.segmentos) && d.segmentos.length)) return;
        const segmentos = d.segmentos;
        let p = tel.replace(/\D/g, ''); if (p.length === 10) p = '521' + p;
        const envTexto = async (s) => { try { await autoEnviarTexto(p, s); } catch (e) { console.error('[auto-opener] envío:', e.message); } };

        if (d.ubicacion_auto_id && d.pin_primero) {
            // "Pásame la ubicación" → PIN primero, luego texto.
            await autoEnviarUbicacion(p, d.ubicacion_auto_id); await sleep(AUTO_OPENER_GAP);
            for (let i = 0; i < segmentos.length; i++) { await envTexto(segmentos[i]); if (i < segmentos.length - 1) await sleep(AUTO_OPENER_GAP); }
        } else if (d.ubicacion_auto_id) {
            // El PIN va DESPUÉS del segmento pin_after_index (default 0 = tras la maquillada;
            // en el combo crédito+ubicación = 2, tras la línea de ubicación).
            const pinIdx = Number.isInteger(d.pin_after_index) ? d.pin_after_index : 0;
            for (let i = 0; i < segmentos.length; i++) {
                await envTexto(segmentos[i]);
                if (i === pinIdx) { await sleep(AUTO_OPENER_GAP); await autoEnviarUbicacion(p, d.ubicacion_auto_id); }
                if (i < segmentos.length - 1) await sleep(AUTO_OPENER_GAP);
            }
        } else if (d.fotos && d.fotos.length) {
            // FOTOS: manda el texto y, tras fotos_after_index, las fotos descargadas.
            const fi = Number.isInteger(d.fotos_after_index) ? d.fotos_after_index : 0;
            for (let i = 0; i < segmentos.length; i++) {
                await envTexto(segmentos[i]);
                if (i === fi) { await sleep(AUTO_OPENER_GAP); await autoEnviarFotos(p, d.fotos); }
                if (i < segmentos.length - 1) await sleep(AUTO_OPENER_GAP);
            }
        } else {
            // Opener / financiamiento: solo texto, 1s entre cada burbuja.
            for (let i = 0; i < segmentos.length; i++) { await envTexto(segmentos[i]); if (i < segmentos.length - 1) await sleep(AUTO_OPENER_GAP); }
        }
        console.log('[auto-opener] ' + (d.modo || 'opener') + ' → ' + tel + ' (' + segmentos.length + ' msgs' + (d.ubicacion_auto_id ? ' +pin' : '') + (d.fotos ? ' +' + d.fotos.length + 'fotos' : '') + ')');
        // 🛟 LA MÁQUINA DE RESCATE: turno cerrado → el cerebro re-evalúa folios
        // (promesa del comprador / cancha / arma el reloj del silencio con su carril)
        fetch('https://fyrachat.vercel.app/api/seb-panel', { method: 'POST', headers: HDR_PUENTE, body: cuerpoPanel({ action: 'rescate_turno', telefono: tel, segmentos: segmentos, pin: !!d.ubicacion_auto_id }) }).catch(() => {});
    } finally {
        U.autoOpenerEnVuelo.delete(tel);
        // ¿Llegó algún mensaje mientras respondíamos? → reprocesar (leerá el nuevo contexto
        // completo, incluida nuestra respuesta anterior). El debounce vuelve a juntar la ráfaga.
        if (U.autoOpenerPendiente.has(tel)) { U.autoOpenerPendiente.delete(tel); programarAutoOpener(tel); }
    }
}

// ── MENSAJE ILEGIBLE (Bad MAC) — registro SILENCIOSO (decisión del owner) ─────
// NO se le manda nada al comprador ni aviso al owner. Solo queda la burbuja en
// FyraChat (para que la conversación exista y no sea un lead invisible) y el log.
// La cura REAL es que las sesiones no se rompan: candado de conexión única (abajo).
U.ilegibleAvisado = new Map();   // tel → ts (throttle SOLO del log, no del registro)
async function manejarMensajeIlegible(m) {
    const tel = telefonoReal(m);
    if (!tel) {
        // G4 (badmac 2026-08-03, caso lid 213400550379606 con 235 mil errores): un @lid
        // SIN mapeo perdía sus mensajes en silencio TOTAL. Que al menos grite en el log.
        console.error('[ilegible] ⚠️ SIN TELÉFONO — lid/jid: ' + (m.key && (m.key.senderLid || m.key.participant || m.key.remoteJid) || '?') + ' push: ' + (m.pushName || '?'));
        return;
    }
    const ahora = Date.now();
    // G2 (badmac 2026-08-03, caso 445 110 9070 / 81 1792 8244): el throttle de 6h TRAGABA
    // el 2º+ mensaje ilegible del mismo contacto — perdido sin rastro. Ahora CADA mensaje
    // perdido deja su burbuja (el dedup real lo da el msg_id); el throttle es solo del log.
    const yaLog = U.ilegibleAvisado.get(tel) && ahora - U.ilegibleAvisado.get(tel) < 6 * 3600000;
    U.ilegibleAvisado.set(tel, ahora);
    const placeholder = '⚠️ [mensaje no descifrado]';
    await guardar({ telefono: tel, nombre: m.pushName || null, mensaje: placeholder, direccion: 'in', tipo: 'text', mensaje_id: m.key.id, ai_generated: 0 }).catch(() => {});
    const emitirIl = cid => emitir(evMensaje({ tenantId: tenant.id, chatId: cid, tel, msgId: m.key.id, ts: ahora, direccion: 'in', emisor: m.pushName || null, texto: placeholder, tipo: 'text', ai: 0, nombre: m.pushName || null }));
    guardarMensajeNuevo({ tel, msgId: m.key.id, ts: ahora, direccion: 'in', emisor: m.pushName || null, texto: placeholder, tipo: 'text', nombre: m.pushName || null, ai_generated: 0, tenantId: tenant.id }).then(emitirIl).catch(() => emitirIl(null));
    if (!yaLog) console.log('[ilegible] Bad MAC de ' + tel.slice(-4) + ' (registro silencioso)');
}

// ── GHOSTING ETAPA 3: el toque de las 3 HORAS (único auto-envío de etapa 3) ──
// Cada ~15 min pregunta al cerebro (ghost_scan) quién lleva 3h sin contestar tras algo
// que le mandamos; el cerebro aplica TODOS los candados y devuelve la frase exacta.
// Además manda al personal del owner la lista (nombre+tel) para que les marque.
const GHOST_SCAN = process.env.GHOST_SCAN !== '0';
const GHOST_SCAN_MS = Number(process.env.GHOST_SCAN_MS || 15 * 60000);
const OWNER_PERSONAL = (process.env.OWNER_PERSONAL || '5218120066355');
U.ghostEnCurso = false;
async function correrGhostScan() {
    if (!GHOST_SCAN || U.estado !== 'conectado' || U.ghostEnCurso) return;
    U.ghostEnCurso = true;
    try {
        const r = await fetch(OPENER_AUTO_URL, {
            method: 'POST', headers: HDR_PUENTE,
            body: cuerpoPanel({ action: 'ghost_scan' })
        });
        const d = await r.json().catch(() => ({}));
        if (d && d.ok && Array.isArray(d.enviar) && d.enviar.length) {
            for (const g of d.enviar) {
                let p = String(g.telefono).replace(/\D/g, ''); if (p.length === 10) p = '521' + p;
                try {
                    // TENANT (2026-09-08): el recordatorio programado desde el FyraChat de un vendedor sale por SU universo
                    const tG = Number(g.tenant_id) || 0;
                    const Ux = tG ? universos.get(tG) : null;
                    if (tG && (!Ux || Ux.estado !== 'conectado')) { console.error('[rescate] tenant ' + tG + ' no conectado → no sale'); continue; }
                    const fTxt = Ux ? Ux.enviarTexto : autoEnviarTexto, fFot = Ux ? Ux.enviarFotos : autoEnviarFotos;
                    if (g.foto) await fFot(p, [g.foto]);
                    else await fTxt(p, g.texto);
                    console.log('[rescate] → chat ' + jidHash(p) + (g.foto ? ' · foto' : ' · texto'));
                } catch (e) { console.error('[rescate] envío:', e.message); }
                await new Promise(s => setTimeout(s, 1500));
            }
            // Lista al personal del owner — envío directo (NO se persiste en FyraChat/SalesBrain).
            if (d.reporte) {
                try {
                    const dest = U.phoneALid.has(OWNER_PERSONAL) ? (U.phoneALid.get(OWNER_PERSONAL) + '@lid') : (OWNER_PERSONAL + '@s.whatsapp.net');
                    const rr = await U.sock.sendMessage(dest, { text: d.reporte });
                    if (rr?.key?.id) { U.enviadosPorPanel.add(rr.key.id); U.sentStore.set(rr.key.id, rr); setTimeout(() => { U.enviadosPorPanel.delete(rr.key.id); U.sentStore.delete(rr.key.id); }, 60 * 60000); }
                } catch (e) { console.error('[ghost-3h] reporte:', e.message); }
            }
        }
    } catch (e) { console.error('[ghost-3h] scan:', e.message); }
    U.ghostEnCurso = false;
}
if (tenant.id === 0) U.ghostTimer = setInterval(correrGhostScan, GHOST_SCAN_MS);
async function registrarManualIlegible(m) {
    const tel = telefonoReal(m);
    if (!tel) return;
    const t = m.messageTimestamp;
    const n = (t && typeof t.toNumber === 'function') ? t.toNumber() : Number(t);
    const ts = (isFinite(n) && n > 1e9) ? n * 1000 : Date.now();
    console.log('[ilegible-out] manual tuyo cifrado en ' + tel + ' — registrado como marcador');
    await guardar({ telefono: tel, nombre: null, mensaje: '[mensaje tuyo — no se pudo leer]', direccion: 'out', tipo: 'text', mensaje_id: m.key.id, ai_generated: 0 }).catch(() => {});
    await guardarMensajeNuevo({ tel, msgId: m.key.id, ts, direccion: 'out', emisor: 'SRS010904', texto: '[mensaje tuyo — no se pudo leer]', tipo: 'text', nombre: null, ai_generated: 0 }).catch(() => {});
}

    U.enviarTexto = autoEnviarTexto; U.enviarFotos = autoEnviarFotos;   // expuestos para envíos enrutados desde otro universo (ghost_scan del t0)
    U.apiSend = async (res, body) => {
        const tenantId = tenant.id;
        {
            try {
                const { phone, text, image, location, manual, origen } = JSON.parse(body || '{}');
                // ══ SOLO POR BOTÓN (auditoría H, 2026-09-12): en universos de vendedor NADA sale sin declarar su origen —
                //    fyrachat (mensajeria.js / citas-vivas.js) lo manda siempre; un cliente viejo o un envío suelto recibe 403.
                if (tenantId && !ORIGENES_OK.has(String(origen || ''))) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'origen requerido en universos de vendedor (' + [...ORIGENES_OK].join('|') + ')' })); }
                // FIRMA MANUAL (caso Gerardo 2026-09-05): manual:true = lo tecleó el owner en FyraChat → copia firmada como SUYA (ai_generated=0)
                const aiFlag = manual === true ? 0 : 1;
                // Ahora se acepta texto Y/O imagen Y/O pin de ubicación (paquete de ubicación).
                if (!phone || (!text && !image && !location)) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'phone y (text|image|location) requeridos' })); }
                if (U.estado !== 'conectado') { res.statusCode = 503; return res.end(JSON.stringify({ ok: false, error: 'whatsapp no conectado' })); }
                let p = String(phone).replace(/\D/g, '');
                if (U.lidAPhone.has(p)) p = U.lidAPhone.get(p);        // si llegó un @lid, traducir a teléfono real
                if (p.length === 10) p = '521' + p;
                // MANDAR al @lid si lo conocemos (WhatsApp migró a direccionamiento LID).
                let destino = U.phoneALid.has(p) ? (U.phoneALid.get(p) + '@lid') : (p + '@s.whatsapp.net');
                // ENVÍO EN FRÍO (vendedores): si NO tenemos el @lid cacheado, resolver el JID REAL
                // con onWhatsApp antes de mandar. Sin esto, un @s.whatsapp.net a un contacto que
                // WhatsApp migró a LID (o con el "1" mexicano que ya no usa) se marca "enviado"
                // pero WhatsApp lo TIRA → nunca llega. Probamos con y sin el "1".
                if (!U.phoneALid.has(p)) {
                    try {
                        const variantes = /^521\d{10}$/.test(p) ? [p, '52' + p.slice(3)] : [p];
                        let hit = null;
                        for (const v of variantes) {
                            const wa = await U.sock.onWhatsApp(v).catch(() => null);
                            const h = Array.isArray(wa) && wa[0] ? wa[0] : null;
                            if (h && (h.lid || h.jid) && h.exists !== false) { hit = h; break; }
                        }
                        if (hit) {
                            destino = hit.lid || hit.jid;           // JID canónico (incluye @lid si aplica)
                            if (String(destino).endsWith('@lid')) { const lid = String(destino).split('@')[0]; U.phoneALid.set(p, lid); U.lidAPhone.set(lid, p); }
                        }
                    } catch (e) { console.error('[send] onWhatsApp resolve falló:', e.message); }  // fallback al destino por defecto
                }

                // Envía UN mensaje. persistir=true → lo guarda/emite a FyraChat (texto).
                // persistir=false → SOLO lo manda a WhatsApp (imagen/pin del paquete: no se
                // muestran como burbuja en FyraChat; el texto formal ya representa el paquete).
                const enviarUno = async (content, repTexto, tipo, persistir) => {
                    const r = await U.sock.sendMessage(destino, content);
                    if (r?.key?.id) {
                        U.enviadosPorPanel.add(r.key.id);
                        U.sentStore.set(r.key.id, r);
                        setTimeout(() => { U.enviadosPorPanel.delete(r.key.id); U.sentStore.delete(r.key.id); }, 60 * 60000);  // 60 min: ventana amplia para reenviar en retry-receipts
                    }
                    if (persistir) {
                        const ts = Date.now();
                        if (!tenantId) await guardar({ telefono: p, mensaje: repTexto, direccion: 'out', mensaje_id: r?.key?.id, ai_generated: aiFlag }).catch(() => {});
                        const emisorS = tenantId ? 'dueno' : 'SRS010904';
                        const emitirS = cid => emitir(evMensaje({ tenantId, chatId: cid, tel: p, msgId: r?.key?.id, ts, direccion: 'out', emisor: emisorS, texto: repTexto, tipo: tipo || 'text', ai: aiFlag, nombre: null }));
                        if (r?.key?.id) guardarMensajeNuevo({ tel: p, msgId: r.key.id, ts, direccion: 'out', emisor: emisorS, texto: repTexto, tipo: tipo || 'text', nombre: null, ai_generated: aiFlag, tenantId }).then(emitirS).catch(() => emitirS(null));
                        else emitirS(null);
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
                    if (!tenantId) encolar(p, () => mandarASalesBrain({ external_id: p, text, direction: 'outbound' }));
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
        }
    };
    U.apiSendFotos = async (res, body) => {
        {
            try {
                const { phone, urls, origen } = JSON.parse(body || '{}');
                if (tenant.id && !ORIGENES_OK.has(String(origen || ''))) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'origen requerido en universos de vendedor (' + [...ORIGENES_OK].join('|') + ')' })); }
                if (!phone || !Array.isArray(urls) || !urls.length) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'phone y urls[] requeridos' })); }
                if (U.estado !== 'conectado') { res.statusCode = 503; return res.end(JSON.stringify({ ok: false, error: 'whatsapp no conectado' })); }
                let p = String(phone).replace(/\D/g, '');
                if (U.lidAPhone.has(p)) p = U.lidAPhone.get(p);
                if (p.length === 10) p = '521' + p;
                await autoEnviarFotos(p, urls);
                res.end(JSON.stringify({ ok: true, n: urls.length }));
            } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
        }
    };
    // ══ DELEGACIÓN (Fase 2): activa un chat en ESTE universo y manda el opener UNA sola vez (Ley 4)
    // ETAPA 2 (base por universo): la delegación es universo → chat (conversaciones) → auto, en `delegaciones` con
    // historial (cambiar de auto = cerrar la activa y abrir otra). DUAL-WRITE: `chats_activos` se sigue escribiendo
    // igual que antes hasta la Etapa 3. La fila en memoria lleva `id` (delegación) y `ca_id` (chats_activos).
    // FORMA DE ENTRADA (orden owner 2026-09-10): el opener sale SOLO si viene en ESTA petición (modo texto/bot elegido por el
    // vendedor), aunque el chat ya estuviera delegado (re-delegar con texto SÍ lo manda, una vez). opener_manual = texto del
    // vendedor → firmado como suyo. opener_pendiente es letra muerta: siempre 0, jamás se lee ni dispara nada después.
    U.delegar = async ({ tel, car_id, car_nombre, comprador_nombre, opener_texto, opener_manual, activado_por }) => {
        let p = String(tel || '').replace(/\D/g, ''); if (p.length === 10) p = '521' + p;
        if (!/^521\d{10}$/.test(p)) return { ok: false, error: 'teléfono inválido' };
        const now = Date.now();
        let fila = U.chatsActivos.get(p);
        const esNueva = !fila;
        if (!fila) fila = { id: null, ca_id: null, tel: p, car_id: car_id || null, car_nombre: car_nombre || null, comprador_nombre: comprador_nombre || null, opener_pendiente: 0, ultimo_from_me: 0, ultimo_entrante: 0 };
        fila.opener_pendiente = 0;
        // ── espejo viejo: chats_activos (igual que antes)
        try {
            if (!fila.ca_id) {
                const ins = await db.execute({ sql: 'INSERT INTO chats_activos (tenant_id, tel, car_id, car_nombre, comprador_nombre, activado_por, desde, opener_pendiente, opener_texto, created) VALUES (?,?,?,?,?,?,?,?,?,?)',
                    args: [tenant.id, p, car_id || null, car_nombre || null, comprador_nombre || null, activado_por || 'fyrachat', now, 0, opener_texto || null, now] });
                fila.ca_id = Number(ins.lastInsertRowid);
            } else {
                await db.execute({ sql: 'UPDATE chats_activos SET car_id=COALESCE(?,car_id), car_nombre=COALESCE(?,car_nombre), comprador_nombre=COALESCE(?,comprador_nombre) WHERE id=?', args: [car_id || null, car_nombre || null, comprador_nombre || null, fila.ca_id] }).catch(() => {});
            }
        } catch (e) { console.error('[t' + tenant.id + '] chats_activos:', e.message); }
        if (!esNueva) Object.assign(fila, { car_id: car_id || fila.car_id, car_nombre: car_nombre || fila.car_nombre, comprador_nombre: comprador_nombre || fila.comprador_nombre });
        U.chatsActivos.set(p, fila);
        // ── el chat existe en su universo (conversación visible en el FyraChat del vendedor aunque nadie haya escrito).
        // emisor 'sistema' = NOTA INTERNA: jamás sale a WhatsApp; FyraChat la pinta como nota gris ("solo tú lo ves").
        await guardarMensajeNuevo({ tel: p, msgId: 'deleg_' + (fila.ca_id || now), ts: now, direccion: 'out', emisor: 'sistema', texto: '🤝 Chat delegado' + (car_nombre ? ' · ' + car_nombre : ''), tipo: 'text', nombre: comprador_nombre || null, ai_generated: 1, tenantId: tenant.id }).catch(() => {});
        // ── la DELEGACIÓN (verdad nueva): por chat_id, idempotente; otro auto → historial
        try {
            const thread = 'whatsapp:' + p + (tenant.id ? ('#t' + tenant.id) : '');
            const cv = (await db.execute({ sql: 'SELECT id FROM conversaciones WHERE channel_thread_id=?', args: [thread] })).rows[0];
            if (cv) {
                const chatId = Number(cv.id);
                const act = (await db.execute({ sql: 'SELECT id, auto_id FROM delegaciones WHERE chat_id=? AND hasta IS NULL ORDER BY id DESC LIMIT 1', args: [chatId] })).rows[0];
                if (act && (!car_id || Number(act.auto_id) === Number(car_id))) {
                    fila.id = Number(act.id);
                    await db.execute({ sql: 'UPDATE delegaciones SET auto_nombre=COALESCE(?,auto_nombre), opener_texto=COALESCE(?,opener_texto), opener_pendiente=0 WHERE id=?', args: [car_nombre || null, opener_texto || null, fila.id] }).catch(() => {});
                } else {
                    if (act) await db.execute({ sql: 'UPDATE delegaciones SET hasta=?, motivo=? WHERE id=?', args: [now, 'delegar', act.id] }).catch(() => {});
                    const insD = await db.execute({ sql: 'INSERT INTO delegaciones (chat_id, tenant_id, auto_id, auto_nombre, activado_por, desde, hasta, opener_pendiente, opener_texto, motivo, created) VALUES (?,?,?,?,?,?,NULL,?,?,NULL,?)',
                        args: [chatId, tenant.id, car_id || null, car_nombre || null, activado_por || 'fyrachat', now, 0, opener_texto || null, now] });
                    fila.id = Number(insD.lastInsertRowid);
                }
                if (car_id) await db.execute({ sql: 'UPDATE conversaciones SET auto_id_activo=? WHERE id=?', args: [Number(car_id), chatId] }).catch(() => {});   // el foco como columna del chat
            }
        } catch (e) { console.error('[t' + tenant.id + '] delegaciones:', e.message); }
        let enviado = false, error = null;
        const texto = String(opener_texto || '').trim();
        if (texto) {   // SOLO lo pedido en ESTA petición; nada queda pendiente para después
            if (U.estado !== 'conectado') error = 'sesión no conectada — el mensaje no salió';
            else {
                try {
                    const r = await autoEnviarTexto(p, texto, { manual: !!opener_manual });
                    enviado = !!(r && r.key && r.key.id);
                    if (!enviado) error = 'WhatsApp no confirmó el envío';
                } catch (e) { error = e.message; }
            }
        }
        console.log('[t' + tenant.id + '] delegado chat ' + jidHash(p) + (esNueva ? '' : ' · ya estaba') + (enviado ? ' · opener enviado' + (opener_manual ? ' (manual)' : '') : ''));
        return { ok: true, chat_id: fila.ca_id || fila.id, delegacion_id: fila.id, ya_delegado: !esNueva, opener_enviado: enviado, error };
    };
    U.soltar = async ({ tel }) => {
        let p = String(tel || '').replace(/\D/g, ''); if (p.length === 10) p = '521' + p;
        const fila = U.chatsActivos.get(p); if (!fila) return { ok: false, error: 'no delegado' };
        const now = Date.now();
        // dual-write: se cierra la delegación (por chat, robusto a ids) Y la fila vieja de chats_activos
        await db.execute({ sql: 'UPDATE chats_activos SET hasta=? WHERE tenant_id=? AND tel=? AND hasta IS NULL', args: [now, tenant.id, p] }).catch(() => {});
        try {
            const thread = 'whatsapp:' + p + (tenant.id ? ('#t' + tenant.id) : '');
            const cv = (await db.execute({ sql: 'SELECT id FROM conversaciones WHERE channel_thread_id=?', args: [thread] })).rows[0];
            if (cv) await db.execute({ sql: 'UPDATE delegaciones SET hasta=?, motivo=COALESCE(motivo, ?) WHERE chat_id=? AND hasta IS NULL', args: [now, 'soltar', Number(cv.id)] });
        } catch (e) { console.error('[t' + tenant.id + '] soltar delegaciones:', e.message); }
        U.chatsActivos.delete(p);
        console.log('[t' + tenant.id + '] soltado chat ' + jidHash(p));
        return { ok: true };
    };
    // ══ VINCULACIÓN POR CÓDIGO (sin QR): WhatsApp → Dispositivos vinculados → Vincular con número
    // de teléfono. El vendedor teclea el código en SU teléfono. Solo mientras no esté registrado.
    U.codigoVinculacion = async () => {
        if (!U.sock) return { ok: false, error: 'universo sin socket' };
        // INVARIANTE 6 (spec 2026-09-10): con creds.registered=true JAMÁS se limpia auth salvo que el estado REPORTADO del
        // universo sea 'desvinculado' (el vendedor quitó el dispositivo / baja). Conectado o reconectando = sigue vinculado:
        // se responde vinculado:true y las credenciales quedan intactas (Sales Brain NO manda WhatsApp con este flag).
        const registrado = !!(U.sock.authState && U.sock.authState.creds && U.sock.authState.creds.registered);
        if (registrado) {
            const est = await estadoSesion(tenant.id);
            if (est !== 'desvinculado') return { ok: false, vinculado: true, error: 'ya está vinculado', estado: est || U.estado };
        }
        const tel = String(tenant.telefono || '').replace(/\D/g, '').replace(/^521(\d{10})$/, '52$1');   // WhatsApp MX: 52 + 10 dígitos
        if (!tel) return { ok: false, error: 'tenant sin teléfono' };
        // UN código por vez (2026-09-10, "códigos diferentes en la web y en WhatsApp"): si el último sigue vivo (<100 s, misma
        // conexión, aún esperando), se devuelve EL MISMO en vez de pedir otro (pedir otro invalida el anterior).
        if (U.ultimoCodigo && U.codigoTs && (Date.now() - U.codigoTs) < 100000 && U.estado === 'esperando_codigo') {
            const c = U.ultimoCodigo; return { ok: true, codigo: c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c, repetido: true };
        }
        // Conexión FRESCA: WhatsApp corta a los ~60-100 s de espera; el código debe nacer recién conectado
        const fresca = U.sockDesde && (Date.now() - U.sockDesde) < 25000 && U.ultimoQR;
        if (!fresca) {
            limpiarAuth(tenant); U.ultimoQR = null; U.estado = 'reconectando';
            try { if (U.reconectTimer) clearTimeout(U.reconectTimer); } catch (e) {}
            U.conectando = false;
            await conectar();
            for (let i = 0; i < 40 && !U.ultimoQR; i++) await sleep(500);   // hasta 20 s a que WhatsApp abra la puerta
            if (!U.ultimoQR) return { ok: false, error: 'WhatsApp no abrió la conexión para pedir el código; intenta de nuevo' };
        }
        try {
            const raw = await U.sock.requestPairingCode(tel);
            const code = String(raw || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
            U.ultimoCodigo = code; U.codigoTs = Date.now(); U.estado = 'esperando_codigo';
            reportarSesion(tenant.id, 'esperando_codigo', 'código pedido');
            return { ok: true, codigo: code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code };
        } catch (e) { return { ok: false, error: e.message }; }
    };
    U.conectar = conectar;
    U.cerrar = async (motivo) => {
        try { if (U.ghostTimer) clearInterval(U.ghostTimer); } catch (e) {}
        try { if (U.reconectTimer) clearTimeout(U.reconectTimer); } catch (e) {}
        U.genConexion++;                                             // cualquier evento del socket viejo se ignora
        try { if (U.sock) await U.sock.logout(); } catch (e) {}
        try { if (U.sock) U.sock.end(undefined); } catch (e) {}
        U.estado = 'desvinculado';
        reportarSesion(tenant.id, 'desvinculado', motivo || 'baja');
    };
    return U;
}

// Abrir / cerrar universos en caliente (sin reiniciar el proceso; los demás ni se enteran)
// ETAPA 2: la verdad es `delegaciones` (por índice tenant_id, hasta; el teléfono viene del chat). Mientras dure el
// dual-write también se lee `chats_activos` y se UNEN por teléfono (una delegación creada antes del backfill solo
// vive ahí; si la tabla nueva no existe todavía, queda el camino viejo). Etapa 3 = quitar la segunda lectura.
async function cargarChatsActivos(U) {
    try {
        const filas = new Map();   // tel → fila en memoria
        let rD = { rows: [] };
        try { rD = await db.execute({ sql: 'SELECT d.id, d.auto_id, d.auto_nombre, c.telefono AS tel, c.nombre AS comprador_nombre FROM delegaciones d JOIN conversaciones c ON c.id=d.chat_id WHERE d.tenant_id=? AND d.hasta IS NULL', args: [U.tenant.id] }); }
        catch (e) { if (!/no such table/i.test(String(e.message))) throw e; }
        // opener_pendiente = 0 SIEMPRE (2026-09-10): la reconexión jamás dispara un opener viejo; el opener solo sale en la petición de delegar que lo pide
        for (const row of rD.rows) filas.set(String(row.tel), { id: Number(row.id), ca_id: null, tel: String(row.tel), car_id: row.auto_id, car_nombre: row.auto_nombre, comprador_nombre: row.comprador_nombre, opener_pendiente: 0, ultimo_from_me: 0, ultimo_entrante: 0 });
        const r = await db.execute({ sql: 'SELECT * FROM chats_activos WHERE tenant_id=? AND hasta IS NULL', args: [U.tenant.id] });
        for (const row of r.rows) {
            const f = filas.get(String(row.tel));
            if (f) { f.ca_id = Number(row.id); f.ultimo_from_me = Number(row.ultimo_from_me) || 0; f.ultimo_entrante = Number(row.ultimo_entrante) || 0; if (!f.car_id) f.car_id = row.car_id; if (!f.car_nombre) f.car_nombre = row.car_nombre; if (!f.comprador_nombre) f.comprador_nombre = row.comprador_nombre; }
            else filas.set(String(row.tel), { id: null, ca_id: Number(row.id), tel: String(row.tel), car_id: row.car_id, car_nombre: row.car_nombre, comprador_nombre: row.comprador_nombre, opener_pendiente: 0, ultimo_from_me: Number(row.ultimo_from_me) || 0, ultimo_entrante: Number(row.ultimo_entrante) || 0 });
        }
        cacheEscribir('chats.' + U.tenant.id + '.json', [...filas.values()]);
        U.chatsActivos.clear();
        for (const [tel, f] of filas) U.chatsActivos.set(tel, f);
        console.log('[delegación] tenant ' + U.tenant.id + ': ' + U.chatsActivos.size + ' chats activos (' + rD.rows.length + ' en delegaciones, ' + r.rows.length + ' en chats_activos)');
        U.chatsCargados = true;
    } catch (e) {
        console.error('[delegación] carga:', e.message);
        // MODO SIN BASE: última lista conocida desde caché; se reintenta cada minuto hasta que la base vuelva
        const cache = cacheLeer('chats.' + U.tenant.id + '.json') || [];
        if (cache.length && !U.chatsActivos.size) for (const row of cache) U.chatsActivos.set(String(row.tel), { id: row.id != null ? Number(row.id) : null, ca_id: row.ca_id != null ? Number(row.ca_id) : (row.id != null && row.ca_id === undefined ? Number(row.id) : null), tel: String(row.tel), car_id: row.car_id, car_nombre: row.car_nombre, comprador_nombre: row.comprador_nombre, opener_pendiente: 0, ultimo_from_me: Number(row.ultimo_from_me) || 0, ultimo_entrante: Number(row.ultimo_entrante) || 0 });
        U.chatsCargados = false;
    }
}
async function abrirUniverso(tenant) {
    if (tenant && tenant.config && Number(tenant.config.demo) === 1) throw new Error('universo demo: no se abre en WhatsApp');   // simulador PRUEBAS#
    if (universos.has(tenant.id)) return universos.get(tenant.id);
    const U = crearUniverso(tenant);
    universos.set(tenant.id, U);
    await cargarChatsActivos(U);
    await U.conectar();
    return U;
}
async function cerrarUniverso(tenantId, borrarCredenciales) {
    const U = universos.get(tenantId); if (!U) return false;
    await U.cerrar('baja');
    universos.delete(tenantId);
    if (borrarCredenciales) {
        const dir = path.join(__dirname, 'auth', String(tenantId));
        try {   // borrado REAL: sobrescribir cada archivo y luego eliminar (Fase 7 lo cifra en reposo)
            for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); const n = fs.statSync(p).size; fs.writeFileSync(p, Buffer.alloc(n, 0)); fs.unlinkSync(p); }
            fs.rmdirSync(dir);
        } catch (e) { console.error('[baja] borrando auth/' + tenantId + ':', e.message); }
    }
    return true;
}
const CACHE_DIR = require('path').join(__dirname, 'cache');
function cacheEscribir(nombre, obj) { try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(require('path').join(CACHE_DIR, nombre), JSON.stringify(obj)); } catch (e) {} }
function cacheLeer(nombre) { try { return JSON.parse(fs.readFileSync(require('path').join(CACHE_DIR, nombre), 'utf8')); } catch (e) { return null; } }
async function cargarTenants() {
    try {
        const rows = await cargarTenantsDB();
        cacheEscribir('tenants.json', rows);
        return rows;
    } catch (e) {
        // MODO SIN BASE (2026-09-08): la base no responde → arrancar con la última lista conocida; jamás quedarnos caídos.
        const cache = cacheLeer('tenants.json');
        if (cache && cache.length) { console.error('[arranque] base sin responder (' + e.message.slice(0, 80) + ') → tenants desde caché: ' + cache.map(t => t.id).join(',')); return cache; }
        // sin caché: derivar de las carpetas de sesión existentes (auth/<id>)
        let ids = [];
        try { ids = fs.readdirSync(require('path').join(__dirname, 'auth')).filter(d => /^\d+$/.test(d)).map(Number).sort((a, b) => a - b); } catch (e2) {}
        if (!ids.length) throw e;
        console.error('[arranque] base sin responder y sin caché → tenants desde auth/: ' + ids.join(','));
        return ids.map(id => ({ id, telefono: '', nombre: 't' + id, config: {} }));
    }
}
async function cargarTenantsDB() {
    await db.execute('CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY, telefono TEXT UNIQUE, nombre TEXT, activo INTEGER DEFAULT 1, config_json TEXT, created_at INTEGER)');
    await db.execute('CREATE TABLE IF NOT EXISTS wa_sessions (tenant_id INTEGER PRIMARY KEY, estado TEXT, motivo TEXT, ultimo_evento INTEGER, ultimo_mensaje INTEGER, qr_pendiente INTEGER DEFAULT 0, updated INTEGER)');
    const r = await db.execute('SELECT id, telefono, nombre, config_json FROM tenants WHERE activo = 1 ORDER BY id');
    let rows = r.rows.map(x => ({ id: Number(x.id), telefono: String(x.telefono || ''), nombre: String(x.nombre || ''), config: (() => { try { return JSON.parse(x.config_json || '{}'); } catch (e) { return {}; } })() }));
    rows = rows.filter(t => Number(t.config && t.config.demo) !== 1);   // universo DEMO (simulador PRUEBAS#): jamás se abre en WhatsApp
    // TENANTS_SOLO=99,100 → arranque acotado (pruebas locales: JAMÁS abrir el tenant 0 fuera del VPS)
    if (process.env.TENANTS_SOLO) { const solo = new Set(process.env.TENANTS_SOLO.split(',').map(Number)); rows = rows.filter(t => solo.has(t.id)); }
    return rows;
}
// LATIDO: cada 60s persiste el último mensaje recibido por sesión (detecta zombis desde Sales Brain)
setInterval(() => {
    for (const [id, U] of universos) {
        if (U.ultimoRecibido) db.execute({ sql: 'UPDATE wa_sessions SET ultimo_mensaje=?, updated=? WHERE tenant_id=?', args: [U.ultimoRecibido, Date.now(), id] }).catch(() => {});
    }
}, 60000);

// ═══════════════════════ CASILLAS PROGRAMADAS — EL TIMBRE DE LAS CITAS (orden owner 2026-09-08) ═══════════════════════
// Cada recordatorio de cita es una CASILLA (tabla cita_casillas, la escribe fyrachat). Aquí vive UN temporizador por
// casilla (evento, no sondeo): al vencer se ejecuta POR LA MISMA PUERTA que el cron (seb-panel action=casilla_ejecutar,
// idempotente). Vueltas de máx. 24 h (se re-arma solo con la due_ts en memoria). Al reiniciar el proceso se re-arma
// leyendo las pendientes de las próximas 24 h en UNA consulta (casillas_pendientes) y cada 12 h se repite (respaldo);
// lo que se escape (proceso caído en la hora exacta) lo recoge el cron cada 10 min por la misma puerta.
const casillaTimers = new Map();   // casilla_id → { timer, due_ts }
const CASILLA_VUELTA_MS = 24 * 3600000;
async function ejecutarCasillaRemota(id) {
    try {
        const r = await fetch(OPENER_AUTO_URL, { method: 'POST', headers: HDR_PUENTE, body: cuerpoPanel({ action: 'casilla_ejecutar', id }) });
        const d = await r.json().catch(() => ({}));
        console.log('[casilla] #' + id + ' → ' + JSON.stringify(d).slice(0, 140));
        // el cerebro dice "aún no toca" (reloj desfasado) → re-armar con su due_ts
        if (d && d.motivo === 'aun_no_toca' && Number(d.due_ts)) programarCasilla(id, Number(d.due_ts));
        // envío fallido (universo desconectado, red) → reintento en 5 min; el cron también la recoge
        else if (d && d.ok === false && d.motivo !== 'no_existe') programarCasilla(id, Date.now() + 5 * 60000);
    } catch (e) { console.error('[casilla] #' + id + ':', e.message); programarCasilla(id, Date.now() + 5 * 60000); }
}
function programarCasilla(id, dueTs) {
    id = Number(id); dueTs = Number(dueTs);
    if (!id || !dueTs) return false;
    const prev = casillaTimers.get(id); if (prev && prev.timer) clearTimeout(prev.timer);
    const espera = Math.max(0, dueTs - Date.now());
    const timer = setTimeout(() => {
        casillaTimers.delete(id);
        if (dueTs - Date.now() > 1000) return programarCasilla(id, dueTs);   // vuelta de 24 h: todavía no → otra vuelta
        ejecutarCasillaRemota(id);
    }, Math.min(espera, CASILLA_VUELTA_MS));
    casillaTimers.set(id, { timer, due_ts: dueTs });
    return true;
}
function cancelarCasillaTimer(id) { const t = casillaTimers.get(Number(id)); if (t && t.timer) clearTimeout(t.timer); return casillaTimers.delete(Number(id)); }
async function rearmarCasillas() {
    try {
        const r = await fetch(OPENER_AUTO_URL + '?action=casillas_pendientes&horas=24' + queryVieja(), { headers: HDR_PUENTE });
        const d = await r.json().catch(() => ({}));
        if (!d || !d.ok || !Array.isArray(d.casillas)) { console.error('[casilla] re-armar: respuesta inválida'); return; }
        let n = 0; for (const c of d.casillas) if (programarCasilla(c.casilla_id, c.due_ts)) n++;
        console.log('[casilla] re-armadas ' + n + ' casillas (próximas 24 h) · timers vivos: ' + casillaTimers.size);
    } catch (e) { console.error('[casilla] re-armar:', e.message); }
}
setTimeout(rearmarCasillas, 20 * 1000); setInterval(rearmarCasillas, 12 * 3600000);

// ═══════════════════════ SERVIDOR HTTP (una puerta, muchos universos) ═══════════════════════
const leerBody = (req) => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
const tenantDe = (body) => { const t = Number(body && body.tenant_id); return universos.get(Number.isInteger(t) ? t : 0); };
const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url, 'http://x');
    // ÚNICA ruta pública: latido sin datos (para monitores). Todo lo demás exige x-api-key (K_PUENTE; KEY_VIEJA en transición).
    if (url.pathname === '/health') return res.end(JSON.stringify({ ok: true }));
    const conKey = llaveEntrante(req, url.pathname);
    if (url.pathname === '/status') {                                                      // (con key: expone estados/teléfonos)
        if (!conKey) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
        const lista = [...universos.values()].map(U => ({ tenant_id: U.tenant.id, nombre: U.tenant.nombre, estado: U.estado, conectado: U.estado === 'conectado', lid_map: U.lidAPhone.size, ultimo_mensaje: U.ultimoRecibido || null }));
        const U0 = universos.get(0);
        return res.end(JSON.stringify({ ok: true, estado: U0 ? U0.estado : 'sin_tenant_0', conectado: !!(U0 && U0.estado === 'conectado'), lid_map: U0 ? U0.lidAPhone.size : 0, universos: lista }));
    }
    let m;
    if ((m = url.pathname.match(/^\/qr\/(\d+)$/))) {                                   // GET /qr/<tenantId> (con key)
        if (!conKey) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
        const U = universos.get(Number(m[1]));
        if (!U) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'tenant sin universo abierto' })); }
        return res.end(JSON.stringify({ ok: true, tenant_id: U.tenant.id, estado: U.estado, qr: U.ultimoQR }));
    }
    if (url.pathname === '/qr') {                                                          // compat: tenant 0 (con key)
        if (!conKey) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
        const U = universos.get(0);
        return res.end(JSON.stringify({ ok: true, estado: U ? U.estado : 'sin_tenant_0', qr: U ? U.ultimoQR : null }));
    }
    if ((m = url.pathname.match(/^\/tenant\/(\d+)\/(open|close)$/)) && req.method === 'POST') {   // alta/baja en caliente (con key)
        if (!conKey) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
        const id = Number(m[1]);
        try {
            if (m[2] === 'open') {
                const r = await db.execute({ sql: 'SELECT id, telefono, nombre, config_json FROM tenants WHERE id=? AND activo=1', args: [id] });
                if (!r.rows.length) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'tenant no existe o inactivo' })); }
                const t = r.rows[0];
                const U = await abrirUniverso({ id, telefono: String(t.telefono || ''), nombre: String(t.nombre || ''), config: (() => { try { return JSON.parse(t.config_json || '{}'); } catch (e) { return {}; } })() });
                return res.end(JSON.stringify({ ok: true, tenant_id: id, estado: U.estado }));
            }
            if (id === 0) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'el tenant 0 no se da de baja por HTTP' })); }
            const b = JSON.parse((await leerBody(req)) || '{}');
            const ok = await cerrarUniverso(id, b.borrar_credenciales !== false);
            return res.end(JSON.stringify({ ok, tenant_id: id }));
        } catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }
    if ((m = url.pathname.match(/^\/tenant\/(\d+)\/codigo$/)) && req.method === 'POST') {           // vinculación por código (con key)
        if (!conKey) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
        const U = universos.get(Number(m[1]));
        if (!U) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'tenant sin universo abierto' })); }
        try { return res.end(JSON.stringify(Object.assign({ tenant_id: U.tenant.id, telefono: U.tenant.telefono }, await U.codigoVinculacion()))); }
        catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }
    if ((m = url.pathname.match(/^\/tenant\/(\d+)\/(delegar|soltar)$/)) && req.method === 'POST') {   // Fase 2 (con key)
        if (!conKey) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
        const U = universos.get(Number(m[1]));
        if (!U) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'tenant sin universo abierto' })); }
        try {
            const b = JSON.parse((await leerBody(req)) || '{}');
            const r = m[2] === 'delegar' ? await U.delegar(b) : await U.soltar(b);
            return res.end(JSON.stringify(r));
        } catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }
    // EL TIMBRE DE CAMBIOS (Ley del Timbre, 2026-09-08): cualquier pieza del sistema (FyraChat, Sales Brain, citas vivas)
    // que CAMBIA algo toca aquí y el puente lo rebota a todas las pantallas conectadas (calendario, FyraChat…).
    // Evento, no sondeo: las pantallas ya no preguntan cada X segundos si algo cambió.
    if (url.pathname === '/api/emit' && req.method === 'POST') {
        if (!conKey) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
        let ev = {}; try { ev = JSON.parse((await leerBody(req)) || '{}'); } catch (e) {}
        if (!ev || typeof ev !== 'object') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'evento inválido' })); }
        // `mensaje` desde el servidor (contrato v2): SOLO renglones que fyrachat persistió él mismo (envíos SIMULADOS del carril de
        // pruebas / universo demo) — exige chat_id + objeto mensaje. Lo real lo emite el puente al mandar/recibir.
        if (ev.tipo === 'mensaje') {
            if (ev.chat_id == null || !ev.mensaje || typeof ev.mensaje !== 'object') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'mensaje inválido (chat_id + mensaje requeridos)' })); }
            const mm = ev.mensaje;
            const outM = Object.assign({}, ev, { tipo: 'mensaje', tenant_id: Number(ev.tenant_id) || 0, chat_id: Number(ev.chat_id), texto: String(mm.texto || ''), direccion: mm.dir === 'in' ? 'in' : 'out', timestamp: Math.floor(Number(mm.ts || Date.now()) / 1000), msg_id: mm.msg_id || null, ts: Date.now() });
            emitir(outM);
            console.log('[timbre] mensaje (servidor) · t' + outM.tenant_id + ' · chat ' + outM.chat_id + (ev.simulado ? ' · simulado' : '') + ' → ' + (wss ? [...wss.clients].filter(c => c.readyState === 1).length : 0) + ' pantallas');
            return res.end(JSON.stringify({ ok: true }));
        }
        // `cambio`: TODO evento lleva tenant_id (default 0), chat_id (o null) y `que` (contrato v2) — fyrachat ya los manda; aquí se garantizan
        const out = Object.assign({ tipo: 'cambio' }, ev, { tenant_id: Number(ev.tenant_id) || 0, chat_id: ev.chat_id == null ? null : Number(ev.chat_id), que: ev.que || 'otro', ts: Date.now() });
        emitir(out);
        console.log('[timbre] cambio · ' + (out.entidad || '?') + (out.accion ? ' · ' + out.accion : '') + ' · ' + out.que + ' · t' + out.tenant_id + (out.chat_id != null ? ' · chat ' + out.chat_id : '') + ' → ' + (wss ? [...wss.clients].filter(c => c.readyState === 1).length : 0) + ' pantallas');
        return res.end(JSON.stringify({ ok: true }));
    }
    // EL TIMBRE DE LAS CITAS: fyrachat programa/cancela temporizadores de casillas (con key).
    //   POST /api/programar { casillas:[{casilla_id, due_ts}] } | { casilla_id, due_ts } | { cancelar:[ids] }
    //   (también /tenant/<id>/programar por simetría con la botonera; el tenant no cambia nada: la casilla trae su universo)
    if ((url.pathname === '/api/programar' || /^\/tenant\/\d+\/programar$/.test(url.pathname)) && req.method === 'POST') {
        if (!conKey) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
        let b = {}; try { b = JSON.parse((await leerBody(req)) || '{}'); } catch (e) {}
        let programadas = 0, canceladas = 0;
        const lista = Array.isArray(b.casillas) ? b.casillas : (b.casilla_id ? [{ casilla_id: b.casilla_id, due_ts: b.due_ts }] : []);
        for (const c of lista) if (c && programarCasilla(c.casilla_id, c.due_ts)) programadas++;
        for (const id of (Array.isArray(b.cancelar) ? b.cancelar : [])) if (cancelarCasillaTimer(id)) canceladas++;
        if (programadas) console.log('[casilla] programadas ' + programadas + ' · timers vivos: ' + casillaTimers.size);
        return res.end(JSON.stringify({ ok: true, programadas, canceladas, timers: casillaTimers.size }));
    }
    if (url.pathname === '/api/send' && req.method === 'POST') {
        if (!conKey) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
        const body = await leerBody(req);
        let parsed = {}; try { parsed = JSON.parse(body || '{}'); } catch (e) {}
        const U = tenantDe(parsed);                                        // Fase 1: default tenant 0; Fase 3 = guardia de salida
        if (!U) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'tenant sin universo' })); }
        return U.apiSend(res, body);
    }
    if (url.pathname === '/api/send-fotos' && req.method === 'POST') {
        if (!conKey) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
        const body = await leerBody(req);
        let parsed = {}; try { parsed = JSON.parse(body || '{}'); } catch (e) {}
        const U = tenantDe(parsed);
        if (!U) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'tenant sin universo' })); }
        return U.apiSendFotos(res, body);
    }
    res.statusCode = 404; res.end(JSON.stringify({ ok: false }));
});

// ═══════════════════════ ARRANQUE: un universo por tenant activo ═══════════════════════
async function arrancar() {
    const tenants = await cargarTenants();
    console.log('[arranque] tenants activos: ' + tenants.map(t => t.id + ':' + (t.nombre || t.telefono)).join(', '));
    for (const t of tenants) { try { await abrirUniverso(t); } catch (e) { console.error('[arranque] tenant ' + t.id + ':', e.message); } }
}
// EL TIMBRE: WebSocket sobre el mismo servidor/puerto. FyraChat se conecta aquí.
try {
    const { WebSocketServer } = require('ws');
    wss = new WebSocketServer({ server });
    wss.on('connection', (c) => { try { c.send(JSON.stringify({ tipo: 'hola' })); } catch (e) {} });
    console.log('🔔 Timbre WebSocket listo');
} catch (e) { console.error('ws no disponible:', e.message); }
server.listen(PORT, () => console.log('Bridge HTTP en puerto ' + PORT));

arrancar().catch(e => { console.error('FATAL', e); process.exit(1); });


