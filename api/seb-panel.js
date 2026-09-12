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
const U = require('../lib/seb/universo.js');   // ETAPA 2: universo → chat → estado/delegación (puerta única)
// CUOTA TURSO (2026-09-08): caché en memoria del proceso — dueños (5 min), inventario activo (15 s),
// y lo que es "por request" se olvida al entrar (ver olvidar en el handler).
const { telefonosDueno, memoQuery, olvidar, INV_TTL } = require('../lib/seb/memo.js');
const { entender } = require('../lib/seb/clasificador.js');
const { pensar } = require('../lib/seb/loop.js');
const { responder: responderOpener, SENTINEL, necesitaCerebro } = require('../lib/seb/opener.js');
const { responderCont } = require('../lib/seb/continuacion.js');
// ══ CITAS VIVAS (WhatsApp REAL) — el MISMO cerebro del sandbox (lib/seb/citas-vivas.js):
// dueño responde → IA interpreta → match/contrapropuesta; comprador en match →
// cancelación/en-camino; señal manual del owner; recordatorios via cron.
const citasVivas = require('../lib/seb/citas-vivas.js');
const ACC = require('../lib/seb/acceso.js');   // ACCESO POR SESIÓN (2026-09-10): el universo lo dicta la cookie, no la barra
const DEMO = require('../lib/seb/demo.js');    // FYRACHAT DE PRUEBA (2026-09-10): universo PRUEBAS# — nada llega a WhatsApp ni al puente
// ══ LA PUERTA ÚNICA DE MENSAJES (FyraChat v2, contrato 2026-09-10): TODO envío que nace aquí (manual, sugerencia
// aprobada, botones, opener de delegar en t0, programados, rescates) sale por lib/seb/mensajeria.js: resuelve chat →
// teléfono real → delegación viva → carril de pruebas → idempotencia por `clave` (tabla envios) → puente → recibo.
const MSJ = require('../lib/seb/mensajeria.js');
const ACCIONES = require('../lib/seb/acciones.js');
// 🚩fyrachat#7: al confirmarse una cita, la fecha/hora del CERRADOR quedan como
// CANÓNICAS (deterministas, sin IA) — el cita-extractor las usa tal cual.
// ══ BITÁCORA DE ESCALADAS (opción A del owner, 2026-07-13): las escaladas de
// CRITERIO abren la puerta a que su primer manual tome posesión (ver doctrina).
// ══ APARADOR DE CARRUSEL (orden owner 2026-07-20) — la lógica vive en la FUENTE
// ÚNICA lib/seb/aparador.js (el sandbox usa LA MISMA): aquí solo se importa.
const { intentarEleccionAparador, arranqueCarrusel, opcionesEnFlujo } = require('../lib/seb/aparador.js');
const RE_PETICION_POS = /(fotos?|im[aá]genes|videos?|ubicaci[oó]n|direcci[oó]n|d[oó]nde|mapa|precio|cu[aá]nto|cotiza|enganche|mensualidad|cita|agenda|disponible|informaci[oó]n|detalles|ficha)/i;


async function logEscala(tel, motivo) {
    try {
        await run("CREATE TABLE IF NOT EXISTS escalas_log (id INTEGER PRIMARY KEY AUTOINCREMENT, telefono TEXT, motivo TEXT, ts INTEGER)");
        await run("INSERT INTO escalas_log (telefono, motivo, ts) VALUES (?,?,?)", [String(tel), String(motivo || ''), Date.now()]);
    } catch (e) { }
}

// tenantId (2026-09-10): universo de la cita; opener_auto es del universo 0 (default)
async function regCanonica(tel, r, tenantId) {
    try {
        if (r && r.cita_confirmada && r.cita_datos) {
            await citasVivas.registrarCitaCanonica({ telefono: tel, fecha: r.cita_datos.fecha, hora: r.cita_datos.hora, lugar: r.cita_datos.lugar || null, tenant_id: Number(tenantId) || 0 });
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

// telefonosDueno() vive en lib/seb/memo.js (cacheado 5 min; misma consulta de siempre).

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

// Guarda qué OFRECIÓ Seb en su última respuesta ("¿te mando las fotos?") para que
// un "sí" del comprador lo ejecute (orden owner 2026-07-21).
async function guardarOferta(telO, segs) {
    try {
        const mm = require('../lib/seb/mesa.js');
        const of = mm.ofertaDeSegmentos(segs);
        const stO = await U.leerEstado(0, telO);
        if (!stO.existe) return;
        const ej = stO.ej;
        if (of) ej.oferta = of; else delete ej.oferta;
        await U.guardarEstado(0, telO, { estado_json: ej });
    } catch (e) { }
}

// ══════════ CLASIFICACIÓN DE ACCIONES (blindaje 2026-09-10, spec docs/seguridad-acceso-spec-2026-09-10.md) ══════════
// PÚBLICA: sin nada. K_PUENTE: solo el puente (header x-api-key). K_PANEL: servidores propios (web, SB, Claude/scripts).
// Las de K_PUENTE y K_PANEL también las abre la sesión MAESTRA (el owner desde su navegador). Todo lo no listado = SESIÓN.
const ACC_PUBLICAS = new Set(['acceso_yo', 'acceso_pedir', 'acceso_entrar', 'acceso_salir', 'acceso_canjear', 'timbre_url', 'acceso_modo', 'acceso_entrar_contrasena']);
// CONTRASEÑA (orden owner 2026-09-12): con sesión pero SIN contraseña creada, solo se permiten estas acciones (la UI obliga a crearla)
const ACC_SIN_CONTRASENA = new Set(['acceso_contrasena_crear', 'acceso_sesiones', 'acceso_cerrar_sesion', 'acceso_cerrar_todas', 'tenant_info']);
const ACC_PUENTE = new Set(['opener_auto', 'ghost_scan', 'recepcion_activa', 'recepcion_foto', 'carga_pieza', 'rescate_turno', 'rescate_manual', 'cierre_timbre', 'cita_entrante', 'casilla_ejecutar', 'casillas_pendientes']);
const ACC_PANEL = new Set(['acceso_ticket_maestra', 'acceso_ticket', 'acceso_cerrar_todas_tenant', 'recepcion_pendientes', 'recepcion_publicar', 'recepcion_rechazar', 'casillas_estado', 'cancelar_match_manual', 'match_directo', 'confirmar_match',
    'cita_vendedor_agregar', 'cita_vendedor_confirmar', 'cita_vendedor_lista', 'rescate_agenda', 'rescate_cancelar', 'rescate_reactivar', 'prog_crear', 'prog_cancelar', 'prog_machote',
    'flags_msgs', 'flags_msgs_done', 'citas_backfill', 'universo_backfill']);
// prog_crear/prog_machote también los usa copilot.html (el vendedor programa "te aviso" desde su FyraChat) → K_PANEL **o** SESIÓN
const ACC_PANEL_O_SESION = new Set(['prog_crear', 'prog_machote']);
const ORIGEN_PROPIO = 'https://fyrachat.vercel.app';

module.exports = async function handler(req, res) {
    // ══ CORS (bloque 6): sin '*'. Solo los orígenes de CORS_ORIGENES (vacío por defecto) reciben ACAO.
    const origin = String((req.headers && req.headers.origin) || '');
    const CORS_OK = (process.env.CORS_ORIGENES || '').split(',').map(s => s.trim()).filter(Boolean);
    if (origin && CORS_OK.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    }
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

        // ══════════ LLAVES (bloque 1): header x-api-key, comparación en tiempo constante; transición KEY_VIEJA por body/query ══════════
        const hdrKey = String((req.headers && req.headers['x-api-key']) || '');
        const bodyKey = String((req.body && req.body.key) || (req.query && req.query.key) || '');
        const viejaOk = !!process.env.KEY_VIEJA && !!bodyKey && ACC.mismaClave(bodyKey, process.env.KEY_VIEJA);
        if (viejaOk) console.warn('[key-vieja]', action);
        const conPuente = (!!process.env.K_PUENTE && !!hdrKey && ACC.mismaClave(hdrKey, process.env.K_PUENTE)) || viejaOk;
        const conPanel = (!!process.env.K_PANEL && !!hdrKey && ACC.mismaClave(hdrKey, process.env.K_PANEL)) || viejaOk;

        // ══════════ ACCESO DEL VENDEDOR (bloque 2 del blindaje, 2026-09-10) ══════════
        // Regla: una sesión de vendedor SIEMPRE opera su propio universo (lo que diga ?vendedor= se ignora).
        // ?vendedor= suelto solo lo aceptan la sesión MAESTRA (owner), STAFF_TELS (solo =0) o quien trae la key (puente / Sales Brain).
        const tokenSes = ACC.leerCookie(req);
        const SES0 = tokenSes ? await ACC.sesionDe(tokenSes).catch(() => null) : null;
        const SES = SES0 && !SES0.desvinculado ? SES0 : null;
        const DESV = SES0 && SES0.desvinculado ? SES0.tenant : null;   // tenía sesión pero su WhatsApp ya no está vinculado
        const IP = ACC.ipDe(req);
        const STAFF = (process.env.STAFF_TELS || '').split(',').map(ACC.tel521).filter(Boolean);
        const esStaff = !!(SES && STAFF.includes(String(SES.tenant.telefono)));
        const MAESTRA = !!(SES && SES.maestra);

        // ══ CSRF (bloque 6): un POST con cookie solo se acepta desde nuestro propio origen (o uno de CORS_ORIGENES)
        if (req.method === 'POST' && tokenSes && origin && origin !== ORIGEN_PROPIO && !CORS_OK.includes(origin)) {
            return res.status(403).json({ ok: false, error: 'origen no permitido' });
        }

        let VEND_PARAM = String((req.query && req.query.vendedor) || (req.body && req.body.vendedor) || '').trim();
        const pidioT0 = VEND_PARAM === '0';
        // UNIVERSO 0 = UN LOTE MÁS (orden owner 2026-09-12): quien entra con el número principal (56 5942 3834) es el dueño de ese universo,
        // igual que cualquier vendedor con el suyo. Sin trato especial: código → contraseña → su FyraChat.
        const duenoT0 = !!(SES && Number(SES.tenant_id) === 0);
        // 'vendedor=0' = FyraChat de Fyradrive (tenant 0 clásico): su dueño, la maestra, STAFF o la key pueden pedirlo así
        if (pidioT0 && (conPuente || conPanel || MAESTRA || esStaff || duenoT0)) VEND_PARAM = '';
        if (SES && !MAESTRA) {
            if (duenoT0) VEND_PARAM = '';   // el dueño del número principal opera SU universo (el 0), como cualquier vendedor el suyo
            else if (esStaff && pidioT0) { /* STAFF en tenant 0 */ }
            else if (esStaff && VEND_PARAM && VEND_PARAM !== String(SES.tenant_id)) return res.status(403).json({ ok: false, error: 'Ese universo no es tuyo' });
            else VEND_PARAM = String(SES.tenant_id);   // toda sesión de vendedor abre SU universo
        } else if (MAESTRA && !VEND_PARAM && !pidioT0) VEND_PARAM = String(SES.tenant_id);   // la maestra sin ?vendedor= abre su universo; con ?vendedor= el que pida

        // ══════════ REGLA ÚNICA DE AUTORIZACIÓN (antes de cualquier acción) ══════════
        const t0 = !VEND_PARAM;
        const mandaEnT0 = !!(SES && (MAESTRA || esStaff || duenoT0));
        const SIN_SESION = { ok: false, error: 'Entra con el código que te llega a tu WhatsApp', login: true };
        if (!ACC_PUBLICAS.has(action)) {
            if (ACC_PUENTE.has(action)) {
                if (!conPuente && !MAESTRA) {
                    if (!process.env.K_PUENTE && !process.env.KEY_VIEJA) return res.status(503).json({ error: 'K_PUENTE no configurada' });
                    return res.status(401).json(SIN_SESION);
                }
            } else if (ACC_PANEL.has(action)) {
                const sesionVale = ACC_PANEL_O_SESION.has(action) && (t0 ? mandaEnT0 : !!SES);
                if (!conPanel && !MAESTRA && !sesionVale) {
                    if (!process.env.K_PANEL && !process.env.KEY_VIEJA) return res.status(503).json({ error: 'K_PANEL no configurada' });
                    return res.status(401).json(SIN_SESION);
                }
            } else if (!conPuente && !conPanel && (t0 ? !mandaEnT0 : !SES)) {
                return res.status(401).json(SIN_SESION);
            }
        }
        // ══ BITÁCORA (invariante 8): toda escritura con cookie deja sesion_id + ip (1 INSERT best-effort; GET no escribe)
        // CANDADO CONTRASEÑA: universo real con sesión pero sin contraseña creada → solo lo mínimo hasta que la cree (la UI muestra "Crea tu contraseña")
        if (SES && SES.contrasena_pendiente && !ACC_PUBLICAS.has(action) && !ACC_SIN_CONTRASENA.has(action) && !conPuente && !conPanel) return res.status(403).json({ ok: false, error: 'Crea tu contraseña para continuar.', contrasena_pendiente: true });
        if (req.method === 'POST' && SES && !ACC_PUBLICAS.has(action)) await ACC.accesosLog({ sesion_id: SES.sid, tenant_id: SES.tenant_id, action, ip: IP });

        // ══════════ MODO PRUEBA (2026-09-10): la sesión del tenant demo opera SOLO su universo simulado ══════════
        const SES_DEMO = !!(SES && SES.tenant && SES.tenant.demo);
        if (SES_DEMO && ['sugerir', 'resolver', 'agregar_mensaje', 'nuevo_chat'].includes(action)) return res.status(400).json({ ok: false, error: 'no disponible en modo prueba' });   // escriben en hilos del tenant 0
        if (action === 'demo_responder' && req.method === 'POST') {
            if (!SES_DEMO) return res.status(403).json({ ok: false, error: 'solo en el FyraChat de prueba' });
            const tDm = await tenantDeParam(String(SES.tenant_id)); if (!tDm || !tDm.demo) return res.status(403).json({ ok: false, error: 'solo en el FyraChat de prueba' });
            // v2 (2026-09-12): la UI manda chat_id (conversaciones.id del universo demo); el teléfono se resuelve aquí
            let telDm = req.body.telefono;
            if (!telDm && req.body.chat_id) { const cDm = await U.chatPorId(Number(req.body.chat_id) || 0); if (!cDm || Number(cDm.tenant_id) !== Number(tDm.id)) return res.status(404).json({ ok: false, error: 'chat inexistente en este universo' }); telDm = cDm.telefono; }
            const r = await DEMO.responder({ tenant: tDm, tel: telDm, texto: req.body.texto });
            return res.status(r.ok ? 200 : 400).json(Object.assign({ simulado: true, chat_id: req.body.chat_id ? Number(req.body.chat_id) : undefined }, r));
        }
        if (action === 'demo_reset' && req.method === 'POST') {
            if (!SES_DEMO) return res.status(403).json({ ok: false, error: 'solo en el FyraChat de prueba' });
            const tDr = await tenantDeParam(String(SES.tenant_id)); if (!tDr || !tDr.demo) return res.status(403).json({ ok: false, error: 'solo en el FyraChat de prueba' });
            const r = await DEMO.reset(tDr);
            return res.status(r.ok ? 200 : 400).json(r);
        }

        if (action === 'acceso_yo') return res.status(200).json({ ok: true, sesion: SES ? { tenant: SES.tenant, maestra: SES.maestra, staff: esStaff, contrasena_pendiente: !!SES.contrasena_pendiente, tiene_contrasena: !!SES.tiene_contrasena, via: SES.via } : null, desvinculado: DESV ? { tenant: DESV } : null });
        // ── CONTRASEÑA (orden owner 2026-09-12) ──
        if (action === 'acceso_modo' && req.method === 'POST') {   // ¿este número entra con contraseña o con código? (no revela si el número existe)
            const telM = String(req.body.telefono || '').replace(/\D/g, '');
            if (telM.length < 10) return res.status(400).json({ ok: false, error: 'Escribe tu WhatsApp de 10 dígitos.' });
            if ((await ACC.contarLimite('modo:ip:' + IP, 60, 10 * 60 * 1000)).excedido) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera unos minutos.' });
            return res.status(200).json(await ACC.modoAcceso(telM));
        }
        if (action === 'acceso_entrar_contrasena' && req.method === 'POST') {
            const r = await ACC.entrarConContrasena(req.body.telefono, req.body.contrasena, req.headers['user-agent'], IP);
            if (!r.ok) return res.status(r.limite ? 429 : 401).json({ ok: false, error: r.error });
            if (r.tenant && r.tenant.id !== 0 && !r.maestra && await ACC.estaDesvinculado(r.tenant.id)) { await ACC.cerrarSesion(r.token); return res.status(409).json({ ok: false, error: 'Tu WhatsApp ya no está vinculado. Vuelve a vincularlo en fyradrive.com/seb.' }); }
            ACC.ponerCookie(res, r.token);
            await ACC.accesosLog({ sesion_id: r.sid, tenant_id: r.tenant.id, action: 'acceso_entrar_contrasena', ip: IP });
            await ACC.avisarSesionNueva(r.tenant, req.headers['user-agent'], IP, r.sid);
            return res.status(200).json({ ok: true, tenant: r.tenant, maestra: r.maestra, contrasena_pendiente: false });
        }
        if (action === 'acceso_contrasena_crear' && req.method === 'POST') {
            // crea (alta) o repone ("olvidé": la sesión nació por código/ticket hace < 15 min). Con contraseña vigente y sesión vieja → usar acceso_contrasena_cambiar.
            if (!SES) return res.status(401).json({ ok: false, error: 'Sin sesión' });
            if (SES.tenant && SES.tenant.demo) return res.status(400).json({ ok: false, error: 'El modo prueba no lleva contraseña.' });
            const reciente = (SES.via === 'codigo' || SES.via === 'ticket') && (Date.now() - Number(SES.creada || 0)) < 15 * 60 * 1000;
            if (SES.tiene_contrasena && !reciente) return res.status(403).json({ ok: false, error: 'Para cambiarla escribe tu contraseña actual.', usar: 'cambiar' });
            const rC = await ACC.ponerContrasena(SES.tenant_id, req.body.contrasena);
            if (!rC.ok) return res.status(400).json(rC);
            await ACC.accesosLog({ sesion_id: SES.sid, tenant_id: SES.tenant_id, action: SES.tiene_contrasena ? 'contrasena_repuesta' : 'contrasena_creada', ip: IP });
            return res.status(200).json({ ok: true });
        }
        if (action === 'acceso_contrasena_cambiar' && req.method === 'POST') {
            if (!SES) return res.status(401).json({ ok: false, error: 'Sin sesión' });
            if ((await ACC.contarLimite('contra:tel:' + SES.tenant.telefono, 5, 10 * 60 * 1000)).excedido) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera 10 minutos.' });
            if (!(await ACC.verificarContrasena(SES.tenant_id, req.body.actual))) return res.status(401).json({ ok: false, error: 'La contraseña actual no es correcta.' });
            const rC = await ACC.ponerContrasena(SES.tenant_id, req.body.nueva);
            if (!rC.ok) return res.status(400).json(rC);
            await ACC.accesosLog({ sesion_id: SES.sid, tenant_id: SES.tenant_id, action: 'contrasena_cambiada', ip: IP });
            return res.status(200).json({ ok: true });
        }
        if (action === 'acceso_pedir' && req.method === 'POST') {
            // RESPUESTA UNIFORME (invariante 7): exista o no el número, la respuesta es la misma. 429 solo por tope de IP.
            const telIn = String(req.body.telefono || '').replace(/\D/g, '');
            if (telIn.length < 10) return res.status(400).json({ ok: false, error: 'Escribe tu WhatsApp de 10 dígitos.' });
            const r = await ACC.pedirCodigo(telIn, IP);
            if (r.limite === 'ip') return res.status(429).json({ ok: false, error: r.error });
            if (!r.silencioso && r.codigo && !DEMO.esDemo(r.tenant)) {   // MODO PRUEBA: al tenant demo no se le manda nada (entra con el código fijo)
                const env = await citasVivas.enviarWA(r.tenant.telefono, ACC.textoCodigo(r.codigo, r.vida_min), 0);   // sale del número de Fyradrive
                if (!env.ok) console.error('[acceso_pedir] envío falló:', env.error);
            }
            return res.status(200).json({ ok: true, vida_min: r.vida_min || 3, tel_mascara: '••• ••• ' + telIn.slice(-4) });
        }
        if (action === 'acceso_entrar' && req.method === 'POST') {
            const tel = ACC.tel521(req.body.telefono);
            if (!tel) return res.status(400).json({ ok: false, error: 'Escribe tu WhatsApp de 10 dígitos.' });
            const r = await ACC.entrarConCodigo(tel, String(req.body.codigo || ''), req.headers['user-agent'], IP);
            if (!r.ok) return res.status(401).json({ ok: false, error: r.error });
            if (r.tenant && r.tenant.id !== 0 && !r.maestra && await ACC.estaDesvinculado(r.tenant.id)) { await ACC.cerrarSesion(r.token); return res.status(409).json({ ok: false, error: 'Tu WhatsApp ya no está vinculado. Vuelve a vincularlo en fyradrive.com/seb y tu FyraChat se abre solo.', desvinculado: true }); }
            ACC.ponerCookie(res, r.token);
            await ACC.accesosLog({ sesion_id: r.sid, tenant_id: r.tenant.id, action: 'acceso_entrar', ip: IP });
            await ACC.avisarSesionNueva(r.tenant, req.headers['user-agent'], IP, r.sid);
            return res.status(200).json({ ok: true, tenant: r.tenant, maestra: r.maestra, contrasena_pendiente: !!r.contrasena_pendiente, tiene_contrasena: !!r.tiene_contrasena });
        }
        if (action === 'acceso_salir' && req.method === 'POST') { await ACC.cerrarSesion(tokenSes); ACC.borrarCookie(res); return res.status(200).json({ ok: true }); }
        if (action === 'acceso_ticket' && req.method === 'POST') {
            // lo llama fyradrive.com/seb al confirmar la vinculación (SOLO K_PANEL, invariante 5): ticket de un solo uso → sesión en ESE navegador
            if (!conPanel) return res.status(401).json({ ok: false, error: 'key inválida' });
            if (!req.body.enviar) return res.status(400).json({ ok: false, error: 'enviar:1 requerido' });
            const r = await ACC.crearTicket(req.body.telefono);
            if (!r.ok) return res.status(404).json({ ok: false, error: r.error });
            const urlT = ORIGEN_PROPIO + '/api/seb-panel?action=acceso_canjear&t=' + encodeURIComponent(r.token);
            // ¿primera vez? = nunca ha tenido sesión en su FyraChat (la web decide si enseña la guía de "agregar a inicio")
            const prev = await query("SELECT COUNT(*) n FROM sesiones_vendedor WHERE tenant_id = ?", [r.tenant.id]).catch(() => [{ n: 0 }]);
            const primera = Number(prev[0] && prev[0].n) === 0;
            // El ticket viaja SOLO al WhatsApp vinculado (quien tiene el teléfono), NUNCA se devuelve la URL:
            // un tercero puede dar de alta un número ajeno desde la web y no debe recibir la sesión de la víctima. 2026-09-10
            const nom = String((r.tenant && r.tenant.nombre) || '').trim().split(/\s+/)[0];
            const txt = 'Listo' + (nom ? ' ' + nom : '') + ', tu FyraChat ya está activo. Ábrelo aquí (link de un solo uso, vence en 15 min):\n' + urlT + '\n\nDespués entras en fyrachat.vercel.app con el código que te llega a este WhatsApp.';
            const env = await citasVivas.enviarWA(r.tenant.telefono, txt, 0);
            return res.status(200).json({ ok: true, enviado: !!env.ok, expira: r.expira, primera });
        }
        if (action === 'acceso_canjear') {
            const r = await ACC.canjearTicket(String(req.query.t || ''), req.headers['user-agent'], IP);
            if (!r.ok) { res.setHeader('Location', '/fyrachat.html?vendedor=entrar&aviso=' + encodeURIComponent(r.error)); return res.status(302).end(); }
            ACC.ponerCookie(res, r.token);
            await ACC.accesosLog({ sesion_id: r.sid, tenant_id: r.tenant.id, action: 'acceso_canjear', ip: IP });
            if (r.origen !== 'sb') await ACC.avisarSesionNueva(r.tenant, req.headers['user-agent'], IP, r.sid);   // el pase del Sales Brain no avisa (es el owner)
            res.setHeader('Location', r.destino && r.maestra ? '/fyrachat.html?vendedor=' + encodeURIComponent(r.destino) : '/fyrachat.html?bienvenida=1'); return res.status(302).end();
        }
        if (action === 'acceso_ticket_maestra' && req.method === 'POST') {
            // Solo el Sales Brain (K_PANEL, tras su PIN): pase de un solo uso con la sesión MAESTRA que abre el FyraChat del universo pedido
            if (!conPanel) return res.status(401).json({ ok: false, error: 'key inválida' });
            const r = await ACC.crearTicketMaestra(Number(req.body.tenant_id));
            if (!r.ok) return res.status(404).json({ ok: false, error: r.error });
            return res.status(200).json({ ok: true, url: 'https://fyrachat.vercel.app/api/seb-panel?action=acceso_canjear&t=' + encodeURIComponent(r.token), expira: r.expira, destino: r.destino });
        }
        // ══ TUS DISPOSITIVOS (bloque 5): sesiones vivas del universo de la cookie + cerrar todas
        if (action === 'acceso_sesiones') {
            if (!SES) return res.status(401).json(SIN_SESION);
            return res.status(200).json({ ok: true, sesiones: await ACC.listarSesiones(SES.tenant_id, SES.sid) });
        }
        if (action === 'acceso_cerrar_todas' && req.method === 'POST') {
            if (!SES) return res.status(401).json(SIN_SESION);
            await ACC.cerrarTodas(SES.tenant_id); ACC.borrarCookie(res);
            return res.status(200).json({ ok: true });
        }
        // K_PANEL (re-alta / desvinculación desde SB o la web): cierra todas las sesiones de un universo
        if (action === 'acceso_cerrar_todas_tenant' && req.method === 'POST') {
            const tidC = Number(req.body.tenant_id);
            if (!Number.isFinite(tidC)) return res.status(400).json({ ok: false, error: 'tenant_id requerido' });
            await ACC.cerrarTodas(tidC);
            return res.status(200).json({ ok: true, tenant_id: tidC });
        }
        // CUOTA TURSO: el estado de conversación (etapa3.estadoConv) se cachea SOLO dentro de un
        // request — cada request nuevo arranca sin rastro (un mensaje nuevo cambia el estado).
        olvidar('estadoConv:');

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
            // Fase 2: ?vendedor=<tenant> → SOLO sus chats delegados (hilos con sufijo #t<id>); sin vendedor = tenant 0 (todo lo de siempre)
            let tenantIdChats = 0;
            if (VEND_PARAM) {
                const tR = await query("SELECT id FROM tenants WHERE (id = ? OR telefono = ?) AND activo=1", [/^\d{1,4}$/.test(String(VEND_PARAM)) ? Number(VEND_PARAM) : -1, (() => { const d = String(VEND_PARAM).replace(/\D/g, ''); return d.length === 10 ? '521' + d : d; })()]);
                if (!tR.length) return res.status(404).json({ ok: false, error: 'vendedor no dado de alta' });
                tenantIdChats = Number(tR[0].id);
            }
            const rows = await query(
                "SELECT channel_thread_id, telefono, nombre, ult_texto, ult_dir, ult_msg_ts, is_dueno_chat " +
                "FROM conversaciones WHERE source='whatsapp' AND ult_msg_ts IS NOT NULL AND COALESCE(tenant_id,0) = ? " +
                "ORDER BY ult_msg_ts DESC LIMIT 120", [tenantIdChats]);
            // CUOTA TURSO: pendientes SOLO de los teléfonos de esta lista (índice seb_queue(telefono, estado))
            // — antes agrupaba la tabla seb_queue completa en cada poll de 90 s.
            const telDeRow = row => row.telefono || ((row.channel_thread_id || '').split(':')[1] || '').split('#')[0] || '';
            const telsLista = [...new Set(rows.map(telDeRow).filter(Boolean))];
            const pend = telsLista.length
                ? await query("SELECT telefono, COUNT(*) n FROM seb_queue WHERE estado='pendiente' AND telefono IN (" + telsLista.map(() => '?').join(',') + ") GROUP BY telefono", telsLista)
                : [];
            const pendMap = {}; pend.forEach(p => pendMap[p.telefono] = p.n);
            const porTel = new Map();
            for (const row of rows) {
                if (row.is_dueno_chat === 1) continue;                 // chat de dueño → ocultar
                const tel = telDeRow(row);
                if (!tel) continue;
                const tel10 = String(tel).replace(/\D/g, '').slice(-10);
                if (!tenantIdChats && duenos.has(tel10)) continue;     // dueño por teléfono → ocultar (solo en el FyraChat del owner)
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
            let resetTs = Number(resets[tel] || 0);   // MODO PRUEBA: todo lo ANTERIOR a esto se ignora (lead nuevo)
            const tChat = VEND_PARAM ? await tenantDeParam(VEND_PARAM) : { id: 0 };
            if (!tChat) return res.status(404).json({ ok: false, error: 'vendedor no dado de alta' });
            if (tChat.demo) resetTs = 0;   // MODO PRUEBA: los reinicios del sandbox (por teléfono) no aplican al universo demo
            const conv = await query("SELECT id FROM conversaciones WHERE channel_thread_id = ? LIMIT 1", [hiloDe(tel, tChat.id)]);
            let mensajes = [];
            if (conv.length) {
                // INCREMENTAL (cuota Turso 2026-09-08): ?desde=<epoch s> → solo lo nuevo (>= para no perder la misma
                // segunda; el front deduplica por msg_id). Sin desde = conversación completa (primera carga).
                const desdeQ = Number(req.query.desde) || 0;
                const rows = await query(
                    "SELECT direccion, texto, ts, msg_id, tipo, ai_generated, emisor FROM mensajes WHERE conversacion_id = ? AND ts >= ? ORDER BY ts ASC, id ASC",
                    [conv[0].id, desdeQ * 1000]);
                // ai: 0 = lo escribió el owner (teléfono o FyraChat), 1 = lo escribió el bot — FyraChat lo etiqueta
                // emisor (2026-09-10): 'sistema' = nota interna ("🤝 Chat delegado…") que JAMÁS salió a WhatsApp → FyraChat la pinta como nota gris, no como burbuja enviada
                mensajes = rows.map(m => ({ mensaje: m.texto || '', direccion: m.direccion, timestamp: Math.floor(Number(m.ts) / 1000), msg_id: m.msg_id, tipo: m.tipo || 'text', ai: Number(m.ai_generated) || 0, emisor: m.emisor || null }));
                // MODO PRUEBA: solo mensajes posteriores al reinicio
                if (resetTs) mensajes = mensajes.filter(m => (m.timestamp * 1000) >= resetTs);
            }
            const draft = await query(
                "SELECT id, borrador, intencion, creado_en FROM seb_queue WHERE telefono=? AND estado='pendiente' ORDER BY id DESC LIMIT 1",
                [tel]);
            let borrador = tChat.demo ? null : (draft[0] || null);   // demo: sin sugerencias de Seb (son del tenant 0)
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
            const est = await U.leerEstado(tChat.id, tel);   // el estado del UNIVERSO de este chat (no cruza universos)
            const estadoFresco = est.existe && est.updated_at >= resetTs;
            let focoChat = null; try { focoChat = await focoDe(tChat, tel); } catch (e) { }
            return res.status(200).json({
                ok: true,
                mensajes,
                foco: focoChat,
                borrador,
                estado: estadoFresco ? { ...est.ej, auto_id_activo: est.auto_id_activo } : {}
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
            // ══ LA MÁQUINA DE RESCATE EN VIVO (owner 2026-07-23): este es el canal por
            // el que el puente ya manda toques cada ~15 min. El anti-ghost VIEJO de 3h
            // queda APAGADO (GHOST_VIEJO=1 lo revive) — jamás doble-push.
            const resc = require('../lib/seb/rescate.js');
            const enviar = [];
            // PUERTA DE MENSAJES (FyraChat v2, 2026-09-10): los rescates y los programados YA NO regresan como lista para
            // que el puente los mande — salen desde aquí por mensajeria.enviar (idempotente por clave, primero la puerta y
            // luego el estado; si el puente falla quedan pendientes con intentos+1 y el cron/este scan reintentan hasta 3).
            // `enviar` queda vacío salvo el ghosting viejo (GHOST_VIEJO=1).
            let rescates = null, programados = null;
            try { rescates = await resc.despachar({ ahora: Date.now() }); } catch (e) { rescates = { error: e.message }; }
            try { programados = await require('../lib/seb/programados.js').despachar({ ahora: Date.now() }); } catch (e) { programados = { error: e.message }; }
            const avisos = await resc.preAvisos({ ahora: Date.now() });
            let reporte = avisos.length ? avisos.join('\n\n') : null;
            if (process.env.GHOST_VIEJO === '1') {
                const { ghostScan } = require('../lib/seb/ghosting.js');
                const duenos = await telefonosDueno();
                const rV = await ghostScan({ duenos, dry: !!(req.body && req.body.dry) });
                for (const g of (rV.enviar || [])) enviar.push(g);
                if (rV.reporte) reporte = (reporte ? reporte + '\n\n' : '') + rV.reporte;
            }
            return res.status(200).json({ ok: true, enviar, reporte, rescates, programados });
        }
        // ══ TIMBRES DEL PUENTE → LA MÁQUINA DE RESCATE (fuente única) ══
        if (action === 'rescate_turno' && req.method === 'POST') {
            const telR = String(req.body.telefono || '').replace(/\D/g, '');
            if (!telR) return res.status(400).json({ ok: false, error: 'telefono' });
            // CANDADO DE CAMPAÑA 📢: una respuesta a la campaña NO crea folios de rescate
            try { if (await require('../lib/seb/campana.js').esMudo(telR)) return res.status(200).json({ ok: true, rescate: { skip: 'campana_muda' } }); } catch (e) { }
            try {
                // la ráfaga entrante = lo que él dijo desde nuestra última salida
                const cvT = await query("SELECT id FROM conversaciones WHERE channel_thread_id=?", ['whatsapp:' + telR]);
                let textoIn = '';
                if (cvT.length) {
                    const ms = await query("SELECT direccion, texto FROM mensajes WHERE conversacion_id=? ORDER BY ts DESC LIMIT 12", [cvT[0].id]);
                    const rafaga = [];
                    for (const m of ms) { if (m.direccion === 'out') break; rafaga.unshift(m.texto); }
                    textoIn = rafaga.join('\n');
                }
                const resc2 = require('../lib/seb/rescate.js');
                const rT2 = await resc2.registrarTurno({ tel: telR, textoIn, ruta: 'real', segmentos: req.body.segmentos || [], pin: !!req.body.pin, ahora: Date.now() });
                return res.status(200).json({ ok: true, rescate: rT2 });
            } catch (e) { return res.status(200).json({ ok: false, error: e.message }); }
        }
        if (action === 'rescate_manual' && req.method === 'POST') {
            const telM = String(req.body.telefono || '').replace(/\D/g, '');
            if (!telM) return res.status(400).json({ ok: false, error: 'telefono' });
            // CANDADO DE CAMPAÑA 📢: tu mensaje manual desde el teléfono = RETOMASTE
            // el chat → el candado se libera y todo vuelve a la normalidad.
            try { await require('../lib/seb/campana.js').liberar(telM); } catch (e) { }
            const resc3 = require('../lib/seb/rescate.js');
            const rM = await resc3.registrarSalidaManual({ tel: telM, texto: String(req.body.texto || ''), esPin: !!req.body.es_pin, ahora: Date.now() });
            return res.status(200).json({ ok: true, rescate: rM });
        }

        // ============ CIERRE TIMBRE (lógica del timbre, orden owner 2026-07-16) ============
        // El puente VPS toca aquí EN EL INSTANTE en que el owner manda "cita confirmada ✅"
        // a un comprador. Misma puerta que el barredor del cron (ejecutarCierre es
        // idempotente): el timbre da la velocidad, el cron la garantía.
        if (action === 'cierre_timbre' && req.method === 'POST') {
            const telT = String(req.body.telefono || '');
            const textoT = String(req.body.texto || '');
            if (!telT || !textoT) return res.status(400).json({ ok: false, error: 'telefono y texto requeridos' });
            // CITAS POR UNIVERSO (2026-09-10): el cierre del owner es del universo 0; si el puente etiqueta otro universo, no aplica
            const rT = await citasVivas.ejecutarCierre({ tel: telT, texto: textoT, ts: Number(req.body.ts) || Date.now(), origen: 'timbre', tenant_id: Number(req.body.tenant_id) || 0 });
            return res.status(200).json(rT);
        }

        // ============ MATCH DIRECTO DESDE EL CALENDAR (orden owner 2026-08-24) ============
        // Agendar en el Calendar = la confirmación del dueño ya viene acreditada por
        // el owner → LA MISMA máquina del match arranca los recordatorios de una vez
        // (víspera, día D, 1h antes). Distinto timbre, mismo funcionamiento.
        if (action === 'match_directo' && req.method === 'POST') {
            const rMD = await citasVivas.matchDirectoCalendar({
                comprador_tel: req.body.comprador_tel, comprador_nombre: req.body.comprador_nombre || null,
                dueno_tel: req.body.dueno_tel || '', dueno: req.body.dueno || null,
                auto_id: req.body.auto_id || null, auto_nombre: req.body.auto_nombre || null,
                fecha: req.body.fecha || '', hora: req.body.hora || '', cita_ts: Number(req.body.cita_ts) || null,
                avisar: !!req.body.avisar, tenant_id: Number(req.body.tenant_id) || 0,
                cita_id: Number(req.body.cita_id) || null,
                // mover/re-confirmar: las máquinas vivas de ese chat se reemplazan y sus casillas se cancelan aquí (no en SB por LIKE)
                reemplazar: !!(req.body.reemplazar === true || req.body.reemplazar === 1 || req.body.reemplazar === '1')
            });
            return res.status(200).json(rMD);
        }

        // ══════════ CASILLAS · ENTRADA POR UNIVERSO · ACCIONES · BACKFILL (orden owner 2026-09-08) ══════════
        // LA MISMA PUERTA para el temporizador del puente y para el barredor del cron: ejecuta UNA casilla.
        if (action === 'casilla_ejecutar' && req.method === 'POST') {
            const idC = Number(req.body.id || req.body.casilla_id) || 0;
            if (!idC) return res.status(400).json({ ok: false, error: 'id requerido' });
            try { return res.status(200).json(await citasVivas.casillaEjecutar(idC)); }
            catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
        }
        // El puente (universos ≠0, tras persistir un ENTRANTE de un chat delegado) → la MISMA máquina que el tenant 0.
        // Se llama por chat; adentro solo se lee si hay cita viva (1-3 filas por índice) y nada más.
        if (action === 'cita_entrante' && req.method === 'POST') {
            const tE = Number(req.body.tenant_id) || 0;
            let telE = String(req.body.telefono || req.body.tel || '').replace(/\D/g, ''); if (telE.length === 10) telE = '521' + telE;
            const textoE = String(req.body.texto || '');
            if (!telE || !textoE) return res.status(400).json({ ok: false, error: 'tel y texto requeridos' });
            try {
                let chatIdE = Number(req.body.chat_id) || null;
                if (!chatIdE) { const cE = await U.chatDe(tE, telE); chatIdE = cE ? Number(cE.id) : null; }
                if (!chatIdE) return res.status(200).json({ ok: true, handled: false, motivo: 'sin chat en ese universo' });
                let pausaMin = null;
                if (tE) { try { const tI = await tenantDeParam(String(tE)); pausaMin = tI && tI.config && Number(tI.config.pausa_min) || null; } catch (e) { } }
                const r = await citasVivas.procesarEntrante({ tenantId: tE, chatId: chatIdE, tel: telE, texto: textoE, vendedor_ultimo_ts: Number(req.body.vendedor_ultimo_ts) || 0, enviar: !!tE, pausaMin });
                return res.status(200).json(Object.assign({ ok: true }, r));
            } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
        }
        // Estado de las casillas de una máquina (SB pausar/reanudar/cancelar entra por aquí — misma puerta)
        if (action === 'casillas_estado' && req.method === 'POST') {
            const mid = Number(req.body.cita_match_id) || 0, acc = String(req.body.accion || '');
            if (!mid || !['pausar', 'reanudar', 'cancelar'].includes(acc)) return res.status(400).json({ ok: false, error: 'cita_match_id y accion (pausar|reanudar|cancelar) requeridos' });
            try {
                const n = acc === 'reanudar' ? await citasVivas.reanudarCasillas({ cita_match_id: mid }) : await citasVivas.cancelarCasillas({ cita_match_id: mid }, acc === 'pausar' ? 'pausada' : 'cancelada');
                return res.status(200).json({ ok: true, cita_match_id: mid, accion: acc, casillas: n });
            } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
        }
        // Acciones del chat (para que FyraChat las pinte como parte del chat) — por índice (chat_id, ts)
        if (action === 'acciones') {
            const tA = VEND_PARAM ? await tenantDeParam(VEND_PARAM) : { id: 0 };
            if (!tA) return res.status(404).json({ ok: false, error: 'vendedor no dado de alta' });
            let telA = String(req.query.telefono || '').replace(/\D/g, ''); if (telA.length === 10) telA = '521' + telA;
            if (!telA) return res.status(400).json({ ok: false, error: 'telefono requerido' });
            try {
                const cA = await U.chatDe(tA.id, telA);
                if (!cA) return res.status(200).json({ ok: true, acciones: [] });
                const desdeA = Number(req.query.desde) || 0;   // epoch en segundos (como FyraChat) o en ms
                const filas = await require('../lib/seb/acciones.js').listar({ chat_id: cA.id, desde: desdeA > 1e12 ? desdeA : desdeA * 1000, limite: Number(req.query.limite) || 200 });
                return res.status(200).json({ ok: true, chat_id: cA.id, acciones: filas.map(a => ({ id: a.id, tipo: a.tipo, ref_id: a.ref_id, meta: (() => { try { return JSON.parse(a.meta_json || 'null'); } catch (e) { return null; } })(), ts: Number(a.ts), actor: a.actor, delegacion_id: a.delegacion_id })) });
            } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
        }
        // Backfill de dirección del sistema de citas (idempotente; reporta lo no ligado)
        if (action === 'citas_backfill' && req.method === 'POST') {
            try { return res.status(200).json({ ok: true, backfill: await citasVivas.backfillDireccionCitas({ dry: req.body.dry !== false && req.body.dry !== 0 && req.body.dry !== 'false', telefonos: Array.isArray(req.body.telefonos) ? req.body.telefonos : null }) }); }
            catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
        }
        // El puente, al reiniciar, re-arma sus temporizadores: casillas pendientes de las próximas N horas (1 consulta por índice)
        if (action === 'casillas_pendientes') {
            try {
                await citasVivas.ensureDireccionCitas();
                const horas = Math.min(Number(req.query.horas) || 24, 72);
                const filas = await query("SELECT id, due_ts, tel, tenant_id FROM cita_casillas WHERE estado='pendiente' AND due_ts <= ? ORDER BY due_ts ASC LIMIT 500", [Date.now() + horas * 3600000]);
                return res.status(200).json({ ok: true, casillas: filas.filter(c => !/^52100000000/.test(String(c.tel || ''))).map(c => ({ casilla_id: Number(c.id), due_ts: Number(c.due_ts), tenant_id: Number(c.tenant_id) || 0 })) });
            } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
        }

        // ============ CANCELAR MATCH MANUAL (orden owner 2026-07-18) ============
        // El botón ✕ del Calendar entra por LA MISMA máquina que la cancelación por
        // WhatsApp del comprador (ejecutarCancelacion): marca la fila y le avisa al
        // DUEÑO con el mismo texto. Distinto timbre, mismo funcionamiento.
        if (action === 'cancelar_match_manual' && req.method === 'POST') {
            let telCM = String(req.body.telefono || '').replace(/\D/g, ''); if (telCM.length === 10) telCM = '521' + telCM;
            if (!telCM && !req.body.chat_id) return res.status(400).json({ ok: false, error: 'telefono requerido' });
            // DIRECCIÓN (2026-09-08): SB manda tenant_id+chat_id de la cita; si no, se resuelve el chat por (tenant, tel) → 1 fila por índice
            const tCM = Number(req.body.tenant_id) || 0;
            let chatCM = Number(req.body.chat_id) || null;
            if (!chatCM) { const dCM = await citasVivas.direccionDe(tCM, telCM); chatCM = dCM.chat_id; }
            const MCM = await citasVivas.filaViva(tCM, chatCM, ['solicitud', 'contrapropuesta', 'esperando_horario', 'match', 'pausada', 'pausada_staff', 'escalada_manual']);
            if (!MCM) return res.status(200).json({ ok: true, avisado: false, motivo: 'sin fila activa de match' });
            // avisar:0 (SB, 2026-09-12): mover/cancelar en un universo de vendedor desde su propia pantalla → sin aviso automático a él mismo
            const avisarCM = !(req.body.avisar === 0 || req.body.avisar === '0' || req.body.avisar === false);
            await citasVivas.ejecutarCancelacion(MCM, { por: 'owner', actor: String(req.body.actor || 'owner').slice(0, 20), texto: req.body.razon || null, avisar: avisarCM });
            return res.status(200).json({ ok: true, avisado: avisarCM, match_id: MCM.id });
        }

        // ============ OPENER AUTO (autopilot del PRIMER mensaje) ============
        // El bridge llama aquí cuando llega un primer contacto. Decide si aplica
        // (comprador, primer contacto, auto resuelto, no vendedor) y devuelve la
        // RÁFAGA del playbook. NO crea sugerencia pendiente: es para enviar solo.
        // ══════════ FASE 2 — FYRACHAT POR VENDEDOR (tenant) ══════════
        // ?vendedor=<tenant id o teléfono>. El tenant 0 (owner) = FyraChat de siempre.
        const BRIDGE_BASE = (process.env.BRIDGE_SEND_URL || 'http://137.184.199.19:3000/api/send').replace(/\/api\/send$/, '');
        const BRIDGE_KEY_T = process.env.K_PUENTE || process.env.BRIDGE_API_KEY || '';   // llave SALIENTE al puente (transición: BRIDGE_API_KEY)
        async function tenantDeParam(v) {
            const raw = String(v == null ? '' : v).trim();
            if (!raw) return { id: 0, telefono: '5215659423834', nombre: 'Sebastián Romero' };
            const digits = raw.replace(/\D/g, '');
            let rows;
            if (/^\d{1,4}$/.test(raw)) rows = await query("SELECT id, telefono, nombre, config_json FROM tenants WHERE id=? AND activo=1", [Number(raw)]);
            else { const t = digits.length === 10 ? '521' + digits : digits; rows = await query("SELECT id, telefono, nombre, config_json FROM tenants WHERE telefono=? AND activo=1", [t]); }
            if (!rows.length) return null;
            const cfgT = (() => { try { return JSON.parse(rows[0].config_json || '{}'); } catch (e) { return {}; } })();
            return { id: Number(rows[0].id), telefono: String(rows[0].telefono || ''), nombre: String(rows[0].nombre || ''), config: cfgT, demo: Number(cfgT.demo) === 1 };   // demo: FyraChat de prueba (nada sale al puente)
        }
        // Autos del tenant: los suyos (dueño por teléfono); el tenant 0 ve todo el inventario activo
        async function autosDeTenant(t) {
            // AUTOS POR UNIVERSO (orden owner 2026-09-08): un auto EXISTE en un universo (autos_universo: comercializa /
            // dueno / acreditado), no se cruza por teléfono. Tenant 0 = Fyradrive comercializa todo el inventario activo.
            try {
                const r = await query(`SELECT i.id, i.fyradrive_web_id, i.marca, i.modelo, i.anio, i.precio, au.rol
                                       FROM autos_universo au JOIN inventario_autos i ON i.id = au.inv_auto_id
                                       WHERE au.tenant_id = ? AND au.activo = 1 AND i.estado = 'activo'
                                       ORDER BY i.marca COLLATE NOCASE, i.modelo COLLATE NOCASE`, [Number(t.id) || 0]);
                if (!r.length && t.demo) {   // MODO PRUEBA: 3 autos activos del inventario (solo lectura) — de preferencia con punto de venta, para que el botón de ubicación tenga qué mandar
                    const conPunto = await query("SELECT id, fyradrive_web_id, marca, modelo, anio, precio FROM inventario_autos WHERE estado='activo' AND id IN (SELECT auto_id FROM punto_envio) ORDER BY id DESC LIMIT 3").catch(() => []);
                    return conPunto.length ? conPunto : query("SELECT id, fyradrive_web_id, marca, modelo, anio, precio FROM inventario_autos WHERE estado='activo' ORDER BY id DESC LIMIT 3");
                }
                if (r.length || t.id) return r;
            } catch (e) { /* tabla aún no existe → camino viejo */ }
            return query("SELECT id, fyradrive_web_id, marca, modelo, anio, precio FROM inventario_autos WHERE estado='activo' ORDER BY marca COLLATE NOCASE, modelo COLLATE NOCASE");
        }
        function hiloDe(tel, tenantId) { return 'whatsapp:' + tel + (tenantId ? '#t' + tenantId : ''); }
        // ── AUTO EN FOCO por contacto (orden owner 2026-09-08): cada contacto tiene UN auto amarrado.
        // ETAPA 2: la DIRECCIÓN es universo → chat → delegación (universo.js). tenant≠0: la delegación activa
        // (espejo en chats_activos.car_id); tenant 0: la columna auto_id_activo del chat (espejo en wa_conversations).
        async function focoDe(t, telFull) {
            const f = await U.focoDe(t.id, telFull);
            if (!f) return null;
            const inv = await query("SELECT id, fyradrive_web_id, marca, modelo, anio, precio FROM inventario_autos WHERE id=? OR fyradrive_web_id=?", [f.auto_id, f.auto_id]);
            if (inv[0]) return { id: inv[0].id, web_id: inv[0].fyradrive_web_id, nombre: [inv[0].marca, inv[0].modelo, inv[0].anio].filter(Boolean).join(' '), precio: inv[0].precio };
            return t.id ? { id: f.auto_id, nombre: f.auto_nombre } : null;
        }
        async function ponerFoco(t, telFull, inv) {
            const nombreA = [inv.marca, inv.modelo, inv.anio].filter(Boolean).join(' ');
            // tenant 0: el chat se crea si falta (el upsert de antes); tenant≠0: solo se cambia el auto de una delegación VIVA
            // (delegar es del puente) — igual que el UPDATE de chats_activos de antes. Historial: cierra la anterior y abre otra.
            const chatF = await U.chatDe(t.id, telFull, { crear: !t.id });
            if (!chatF) return;
            await U.cambiarFoco(chatF, inv.fyradrive_web_id || inv.id, 'fyrachat', { activado_por: 'fyrachat', auto_nombre: nombreA, solo_si_activa: !!t.id });
        }
        // ══ ETAPA 2 — BACKFILL de la base por universo (idempotente, por lotes; NO manda nada a WhatsApp).
        // Lo dispara el owner cuando decida: POST { action:'universo_backfill', dry:true|false, telefonos:[...] } con header x-api-key: K_PANEL.
        // dry=true solo cuenta. telefonos=[…] limita a esos (pruebas). Reporta conteos.
        if (action === 'universo_backfill' && req.method === 'POST') {
            try {
                const rep = await U.backfillUniverso({ dry: req.body.dry !== false && req.body.dry !== 0 && req.body.dry !== 'false', telefonos: Array.isArray(req.body.telefonos) ? req.body.telefonos : null });
                return res.status(200).json({ ok: true, backfill: rep });
            } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
        }
        if (action === 'timbre_url') {
            // URL viva del túnel del timbre (la publica el puente cada minuto); fallback = la última conocida
            let u = null; try { const r = await query("SELECT valor FROM sistema_config WHERE clave='timbre_url'"); u = r.length ? r[0].valor : null; } catch (e) { }
            // base caída → última URL conocida (el timbre NO depende de la base: vive en el puente)
            if (!u) u = process.env.TIMBRE_URL_FALLBACK || 'wss://movers-diabetes-were-greetings.trycloudflare.com';
            return res.status(200).json({ ok: true, url: u });
        }
        if (action === 'foco_cambiar' && req.method === 'POST') {
            const tF = VEND_PARAM ? await tenantDeParam(VEND_PARAM) : { id: 0 };
            if (!tF) return res.status(404).json({ ok: false, error: 'vendedor no dado de alta' });
            let telF = String(req.body.telefono || '').replace(/\D/g, ''); if (telF.length === 10) telF = '521' + telF;
            if (tF.demo) telF = DEMO.telComprador(telF);   // MODO PRUEBA
            const idF = Number(req.body.auto_id) || 0;
            if (!telF || !idF) return res.status(400).json({ ok: false, error: 'telefono y auto_id requeridos' });
            // SOLO los autos habilitados para ese usuario (su catálogo)
            const cat = await autosDeTenant(tF);
            const inv = cat.find(a => Number(a.id) === idF || Number(a.fyradrive_web_id) === idF);
            if (!inv) return res.status(403).json({ ok: false, error: 'ese auto no está habilitado para este usuario' });
            await ponerFoco(tF, telF, inv);
            try { const dF = await citasVivas.direccionDe(tF.id, telF); await require('../lib/seb/acciones.js').registrar({ tenant_id: tF.id, chat_id: dF.chat_id, delegacion_id: dF.delegacion_id, tipo: 'foco_cambiado', ref_id: inv.id, meta: { auto: [inv.marca, inv.modelo, inv.anio].filter(Boolean).join(' ') }, actor: 'vendedor', sesion_id: SES ? SES.sid : null }); } catch (e) { }
            return res.status(200).json({ ok: true, foco: { id: inv.id, web_id: inv.fyradrive_web_id, nombre: [inv.marca, inv.modelo, inv.anio].filter(Boolean).join(' '), precio: inv.precio } });
        }
        if (action === 'tenant_info') {
            const t = await tenantDeParam(VEND_PARAM);
            if (!t) return res.status(404).json({ ok: false, error: 'vendedor no dado de alta' });
            let sesion = null; try { const s2 = await query("SELECT estado, motivo, ultimo_mensaje, updated FROM wa_sessions WHERE tenant_id=?", [t.id]); sesion = s2[0] || null; } catch (e) { }
            if (t.demo) sesion = { estado: 'vinculado', motivo: 'demo', ultimo_mensaje: null, updated: Date.now() };   // MODO PRUEBA: el universo no depende del puente
            const autos = await autosDeTenant(t);
            return res.status(200).json({ ok: true, tenant: { id: t.id, nombre: t.nombre, telefono: t.telefono, demo: !!t.demo, comprador_prueba: t.demo ? DEMO.DEMO_COMPRADOR : undefined }, sesion, autos: autos.map(a => ({ id: a.id, web_id: a.fyradrive_web_id, nombre: [a.marca, a.modelo, a.anio].filter(Boolean).join(' '), precio: a.precio })) });
        }
        // NUEVO COMPRADOR / DELEGAR (única puerta de delegación, orden owner 2026-09-07):
        // nombre del auto + teléfono → chat delegado en el universo del vendedor + opener UNA vez.
        // ══ NÚCLEO DE DELEGAR — UNA puerta para `delegar` (v1) y `delegar_v2` (contrato FyraChat v2). Devuelve { status, out }.
        //   X = { sesionId, clave } — la clave (idempotencia de la UI) deriva las claves del opener (':opener') y de la acción (':accion').
        async function delegarCore(t, body, X) {
            X = X || {}; body = body || {};
            const R = (status, out) => ({ status, out });
            let telD = String(body.telefono || '').replace(/\D/g, ''); if (telD.length === 10) telD = '521' + telD;
            if (t.demo) telD = DEMO.telComprador(telD);   // MODO PRUEBA: el comprador es SIEMPRE del carril de pruebas
            if (!/^521\d{10}$/.test(telD)) return R(400, { ok: false, error: 'teléfono inválido — 10 dígitos' });
            const autos = await autosDeTenant(t);
            const auto = autos.find(a => Number(a.id) === Number(body.auto_id) || Number(a.fyradrive_web_id) === Number(body.auto_id));
            if (!auto) return R(400, { ok: false, error: 'ese auto no es del vendedor', necesita: 'auto' });
            const autoNombre = [auto.marca, auto.modelo, auto.anio].filter(Boolean).join(' ');
            const nomC = String(body.nombre || '').trim();
            const primerNombre = (t.nombre || 'el vendedor').split(/\s+/)[0];
            // MACHOTE de la presentación (modo 'bot'): PURA presentación a nombre del vendedor, sin pregunta ni venta
            // (el owner lo ajusta en config_json.opener_texto si quiere)
            const plantilla = (t.config && t.config.opener_texto) || 'Hola{nombre}, soy el asistente de {vendedor} para el {auto}.';
            // ══ FORMA DE ENTRADA (orden owner 2026-09-10): al delegar, el vendedor ELIGE cómo entra el bot ══
            //   'silencio'  → entra sin decir nada (solo se registra el chat)                       — SIN modo explícito = silencio
            //   'texto'     → el texto que él escribió/editó (literal), firmado como SUYO (emisor 'dueno', ai 0)
            //   'bot'       → SOLO la presentación a nombre del vendedor (machote), explícita, nunca por defecto
            //   'info' | 'fotos' | 'ubicacion' | 'cotizar' | 'cita' → delega EN SILENCIO y ejecuta SOLO esa acción con el mismo
            //                machote seco de los botones del chat (ejecutarAccion = una sola puerta): sin saludo, sin "soy el asistente".
            // Al comprador NO le llega NADA más que lo elegido: nada de "chat delegado", nada de "el bot…". Jamás se manda un
            // machote que el vendedor no eligió (una UI vieja/cacheada no puede disparar nada).
            const MODOS_MSJ = ['silencio', 'texto', 'bot'], MODOS_ACC = ['info', 'fotos', 'ubicacion', 'cotizar', 'cita', 'primer_mensaje'];
            const modoRaw = String(body.modo_entrada || '');
            const modoE = MODOS_MSJ.concat(MODOS_ACC).includes(modoRaw) ? modoRaw : 'silencio';
            const esAccion = MODOS_ACC.includes(modoE);
            const openerBase = modoE === 'texto' ? String(body.opener_texto || '') : (modoE === 'bot' ? plantilla : '');
            const opener = openerBase.replace('{nombre}', nomC ? ' ' + nomC.split(/\s+/)[0] : '').replace('{vendedor}', primerNombre).replace('{auto}', autoNombre).trim();
            if (body.solo_preview) return R(200, { ok: true, opener, modo: modoE, modos: MODOS_MSJ.concat(MODOS_ACC) });   // la UI pide el machote para dejarlo editar
            if (modoE === 'texto' && !opener) return R(400, { ok: false, error: 'el texto quedó vacío — elige "sin decir nada" si no quieres mensaje' });
            // datos que la acción exige ANTES de delegar (no se delega para luego fallar): cotizar → enganche; cita → fecha y hora
            const engD = body.enganche != null && String(body.enganche).trim() !== '' ? Number(String(body.enganche).replace(/[^0-9.]/g, '')) : null;
            if (modoE === 'cotizar' && !(engD > 0)) return R(400, { ok: false, necesita: 'enganche', error: 'para cotizar hace falta el enganche' });
            if (modoE === 'cita' && !(/^\d{4}-\d{2}-\d{2}$/.test(String(body.fecha_iso || '')) && /^\d{1,2}:\d{2}$/.test(String(body.hora || '')))) return R(400, { ok: false, necesita: 'fecha_hora', error: 'para agendar hace falta día y hora' });
            const cuerpoAcc = { auto_id: auto.id, enganche: engD || undefined, plazo_meses: body.plazo_meses || undefined, fecha_iso: body.fecha_iso || undefined, hora: body.hora || undefined, comprador_nombre: nomC, via: 'entrada', clave: X.clave ? X.clave + ':accion' : undefined };
            const registrarDeleg = async (extra) => { try { const dD = await citasVivas.direccionDe(t.id, telD); await ACCIONES.registrar({ tenant_id: t.id, chat_id: dD.chat_id, delegacion_id: dD.delegacion_id, tipo: 'delegacion', ref_id: auto.id, meta: Object.assign({ auto: autoNombre, modo: modoE }, extra || {}), actor: 'vendedor', sesion_id: X.sesionId == null ? null : X.sesionId }); } catch (e) { } };
            const conChat = async (o) => { try { const dF = await citasVivas.direccionDe(t.id, telD); o.chat_id = dF.chat_id || o.chat_id || null; } catch (e) { } o.nombre = nomC || o.nombre || null; return o; };
            // tenant 0: chat delegado = chat del owner de siempre (nuevo_chat) — sin universo aparte
            let chatD0 = null;
            if (!t.id) {
                // ETAPA 2: el chat nace en su universo (0) y la delegación (chat → auto) queda con historial; espejo a wa_conversations
                chatD0 = await U.chatDe(0, telD, { crear: true, visible: true, nombre: nomC || null });
                try { await require('../lib/seb/canal-messenger.js').marcarOwner(telD); } catch (e) { }
                try { if (chatD0) await U.delegar(chatD0, { auto_id: auto.fyradrive_web_id || auto.id, auto_nombre: autoNombre, activado_por: 'fyrachat' }); } catch (e) { }
            }
            let r = null;
            if (t.demo) {
                // MODO PRUEBA: NO se llama al puente. Se crea en local lo que el puente crearía (chat #t<id>, delegación + chats_activos,
                // renglón 'sistema'); el opener (solo texto/bot) queda en el hilo con prefijo [prueba]; la acción de entrada se pinta igual que los botones.
                r = await DEMO.delegar({ tenant: t, tel: telD, auto_id: auto.fyradrive_web_id || auto.id, auto_nombre: autoNombre, nombre: nomC || null, opener, opener_emisor: modoE === 'texto' ? 'dueno' : 'asistente' });
                let acc = null;
                if (r && r.ok && esAccion) { const rA = await ejecutarAccion(t, telD, modoE, cuerpoAcc); acc = rA.out || {}; }
                await registrarDeleg({ opener_enviado: !!(r && r.opener_enviado), accion_ejecutada: esAccion ? modoE : null, accion_ok: acc ? !!acc.ok : null, simulado: true });
                return R(r.ok ? 200 : 400, await conChat(Object.assign({ ok: true, telefono: telD, auto: autoNombre, modo: modoE, opener, simulado: true }, r || {},
                    esAccion ? { accion_ejecutada: modoE, enviado: acc && acc.ok ? (acc.enviado || 'ejecutado') : null, texto_enviado: acc && acc.ok ? (acc.texto_enviado || null) : null, accion_ok: !!(acc && acc.ok), error: acc && !acc.ok ? (acc.error || 'la acción no se pudo ejecutar') : undefined, necesita: acc && acc.necesita || undefined } : {})));
            }
            try {
                // el puente delega (idempotente: si ya estaba delegado responde ok igual) y manda el opener SOLO si viene en ESTA petición
                // (texto/bot); opener_manual = texto del vendedor → lo firma como suyo. Jamás manda nada "pendiente" de antes.
                const fr = await fetch(BRIDGE_BASE + '/tenant/' + t.id + '/delegar', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_KEY_T }, body: JSON.stringify({ tel: telD, car_id: auto.fyradrive_web_id || auto.id, car_nombre: autoNombre, comprador_nombre: nomC || null, opener_texto: (t.id && opener) ? opener : null, opener_manual: modoE === 'texto', activado_por: 'fyrachat' }) });
                r = await fr.json().catch(() => ({ ok: false, error: 'puente ilegible' }));
            } catch (e) { r = { ok: false, error: 'puente: ' + e.message }; }
            // tenant 0: el opener (solo texto/bot) sale por la PUERTA DE MENSAJES (clave derivada → idempotente); en silencio/acción NO se manda nada
            if (!t.id) {
                if (opener && chatD0) {
                    const e0 = await MSJ.enviar({ tenantId: 0, chatId: chatD0.id, origen: 'delegar', clave: X.clave ? X.clave + ':opener' : ('delegar:' + chatD0.id + ':' + Date.now()), texto: opener, manual: modoE === 'texto', sesionId: X.sesionId, accion: 'delegacion_opener', refId: auto.id, meta: { auto: autoNombre, modo: modoE } });
                    r = Object.assign({ ok: true }, r || {}, { opener_enviado: !!e0.ok, error: e0.ok ? undefined : (e0.error || 'no se pudo mandar el opener'), simulado: !!e0.simulado });
                } else r = Object.assign({ ok: true }, r || {}, { opener_enviado: false });
            }
            // ACCIÓN DE ENTRADA: la delegación ya existe (puente) → se ejecuta SOLO esa acción por la misma puerta que los botones.
            // Si el puente dijo que ya estaba delegado, se ejecuta igual (es lo que el vendedor pidió).
            let acc = null;
            if (esAccion && r && r.ok !== false) { const rA = await ejecutarAccion(t, telD, modoE, cuerpoAcc); acc = rA.out || {}; }
            // ACCIÓN POR CHAT: la delegación queda como acción (con la delegación activa que acaba de nacer)
            await registrarDeleg({ opener_enviado: !!(r && r.opener_enviado), accion_ejecutada: esAccion ? modoE : null, accion_ok: acc ? !!acc.ok : null });
            const salida = Object.assign({ ok: true, telefono: telD, auto: autoNombre, modo: modoE, opener }, r || {});
            if (esAccion) Object.assign(salida, { accion_ejecutada: modoE, enviado: acc && acc.ok ? (acc.enviado || 'ejecutado') : null, texto_enviado: acc && acc.ok ? (acc.texto_enviado || null) : null, accion_ok: !!(acc && acc.ok), error: acc ? (acc.ok ? undefined : (acc.error || 'la acción no se pudo ejecutar')) : (salida.error || 'no se pudo delegar'), necesita: acc && acc.necesita || undefined });
            return R(200, await conChat(salida));
        }
        // ══ NÚCLEO DE SOLTAR — una puerta para `soltar` (v1, por teléfono) y `soltar_v2` (por chat_id). Devuelve { status, out }.
        async function soltarCore(t, telRaw, X) {
            X = X || {};
            let telD = String(telRaw || '').replace(/\D/g, ''); if (telD.length === 10) telD = '521' + telD;
            if (t.demo) {   // MODO PRUEBA: sin puente — cierra la delegación local y deja el renglón 'sistema'
                telD = DEMO.telComprador(telD);
                const rS = await DEMO.soltar({ tenant: t, tel: telD });
                try { const dS = await citasVivas.direccionDe(t.id, telD); await ACCIONES.registrar({ tenant_id: t.id, chat_id: dS.chat_id, delegacion_id: dS.delegacion_id, tipo: 'soltado', meta: { simulado: true }, actor: 'vendedor', sesion_id: X.sesionId == null ? null : X.sesionId }); } catch (e) { }
                return { status: 200, out: rS };
            }
            // ETAPA 2 (tenant 0): la delegación se cierra aquí (idempotente); en universos ≠0 la cierra el puente (dual-write) porque es quien la carga en memoria
            if (!t.id) { try { const cS = await U.chatDe(0, telD); if (cS) await U.soltar(cS, 'fyrachat'); } catch (e) { } }
            try { const dS = await citasVivas.direccionDe(t.id, telD); await ACCIONES.registrar({ tenant_id: t.id, chat_id: dS.chat_id, delegacion_id: dS.delegacion_id, tipo: 'soltado', meta: null, actor: 'vendedor', sesion_id: X.sesionId == null ? null : X.sesionId }); } catch (e) { }
            try {
                const fr = await fetch(BRIDGE_BASE + '/tenant/' + t.id + '/soltar', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_KEY_T }, body: JSON.stringify({ tel: telD }) });
                return { status: 200, out: await fr.json().catch(() => ({ ok: false, error: 'puente ilegible' })) };
            } catch (e) { return { status: 500, out: { ok: false, error: e.message } }; }
        }
        if (action === 'delegar' && req.method === 'POST') {
            const t = await tenantDeParam(VEND_PARAM);
            if (!t) return res.status(404).json({ ok: false, error: 'vendedor no dado de alta' });
            const rD = await delegarCore(t, req.body, { sesionId: SES ? SES.sid : null, clave: req.body.clave ? String(req.body.clave) : null });
            return res.status(rD.status).json(rD.out);
        }
        if (action === 'soltar' && req.method === 'POST') {
            const t = await tenantDeParam(VEND_PARAM);
            if (!t) return res.status(404).json({ ok: false, error: 'vendedor no dado de alta' });
            const rS = await soltarCore(t, req.body.telefono, { sesionId: SES ? SES.sid : null });
            return res.status(rS.status).json(rS.out);
        }

        // ══ VENDEDOR ASIGNADO A LA CITA (orden owner 2026-08-25): agregar desde el
        // Calendar, confirmar (él por WhatsApp o el owner aquí) y listar.
        // ══ NUEVO CHAT desde FyraChat (orden owner 2026-09-06): él agrega el contacto y le
        // manda el PRIMER mensaje desde aquí. Nace la conversación (con nombre si lo da) y el
        // chat queda marcado como SUYO (canal 'owner') → el bot no se mete; el primer envío
        // sale por el puente firmado como manual (ai=0).
        if (action === 'nuevo_chat' && req.method === 'POST') {
            let telN = String(req.body.telefono || '').replace(/\D/g, '');
            if (telN.length === 10) telN = '521' + telN;
            if (telN.length === 12 && telN.startsWith('52')) telN = '521' + telN.slice(2);
            if (!/^521\d{10}$/.test(telN)) return res.status(400).json({ ok: false, error: 'teléfono inválido — 10 dígitos' });
            const nombreN = String(req.body.nombre || '').trim() || null;
            try {
                const ex = await query("SELECT id, nombre FROM conversaciones WHERE channel_thread_id=? LIMIT 1", ['whatsapp:' + telN]);
                let creado = false;
                if (!ex.length) {
                    await run("INSERT INTO conversaciones (channel_thread_id, telefono, nombre, ult_texto, ult_dir, ult_msg_ts, no_leidos, is_dueno_chat, source, created_at) VALUES (?,?,?,?,?,?,0,0,'whatsapp',?)",
                        ['whatsapp:' + telN, telN, nombreN, '', 'out', Date.now(), Date.now()]);
                    creado = true;
                } else if (nombreN && !String(ex[0].nombre || '').trim()) {
                    await run("UPDATE conversaciones SET nombre=? WHERE id=?", [nombreN, ex[0].id]);
                }
                try { await require('../lib/seb/canal-messenger.js').marcarOwner(telN); } catch (e) { }
                return res.status(200).json({ ok: true, telefono: telN, nombre: nombreN || (ex[0] && ex[0].nombre) || null, creado });
            } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
        }

        if (action === 'cita_vendedor_agregar' && req.method === 'POST') {
            try {
                const r = await citasVivas.staffInvitar({ cita_id: req.body.cita_id, nombre: req.body.nombre, tel: req.body.tel });
                return res.status(200).json(r);
            } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
        }
        if (action === 'cita_vendedor_confirmar' && req.method === 'POST') {
            try {
                const r = await citasVivas.staffConfirmar(req.body.id);
                return res.status(200).json(r);
            } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
        }
        if (action === 'cita_vendedor_lista') {
            try {
                const filas = await citasVivas.staffLista(req.query.cita_id);
                return res.status(200).json({ ok: true, vendedores: filas });
            } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
        }

        if (action === 'opener_auto' && req.method === 'POST') {
            const tel = String(req.body.telefono || '');
            if (!tel) return res.status(400).json({ ok: false, error: 'telefono requerido' });
            // ══ PRIMERA COMPUERTA — "CERRAR" (bloque 5, 2026-09-10): si el teléfono es dueño de un universo y su último
            // entrante es exactamente CERRAR, se cierran TODAS sus sesiones de FyraChat y se le confirma por WhatsApp.
            // Determinista (regex exacta), jamás despierta al bot.
            try {
                const tCz = await ACC.tenantPorTelefono(tel);
                if (tCz) {
                    const cvZ = await query("SELECT id FROM conversaciones WHERE channel_thread_id = ? LIMIT 1", ['whatsapp:' + tel.replace(/\D/g, '')]);
                    const mZ = cvZ.length ? await query("SELECT texto FROM mensajes WHERE conversacion_id=? AND direccion='in' ORDER BY ts DESC, id DESC LIMIT 1", [cvZ[0].id]) : [];
                    const txtZ = mZ.length ? String(mZ[0].texto || '') : '';
                    if (/^\s*cerrar[.!]?\s*$/i.test(txtZ)) {
                        await ACC.cerrarTodas(tCz.id);
                        await ACC.accesosLog({ sesion_id: null, tenant_id: tCz.id, action: 'cerrar_wa', ip: IP });
                        await citasVivas.enviarWA(String(tCz.telefono), 'Listo: cerré todas las sesiones de tu FyraChat. Para entrar de nuevo pide un código.', 0);
                        return res.status(200).json({ ok: true, acceso_cerrado: true, tenant_id: tCz.id });
                    }
                }
            } catch (e) { console.error('[acceso cerrar_wa]', e.message); }
            // Dueño/vendedor por teléfono → nunca autopilot.
            // MODO COMPRADOR DE PRUEBA (owner 2026-08-05, "solo por esta vez"): si existe
            // el marcador 'comprador:<tel>' en prueba_reset, ese tel actúa de COMPRADOR
            // normal aunque sea dueño/owner. Se apaga borrando el renglón.
            let compradorTest = false;
            try {
                const ct = await query("SELECT 1 FROM prueba_reset WHERE telefono=?", ['comprador:' + tel.replace(/\D/g, '')]);
                compradorTest = ct.length > 0;
            } catch (e) { }
            const duenos = await telefonosDueno();
            if (!compradorTest && duenos.has(tel.replace(/\D/g, '').slice(-10))) {
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
                        // DIRECCIÓN: el chat del dueño ya está resuelto → 1 lectura por índice (dueno_chat_id, estado)
                        const segsD = await citasVivas.manejarMensajeDueno(tel, ultimoD, convD.length ? convD[0].id : null);
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
            // ══ VENDEDOR ASIGNADO (staff, orden owner 2026-08-25): si este tel tiene una
            // silla de vendedor viva, su mensaje entra a ESA máquina (sí→confirma, no→
            // escala, resto→escala) — jamás al flujo de comprador.
            try {
                const segsSt = await citasVivas.manejarMensajeStaff(tel, entrantes[entrantes.length - 1].mensaje, convId);   // por chat (idx_cv_chat)
                if (segsSt !== null) {
                    if (segsSt && segsSt.length) return res.status(200).json({ ok: true, modo: 'staff', tipo: 'cita_staff', segmentos: segsSt });
                    return res.status(200).json({ ok: false, motivo: 'staff — escalado al owner' });
                }
            } catch (e) { console.error('[staff]', e.message); }
            // ══ COMPRADOR CON MATCH VIVO (WhatsApp real): cancelación / "ya voy en camino"
            // se interpretan ANTES del pipeline (idéntico al sandbox).
            try {
                // 🚩 caso Mazda 2026-07-13 ("llano estoi interesado" + "Grsias"): la cancelación
                // llega en RÁFAGA — se evalúa la ráfaga entrante COMPLETA, no solo la última burbuja.
                let lastOutIdxC = -1; mensajes.forEach((m, i) => { if (m.direccion === 'out') lastOutIdxC = i; });
                const rafagaIn = (lastOutIdxC >= 0 ? mensajes.slice(lastOutIdxC + 1) : mensajes).filter(m => m.direccion === 'in').map(m => m.mensaje).join(' ') || (entrantes[entrantes.length - 1].mensaje || '');
                const segsM = await citasVivas.manejarMensajeComprador(tel, rafagaIn, 0, convId);   // por dirección (0, chat) → 1 lectura
                if (segsM && segsM.length) return res.status(200).json({ ok: true, modo: 'cita_match', tipo: 'cita_comprador', segmentos: segsM });
            } catch (e) { console.error('[citas-vivas] comprador:', e.message); }

            // ══ CANDADO DE CAMPAÑA 📢 (orden owner 2026-07-25): a los teléfonos del
            // blast el bot NO les dice UNA sola palabra — ni Seb, ni Ignacio, ni acuses.
            // Lo que contesten SOLO se escala al owner. Se libera cuando él escribe a
            // mano en ese chat (manual ai=0 posterior al candado, o eco del teléfono).
            try {
                const camp = require('../lib/seb/campana.js');
                const mudo = await camp.esMudo(tel);
                if (mudo) {
                    const manualDespues = mensajes.some(m => m.direccion === 'out' && !m.ai && Number(m.ts) > Number(mudo.ts));
                    if (manualDespues) {
                        await camp.liberar(tel);   // el owner ya retomó → chat normal
                    } else {
                        const nomCamp = (convRow.length && convRow[0].nombre) || null;
                        return res.status(200).json({
                            ok: false, escalar_owner: true,
                            escala_motivo: 'CAMPAÑA 📢 — respondió al mensaje de la plataforma; el bot está MUDO en este chat (se libera cuando le escribas tú)',
                            escala_nombre: nomCamp, escala_ultimo: entrantes[entrantes.length - 1].mensaje
                        });
                    }
                }
            } catch (e) { console.error('[campana]', e.message); }

            // ══ CANAL MESSENGER 🔵 (orden owner 2026-08-24): "soy Sebastian de facebook"
            // manual tuyo = lead de TU canal de Messenger y TÚ llevas el chat — el bot NO
            // habla (solo lee y registra), el funnel ya quedó adelantado a calificación,
            // y el "cita confirmada ✅" sigue entrando por su timbre de siempre.
            try {
                const cm = require('../lib/seb/canal-messenger.js');
                const telCM = tel.replace(/\D/g, '');
                const conClave = cm.tieneClave(mensajes);
                // ARRANQUE ATÍPICO: solo cuenta si el lead NO viene de un anuncio
                // (un lead de anuncio con "si me interesa" corto es NORMAL, no atípico)
                let atipico = false;
                if (cm.esArranqueAtipico(mensajes)) {
                    try {
                        // CUOTA TURSO: ad_por_telefono tiene PK telefono → búsqueda exacta por las 3 formas (521/52/10 dígitos), no LIKE '%…' (tabla completa)
                        const t10CM = telCM.slice(-10);
                        const adRow = await query("SELECT 1 FROM ad_por_telefono WHERE telefono IN (?,?,?) LIMIT 1", ['521' + t10CM, '52' + t10CM, t10CM]);
                        atipico = !adRow.length;
                    } catch (e) { atipico = true; }
                }
                const iniciadoOwner = cm.esChatIniciadoPorOwner(mensajes) || atipico;
                if (conClave || iniciadoOwner || await cm.esMessenger(telCM)) {
                    // sin clave pero iniciado por el owner (o arranque atípico sin
                    // anuncio: te conoce/contesta como si ya hubieran hablado) →
                    // igual queda mudo persistente
                    if (!conClave && iniciadoOwner) await cm.marcarOwner(telCM);
                    const regCM = await cm.detectarYRegistrar(telCM);
                    const nomCM = (regCM && regCM.nombre) || (convRow.length && convRow[0].nombre) || null;
                    return res.status(200).json({
                        ok: false, escalar_owner: true,
                        escala_motivo: 'LEAD TUYO 🔵 — ' + (conClave || (regCM && regCM.messenger) ? 'canal Messenger' : (atipico ? 'contestó como si ya hubieran hablado (tu 1er mensaje no pasó por el puente)' : 'tú iniciaste este chat')) + '; el bot solo lee y registra' + (regCM && regCM.foco ? ' · foco: ' + regCM.foco : ''),
                        escala_nombre: nomCM, escala_ultimo: entrantes[entrantes.length - 1].mensaje
                    });
                }
            } catch (e) { console.error('[canal-messenger]', e.message); }

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
                    // CUOTA TURSO: se le pasa la libreta YA leída arriba (mismo request, mismo filtro de reset) — no se relee
                    const rIg = await recepcion.turnoIgnacio({ telefono: tel, convId, desdeTs: resetTsOA, mensajesPre: mensajes });
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
                    // "mándame la información del X" = herramienta DIRECTA (leer ficha) — sin
                    // gancho, y si nombra otro auto ese se abre (orden owner 2026-07-21)
                    const infoP = await require('../lib/seb/mesa.js').herramientaEnPosesion({ tel, texto: ultimoSolo }).catch(() => null);
                    if (infoP) return res.status(200).json({ ok: true, modo: 'posesion_herramienta', tipo: 'herr_' + (infoP.universo || 'info_auto'), segmentos: infoP.segmentos, fotos: infoP.fotos || null, fotos_after_index: (infoP.fotos_after_index != null ? infoP.fotos_after_index : 0), ubicacion_auto_id: infoP.ubicacion_auto_id || null, pin_after_index: (infoP.pin_after_index != null ? infoP.pin_after_index : null) });
                    const mcP = adCtx ? '[DESC: ' + adCtx + ']\n' + ultimoSolo : ultimoSolo;
                    const clasifP = await entender({ mensaje: mcP, historial: histCorto, estado: {} });
                    let autoP = clasifP.auto_id;
                    if (!autoP) { try { autoP = await U.autoActivoDe(0, tel); } catch (e) { } }
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
                    // El silencio JAMÁS se traga una PETICIÓN (auditoría caso Héctor): si el
                    // comprador pidió algo reconocible y la herramienta no pudo correr, se
                    // te ESCALA con el motivo — el dueño se entera siempre.
                    if (RE_PETICION_POS.test(followupP)) {
                        const nomPet = (convRow.length && convRow[0].nombre) || null;
                        await logEscala(tel, '🔧 pidió algo en tu chat y el bot no pudo servirlo');
                        return res.status(200).json({ ok: false, escalar_owner: true, escala_motivo: '🔧 te pidió algo (chat en tus manos) y la herramienta no pudo correr — lo ves tú', escala_nombre: nomPet, escala_ultimo: followupP });
                    }
                    return res.status(200).json({ ok: false, motivo: 'posesion_owner — chat en tus manos; no es herramienta → silencio' });
                }
            } catch (e) { console.error('[posesion]', e.message); }

            // ===== EN_CURSO: PRIMERA respuesta del comprador al opener (1 ráfaga nuestra + último=entrante) =====
            // Solo financiamiento / ubicación (sus manuales). Lo demás → silencio (lo ve el owner).
            if (bursts === 1 && lastDir === 'in') {
                let followup = mensajes.slice(lastOutIdx + 1).filter(m => m.direccion === 'in').map(m => m.mensaje).join(' ');
                // 📷 LA IMAGEN SE LEE (owner 2026-07-22): con URL se identifica el auto y
                // entra al texto; sin URL y sin texto útil → aviso al owner, jamás silencio.
                {
                    const absI = await require('../lib/seb/aparador.js').absorberImagen({ texto: followup, urls: req.body.imagenes });
                    if (absI.imagen && absI.sinUrl && !absI.textoUtil) {
                        await logEscala(tel, '📷 mandó una IMAGEN que el bot no puede ver — revísala tú');
                        return res.status(200).json({ ok: false, escalar_owner: true, escala_motivo: '📷 mandó una IMAGEN que el bot no puede ver — revísala tú', escala_nombre: nombreChat || null, escala_ultimo: followup });
                    }
                    if (absI.texto && absI.texto !== followup) followup = absI.texto;
                }
                // ══ ELECCIÓN DEL APARADOR (carrusel 2026-07-20): si mostramos aparador y
                // aún no hay foco, este mensaje puede ser la elección (hecho duro) o "más opciones"
                const elA = await intentarEleccionAparador(tel, followup, convId);
                if (elA) return res.status(200).json({ ok: true, modo: 'aparador', ...elA, pin_after_index: (elA.pin_after_index != null ? elA.pin_after_index : null) });
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
                // DUDAS GENERALES (crédito/requisitos/tasas) → su carril, no la mesa
                const dgC = await require('../lib/seb/mesa.js').dudaGeneral({ tel, texto: followup, nombre: nombreChat, clasif: clasifC, convId });
                if (dgC) return res.status(200).json({ ok: true, modo: 'duda_general', tipo: dgC.tipo, segmentos: dgC.segmentos });
                const mesaC = await require('../lib/seb/mesa.js').responderMesa({ tel, texto: followup, clasif: clasifC, convId });
                if (mesaC && mesaC.segmentos) return res.status(200).json({ ok: true, modo: 'mesa', tipo: mesaC.tipo, segmentos: mesaC.segmentos, fotos: mesaC.fotos || null, fotos_after_index: (mesaC.fotos_after_index != null ? mesaC.fotos_after_index : null), ubicacion_auto_id: mesaC.ubicacion_auto_id || null, pin_after_index: (mesaC.pin_after_index != null ? mesaC.pin_after_index : null) });
                if (mesaC && mesaC.auto_id) clasifC.auto_id = mesaC.auto_id;
                // ══ EL PERRO (owner 2026-07-21): Haiku elige herramientas (combinadas o
                // no), el código ejecuta con machotes — mata el parche-por-parche.
                {
                    const histTxt = histCorto.map(h => (h.direccion === 'in' ? 'COMPRADOR: ' : 'SEB: ') + h.mensaje).join('\n');
                    const perroC = await require('../lib/seb/ruteador.js').rutear({ tel, texto: followup, historial: histTxt, convId });
                    if (perroC && perroC.escalar_owner) {
                        await logEscala(tel, perroC.escala_motivo);
                        return res.status(200).json({ ok: !!(perroC.segmentos && perroC.segmentos.length), modo: 'perro', tipo: perroC.tipo, segmentos: perroC.segmentos || [], fotos: perroC.fotos || null, fotos_after_index: (perroC.fotos_after_index != null ? perroC.fotos_after_index : null), escalar_owner: true, escala_motivo: perroC.escala_motivo, escala_ultimo: followup });
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
                        try { await citasVivas.intentarMatchDirecto(tel, cont.cita_datos.fecha, cont.cita_datos.hora, 0); } catch (e) { }   // opener_auto = universo 0
                    }
                    return res.status(200).json({ ok: true, modo: 'continuacion', tipo: 'cont_' + cont.universo, segmentos: cont.segmentos, ubicacion_auto_id: cont.ubicacion_auto_id || null, pin_primero: !!cont.pin_primero, pin_after_index: (cont.pin_after_index != null ? cont.pin_after_index : null), fotos: cont.fotos || null, fotos_after_index: (cont.fotos_after_index != null ? cont.fotos_after_index : null) });
                }
                // DESAMBIGUAR (orden owner 2026-07-15): contestó la pregunta del opener
                // con una FAMILIA ("el mazda" y hay 2 Mazda) → se le presentan y se
                // pregunta cuál — esto NO es "fuera de lista blanca", es leer inventario.
                try {
                    const { candidatosDeAuto } = require('../lib/seb/clasificador.js');
                    const aActC = await memoQuery(INV_TTL, "SELECT id, marca, modelo, version, anio, precio FROM inventario_autos WHERE estado='activo'");
                    const candC = candidatosDeAuto(followup, aActC.map(a => ({ id: a.id, nombre: [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' '), precio: a.precio })));
                    if (candC) {
                        return res.status(200).json({
                            ok: true, modo: 'continuacion', tipo: 'cont_desambiguar', segmentos: [
                                require('../lib/seb/aparador.js').introFamilia(followup, candC) + '\n' + candC.map(a => '• ' + a.nombre + (a.precio ? ' — $' + Number(a.precio).toLocaleString('es-MX') : '')).join('\n'),
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
                let followupE = mensajes.slice(lastOutIdx + 1).filter(m => m.direccion === 'in').map(m => m.mensaje).join(' ') || (entrantes.length ? entrantes[entrantes.length - 1].mensaje : '');
                // 📷 LA IMAGEN SE LEE (owner 2026-07-22) — misma ley que en continuación
                {
                    const absI2 = await require('../lib/seb/aparador.js').absorberImagen({ texto: followupE, urls: req.body.imagenes });
                    if (absI2.imagen && absI2.sinUrl && !absI2.textoUtil) {
                        await logEscala(tel, '📷 mandó una IMAGEN que el bot no puede ver — revísala tú');
                        return res.status(200).json({ ok: false, escalar_owner: true, escala_motivo: '📷 mandó una IMAGEN que el bot no puede ver — revísala tú', escala_nombre: nombreChat || null, escala_ultimo: followupE });
                    }
                    if (absI2.texto && absI2.texto !== followupE) followupE = absI2.texto;
                }
                // elección tardía del aparador (preguntó algo en medio y luego eligió)
                const elA2 = await intentarEleccionAparador(tel, followupE, convId);
                if (elA2) return res.status(200).json({ ok: true, modo: 'aparador', ...elA2, pin_after_index: (elA2.pin_after_index != null ? elA2.pin_after_index : null) });
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
                // DUDAS GENERALES (crédito/requisitos/tasas) → su carril, no la mesa
                const dgE = await require('../lib/seb/mesa.js').dudaGeneral({ tel, texto: followupE, nombre: nombreChat, clasif: clasifE, convId });
                if (dgE) return res.status(200).json({ ok: true, modo: 'duda_general', tipo: dgE.tipo, segmentos: dgE.segmentos });
                const mesaE = await require('../lib/seb/mesa.js').responderMesa({ tel, texto: followupE, clasif: clasifE, convId });
                if (mesaE && mesaE.segmentos) return res.status(200).json({ ok: true, modo: 'mesa', tipo: mesaE.tipo, segmentos: mesaE.segmentos, fotos: mesaE.fotos || null, fotos_after_index: (mesaE.fotos_after_index != null ? mesaE.fotos_after_index : null), ubicacion_auto_id: mesaE.ubicacion_auto_id || null, pin_after_index: (mesaE.pin_after_index != null ? mesaE.pin_after_index : null) });
                if (mesaE && mesaE.auto_id) clasifE.auto_id = mesaE.auto_id;
                // ══ EL PERRO (owner 2026-07-21) — misma capa que en continuación
                {
                    const histTxtE = histCorto.map(h => (h.direccion === 'in' ? 'COMPRADOR: ' : 'SEB: ') + h.mensaje).join('\n');
                    const perroE = await require('../lib/seb/ruteador.js').rutear({ tel, texto: followupE, historial: histTxtE, convId });
                    if (perroE && perroE.escalar_owner) {
                        await logEscala(tel, perroE.escala_motivo);
                        return res.status(200).json({ ok: !!(perroE.segmentos && perroE.segmentos.length), modo: 'perro', tipo: perroE.tipo, segmentos: perroE.segmentos || [], fotos: perroE.fotos || null, fotos_after_index: (perroE.fotos_after_index != null ? perroE.fotos_after_index : null), escalar_owner: true, escala_motivo: perroE.escala_motivo, escala_ultimo: followupE });
                    }
                    if (perroE) return res.status(200).json({ ok: true, modo: 'perro', tipo: perroE.tipo, segmentos: perroE.segmentos, fotos: perroE.fotos || null, fotos_after_index: (perroE.fotos_after_index != null ? perroE.fotos_after_index : null) });
                }
                let autoE = clasifE.auto_id;
                if (!autoE) { try { autoE = await U.autoActivoDe(0, tel); } catch (e) { } }
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
                        try { await citasVivas.intentarMatchDirecto(tel, e3.cita_datos.fecha, e3.cita_datos.hora, 0); } catch (e) { }   // opener_auto = universo 0
                    }
                    return res.status(200).json({ ok: true, modo: 'etapa3', tipo: 'e3_' + (e3.universo || ''), segmentos: e3.segmentos, ubicacion_auto_id: e3.ubicacion_auto_id || null, pin_primero: !!e3.pin_primero, pin_after_index: (e3.pin_after_index != null ? e3.pin_after_index : (e3.ubicacion_auto_id ? 0 : null)), fotos: e3.fotos || null, fotos_after_index: (e3.fotos_after_index != null ? e3.fotos_after_index : 0) });
                }
                // responderEtapa3 = null → LONG-TAIL / no es claro → ESCALA al owner (jamás Sonnet suelto).
                return res.status(200).json({ ok: false, escalar_owner: true, escala_motivo: 'mensaje fuera de banco (no claro / requiere tu criterio)', escala_nombre: escNom, escala_ultimo: followupE });
            }

            // Ya hablamos (opener + continuación, o más turnos) → SILENCIO total (modo manual).
            if (bursts >= 1) return res.status(200).json({ ok: false, motivo: 'en_curso_silencio' });

            // ===== PRIMER CONTACTO (bursts === 0) → OPENER =====
            let lastMsg = entrantes[entrantes.length - 1].mensaje;
            let textoFamilia = entrantes.map(e => e.mensaje).join(' ');   // junta la ráfaga del comprador
            // 📷 LA IMAGEN TAMBIÉN ABRE (owner 2026-07-23, caso Brenda): foto en el primer
            // contacto → el ojo la identifica, el auto queda SENTADO (mesa+escena) y si
            // además venía OTRA pregunta se contestan AMBAS (nota de la foto + el flujo).
            let notaFoto = null;
            try {
                const apF = require('../lib/seb/aparador.js');
                const absF = await apF.absorberImagen({ texto: textoFamilia });
                if (absF && absF.auto) {
                    const autosF = await apF.inventarioActivo();
                    const rowF = autosF.find(a => a.id === absF.auto.auto_id);
                    if (rowF) {
                        const { guardarMesa } = require('../lib/seb/mesa.js');
                        const ejF2 = (await U.leerEstado(0, tel)).ej;
                        ejF2.escena = [rowF.id];
                        await guardarMesa(tel, ejF2, [rowF.id], rowF.id);
                        const limpioF = String(absF.texto || '').replace(rowF.nombre, ' ').replace(/\$+/g, ' ').replace(/\s+/g, ' ').trim();
                        if (limpioF.length >= 8) {
                            notaFoto = `El de la foto es el ${rowF.nombre}${rowF.precio ? ' — $' + Number(rowF.precio).toLocaleString('es-MX') : ''}, disponible 👍`;
                            textoFamilia = limpioF; lastMsg = limpioF;   // el flujo contesta la OTRA pregunta
                        } else {
                            textoFamilia = rowF.nombre; lastMsg = rowF.nombre;   // solo la foto → su paquete
                        }
                    }
                } else if (absF && absF.imagen && absF.sinUrl && !absF.textoUtil) {
                    await logEscala(tel, '📷 abrió con una IMAGEN que el bot no puede ver — revísala tú');
                    return res.status(200).json({ ok: false, escalar_owner: true, escala_motivo: '📷 abrió con una IMAGEN que el bot no puede ver — revísala tú', escala_nombre: nombreChat || null, escala_ultimo: textoFamilia });
                }
            } catch (e) { console.error('[foto opener]', e.message); }
            const conFoto = (o) => { if (notaFoto && Array.isArray(o.segmentos) && o.segmentos.length) { const i = Math.min(2, o.segmentos.length); o.segmentos = [...o.segmentos.slice(0, i), notaFoto, ...o.segmentos.slice(i)]; } return o; };
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
                        // FAMILIA ambigua también en el opener ("info del mazda 2021" y hay
                        // dos): se pregunta con la familia y SE RECUERDA — jamás adivinar
                        const rFamO = apNeg.resolverEleccion(textoFamilia, autosG.map(a => ({ n: 0, id: a.id, nombre: a.nombre, color: '' })));
                        // ⚖️ EL JUEZ DE DISPARO (owner 2026-07-22): primer contacto — si el
                        // juez razona que NO nombró esos autos, este guard no dispara.
                        let famOk = true;
                        if (rFamO && rFamO.pregunta && rFamO.via === 'nombre_ambiguo') {
                            try {
                                const { juezNombroAuto } = require('../lib/seb/juez.js');
                                const jF = await juezNombroAuto({ texto: textoFamilia, candidatos: rFamO.pregunta });
                                famOk = !jF || jF.nombro !== false;
                            } catch (e) { }
                        }
                        if (famOk && rFamO && rFamO.pregunta && rFamO.via === 'nombre_ambiguo' && rFamO.pregunta.some(x => x.id === Number(clasif.auto_id))) {
                            const idsF = rFamO.pregunta.map(x => x.id);
                            const ejF = JSON.stringify({ mesa_familia: idsF });
                            await U.guardarEstado(0, tel, { estado_json: ejF, estado: 'mesa' }).catch(() => { });
                            const { nombreReal: nrF, saludoHora: shF } = require('../lib/seb/opener.js');
                            const nmF = nrF(nombreChat);
                            return res.status(200).json({ ok: true, modo: 'mesa', tipo: 'mesa_pregunta_cual', segmentos: [`Qué tal${nmF ? ' ' + nmF : ''} ${shF()}!`, 'De esos tenemos estos — ¿cuál te interesa?\n' + rFamO.pregunta.map((x, i) => `${i + 1}) ${x.nombre}`).join('\n')] });
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
                if (arrC) return res.status(200).json(conFoto({ ok: true, ...arrC }));
            } catch (e) { console.error('[aparador clic]', e.message); }

            // ══ ENTRADA MÚLTIPLE (red team #3): abre nombrando 2-3 autos → todos a la
            // mesa desde el saludo (ficha + portada + punto de cada uno → a la cita)
            try {
                const emP = await require('../lib/seb/mesa.js').entradaMultiple({ tel, texto: textoFamilia, nombre: nombreChat });
                if (emP) { const oP = conFoto({ ok: true, modo: 'mesa', tipo: emP.tipo, segmentos: emP.segmentos, fotos: emP.fotos || null, fotos_after_index: (emP.fotos_after_index != null ? emP.fotos_after_index : null), ubicacion_auto_id: emP.ubicacion_auto_id || null, pin_after_index: (emP.pin_after_index != null ? emP.pin_after_index : null) }); if (notaFoto && oP.fotos_after_index != null && oP.fotos_after_index >= 2) oP.fotos_after_index++; return res.status(200).json(oP); }
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
            if (op && op.segmentos && op.segmentos.length) { const oOp = conFoto({ ok: true, segmentos: op.segmentos, tipo: op.tipo, fotos: op.fotos || null, fotos_after_index: (op.fotos_after_index != null ? op.fotos_after_index : null) }); if (notaFoto && oOp.fotos_after_index != null && oOp.fotos_after_index >= 2) oOp.fotos_after_index++; return res.status(200).json(oOp); }
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
                        const aAct = await memoQuery(INV_TTL, "SELECT id, marca, modelo, version, anio, precio FROM inventario_autos WHERE estado='activo'");
                        const cand = candidatosDeAuto(textoFamilia, aAct.map(a => ({ id: a.id, nombre: [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' '), precio: a.precio })));
                        if (cand) {
                            return res.status(200).json(conFoto({
                                ok: true, tipo: 'opener_desambiguar', segmentos: [
                                    `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}!`,
                                    'Mucho gusto, mi nombre es Sebastián Romero, para servirte',
                                    require('../lib/seb/aparador.js').introFamilia(textoFamilia, cand) + '\n' + cand.map(a => '• ' + a.nombre + (a.precio ? ' — $' + Number(a.precio).toLocaleString('es-MX') : '')).join('\n'),
                                    'Cuál te interesa?'
                                ]
                            }));
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
                    // ══ LEY DEL OPENER (owner 2026-07-22): ni anuncio ni auto ni señal de
                    // rol ("cómo funcionan", "info de su negocio") → se pregunta el CAJÓN
                    // directo; la respuesta la resuelve dudaGeneral (comprar/vender).
                    try {
                        if (require('../lib/seb/aparador.js').rolAmbiguo({ texto: textoFamilia, adCtx })) {
                            const ejRol = (await U.leerEstado(0, tel)).ej;
                            ejRol.pregunta_rol = 1;
                            await U.guardarEstado(0, tel, { estado_json: ejRol, estado: 'opener' }).catch(() => { });
                            return res.status(200).json({
                                ok: true, tipo: 'opener_rol', segmentos: [
                                    `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}!`,
                                    'Mucho gusto, mi nombre es Sebastián Romero, para servirte',
                                    '¿Andas buscando comprar un auto, o vender el tuyo? Para atenderte como va 👍'
                                ]
                            });
                        }
                    } catch (e) { console.error('[rol]', e.message); }
                    // red de seguridad: la pregunta clásica del owner
                    return res.status(200).json(conFoto({
                        ok: true, tipo: 'opener_sin_auto', segmentos: [
                            `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}!`,
                            'Mucho gusto, mi nombre es Sebastián Romero, para servirte',
                            'Claro que sí, de qué auto buscas información? Para poderte ayudar'
                        ]
                    }));
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
            const convEstado = await U.leerEstado(0, tel);
            // MODO PRUEBA: si el estado es ANTERIOR al reinicio (contestaste un anuncio nuevo),
            // se IGNORA → lead nuevo de 0 (sin enganche/plazo/auto_id/pregunta arrastrados).
            const estado = (convEstado.existe && convEstado.updated_at >= resetTs)
                ? { ...convEstado.ej, auto_id_activo: convEstado.auto_id_activo }
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
                await U.guardarEstado(0, item.telefono, { estado_json: meta.estado_nuevo, auto_id_activo: meta.estado_nuevo.auto_id_activo || null, estado: 'seb' });
            }

            // 3) ENVÍO POR LA PUERTA DE MENSAJES (FyraChat v2, 2026-09-10): clave 'resolver:<qid>' (el candado del QID
            //    ya ganó arriba; la puerta además resuelve chat/teléfono real/carril de pruebas y deja el recibo en `envios`).
            let enviado = false, error_envio = null;
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
            let envRs = { ok: false, error: 'sin chat' };
            const chatRs = await U.chatDe(0, item.telefono, { crear: true, visible: true });
            if (chatRs) envRs = await MSJ.enviar({ tenantId: 0, chatId: chatRs.id, origen: 'sugerencia', clave: 'resolver:' + item.id, texto: final, imagen: extra.image || null, imagen_ref: (extra.image && meta.auto_id) ? 'ubic-img:' + Number(meta.auto_id) : null, location: extra.location || null, manual: resolucion === 'manual', sesionId: SES ? SES.sid : null, accion: 'sugerencia_' + resolucion, refId: item.id, meta: { intencion: item.intencion, similitud: sim } });
            enviado = !!envRs.ok; if (!enviado) error_envio = envRs.error || 'no se pudo mandar';

            // 4) El saliente ya llega a raw_conversations vía el bridge (/api/send → SALES-BRAIN).
            //    Fuente única: NO se escribe wa_messages aquí.
            await run("UPDATE seb_queue SET estado=?, texto_final=?, resuelto_en=? WHERE id=?",
                [enviado ? 'enviado' : 'aprobado_sin_enviar', final, Date.now(), item.id]);

            // 5) CONTROL: si fue paquete de ubicación, deja en FyraChat la CAPTURA + el PIN
            //    renderizables (no como "[imagen]"). La imagen se sirve por action=ubic_img.
            //    (simulado: la puerta ya dejó esos renglones en el hilo)
            if (enviado && !envRs.simulado && meta.auto_id && (extra.image || extra.location)) {
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

            return res.status(200).json({ ok: true, enviado, error_envio, similitud: sim, simulado: !!envRs.simulado, msg_id: envRs.msg_id || null, mensaje: envRs.mensaje || null, chat_id: chatRs ? chatRs.id : null, clave: 'resolver:' + item.id });
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
        // ══════════ 🛟 LA GUARDIA — agenda de rescate para el calendario ══════════
        if (action === 'rescate_agenda') {
            const resc = require('../lib/seb/rescate.js');
            const incluirPruebas = String(req.query.incluir_pruebas || '') === '1';
            const desde = Date.now() - 48 * 3600000;
            // POR UNIVERSO (2026-09-10): la agenda es del universo del request (VEND_PARAM / sesión; sin él = 0). Los folios
            // de rescate son SOLO del universo 0 (la máquina de rescate es de Fyradrive); los programados, los del universo.
            const tAg = VEND_PARAM ? await tenantDeParam(VEND_PARAM) : { id: 0 };
            if (!tAg) return res.status(404).json({ ok: false, error: 'vendedor no dado de alta' });
            let rows = Number(tAg.id) ? [] : await query("SELECT * FROM rescates WHERE (estado='vivo' OR updated > ?) AND COALESCE(tenant_id,0)=0 ORDER BY proxima_ts ASC LIMIT 200", [desde]).catch(() => []);
            if (!incluirPruebas) rows = rows.filter(r => !/^52100000000/.test(String(r.telefono)));
            // los folios que murieron BIEN (regresó a la cancha, renovada, contestó) son
            // puro ruido en el calendario — solo se enseñan vivos, cancelados y agotados
            rows = rows.filter(r => r.estado === 'vivo' || /cancelado|agotado|cita viva/.test(String(r.motivo_cierre || '')));
            const out = [];
            for (const r of rows.slice(0, 80)) {
                const ctx = await resc.ctxDe(r.telefono, Number(r.etapa) || 0, Number(r.proxima_ts) || Date.now()).catch(() => ({}));
                let nombre = ctx && ctx.nombre;
                if (!nombre) { try { const cv = await query("SELECT nombre FROM conversaciones WHERE channel_thread_id=?", ['whatsapp:' + r.telefono]); nombre = cv.length ? cv[0].nombre : null; } catch (e) { } }
                let saldra = [];
                try { saldra = resc.machote(r, { ...ctx, ahora: Number(r.proxima_ts) || Date.now() }); } catch (e) { }
                out.push({
                    id: r.id, folio: 'R-' + r.id, telefono: r.telefono, nombre: nombre || '',
                    tipo: r.tipo, carril: r.carril, bala: r.pendiente, etapa: Number(r.etapa) || 0,
                    escala: r.escala || '', etiqueta: r.etiqueta || '', estado: r.estado, motivo_cierre: r.motivo_cierre || '',
                    proxima_ts: Number(r.proxima_ts) || null, created: Number(r.created) || null,
                    auto: (ctx && ctx.auto && ctx.auto.nombre) || '', foto: (ctx && ctx.foto) || null, saldra
                });
            }
            // MENSAJES PROGRAMADOS A MANO (owner 2026-08-03): van en la misma agenda
            let programados = [];
            try {
                const prog = require('../lib/seb/programados.js');
                programados = (await prog.listar({ incluirPruebas, tenantId: Number(tAg.id) || 0 })).map(p => ({
                    id: p.id, telefono: p.telefono, nombre: p.nombre || '', texto: p.texto,
                    con_foto: Number(p.con_foto) || 0, cuando_ts: Number(p.cuando_ts), estado: p.estado
                }));
            } catch (e) { }
            return res.status(200).json({ ok: true, folios: out, programados, ahora: Date.now() });
        }
        // ══ EJECUTAR UNA ACCIÓN DE LA LISTA BLANCA (una sola puerta, 2026-09-10): la usan el botón del chat (accion_boton)
        // y la FORMA DE ENTRADA al delegar (delegar con modo info/fotos/ubicacion/cotizar/cita). DETERMINISTA: ejecuta literal
        // la herramienta con el auto EN FOCO (o el auto_id que venga), restringida al catálogo del universo. Cero IA.
        // Devuelve { status, out } — quien llama responde. B = cuerpo (auto_id, auto_texto, enganche, plazo_meses, fecha_iso, hora, comprador_nombre).
        async function ejecutarAccion(tAcc, telFullB, accB, B) {
            B = B || {};
            const R = (status, out) => ({ status, out });
            const TID = tAcc.id;
            const esDemoB = !!tAcc.demo;   // MODO PRUEBA: el comprador es de prueba y cada salida se REGISTRA en el hilo (nada al puente)
            if (esDemoB) telFullB = DEMO.telComprador(telFullB);
            const catalogoT = TID ? await autosDeTenant(tAcc) : null;
            const enCatalogo = a => !catalogoT || esDemoB || catalogoT.some(c => Number(c.id) === Number(a.id));   // demo: cualquier auto activo del inventario (solo lectura)
            const H = require('../lib/seb/herramientas.js');
            const normB = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
            // ── 1) RESOLVER EL AUTO (fila de inventario) ──
            let inv = null;
            const buscarInv = async (cond, args) => {
                const r = await query("SELECT id, fyradrive_web_id, marca, modelo, version, anio, precio FROM inventario_autos WHERE estado='activo' AND (" + cond + ")", args);
                return r;
            };
            if (B.auto_id) {
                const r = await buscarInv('id = ? OR fyradrive_web_id = ?', [Number(B.auto_id), Number(B.auto_id)]);
                inv = r[0] || null;
                if (inv && !enCatalogo(inv)) return R(403, { ok: false, error: 'ese auto no está habilitado para este usuario' });
            } else if (TID) {
                // universo de vendedor: el foco del contacto manda; sin foco NO se adivina (cambia el auto en la barrita)
                const f = await focoDe(tAcc, telFullB);
                if (f && f.id) { const r = await buscarInv('id = ?', [Number(f.id)]); inv = r[0] || null; }
                if (!inv || !enCatalogo(inv)) return R(200, { ok: false, necesita: 'foco', error: 'este contacto no tiene auto en foco (o ya no está activo) — cámbialo en la barrita del chat' });
            } else if (String(B.auto_texto || '').trim()) {
                // match por nombre contra TODO el inventario activo: todos los tokens
                // del texto deben vivir en [marca modelo version año]; único o nada.
                const t = normB(B.auto_texto);
                const toks = t.split(' ').filter(x => x.length >= 2 || /^\d$/.test(x));
                const todos = await buscarInv('1=1', []);
                const hits = todos.filter(a => {
                    const nom = normB([a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' '));
                    return toks.every(tk => nom.includes(tk));
                });
                if (hits.length === 1) inv = hits[0];
                else return R(200, { ok: false, necesita: 'auto', error: hits.length ? ('ambiguo: ' + hits.map(h => [h.marca, h.modelo, h.anio].join(' ')).join(' | ')) : 'no encontré ese auto en el inventario' });
            } else {
                // el AUTO EN FOCO de la conversación
                const foco = await U.autoActivoDe(0, telFullB);
                if (foco) { const r = await buscarInv('id = ? OR fyradrive_web_id = ?', [foco, foco]); inv = r[0] || null; }
                if (!inv) return R(200, { ok: false, necesita: 'auto' });
            }
            const nombreAuto = [inv.marca, inv.modelo, inv.anio].filter(Boolean).join(' ');
            // el foco queda amarrado a lo que se ejecutó (seguimiento coherente) — upsert
            try { await ponerFoco(tAcc, telFullB, inv); } catch (e) { }
            // ACCIÓN POR CHAT (Etapa 2c): la cita deja su fila aquí; info/fotos/ubicación/cotizar la dejan en la PUERTA DE MENSAJES (una por envío)
            const regAcc = async (tipo, meta) => { try { const dA = await citasVivas.direccionDe(TID, telFullB); await ACCIONES.registrar({ tenant_id: TID, chat_id: dA.chat_id, delegacion_id: dA.delegacion_id, tipo, ref_id: inv.id, meta: Object.assign({ auto: nombreAuto }, meta || {}), actor: 'vendedor', sesion_id: SES ? SES.sid : null }); } catch (e) { } };
            // CANDADO SANDBOX (ley de la casa): tels de prueba JAMÁS salen a WhatsApp — la PUERTA DE MENSAJES los simula
            // (y al universo demo) dejando el renglón en el hilo; el flujo se prueba completo sin tocar el puente.
            const esPrueba = /^52100000000/.test(telFullB) || esDemoB;
            // ══ PUERTA DE MENSAJES (FyraChat v2, 2026-09-10): dirección del chat + clave idempotente (la UI manda B.clave; sin ella se genera)
            const dirAcc = await citasVivas.direccionDe(TID, telFullB, { crear: !TID });
            if (!dirAcc.chat_id) return R(404, { ok: false, error: 'este contacto no tiene chat en este universo (delega primero)' });
            const claveB = String(B.clave || ('boton:' + accB + ':' + dirAcc.chat_id + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8)));
            const mandar = (extra) => MSJ.enviar(Object.assign({ tenantId: TID, chatId: dirAcc.chat_id, origen: 'boton:' + accB, clave: claveB + ':msg', manual: false, sesionId: SES ? SES.sid : null, accion: 'boton_' + accB, refId: inv.id, meta: { auto: nombreAuto, via: B.via || 'boton' } }, extra || {}));
            const simTxt = () => 'SIMULADO (' + (esDemoB ? 'prueba' : 'carril pruebas') + '): ';
            try {
                // ── 2) EJECUTAR LITERAL ──
                if (accB === 'info') {
                    // 📄 ENVIAR INFO (owner 2026-08-07): el machote COMPLETO del auto,
                    // copy-paste literal (mismo generador del "más información" del bot)
                    const { machoteDe } = require('../lib/seb/machote.js');
                    const mch = await machoteDe(inv.id);
                    if (!mch) return R(200, { ok: false, error: 'no pude armar el machote (al auto le falta precio o año)' });
                    const env = await mandar({ texto: mch });
                    if (!env.ok) return R(200, { ok: false, error: env.error || 'no se pudo mandar el machote', auto: nombreAuto });
                    return R(200, { ok: true, simulado: !!env.simulado, auto: nombreAuto, enviado: (env.simulado ? simTxt() + 'machote de info' : 'machote completo de ' + nombreAuto), texto_enviado: String(mch), machote: String(mch).slice(0, 150), msg_id: env.msg_id || null, clave: claveB, repetido: !!env.repetido });
                }
                if (accB === 'primer_mensaje') {
                    // PRIMER MENSAJE (orden owner 2026-09-12): el vendedor se presenta en primera persona y pregunta si le interesa el auto.
                    const nomV = String((tAcc && tAcc.nombre) || '').trim() || 'el vendedor';
                    const txt1 = 'Hola, mi nombre es ' + nomV + ', del ' + nombreAuto + '. Te escribo para ver si te interesaba comprar el auto.';
                    const env = await mandar({ texto: txt1, manual: true, meta: { auto: nombreAuto, tipo: 'primer_mensaje' } });
                    if (!env.ok) return R(200, { ok: false, error: env.error || 'no se pudo mandar el primer mensaje', auto: nombreAuto });
                    return R(200, { ok: true, simulado: !!env.simulado, auto: nombreAuto, enviado: (env.simulado ? simTxt() : '') + 'primer mensaje', texto_enviado: txt1 });
                }
                if (accB === 'cita_propuesta') {
                    // 📅 AÚN SIN HORARIO (orden owner 2026-09-12): sale la PROPUESTA de cita — busca día y hora — sin crear la cita todavía.
                    const nomP = String(B.comprador_nombre || '').trim().split(/\s+/)[0] || '';
                    const txtP = (nomP ? nomP + ', ¿' : '¿') + 'qué día y a qué hora te queda bien pasar a ver el ' + nombreAuto + '? Dime y te lo aparto para esa hora.';
                    const env = await mandar({ texto: txtP, meta: { auto: nombreAuto, tipo: 'cita_propuesta' } });
                    if (!env.ok) return R(200, { ok: false, error: env.error || 'no se pudo mandar la propuesta', auto: nombreAuto });
                    return R(200, { ok: true, simulado: !!env.simulado, auto: nombreAuto, enviado: (env.simulado ? simTxt() : '') + 'propuesta de cita (sin horario)', texto_enviado: txtP });
                }
                if (accB === 'fotos') {
                    const urls = await H.fotosDeAuto(inv.id, 8);
                    if (!urls || !urls.length) return R(200, { ok: false, error: 'ese auto no tiene fotos en el sistema' });
                    // universos de vendedor: SOLO las fotos, sin redactar; t0: texto + fotos (una sola intención, un solo recibo)
                    const env = await mandar({ texto: TID ? null : 'Van, ahí te las mando 📸', fotos: urls, meta: { auto: nombreAuto, n: urls.length } });
                    if (!env.ok) return R(200, { ok: false, error: env.error || 'el puente no pudo mandar las fotos', auto: nombreAuto });
                    return R(200, { ok: true, simulado: !!env.simulado, auto: nombreAuto, enviado: (env.simulado ? simTxt() : '') + (TID ? 'solo ' : 'texto + ') + urls.length + ' fotos', texto_enviado: TID ? null : 'Van, ahí te las mando 📸', fotos: urls.length, msg_id: env.msg_id || null, clave: claveB, repetido: !!env.repetido });
                }
                if (accB === 'ubicacion') {
                    const u = await H.ubicacion({ auto_id: inv.id });
                    if (!u.ok) return R(200, { ok: false, error: u.error === 'sin_punto_asignado' ? ('el ' + nombreAuto + ' NO tiene punto de venta asignado (configúralo en puntos.html)') : u.error });
                    const punto = (u.placeholders && u.placeholders.punto_nombre) || 'nuestro punto Fyradrive';
                    const pe = await query('SELECT image_b64, lat, lng, name FROM punto_envio WHERE auto_id = ?', [inv.id]);
                    const cap = pe.length ? pe[0] : {};
                    const texto = 'Lo tenemos en ' + punto + ', para que lo veas cuando gustes';
                    // el paquete: captura + texto + pin (el puente los manda en ese orden en UNA llamada) y, solo en t0, la pregunta de cita
                    const env = await mandar({
                        segmentos: TID ? [texto] : [texto, '¿Qué día te queda bien para venir a verlo y manejarlo? Te agendo de una vez'],
                        imagen: cap.image_b64 || null, imagen_ref: cap.image_b64 ? 'ubic-img:' + inv.id : null,
                        location: (cap.lat != null && cap.lng != null) ? { lat: cap.lat, lng: cap.lng, name: cap.name || punto } : null,
                        meta: { auto: nombreAuto, punto }
                    });
                    if (!env.ok) return R(200, { ok: false, error: env.error || 'el puente no pudo mandar la ubicación', auto: nombreAuto });
                    return R(200, { ok: true, simulado: !!env.simulado, auto: nombreAuto, enviado: (env.simulado ? simTxt() : '') + 'paquete de ubicación de ' + punto + ' (' + [cap.image_b64 ? 'captura' : null, 'texto', (cap.lat != null ? 'pin' : null), TID ? null : 'cita'].filter(Boolean).join(' + ') + ')', texto_enviado: TID ? texto : texto + '\n¿Qué día te queda bien para venir a verlo y manejarlo? Te agendo de una vez', msg_id: env.msg_id || null, clave: claveB, repetido: !!env.repetido });
                }
                if (accB === 'cotizar') {
                    const c = await H.cotizar({ auto_id: inv.id, enganche: B.enganche ? Number(B.enganche) : undefined, plazo_meses: B.plazo_meses ? Number(B.plazo_meses) : undefined });
                    if (!c.ok) return R(200, { ok: false, necesita: c.error === 'falta_enganche' ? 'datos' : undefined, error: c.error });
                    const tarjeta = String(c.placeholders.cotizacion);
                    // vendedores: SOLO la tarjeta; t0: la ráfaga del owner (3 burbujas, un solo recibo)
                    const env = await mandar({ segmentos: TID ? [tarjeta] : ['Va, mira cómo quedaría:', tarjeta, '¿Cómo la ves?'], meta: { auto: nombreAuto, enganche: B.enganche || null, plazo: B.plazo_meses || null } });
                    if (!env.ok) return R(200, { ok: false, error: env.error || 'no se pudo mandar la cotización', auto: nombreAuto, tarjeta });
                    return R(200, { ok: true, simulado: !!env.simulado, auto: nombreAuto, enviado: (env.simulado ? simTxt() + 'cotización lista' + (TID ? ' (solo la tarjeta)' : '') : 'cotización de ' + nombreAuto), texto_enviado: TID ? tarjeta : ['Va, mira cómo quedaría:', tarjeta, '¿Cómo la ves?'].join('\n'), tarjeta, msg_id: env.msg_id || null, clave: claveB, repetido: !!env.repetido });
                }
                if (accB === 'cita') {
                    const fI = String(B.fecha_iso || ''), hI = String(B.hora || '');
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(fI) || !/^\d{1,2}:\d{2}$/.test(hI)) return R(200, { ok: false, necesita: 'fecha_hora' });
                    await regAcc('cita_agendada', { fecha_iso: fI, hora: hI, simulado: esPrueba, via: B.via || 'boton' });
                    // MISMO machote dictado por el owner (2026-08-24). UNIVERSOS DE VENDEDOR (orden owner 2026-09-10): SIN presentación
                    // ("soy el asistente de… 🤖" jamás) — el vendedor ya se presentó a mano; el bot solo ejecuta: "Ya quedó tu cita ✅ …".
                    const [yC, moC, dC] = fI.split('-').map(Number); const [hhC, miC] = hI.split(':').map(Number);
                    const diasC = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
                    const diaNomC = diasC[new Date(Date.UTC(yC, moC - 1, dC, 12)).getUTCDay()];
                    const horaTxtC = (hhC % 12 === 0 ? 12 : hhC % 12) + (miC ? ':' + String(miC).padStart(2, '0') : '') + (hhC < 12 ? 'am' : 'pm');
                    const citaTsC = Date.UTC(yC, moC - 1, dC, hhC, miC) + 6 * 3600000;   // Monterrey = UTC-6 (misma cuenta que el SB)
                    const msjCitaVend = (() => {
                        const nomC = String(B.comprador_nombre || '').trim().split(/\s+/)[0] || '';
                        const [y, mo, d] = [yC, moC, dC];
                        const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
                        const horaTxt = horaTxtC;
                        const cuando = diaNomC + ' ' + d + ' de ' + meses[mo - 1] + ' a las ' + horaTxt + ' para ver el ' + nombreAuto + '.';
                        if (TID) return (nomC ? nomC + ', ya' : 'Ya') + ' quedó tu cita ✅ ' + cuando + '\n' +
                            'Por aquí te estaré enviando las notificaciones previas a tu cita 👍';
                        const vend = String(tAcc.nombre || '').split(/\s+/)[0] || 'tu vendedor';
                        return 'Hola' + (nomC ? ' ' + nomC : '') + ', soy el asistente de ' + vend + ' 🤖\n' +
                            'Ya quedó tu cita ✅ ' + cuando + '\n' +
                            'Por aquí te estaré enviando las notificaciones previas a tu cita para comprar tu auto 👍';
                    })();
                    // MODO PRUEBA / carril: NO se crea cita en CRM ni en Calendar; en demo el machote de confirmación queda en el hilo
                    if (esPrueba) {
                        // el machote de confirmación sale por la PUERTA (simulado: queda en el hilo; recibo en envios con la clave de la UI)
                        const envC = await mandar({ texto: msjCitaVend, meta: { auto: nombreAuto, fecha_iso: fI, hora: hI } });
                        // la MISMA máquina de citas (citas_match + casillas) nace también aquí: el comprador es de prueba → todo se simula,
                        // el puente no programa nada (programarEnPuente salta tels de prueba) y citas_mias la muestra con sus casillas
                        let matchC = null;
                        try {
                            matchC = await citasVivas.matchDirectoCalendar({ comprador_tel: telFullB, comprador_nombre: String(B.comprador_nombre || '').trim() || null, dueno_tel: TID ? String(tAcc.telefono || '') : '', dueno: TID ? String(tAcc.nombre || '') : null, auto_id: inv.id, auto_nombre: nombreAuto, fecha: diaNomC, hora: horaTxtC, cita_ts: citaTsC, avisar: false, tenant_id: TID, reemplazar: true });
                        } catch (e) { matchC = { ok: false, error: e.message }; }
                        return R(200, { ok: !!envC.ok, simulado: true, auto: nombreAuto, enviado: 'SIMULADO (' + (esDemoB ? 'prueba' : 'carril pruebas') + '): cita ' + fI + ' ' + hI + ' (sin CRM ni Calendar)', texto_enviado: msjCitaVend, cita_match_id: matchC && matchC.match_id || null, casillas: matchC && matchC.casillas || 0, error: envC.ok ? undefined : (envC.error || 'no se pudo dejar el machote'), clave: claveB, repetido: !!envC.repetido });
                    }
                    const rc = await fetch('https://sales-brain-theta.vercel.app/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ action: 'cita_manual', phone: telFullB.slice(-10), fecha_iso: fI, hora: hI, inv_auto_id: inv.id }, TID ? {
                        // TENANT = DUEÑO (orden owner 2026-09-08): no se le pide confirmación a nadie — el vendedor la agenda él mismo;
                        // el bot Fyradrive le habla A ÉL (víspera/día D) y el comprador recibe el machote + recordatorios por el número del vendedor.
                        dueno_confirmado: 1, tenant_id: TID, dueno_tel: tAcc.telefono, dueno_nombre: tAcc.nombre,
                        msj_confirmacion: msjCitaVend
                    } : {})) });
                    const dc = await rc.json().catch(() => ({}));
                    if (!dc.ok) return R(200, { ok: false, error: dc.error || 'no se pudo crear la cita' });
                    return R(200, { ok: true, auto: nombreAuto, enviado: 'cita ' + fI + ' ' + hI + ' — CRM ✓ Calendar ' + (dc.gcal_ok ? '✓' : '⚠️') + ' Solicitud ' + (dc.solicitud_ok ? '✓' : (dc.solicitud_na ? '(sin tel dueño)' : '⚠️')), texto_enviado: TID ? msjCitaVend : null, cita_id: dc.cita_id, cita_match_id: dc.match && dc.match.match_id || null });
                }
                return R(400, { ok: false, error: 'accion desconocida' });
            } catch (e) { return R(200, { ok: false, error: e.message }); }
        }
        // ══ BOTONERA DE EMERGENCIA (owner 2026-08-06): (ubicación)(cotizar)(fotos)(cita) en FyraChat.
        // Los botones funcionan en cada universo, con el AUTO EN FOCO del contacto, restringidos a su catálogo, y TODO sale
        // por el número de ESE tenant. La ejecución vive en ejecutarAccion (misma puerta que la forma de entrada al delegar).
        if (action === 'accion_boton' && req.method === 'POST') {
            const telB = String(req.body.telefono || '').replace(/\D/g, '');
            const accB = String(req.body.accion || '');
            if (!telB || !accB) return res.status(400).json({ ok: false, error: 'telefono y accion requeridos' });
            const telFullB = telB.length === 10 ? '521' + telB : telB;
            const tAcc = VEND_PARAM ? await tenantDeParam(VEND_PARAM) : { id: 0, telefono: '5215659423834', nombre: 'Sebastián Romero' };
            if (!tAcc) return res.status(404).json({ ok: false, error: 'vendedor no dado de alta' });
            const rA = await ejecutarAccion(tAcc, telFullB, accB, req.body);
            return res.status(rA.status).json(rA.out);
        }
        // ══ MENSAJES PROGRAMADOS (owner 2026-08-03): el Calendar agenda a mano ══
        if (action === 'prog_crear' && req.method === 'POST') {
            const prog = require('../lib/seb/programados.js');
            const tP = VEND_PARAM ? await tenantDeParam(VEND_PARAM) : { id: 0 };
            if (!tP) return res.status(404).json({ ok: false, error: 'vendedor no dado de alta' });
            if (tP.demo) {   // MODO PRUEBA: no se programa nada (el cron no lo toca); queda como renglón 'sistema' en el hilo
                const cuP = Number(req.body.cuando_ts) || 0; const msP = cuP > 1e12 ? cuP : cuP * 1000;
                let cuandoTxt = ''; try { cuandoTxt = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Monterrey', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(msP)); } catch (e) { cuandoTxt = new Date(msP).toISOString(); }
                const rP = await DEMO.sistema(tP, DEMO.telComprador(req.body.telefono), DEMO.PREFIJO + '⏰ Recordatorio programado para ' + cuandoTxt + ': «' + String(req.body.texto || '').slice(0, 300) + '»' + (req.body.con_foto === false || req.body.con_foto === 0 ? '' : ' (+ foto)'));
                return res.status(rP.ok ? 200 : 400).json({ ok: !!rP.ok, simulado: true, id: null, error: rP.ok ? undefined : rP.error });
            }
            const r = await prog.crear({ tel: req.body.telefono, nombre: req.body.nombre, texto: req.body.texto, cuandoTs: Number(req.body.cuando_ts), conFoto: req.body.con_foto !== false && req.body.con_foto !== 0, tenantId: tP.id });
            if (r.ok) { try { let telPg = String(req.body.telefono || '').replace(/\D/g, ''); if (telPg.length === 10) telPg = '521' + telPg; const dP = await citasVivas.direccionDe(tP.id, telPg); await require('../lib/seb/acciones.js').registrar({ tenant_id: tP.id, chat_id: dP.chat_id, delegacion_id: dP.delegacion_id, tipo: 'programado', ref_id: r.id, meta: { cuando_ts: Number(req.body.cuando_ts) }, actor: 'vendedor', sesion_id: SES ? SES.sid : null }); } catch (e) { } }
            return res.status(r.ok ? 200 : 400).json(r);
        }
        if (action === 'prog_cancelar' && req.method === 'POST') {
            const prog = require('../lib/seb/programados.js');
            // POR UNIVERSO (2026-09-10): solo cancela un programado de SU universo (VEND_PARAM → tenant; sin él = 0)
            const tPc = VEND_PARAM ? await tenantDeParam(VEND_PARAM) : { id: 0 };
            if (!tPc) return res.status(404).json({ ok: false, error: 'vendedor no dado de alta' });
            return res.status(200).json(await prog.cancelar(req.body.id, tPc.id));
        }
        if (action === 'prog_machote') {
            // prellenado del popup: nombre + auto en foco → machote editable
            const telM2 = String(req.query.telefono || '').replace(/\D/g, '');
            if (!telM2) return res.status(400).json({ ok: false, error: 'telefono' });
            const resc = require('../lib/seb/rescate.js');
            const telFull = telM2.length === 10 ? '521' + telM2 : telM2;
            const ctx = await resc.ctxDe(telFull, 1, Date.now()).catch(() => ({}));
            let nombre = ctx && ctx.nombre;
            if (!nombre) { try { const cv = await query("SELECT nombre FROM conversaciones WHERE channel_thread_id=?", ['whatsapp:' + telFull]); nombre = cv.length ? cv[0].nombre : null; } catch (e) { } }
            const saludo = (() => { const h = new Date(Date.now() - 6 * 3600000).getUTCHours(); return h < 12 ? 'buen día' : (h < 19 ? 'buenas tardes' : 'buenas noches'); })();
            const auto = ctx && ctx.auto && ctx.auto.nombre;
            const texto = 'Hola' + (nombre ? ' ' + nombre : '') + ', ' + saludo + '!\n' +
                (auto ? ('¿Qué has pensado del ' + auto + '? ¿Sí te vas a animar? 👍') : '¿Qué has pensado? ¿Seguimos en pie? 👍');
            return res.status(200).json({ ok: true, nombre: nombre || '', auto: auto || '', foto: (ctx && ctx.foto) || null, texto });
        }
        if (action === 'rescate_cancelar' && req.method === 'POST') {
            const idR = Number(req.body.id || 0);
            if (!idR) return res.status(400).json({ ok: false, error: 'id requerido' });
            await run("UPDATE rescates SET estado='cerrado', motivo_cierre='cancelado por el owner', updated=? WHERE id=?", [Date.now(), idR]);
            await require('../lib/seb/timbre.js').tocar({ entidad: 'rescate', id: idR, accion: 'cancelado' });
            return res.status(200).json({ ok: true });
        }
        if (action === 'rescate_reactivar' && req.method === 'POST') {
            const idR = Number(req.body.id || 0);
            if (!idR) return res.status(400).json({ ok: false, error: 'id requerido' });
            const rowR = await query("SELECT proxima_ts FROM rescates WHERE id=?", [idR]);
            if (!rowR.length) return res.status(404).json({ ok: false, error: 'no existe' });
            let prox = Number(rowR[0].proxima_ts) || 0;
            if (prox < Date.now()) prox = Date.now() + 60 * 60000;   // ya pasó → reloj fresco de 60 min
            await run("UPDATE rescates SET estado='vivo', motivo_cierre='', proxima_ts=?, updated=? WHERE id=?", [prox, Date.now(), idR]);
            await require('../lib/seb/timbre.js').tocar({ entidad: 'rescate', id: idR, accion: 'reactivado' });
            return res.status(200).json({ ok: true, proxima_ts: prox });
        }
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
                        // 🚫 CANDADO COMPRADOR (2026-07-22, caso 3223506761: clic de anuncio
                        // + pantallazo despertó a Ignacio como si fuera vendedor). Si este
                        // contacto viene de un ANUNCIO o sus mensajes suenan a COMPRADOR,
                        // la foto JAMÁS despierta a Ignacio — es imagen de comprador.
                        if (activa) {
                            const adR = await query("SELECT 1 FROM ad_por_telefono WHERE telefono=?", [tR]).catch(() => []);
                            let compradorTxt = false; let insR = [];
                            if (cvR.length) {
                                insR = await query("SELECT texto FROM mensajes WHERE conversacion_id=? AND direccion='in' ORDER BY id DESC LIMIT 5", [cvR[0].id]).catch(() => []);
                                const blob = insR.map(x => String(x.texto || '')).join(' ').toLowerCase();
                                compradorTxt = /(fb\.me\/|instagram\.com|wa\.me\/|me interesa (un|el|este) auto|me interesa un auto|informaci[oó]n para comprar|quiero comprar|busco (un|una) (auto|carro|camioneta)|precio de[l]? )/.test(blob);
                            }
                            if (adR.length || compradorTxt) activa = false;
                            // ⚖️ JUEZ DE ROL (owner 2026-07-22): respaldo IA del candado.
                            // Si el determinista no vio señal pero hay TEXTO, el juez razona
                            // el rol; SOLO 'comprador' frena a Ignacio (vendedor/duda pasan).
                            if (activa && insR.length) {
                                try {
                                    const { juezRol } = require('../lib/seb/juez.js');
                                    const jR = await juezRol({ mensajes: insR.map(x => x.texto) });
                                    if (jR && jR.rol === 'comprador') activa = false;
                                } catch (e) { }
                            }
                        }
                    }
                } catch (e) { }
            }
            return res.status(200).json({ ok: true, activa });
        }
        // Foto del VENDEDOR (ya subida al Blob por el puente) → pool de su sesión.
        // Silencio por foto (no spamear); solo al COMPLETAR el checklist se contesta.
        if (action === 'recepcion_foto' && req.method === 'POST') {
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
            const { pieza } = require('../lib/seb/carga-lote.js');
            const rp = await pieza({ remitente: req.body.remitente, tipo: req.body.tipo, texto: req.body.texto, url: req.body.url });
            return res.status(200).json(rp || { ok: false });
        }

        // ══════════════════════════════════════════════════════════════════════════════════════════════════════
        // FYRACHAT v2 — ENDPOINTS DEL CONTRATO (docs/fyrachat-v2-contrato-2026-09-10.md). Clase SESIÓN (regla única arriba).
        // Identidad: chat_id = conversaciones.id DEL universo de la sesión (VEND_PARAM ya viene blindado). La UI manda
        // chat_id + clave; aquí se resuelve DE NUEVO (universo → chat → teléfono → auto en foco → delegación) antes de ejecutar.
        // ══════════════════════════════════════════════════════════════════════════════════════════════════════
        const V2 = new Set(['inbox', 'hilo', 'enviar', 'foco', 'delegar_v2', 'cotizar_v2', 'cita_v2', 'bot_estado', 'reactivar', 'soltar_v2', 'autos_mios', 'foto_subir', 'auto_subir',
            'accion_v2', 'recordatorio_v2', 'recordatorios_mios', 'recordatorio_cancelar_v2', 'citas_mias']);   // huecos del front (2026-09-12)
        if (V2.has(action)) {
            const tV = VEND_PARAM ? await tenantDeParam(VEND_PARAM) : await tenantDeParam('');
            if (!tV) return res.status(404).json({ ok: false, error: 'vendedor no dado de alta' });
            const TV = Number(tV.id) || 0;
            const SID = SES ? SES.sid : null;
            const WEB_URL = process.env.FYRADRIVE_WEB_URL || 'https://www.fyradrive.com';
            const err = (status, error, extra) => res.status(status).json(Object.assign({ ok: false, error }, extra || {}));
            const okJ = (o) => res.status(200).json(Object.assign({ ok: true }, o || {}));
            // contrato (2026-09-12): `enviado` = el TEXTO enviado (string) cuando existe; si no, booleano
            const enviadoDe = o => (o && o.ok) ? (o.texto_enviado ? String(o.texto_enviado) : true) : false;
            const codigoDe = (r) => (r && r.status && r.status >= 400) ? r.status : (r && r.ok === false ? 400 : 200);
            // el chat DEL universo por id (1 lectura); null → 404
            const chatDelUniverso = async (chatId) => { const c = await U.chatPorId(Number(chatId) || 0); return (c && (Number(c.tenant_id) || 0) === TV) ? c : null; };
            const nombreAuto = a => [a.marca, a.modelo, a.anio].filter(Boolean).join(' ');
            const nombreDe = c => (c.nombre && c.nombre !== '.') ? String(c.nombre) : ('+' + String(c.telefono).slice(0, 3) + ' ' + String(c.telefono).slice(-10));
            const iniDe = nombre => { const n = String(nombre || '').trim(); if (!n || n === '.') return '#'; const p = n.split(/\s+/).filter(Boolean); const s = ((p[0] || '')[0] || '') + ((p[1] || '')[0] || ''); return s.toUpperCase() || '#'; };
            const ghostDias = c => (c.ult_dir === 'out' && Number(c.ult_msg_ts)) ? Math.max(0, Math.floor((Date.now() - Number(c.ult_msg_ts)) / 86400000)) : null;
            const botInbox = c => TV ? 'n/a' : ((c.canal === 'owner' || c.canal === 'messenger') ? 'humano' : 'seb');
            const ph = arr => arr.map(() => '?').join(',');
            // portada por web_id (1 lectura): principal, o la primera por orden
            async function portadasDe(webIds) {
                const ids = [...new Set((webIds || []).map(Number).filter(Boolean))];
                const out = {};
                if (!ids.length) return out;
                const rows = await query(`SELECT auto_id, url_imagen, es_principal, orden_imagen FROM imagenes_autos WHERE auto_id IN (${ph(ids)}) AND url_imagen IS NOT NULL AND (es_principal=1 OR COALESCE(orden_imagen,0)<=1)`, ids).catch(() => []);
                const best = {};
                for (const r of rows) { const k = Number(r.auto_id); if (!best[k] || (Number(r.es_principal) && !best[k].principal)) best[k] = { url: r.url_imagen, principal: !!Number(r.es_principal) }; }
                for (const k of Object.keys(best)) out[k] = best[k].url;
                return out;
            }
            // autos por id o por web_id (los focos históricos traen cualquiera de los dos) → 1 lectura
            async function autosPorFoco(focoIds) {
                const ids = [...new Set((focoIds || []).map(Number).filter(Boolean))];
                const porWeb = {}, porId = {};
                if (!ids.length) return { porWeb, porId };
                const rows = await query(`SELECT id, fyradrive_web_id, marca, modelo, anio, precio FROM inventario_autos WHERE id IN (${ph(ids)}) OR fyradrive_web_id IN (${ph(ids)})`, ids.concat(ids)).catch(() => []);
                for (const r of rows) { porId[Number(r.id)] = r; if (r.fyradrive_web_id != null) porWeb[Number(r.fyradrive_web_id)] = r; }
                return { porWeb, porId };
            }
            const autoJson = (a, portadas) => a ? { id: Number(a.id), web_id: a.fyradrive_web_id == null ? null : Number(a.fyradrive_web_id), nombre: nombreAuto(a), precio: a.precio == null ? null : Number(a.precio), portada: (portadas && a.fyradrive_web_id != null && portadas[Number(a.fyradrive_web_id)]) || null } : null;
            // media normalizado a partir de las columnas actuales de `mensajes` (tipo + texto)
            function mediaDe(m) {
                const tipo = String(m.tipo || 'text'), tx = String(m.texto || '');
                const url = (tx.match(/https?:\/\/\S+/) || [])[0] || null;
                if (tipo === 'image') { const ub = tx.match(/^ubic-img:(\d+)/); return { tipo: 'imagen', url: url || (ub ? '/api/seb-panel?action=ubic_img&auto_id=' + ub[1] : null) }; }
                if (tipo === 'location') {
                    const p = tx.split('|||'); const lat = Number(p[1]), lng = Number(p[2]);
                    const hay = p.length >= 3 && isFinite(lat) && isFinite(lng) && String(p[1]).trim() !== '';
                    return { tipo: 'ubicacion', url: (p[3] && /^https?:/.test(p[3])) ? p[3] : (hay ? 'https://maps.google.com/?q=' + lat + ',' + lng : null), nombre: hay ? (p[0] || null) : null, lat: hay ? lat : null, lng: hay ? lng : null };
                }
                if (tipo === 'audio') return { tipo: 'audio', url };
                if (tipo === 'video' || tipo === 'document' || tipo === 'sticker' || tipo === 'contact') return { tipo, url };
                return null;
            }
            const textoDe = m => { const tipo = String(m.tipo || 'text'), tx = String(m.texto || ''); if (tipo === 'location') { const p = tx.split('|||'); return p.length >= 3 ? ('[ubicación]' + (p[0] ? ' ' + p[0] : '')) : (tx || '[ubicación]'); } if (tipo === 'image' && /^ubic-img:/.test(tx)) return '[captura del punto]'; return tx; };
            const mensajeJson = m => ({ id: Number(m.id), msg_id: m.msg_id, dir: m.direccion === 'out' ? 'out' : 'in', emisor: MSJ.emisorNorm(m.direccion, m.emisor, m.ai_generated), texto: textoDe(m), ts: Number(m.ts), media: mediaDe(m), estado: 'enviado' });
            // ESTADO DEL BOT en t0 (mecanismos REALES, deterministas): canal 'owner'/'messenger' = humano (bot mudo); último manual del
            // owner = "déjame confirmo" (<7 d) = pausado (STANDBY, doctrina.esStandby); posesión de etapa 3 (doctrina.posesionOwner) = humano.
            // Se evalúa sobre la página cargada del hilo (últimos N mensajes): standby exacto; posesión aproximada si el hilo es más largo.
            function botEstadoT0(c, msgsAsc) {
                if (c.canal === 'owner' || c.canal === 'messenger') return 'humano';
                try {
                    const { esStandby, posesionOwner } = require('../lib/seb/doctrina.js');
                    const outsMan = msgsAsc.filter(m => m.direccion === 'out' && !Number(m.ai_generated) && m.emisor !== 'sistema');
                    const ult = outsMan[outsMan.length - 1];
                    if (ult && esStandby(String(ult.texto || '')) && Date.now() - Number(ult.ts) < 7 * 86400000) return 'pausado';
                    if (posesionOwner(msgsAsc.map(m => ({ direccion: m.direccion, ai: Number(m.ai_generated) || 0, ts: Number(m.ts), mensaje: m.texto })), [])) return 'humano';
                } catch (e) { }
                return 'seb';
            }

            // 1) INBOX — paginado por cursor (ult_ts, ms), búsqueda en servidor, filtros reales. Cada fila = SOLO datos de ESA conversación.
            if (action === 'inbox') {
                const q = String(req.query.q || '').trim();
                const filtro = ['todos', 'sugerencia', 'compradores'].includes(String(req.query.filtro)) ? String(req.query.filtro) : 'todos';
                const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
                const cursor = Number(req.query.cursor) || 0;
                const SOBRA = 40;   // se leen de más para poder filtrar dueños en JS sin romper la paginación
                const duenos = TV ? new Set() : await telefonosDueno();
                const COLS = 'id, channel_thread_id, telefono, nombre, ult_texto, ult_dir, ult_msg_ts, no_leidos, is_dueno_chat, auto_id_activo, canal, estado_bot';
                let rows;
                if (filtro === 'sugerencia') {
                    // sugerencia = seb_queue pendiente (solo existe en t0; índice (estado, telefono))
                    if (TV) rows = [];
                    else {
                        const pend = await query("SELECT DISTINCT telefono FROM seb_queue WHERE estado='pendiente' LIMIT 200");
                        const tels = pend.map(p => String(p.telefono)).filter(Boolean);
                        rows = tels.length ? await query(`SELECT ${COLS} FROM conversaciones WHERE COALESCE(tenant_id,0)=0 AND telefono IN (${ph(tels)}) AND ult_msg_ts IS NOT NULL ORDER BY ult_msg_ts DESC LIMIT ?`, tels.concat([limit + SOBRA])) : [];
                    }
                } else {
                    const w = ['COALESCE(tenant_id,0)=?', "source='whatsapp'", 'ult_msg_ts IS NOT NULL'], a = [TV];
                    if (cursor) { w.push('ult_msg_ts < ?'); a.push(cursor); }
                    if (q) {
                        const d = q.replace(/\D/g, '');
                        if (d.length >= 4 && d.length === q.replace(/[\s+\-().]/g, '').length) { w.push('telefono LIKE ?'); a.push('%' + d.slice(-10)); }
                        else { w.push('nombre LIKE ? COLLATE NOCASE'); a.push('%' + q + '%'); }
                    }
                    rows = await query(`SELECT ${COLS} FROM conversaciones WHERE ${w.join(' AND ')} ORDER BY ult_msg_ts DESC LIMIT ?`, a.concat([limit + SOBRA]));
                }
                // ══ CITAS ARRIBA (orden owner 2026-09-12): los chats con cita próxima van SIEMPRE hasta arriba (verde + cronómetro + auto).
                // Solo en la primera página y sin búsqueda; se leen aparte para que no dependan de la paginación por último mensaje.
                const nowC = Date.now();
                const citaMap = {};
                const fijados = [];
                if (!cursor && !q && filtro !== 'sugerencia') {
                    const proximas = await query(`SELECT m.chat_id, MIN(m.cita_ts) cita_ts FROM citas_match m
                                                  WHERE COALESCE(m.tenant_id,0) = ? AND m.cita_ts >= ? AND m.estado NOT IN ('reemplazada','cancelada','rechazo','vencida','realizada')
                                                  GROUP BY m.chat_id ORDER BY cita_ts ASC LIMIT 30`, [TV, nowC - 3 * 3600000]).catch(() => []);
                    const idsC = proximas.map(r => Number(r.chat_id)).filter(Boolean);
                    if (idsC.length) {
                        const det = await query(`SELECT chat_id, cita_ts, auto_nombre, estado, comprador_nombre FROM citas_match WHERE chat_id IN (${ph(idsC)}) AND cita_ts >= ? AND estado NOT IN ('reemplazada','cancelada','rechazo','vencida','realizada') ORDER BY cita_ts ASC`, idsC.concat([nowC - 3 * 3600000])).catch(() => []);
                        for (const d of det) if (!citaMap[Number(d.chat_id)]) citaMap[Number(d.chat_id)] = { cita_ts: Number(d.cita_ts), auto: d.auto_nombre || null, estado: d.estado === 'match' ? 'confirmada' : 'match' };
                        const filasC = await query(`SELECT ${COLS} FROM conversaciones WHERE id IN (${ph(idsC)}) AND COALESCE(tenant_id,0) = ?`, idsC.concat([TV])).catch(() => []);
                        const porId = {}; for (const f of filasC) porId[Number(f.id)] = f;
                        for (const id of idsC) if (porId[id]) fijados.push(porId[id]);
                    }
                }
                const fijadosIds = new Set(fijados.map(f => Number(f.id)));
                const lista = fijados.slice(); let consumidas = 0;
                for (const c of rows) {
                    if (lista.length >= limit + fijados.length) break;
                    consumidas++;
                    if (fijadosIds.has(Number(c.id))) continue;
                    const tel10 = String(c.telefono || '').replace(/\D/g, '').slice(-10);
                    const esDueno = Number(c.is_dueno_chat) === 1 || (!TV && duenos.has(tel10));
                    if (esDueno && (filtro === 'compradores' || filtro === 'sugerencia')) continue;
                    lista.push(c);
                }
                const hayMas = filtro !== 'sugerencia' && (consumidas < rows.length || rows.length >= limit + SOBRA);
                const cursor_next = hayMas ? Number((lista.length ? lista[lista.length - 1] : rows[consumidas - 1]).ult_msg_ts) || null : null;
                // lotes: sugerencias pendientes (t0), delegación activa, auto en foco, portadas — 4 lecturas por índice
                const telsL = [...new Set(lista.map(c => String(c.telefono)))];
                const pendMap = {};
                if (!TV && telsL.length) for (const p of await query(`SELECT telefono, COUNT(*) n FROM seb_queue WHERE estado='pendiente' AND telefono IN (${ph(telsL)}) GROUP BY telefono`, telsL).catch(() => [])) pendMap[String(p.telefono)] = Number(p.n);
                const ids = lista.map(c => Number(c.id));
                const delegMap = {};
                if (ids.length) for (const d of await query(`SELECT id, chat_id, auto_id, auto_nombre FROM delegaciones WHERE hasta IS NULL AND chat_id IN (${ph(ids)})`, ids).catch(() => [])) delegMap[Number(d.chat_id)] = d;
                const focoDeFila = c => TV ? (delegMap[Number(c.id)] ? delegMap[Number(c.id)].auto_id : null) : c.auto_id_activo;
                const { porWeb, porId } = await autosPorFoco(lista.map(focoDeFila).filter(Boolean));
                const resolverAuto = fid => fid ? (porWeb[Number(fid)] || porId[Number(fid)] || null) : null;
                const portadas = await portadasDe(Object.values(porId).map(a => a.fyradrive_web_id));
                const chats = lista.map(c => {
                    const d = delegMap[Number(c.id)] || null;
                    const a = resolverAuto(focoDeFila(c));
                    return {
                        chat_id: Number(c.id), telefono: String(c.telefono), nombre: nombreDe(c), ini: iniDe(c.nombre),
                        ult_texto: String(c.ult_texto || '').slice(0, 120), ult_dir: c.ult_dir === 'out' ? 'out' : 'in',
                        ult_emisor: c.ult_dir === 'out' ? (TV ? 'dueno' : 'bot') : 'comprador',   // heurística de portada (el hilo trae el emisor exacto por mensaje)
                        ult_ts: Number(c.ult_msg_ts) || 0, no_leidos: Number(c.no_leidos) || 0,
                        sugerencia: !!pendMap[String(c.telefono)], delegado: !!d,
                        auto: a ? autoJson(a, portadas) : (d && d.auto_nombre ? { id: d.auto_id == null ? null : Number(d.auto_id), web_id: null, nombre: d.auto_nombre, precio: null, portada: null } : null),
                        bot: botInbox(c), ghost_dias: ghostDias(c),
                        cita: citaMap[Number(c.id)] || null   // { cita_ts, auto, estado } → fila verde, arriba, con cronómetro
                    };
                });
                return okJ({ chats, cursor_next, filtro, q, tenant_id: TV });
            }

            // 2) HILO — paginación antes/limit; marca leído sin `antes`; emisor y media normalizados
            if (action === 'hilo') {
                const c = await chatDelUniverso(req.query.chat_id); if (!c) return err(404, 'chat inexistente en este universo');
                const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 200);
                const antes = Number(req.query.antes) || 0;
                const desde = Number(req.query.desde) || 0;   // solo lo NUEVO (ts > desde), en orden ascendente; para refrescar un hilo abierto
                const SEL = 'SELECT id, msg_id, direccion, emisor, texto, ts, tipo, ai_generated FROM mensajes WHERE conversacion_id=?';
                const rowsM = antes
                    ? await query(SEL + ' AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?', [c.id, antes, limit + 1])
                    : (desde
                        ? await query(SEL + ' AND ts > ? ORDER BY ts ASC, id ASC LIMIT ?', [c.id, desde, limit + 1])
                        : await query(SEL + ' ORDER BY ts DESC, id DESC LIMIT ?', [c.id, limit + 1]));
                const hay_mas = rowsM.length > limit;
                const asc = desde ? rowsM.slice(0, limit) : rowsM.slice(0, limit).reverse();
                // chatPorId no trae no_leidos (COLS_CHAT): 1 lectura chica para reportarlo y, sin `antes`, 1 UPDATE condicionado (marca leído)
                const nlRow = (await query('SELECT no_leidos FROM conversaciones WHERE id=?', [c.id]).catch(() => []))[0];
                const noLeidosAntes = Number(nlRow && nlRow.no_leidos) || 0;
                if (!antes && noLeidosAntes) await run('UPDATE conversaciones SET no_leidos=0 WHERE id=? AND COALESCE(no_leidos,0)>0', [c.id]).catch(() => { });   // con `antes` (historial) NO se marca leído
                const focoH = await focoDe(tV, c.telefono).catch(() => null);
                const cat = await autosDeTenant(tV);
                const portadasH = await portadasDe(cat.slice(0, 200).map(a => a.fyradrive_web_id).concat(focoH && focoH.web_id ? [focoH.web_id] : []));
                const deleg = await U.delegacionActiva(c.id).catch(() => null);
                return okJ({
                    chat: {
                        chat_id: Number(c.id), telefono: String(c.telefono), nombre: nombreDe(c), ini: iniDe(c.nombre),
                        auto: focoH ? { id: Number(focoH.id), web_id: focoH.web_id == null ? null : Number(focoH.web_id), nombre: focoH.nombre, precio: focoH.precio == null ? null : Number(focoH.precio), portada: (focoH.web_id && portadasH[Number(focoH.web_id)]) || null } : null,
                        autos_disponibles: cat.slice(0, 200).map(a => autoJson(a, portadasH)),
                        bot: TV ? 'n/a' : botEstadoT0(c, antes ? [] : asc), delegado: !!deleg,
                        ghost_dias: ghostDias(c), no_leidos: antes ? noLeidosAntes : 0, canal: c.canal || null
                    },
                    mensajes: asc.map(mensajeJson), hay_mas, desde: desde || undefined, antes: antes || undefined
                });
            }

            // 3) ENVIAR — texto manual del vendedor/owner por la PUERTA (clave de la UI = idempotencia)
            if (action === 'enviar' && req.method === 'POST') {
                const c = await chatDelUniverso(req.body.chat_id); if (!c) return err(404, 'chat inexistente en este universo');
                const texto = String(req.body.texto || '').trim(); if (!texto) return err(400, 'texto vacío');
                const clave = String(req.body.clave || '').trim(); if (!clave) return err(400, 'clave requerida');
                if (!TV) { try { await citasVivas.senalManual(c.telefono, texto); } catch (e) { console.error('[senalManual v2]', e.message); } }   // "cita confirmada/cancelada" en el chat del dueño (t0)
                const env = await MSJ.enviar({ tenantId: TV, chatId: c.id, origen: 'manual', clave, texto, manual: true, sesionId: SID, accion: 'manual' });
                if (!env.ok) return res.status(env.status && env.status >= 400 ? env.status : 502).json({ ok: false, error: env.error || 'no se pudo mandar', chat_id: Number(c.id), clave, en_vuelo: !!env.en_vuelo });
                return okJ({ mensaje: env.mensaje, chat_id: Number(c.id), clave, simulado: !!env.simulado, repetido: !!env.repetido });
            }

            // 4) FOCO — auto en foco del chat (valida catálogo del universo)
            if (action === 'foco' && req.method === 'POST') {
                const c = await chatDelUniverso(req.body.chat_id); if (!c) return err(404, 'chat inexistente en este universo');
                const idF = Number(req.body.auto_id) || 0; if (!idF) return err(400, 'auto_id requerido', { necesita: 'auto' });
                const cat = await autosDeTenant(tV);
                const inv = cat.find(a => Number(a.id) === idF || Number(a.fyradrive_web_id) === idF);
                if (!inv) return err(403, 'ese auto no está habilitado para este universo');
                const deleg = await U.delegacionActiva(c.id).catch(() => null);
                if (TV && !deleg) return err(409, 'chat no delegado en este universo');
                await ponerFoco(tV, c.telefono, inv);
                await ACCIONES.registrar({ tenant_id: TV, chat_id: Number(c.id), delegacion_id: deleg ? Number(deleg.id) : null, tipo: 'foco_cambiado', ref_id: inv.id, meta: { auto: nombreAuto(inv) }, actor: 'vendedor', sesion_id: SID });
                const portadas = await portadasDe([inv.fyradrive_web_id]);
                return okJ({ auto: autoJson(inv, portadas), chat_id: Number(c.id) });
            }

            // 5) DELEGAR v2 — envuelve delegarCore (puente + ejecutarAccion) con clave idempotente
            if (action === 'delegar_v2' && req.method === 'POST') {
                const clave = String(req.body.clave || '').trim(); if (!clave) return err(400, 'clave requerida');
                const E = (req.body.entrada && typeof req.body.entrada === 'object') ? req.body.entrada : {};
                const body = { telefono: req.body.telefono, nombre: req.body.nombre, auto_id: req.body.auto_id, modo_entrada: E.modo || 'silencio', opener_texto: E.texto, enganche: E.enganche, plazo_meses: E.plazo, fecha_iso: E.fecha_iso, hora: E.hora };
                const r = await MSJ.conClave(clave, { tenantId: TV, accion: 'delegar_v2', sesionId: SID }, async () => {
                    const rD = await delegarCore(tV, body, { sesionId: SID, clave });
                    const o = rD.out || {};
                    const okD = rD.status < 400 && o.ok !== false;
                    // enviado = el TEXTO que salió (opener o texto de la acción); true si salió algo sin texto (fotos); false si nada
                    const envD = !okD ? false : (o.texto_enviado ? String(o.texto_enviado) : (o.opener_enviado && o.opener ? String(o.opener) : (o.accion_ok ? true : false)));
                    return { ok: okD, status: rD.status, chat_id: o.chat_id || null, telefono: o.telefono || null, nombre: o.nombre || null, auto: o.auto || null, modo: o.modo || null, ya_delegado: !!o.ya_delegado, opener_enviado: !!o.opener_enviado, accion_ejecutada: o.accion_ejecutada || null, enviado: envD, detalle: o.enviado != null ? o.enviado : (o.opener_enviado ? 'opener' : null), simulado: !!o.simulado, error: o.error || undefined, necesita: o.necesita || undefined };
                });
                return res.status(codigoDe(r)).json(r);
            }

            // 6) COTIZAR v2 — ejecutarAccion 'cotizar' con el auto en foco del chat
            if (action === 'cotizar_v2' && req.method === 'POST') {
                const c = await chatDelUniverso(req.body.chat_id); if (!c) return err(404, 'chat inexistente en este universo');
                const clave = String(req.body.clave || '').trim(); if (!clave) return err(400, 'clave requerida');
                const eng = Number(String(req.body.enganche == null ? '' : req.body.enganche).replace(/[^0-9.]/g, ''));
                if (!(eng > 0)) return err(400, 'para cotizar hace falta el enganche', { necesita: 'enganche' });
                const plazo = [36, 48, 60].includes(Number(req.body.plazo)) ? Number(req.body.plazo) : undefined;
                const r = await MSJ.conClave(clave, { tenantId: TV, chatId: c.id, accion: 'cotizar_v2', sesionId: SID }, async () => {
                    const rA = await ejecutarAccion(tV, c.telefono, 'cotizar', { enganche: eng, plazo_meses: plazo, clave, via: 'v2' });
                    const o = rA.out || {};
                    return { ok: !!o.ok, status: rA.status, chat_id: Number(c.id), texto_tarjeta: o.tarjeta || null, enviado: enviadoDe(o), detalle: o.ok ? (o.enviado || 'cotización') : null, simulado: !!o.simulado, auto: o.auto || null, msg_id: o.msg_id || null, error: o.error || undefined, necesita: o.necesita === 'datos' ? 'enganche' : (o.necesita === 'foco' ? 'auto' : (o.necesita || undefined)) };
                });
                return res.status(codigoDe(r)).json(r);
            }

            // 6b) ACCION v2 — fotos | ubicacion | info con el auto en foco del chat (misma puerta que los botones: ejecutarAccion → mensajeria)
            if (action === 'accion_v2' && req.method === 'POST') {
                const c = await chatDelUniverso(req.body.chat_id); if (!c) return err(404, 'chat inexistente en este universo');
                const clave = String(req.body.clave || '').trim(); if (!clave) return err(400, 'clave requerida');
                const acc = String(req.body.accion || '');
                if (!['fotos', 'ubicacion', 'info', 'cita_propuesta', 'primer_mensaje'].includes(acc)) return err(400, "accion debe ser 'fotos' | 'ubicacion' | 'info' | 'cita_propuesta' | 'primer_mensaje'");
                const r = await MSJ.conClave(clave, { tenantId: TV, chatId: c.id, accion: 'accion_v2:' + acc, sesionId: SID }, async () => {
                    const rA = await ejecutarAccion(tV, c.telefono, acc, { clave, via: 'v2', comprador_nombre: c.nombre || '' });
                    const o = rA.out || {};
                    return { ok: !!o.ok, status: rA.status, chat_id: Number(c.id), accion: acc, enviado: enviadoDe(o), detalle: o.ok ? (o.enviado || acc) : null, fotos: o.fotos || undefined, simulado: !!o.simulado, auto: o.auto || null, msg_id: o.msg_id || null, error: o.error || undefined, necesita: o.necesita === 'foco' ? 'auto' : (o.necesita || undefined) };
                });
                return res.status(codigoDe(r)).json(r);
            }

            // 6c) RECORDATORIO v2 — "te aviso" manual: crea la INTENCIÓN (mensajes_programados) que sale por la puerta en su momento
            //     (programados.despachar). Tope: 2 pendientes por cliente y universo (programados.crear). También en el universo demo (se simula al salir).
            if (action === 'recordatorio_v2' && req.method === 'POST') {
                const c = await chatDelUniverso(req.body.chat_id); if (!c) return err(404, 'chat inexistente en este universo');
                const clave = String(req.body.clave || '').trim(); if (!clave) return err(400, 'clave requerida');
                const texto = String(req.body.texto || '').trim(); if (!texto) return err(400, 'texto vacío', { campo: 'texto' });
                const cuRaw = Number(req.body.cuando_ts) || 0; const cuando = cuRaw > 1e12 ? cuRaw : cuRaw * 1000;
                if (!cuando || cuando < Date.now() - 60000) return err(400, 'cuando_ts debe ser una hora futura', { campo: 'cuando_ts' });
                const r = await MSJ.conClave(clave, { tenantId: TV, chatId: c.id, accion: 'recordatorio_v2', sesionId: SID }, async () => {
                    const prog = require('../lib/seb/programados.js');
                    let nombreR = (c.nombre && c.nombre !== '.') ? c.nombre : null;
                    try { if (nombreR) nombreR = require('../lib/seb/opener.js').nombreReal(nombreR) || nombreR; } catch (e) { }
                    const rp = await prog.crear({ tel: c.telefono, nombre: nombreR, texto, cuandoTs: cuando, conFoto: !TV && req.body.con_foto === true, tenantId: TV });
                    if (!rp.ok) return { ok: false, status: 409, error: rp.error, tope: rp.tope || undefined };
                    const deleg = await U.delegacionActiva(c.id).catch(() => null);
                    await ACCIONES.registrar({ tenant_id: TV, chat_id: Number(c.id), delegacion_id: deleg ? Number(deleg.id) : null, tipo: 'programado', ref_id: rp.id, meta: { cuando_ts: cuando, v2: true }, actor: 'vendedor', sesion_id: SID });
                    return { ok: true, id: rp.id, chat_id: Number(c.id), cuando_ts: cuando, texto };
                });
                return res.status(codigoDe(r)).json(r);
            }
            if (action === 'recordatorios_mios') {
                const c = await chatDelUniverso(req.query.chat_id); if (!c) return err(404, 'chat inexistente en este universo');
                const rows = await query("SELECT id, texto, cuando_ts, estado, con_foto, intentos, ultimo_error, enviado_ts FROM mensajes_programados WHERE telefono=? AND COALESCE(tenant_id,0)=? AND (estado='pendiente' OR cuando_ts > ?) ORDER BY cuando_ts ASC LIMIT 50", [U.tel12(c.telefono), TV, Date.now() - 48 * 3600000]).catch(() => []);
                return okJ({ chat_id: Number(c.id), recordatorios: rows.map(r => ({ id: Number(r.id), cuando_ts: Number(r.cuando_ts), texto: r.texto, estado: r.estado, con_foto: !!Number(r.con_foto), intentos: Number(r.intentos) || 0, error: r.ultimo_error || null, enviado_ts: r.enviado_ts == null ? null : Number(r.enviado_ts) })), pendientes: rows.filter(r => r.estado === 'pendiente').length, tope: 2 });
            }
            if (action === 'recordatorio_cancelar_v2' && req.method === 'POST') {
                const idR = Number(req.body.id) || 0; if (!idR) return err(400, 'id requerido');
                const rC = await require('../lib/seb/programados.js').cancelar(idR, TV);   // acotado al universo de la sesión
                return res.status(rC.ok ? 200 : 400).json(rC);
            }

            // 6d) CITAS MÍAS — las citas del universo (citas_match = la máquina; citas = el CRM; cita_casillas = recordatorios). 2 consultas.
            //     estado=proximas (default): cita_ts ≥ ahora − 3 h · pasadas: cita_ts < ahora. Estados: match (en trámite) | confirmada |
            //     realizada | cancelada | pasada. Las 'reemplazada' (movidas) no se listan.
            if (action === 'citas_mias') {
                const est = String(req.query.estado || 'proximas') === 'pasadas' ? 'pasadas' : 'proximas';
                const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
                const now = Date.now();
                const condTs = est === 'pasadas' ? 'm.cita_ts < ?' : 'm.cita_ts >= ?';
                const argTs = est === 'pasadas' ? now : now - 3 * 3600000;
                // 1) máquina + CRM (misma dirección y misma fecha-hora local) + auto + portada, en UNA lectura
                const rowsC = await query(`SELECT m.id, m.cita_ts, m.fecha, m.hora, m.estado, m.chat_id, m.comprador_tel, m.comprador_nombre, m.auto_id, m.auto_nombre, m.updated,
                        c.id AS cita_id, c.estado AS cita_estado, c.resultado, c.fecha AS cita_fecha, c.hora AS cita_hora,
                        i.id AS inv_id, i.fyradrive_web_id, i.marca, i.modelo, i.anio, i.precio,
                        (SELECT url_imagen FROM imagenes_autos im WHERE im.auto_id = i.fyradrive_web_id AND im.url_imagen IS NOT NULL ORDER BY im.es_principal DESC, COALESCE(im.orden_imagen, 99) ASC LIMIT 1) AS portada,
                        cv.nombre AS chat_nombre
                    FROM citas_match m
                    LEFT JOIN citas c ON c.tenant_id = m.tenant_id AND c.chat_id = m.chat_id AND c.fecha_hora = strftime('%Y-%m-%d %H:%M:00', (m.cita_ts / 1000) - 21600, 'unixepoch') AND c.estado <> 'descartada'
                    LEFT JOIN inventario_autos i ON (i.id = m.auto_id OR i.fyradrive_web_id = m.auto_id)
                    LEFT JOIN conversaciones cv ON cv.id = m.chat_id
                    WHERE COALESCE(m.tenant_id,0) = ? AND ${condTs} AND m.estado <> 'reemplazada'
                    ORDER BY m.cita_ts ${est === 'pasadas' ? 'DESC' : 'ASC'} LIMIT ?`, [TV, argTs, limit]).catch(() => []);
                // 2) casillas de esas citas (1 lectura por índice)
                const idsM = [...new Set(rowsC.map(r => Number(r.id)))];
                const casMap = {};
                if (idsM.length) for (const k of await query(`SELECT id, cita_match_id, tipo, para, due_ts, estado, texto, enviado_ts, error FROM cita_casillas WHERE cita_match_id IN (${ph(idsM)}) ORDER BY due_ts ASC`, idsM).catch(() => [])) {
                    (casMap[Number(k.cita_match_id)] = casMap[Number(k.cita_match_id)] || []).push({ id: Number(k.id), tipo: k.tipo, para: k.para, due_ts: Number(k.due_ts), estado: k.estado, texto: k.texto, enviado_ts: k.enviado_ts == null ? null : Number(k.enviado_ts), error: k.error || null });
                }
                const vistos = new Set();
                const estadoDeCita = r => {
                    const me = String(r.estado || ''), ce = String(r.cita_estado || '').toLowerCase();
                    if (me === 'realizada' || ce === 'realizada' || r.resultado) return 'realizada';
                    if (['cancelada', 'rechazo'].includes(me) || ce === 'cancelada') return 'cancelada';
                    if (Number(r.cita_ts) < now || me === 'vencida') return 'pasada';
                    if (me === 'match') return 'confirmada';
                    return 'match';   // solicitud / contrapropuesta / esperando_horario / pausada* / escalada_manual
                };
                const fechaIso = ts => { const d = new Date(Number(ts) - 6 * 3600000); return d.toISOString().slice(0, 10); };
                const horaHm = ts => { const d = new Date(Number(ts) - 6 * 3600000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
                const citas = [];
                for (const r of rowsC) {
                    if (vistos.has(Number(r.id))) continue; vistos.add(Number(r.id));   // el LEFT JOIN a citas puede duplicar la máquina (mismo chat, misma hora)
                    citas.push({
                        id: Number(r.id), cita_id: r.cita_id == null ? null : Number(r.cita_id), cita_ts: Number(r.cita_ts), fecha: fechaIso(r.cita_ts), hora: horaHm(r.cita_ts),
                        fecha_txt: r.fecha || null, hora_txt: r.hora || null, estado: estadoDeCita(r), estado_maquina: r.estado, resultado: r.resultado || null,
                        comprador: { chat_id: r.chat_id == null ? null : Number(r.chat_id), nombre: r.comprador_nombre || ((r.chat_nombre && r.chat_nombre !== '.') ? r.chat_nombre : null), telefono: String(r.comprador_tel || '').replace(/\D/g, '') },
                        auto: (r.inv_id || r.auto_id) ? { id: r.inv_id == null ? (r.auto_id == null ? null : Number(r.auto_id)) : Number(r.inv_id), web_id: r.fyradrive_web_id == null ? null : Number(r.fyradrive_web_id), nombre: r.inv_id ? nombreAuto(r) : (r.auto_nombre || null), precio: r.precio == null ? null : Number(r.precio), portada: r.portada || null } : null,
                        recordatorios: casMap[Number(r.id)] || []
                    });
                }
                return okJ({ estado: est, citas, tenant_id: TV });
            }

            // 7) CITA v2 — ejecutarAccion 'cita' (Sales Brain cita_manual → casillas); el texto de confirmación lo manda el SB
            if (action === 'cita_v2' && req.method === 'POST') {
                const c = await chatDelUniverso(req.body.chat_id); if (!c) return err(404, 'chat inexistente en este universo');
                const clave = String(req.body.clave || '').trim(); if (!clave) return err(400, 'clave requerida');
                const fI = String(req.body.fecha_iso || ''), hI = String(req.body.hora || '');
                if (!/^\d{4}-\d{2}-\d{2}$/.test(fI) || !/^\d{1,2}:\d{2}$/.test(hI)) return err(400, 'para agendar hace falta día (YYYY-MM-DD) y hora (HH:MM)', { necesita: 'fecha_hora' });
                const r = await MSJ.conClave(clave, { tenantId: TV, chatId: c.id, accion: 'cita_v2', sesionId: SID }, async () => {
                    const rA = await ejecutarAccion(tV, c.telefono, 'cita', { fecha_iso: fI, hora: hI, comprador_nombre: (c.nombre && c.nombre !== '.') ? c.nombre : '', clave, via: 'v2' });
                    const o = rA.out || {};
                    return { ok: !!o.ok, status: rA.status, chat_id: Number(c.id), cita: o.ok ? { fecha: fI, hora: hI, auto: o.auto || null, cita_id: o.cita_id || null, cita_match_id: o.cita_match_id || null, casillas: o.casillas || undefined } : null, enviado: enviadoDe(o), detalle: o.ok ? (o.enviado || 'cita') : null, simulado: !!o.simulado, error: o.error || undefined, necesita: o.necesita === 'foco' ? 'auto' : (o.necesita || undefined) };
                });
                return res.status(codigoDe(r)).json(r);
            }

            // 8) BOT_ESTADO — t0: 'humano' = el bot NO habla en ese chat (canal 'owner': el MISMO mecanismo que hoy activa el manual del owner
            //    "soy Sebastian de facebook" / nuevo_chat → opener_auto escala y calla); 'seb' = liberar (canal NULL). El STANDBY ("déjame
            //    confirmo") y la POSESIÓN de etapa 3 siguen siendo deterministas por los mensajes manuales y se reportan en hilo.chat.bot.
            //    tenant≠0: 'n/a' (no hay cerebro en esos universos).
            if (action === 'bot_estado' && req.method === 'POST') {
                const c = await chatDelUniverso(req.body.chat_id); if (!c) return err(404, 'chat inexistente en este universo');
                if (TV) return okJ({ bot: 'n/a', chat_id: Number(c.id) });
                const est = String(req.body.estado || '');
                if (!['seb', 'humano'].includes(est)) return err(400, "estado debe ser 'seb' o 'humano'");
                await U.guardarEstado(0, c.telefono, { canal: est === 'humano' ? 'owner' : null });
                await ACCIONES.registrar({ tenant_id: 0, chat_id: Number(c.id), tipo: 'bot_' + est, meta: { canal: est === 'humano' ? 'owner' : null }, actor: 'vendedor', sesion_id: SID });
                return okJ({ bot: est, chat_id: Number(c.id) });
            }

            // 9) REACTIVAR — crea la INTENCIÓN (mensajes_programados dentro de 5 min, machote de rescate) que sale por la puerta
            //    (programados.despachar en el cron / ghost_scan). Jamás manda directo.
            if (action === 'reactivar' && req.method === 'POST') {
                const c = await chatDelUniverso(req.body.chat_id); if (!c) return err(404, 'chat inexistente en este universo');
                const clave = String(req.body.clave || '').trim(); if (!clave) return err(400, 'clave requerida');
                const r = await MSJ.conClave(clave, { tenantId: TV, chatId: c.id, accion: 'reactivar', sesionId: SID }, async () => {
                    const resc = require('../lib/seb/rescate.js'); const prog = require('../lib/seb/programados.js');
                    const ctx = TV ? {} : await resc.ctxDe(c.telefono, 1, Date.now()).catch(() => ({}));   // t0: auto en foco + portada
                    let nombre = (ctx && ctx.nombre) || null;
                    if (!nombre && c.nombre && c.nombre !== '.') { try { nombre = require('../lib/seb/opener.js').nombreReal(c.nombre) || null; } catch (e) { } }
                    let autoN = (ctx && ctx.auto && ctx.auto.nombre) || null;
                    if (TV) { const f = await focoDe(tV, c.telefono).catch(() => null); autoN = (f && f.nombre) || null; }
                    const saludo = (() => { const h = new Date(Date.now() - 6 * 3600000).getUTCHours(); return h < 12 ? 'buen día' : (h < 19 ? 'buenas tardes' : 'buenas noches'); })();
                    const texto = 'Hola' + (nombre ? ' ' + nombre : '') + ', ' + saludo + '!\n' + (autoN ? ('¿Qué has pensado del ' + autoN + '? ¿Sí te vas a animar? 👍') : '¿Qué has pensado? ¿Seguimos en pie? 👍');
                    const cuando = Date.now() + 5 * 60000;
                    const rp = await prog.crear({ tel: c.telefono, nombre, texto, cuandoTs: cuando, conFoto: !TV && !!(ctx && ctx.foto), tenantId: TV });
                    if (!rp.ok) return { ok: false, status: 409, error: rp.error, tope: rp.tope };
                    const deleg = await U.delegacionActiva(c.id).catch(() => null);
                    await ACCIONES.registrar({ tenant_id: TV, chat_id: Number(c.id), delegacion_id: deleg ? Number(deleg.id) : null, tipo: 'programado', ref_id: rp.id, meta: { cuando_ts: cuando, reactivar: true }, actor: 'vendedor', sesion_id: SID });
                    return { ok: true, chat_id: Number(c.id), programado_ts: cuando, programado_id: rp.id, texto };
                });
                return res.status(codigoDe(r)).json(r);
            }

            // 10) SOLTAR v2
            if (action === 'soltar_v2' && req.method === 'POST') {
                const c = await chatDelUniverso(req.body.chat_id); if (!c) return err(404, 'chat inexistente en este universo');
                const rS = await soltarCore(tV, c.telefono, { sesionId: SID });
                return res.status(rS.status).json(Object.assign({ chat_id: Number(c.id) }, rS.out || {}));
            }

            // 11) AUTOS_MIOS — autos del universo (t0 = inventario activo completo, límite 200) con portada, km, fotos y estado
            if (action === 'autos_mios') {
                let rows;
                if (!TV) rows = await query("SELECT id, fyradrive_web_id, marca, modelo, anio, precio, kilometraje, estado FROM inventario_autos WHERE estado='activo' ORDER BY marca COLLATE NOCASE, modelo COLLATE NOCASE LIMIT 200");
                else {
                    rows = await query(`SELECT i.id, i.fyradrive_web_id, i.marca, i.modelo, i.anio, i.precio, i.kilometraje, i.estado, au.rol
                                        FROM autos_universo au JOIN inventario_autos i ON i.id = au.inv_auto_id
                                        WHERE au.tenant_id = ? AND au.activo = 1 ORDER BY i.marca COLLATE NOCASE, i.modelo COLLATE NOCASE LIMIT 200`, [TV]).catch(() => []);
                    if (!rows.length && tV.demo) rows = await autosDeTenant(tV);   // MODO PRUEBA: 3 autos de muestra (solo lectura)
                }
                const webIds = rows.map(r => r.fyradrive_web_id).filter(Boolean).map(Number);
                const webEstado = {}, fotosN = {};
                if (webIds.length) {
                    for (const w of await query(`SELECT id, estado FROM autos WHERE id IN (${ph(webIds)})`, webIds).catch(() => [])) webEstado[Number(w.id)] = String(w.estado || '');
                    for (const f of await query(`SELECT auto_id, COUNT(*) n FROM imagenes_autos WHERE auto_id IN (${ph(webIds)}) AND url_imagen IS NOT NULL GROUP BY auto_id`, webIds).catch(() => [])) fotosN[Number(f.auto_id)] = Number(f.n);
                }
                const portadas = await portadasDe(webIds);
                const estadoDe = r => { const w = webEstado[Number(r.fyradrive_web_id)]; if (w === 'en_revision' || w === 'no_aprobado') return 'revision'; if (w === 'vendido' || r.estado === 'vendido') return 'vendido'; if (r.estado === 'activo' || w === 'activo') return 'activo'; return 'revision'; };
                return okJ({ autos: rows.map(r => ({ id: Number(r.id), web_id: r.fyradrive_web_id == null ? null : Number(r.fyradrive_web_id), nombre: nombreAuto(r), marca: r.marca, modelo: r.modelo, anio: r.anio == null ? null : Number(r.anio), precio: r.precio == null ? null : Number(r.precio), km: r.kilometraje == null ? null : Number(r.kilometraje), portada: (r.fyradrive_web_id && portadas[Number(r.fyradrive_web_id)]) || null, estado: estadoDe(r), fotos: fotosN[Number(r.fyradrive_web_id)] || 0, rol: r.rol || (TV ? null : 'comercializa') })), tenant_id: TV });
            }

            // 12) FOTO_SUBIR — reenvía al Blob de la web (upload-photo, como la carga de lote); límite 6 MB (ojo: el body de Vercel tope ~4.5 MB)
            if (action === 'foto_subir' && req.method === 'POST') {
                const b64 = String(req.body.base64 || '').replace(/^data:[^,]+,/, '').replace(/\s+/g, '');
                if (!b64) return err(400, 'base64 requerido');
                let buf; try { buf = Buffer.from(b64, 'base64'); } catch (e) { return err(400, 'base64 inválido'); }
                if (!buf.length) return err(400, 'imagen vacía');
                if (buf.length > 6 * 1024 * 1024) return err(413, 'la foto pesa más de 6 MB');
                const nombre = String(req.body.nombre || 'foto.jpg').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'foto.jpg';
                const mime = /\.png$/i.test(nombre) ? 'image/png' : (/\.webp$/i.test(nombre) ? 'image/webp' : 'image/jpeg');
                try {
                    const fd = new FormData();
                    fd.append('code', 'AUTOS LOZANO');   // mismo Blob compartido que usan el puente y la carga de lote
                    fd.append('filename', 'fyrachat-t' + TV + '-' + Date.now() + '-' + nombre);
                    fd.append('file', new Blob([buf], { type: mime }));
                    const up = await fetch(WEB_URL + '/api/agency/upload-photo', { method: 'POST', body: fd });
                    const du = await up.json().catch(() => ({}));
                    if (!(du && du.ok && du.url)) return err(502, 'no se pudo subir la foto: ' + ((du && du.error) || ('web ' + up.status)));
                    return okJ({ url: du.url, bytes: buf.length });
                } catch (e) { return err(502, 'no se pudo subir la foto: ' + e.message); }
            }

            // 13) AUTO_SUBIR — publish-batch particular (K_PANEL), dueño = teléfono del universo (t0 → el owner), ≥4 fotos, campos
            //     obligatorios con error por campo; NACE EN REVISIÓN: la web lo crea activo → se deja `autos.estado='en_revision'`
            //     (fyradmin/pending lo aprueba; el catálogo público lo oculta) y en universos ≠0 queda en autos_universo (rol dueno).
            if (action === 'auto_subir' && req.method === 'POST') {
                const clave = String(req.body.clave || '').trim(); if (!clave) return err(400, 'clave requerida');
                const B = req.body || {};
                const campos = {};
                const marca = String(B.marca || '').trim(), modelo = String(B.modelo || '').trim();
                const anio = Number(B.anio), yNow = new Date().getFullYear();
                const precio = Number(String(B.precio == null ? '' : B.precio).replace(/[^0-9.]/g, ''));
                const kmRaw = B.km == null ? '' : String(B.km).trim(); const km = Number(kmRaw.replace(/[^0-9.]/g, ''));
                if (!marca) campos.marca = 'requerido';
                if (!modelo) campos.modelo = 'requerido';
                if (!(anio >= 1990 && anio <= yNow + 1)) campos.anio = 'año inválido (1990–' + (yNow + 1) + ')';
                if (!(precio > 0)) campos.precio = 'precio requerido (mayor a 0)';
                if (kmRaw === '' || !Number.isFinite(km) || km < 0) campos.km = 'kilometraje requerido';
                const fotos = (Array.isArray(B.fotos) ? B.fotos : []).map(String).filter(u => /^https?:\/\//.test(u));
                if (fotos.length < 4) campos.fotos = 'mínimo 4 fotos (van ' + fotos.length + ')';
                if (Object.keys(campos).length) { const campo = Object.keys(campos)[0]; return res.status(400).json({ ok: false, error: campo + ': ' + campos[campo], campo, campos }); }
                const r = await MSJ.conClave(clave, { tenantId: TV, accion: 'auto_subir', sesionId: SID }, async () => {
                    if (!process.env.K_PANEL) return { ok: false, status: 503, error: 'K_PANEL no configurada' };
                    const duenoTel = TV ? String(tV.telefono || '') : ACC.OWNER_TEL;
                    const partes = String(tV.nombre || 'Vendedor').trim().split(/\s+/).filter(Boolean);
                    const cuerpo = {
                        tipo: 'particular', key: process.env.KEY_VIEJA || undefined,
                        vendedor: { nombre: partes[0] || 'Vendedor', apellido: partes.slice(1).join(' ') || undefined, telefono: duenoTel },
                        autos: [{
                            marca, modelo: [modelo, String(B.version || '').trim()].filter(Boolean).join(' '), anio, precio, kilometraje: km,
                            color: B.color ? String(B.color).slice(0, 40) : undefined, transmision: B.transmision ? String(B.transmision).slice(0, 30) : undefined,
                            comentarios: [B.combustible ? 'Combustible: ' + String(B.combustible).slice(0, 30) : null, B.descripcion ? String(B.descripcion).slice(0, 600) : null].filter(Boolean).join('. ') || undefined,
                            photos: fotos.map((u, i) => ({ url: u, isPrincipal: i === 0 }))
                        }]
                    };
                    const resp = await fetch(WEB_URL + '/api/agency/publish-batch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.K_PANEL }, body: JSON.stringify(cuerpo) });
                    const d = await resp.json().catch(() => ({}));
                    const okPub = resp.ok && d && d.ok !== false && Array.isArray(d.created) && d.created.length && !(d.errors && d.errors.length);
                    if (!okPub) return { ok: false, status: 502, error: String((d.errors && d.errors[0] && d.errors[0].error) || d.error || ('web ' + resp.status)).slice(0, 200) };
                    const webId = Number(d.created[0].id);
                    await run("UPDATE autos SET estado='en_revision' WHERE id=?", [webId]).catch(() => { });   // nace en revisión (la web lo crea activo)
                    let invId = null; try { const iv = (await query('SELECT id FROM inventario_autos WHERE fyradrive_web_id=? LIMIT 1', [webId]))[0]; invId = iv ? Number(iv.id) : null; } catch (e) { }
                    if (TV && invId) await run('INSERT OR IGNORE INTO autos_universo (inv_auto_id, tenant_id, rol, origen, activo, created, updated) VALUES (?,?,?,?,1,?,?)', [invId, TV, 'dueno', 'fyrachat', Date.now(), Date.now()]).catch(() => { });
                    await ACCIONES.registrar({ tenant_id: TV, chat_id: null, tipo: 'auto_subido', ref_id: invId || webId, meta: { web_id: webId, inv_id: invId, marca, modelo, anio, precio, fotos: fotos.length, template: !!d.created[0].template }, actor: 'vendedor', sesion_id: SID });
                    return { ok: true, auto_id: invId || webId, web_id: webId, inv_id: invId, estado: 'revision', fotos: fotos.length, template: !!d.created[0].template };
                });
                return res.status(codigoDe(r)).json(r);
            }
        }

        if (action === 'manual_directo' && req.method === 'POST') {
            const tel = String(req.body.telefono || '');
            const texto = String(req.body.texto || '').trim();
            if (!tel || !texto) return res.status(400).json({ error: 'telefono y texto requeridos' });
            // PUERTA DE MENSAJES (FyraChat v2, 2026-09-10): el universo lo dicta la sesión; el chat se resuelve por (universo, tel);
            // el universo demo y el carril de pruebas se simulan DENTRO de la puerta (renglón en el hilo, nada al puente).
            const tMD = VEND_PARAM ? await tenantDeParam(VEND_PARAM) : { id: 0 };
            if (!tMD) return res.status(404).json({ ok: false, error: 'vendedor no dado de alta' });
            let telMD = tel.replace(/\D/g, ''); if (telMD.length === 10) telMD = '521' + telMD;
            if (tMD.demo) telMD = DEMO.telComprador(telMD);
            // ══ SEÑAL MANUAL (human-in-the-loop real): el owner escribe "cita confirmada"
            // (le confirmaron por teléfono) o "cita cancelada" en el chat del DUEÑO →
            // ejecuta el match/cancelación de verdad (confianza al comprador, recordatorios).
            // CITAS POR UNIVERSO (2026-09-10): la señal en el chat del DUEÑO es del universo 0; un vendedor escribiendo
            // "cita confirmada" en SU universo jamás toca la máquina del dueño de Fyradrive (el chat del dueño vive en t0).
            if (!Number(tMD.id)) { try { await citasVivas.senalManual(telMD, texto); } catch (e) { console.error('[senalManual]', e.message); } }
            // consume_qid: en una SECUENCIA del banco, el PRIMER mensaje "consume" la
            // sugerencia encolada (marca enviado + avanza estado), sin re-enviar nada.
            const consumeQid = Number(req.body.consume_qid || 0) || null;
            // el chat del universo: en t0 se crea si falta (el owner abre chats nuevos desde FyraChat); en universos ≠0 debe existir y estar delegado
            const chatMD = await U.chatDe(tMD.id, telMD, { crear: !tMD.id, visible: true });
            if (!chatMD) return res.status(404).json({ ok: false, enviado: false, error_envio: 'sin chat en este universo (delega primero)' });
            const claveMD = String(req.body.clave || ('manual:' + chatMD.id + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8)));
            // FIRMA MANUAL (caso Gerardo 2026-09-05): texto libre del owner → el puente lo guarda como suyo (ai_generated=0).
            // Una sugerencia del bot que él aprueba (consume_qid) sigue firmada IA: el texto es del bot.
            const env = await MSJ.enviar({ tenantId: tMD.id, chatId: chatMD.id, origen: consumeQid ? 'sugerencia' : 'manual', clave: claveMD, texto, manual: (!consumeQid && req.body.manual === true), sesionId: SES ? SES.sid : null, accion: consumeQid ? 'sugerencia_secuencia' : 'manual', refId: consumeQid });
            const enviado = !!env.ok, error_envio = env.ok ? null : (env.error || 'no se pudo mandar');

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
                                await U.guardarEstado(0, q[0].telefono, { estado_json: meta.estado_nuevo, auto_id_activo: meta.estado_nuevo.auto_id_activo || null, estado: 'seb' });
                            }
                            await run("INSERT INTO seb_entrenamiento (queue_id, telefono, intencion, auto_id, borrador, texto_final, accion, similitud, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                                [q[0].id, q[0].telefono, q[0].intencion, meta.auto_id || null, q[0].borrador, texto, 'secuencia', 0, Date.now()]);
                            // MEDIA del banco (pin de ubicación / fotos) — se manda al consumir el QID, por la misma puerta (claves derivadas).
                            if (meta.ubic) {
                                try {
                                    const pe = await query("SELECT image_b64, name, lat, lng, maps_link FROM punto_envio WHERE auto_id=?", [Number(meta.ubic)]);
                                    if (pe[0] && (pe[0].image_b64 || (pe[0].lat != null && pe[0].lng != null))) {
                                        await MSJ.enviar({ tenantId: 0, chatId: chatMD.id, origen: 'sugerencia', clave: claveMD + ':ubic', imagen: pe[0].image_b64 || null, imagen_ref: 'ubic-img:' + Number(meta.ubic), location: (pe[0].lat != null && pe[0].lng != null) ? { lat: pe[0].lat, lng: pe[0].lng, name: pe[0].name || null, maps_link: pe[0].maps_link || null } : null, manual: false, sesionId: SES ? SES.sid : null, accion: 'sugerencia_ubicacion', refId: consumeQid });
                                    }
                                } catch (e) { /* sin pin */ }
                            }
                            if (meta.fotos && meta.fotos.length) {
                                try { await MSJ.enviar({ tenantId: 0, chatId: chatMD.id, origen: 'sugerencia', clave: claveMD + ':fotos', fotos: meta.fotos, manual: false, sesionId: SES ? SES.sid : null, accion: 'sugerencia_fotos', refId: consumeQid }); } catch (e) { /* sin fotos */ }
                            }
                        }
                    }
                } catch (e) { /* consumo no crítico */ }
            }
            // Fuente única: el saliente llega a raw_conversations vía el bridge, no se escribe wa_messages.
            return res.status(200).json({ ok: true, enviado, error_envio, simulado: !!env.simulado, msg_id: env.msg_id || null, mensaje: env.mensaje || null, chat_id: chatMD.id, clave: claveMD, repetido: !!env.repetido });
        }

        return res.status(400).json({ error: 'action inválida' });
    } catch (err) {
        console.error('[SEB-PANEL]', err);
        return res.status(500).json({ error: err.message });
    }
};
