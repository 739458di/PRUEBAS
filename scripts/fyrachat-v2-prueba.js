// scripts/fyrachat-v2-prueba.js — PRUEBA E2E del backend FyraChat v2 (contrato 2026-09-10 + huecos 2026-09-12).
//
// Turso REAL, universo demo (tenant 4 "PRUEBAS#"), teléfonos del carril 52100000000xx. CERO envíos reales: los tels de
// prueba y el universo demo se simulan dentro de la puerta de mensajes (lib/seb/mensajeria.js) y enviarWA bloquea el carril.
// Limpieza TOTAL al final (demo_reset + rastros en t0 + envios + sesión de prueba). Correr:
//   cd /Users/Shared/PRUEBAS && node scripts/fyrachat-v2-prueba.js
//
// Recorrido: inbox → hilo (desde/antes) → enviar (misma clave ×2 = 1 envío) → foco → delegar_v2 fotos (idempotente) →
// accion_v2 info → cotizar_v2 → cita_v2 → citas_mias (cita + casillas) → recordatorio_v2 ×3 (3º rechazado) → reactivar
// (intención, 0 envíos) → bot_estado (n/a) → soltar_v2 → autos_mios. Y en t0 con tel de prueba: manual_directo y resolver
// dejan recibo en `envios`; dueNow/despachar con puente caído NO marca enviado; casilla al comprador en tenant≠0 con
// manual reciente del vendedor se POSPONE 15 min.
'use strict';
const path = require('path');
const fs = require('fs');
const RAIZ = path.join(__dirname, '..');
process.chdir(RAIZ);
fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) process.env[l.slice(0, i).trim()] = process.env[l.slice(0, i).trim()] || l.slice(i + 1).trim(); });
process.env.K_PANEL = process.env.K_PANEL || 'pv2-llave-de-prueba';     // llave local para las acciones de t0 (solo vive en este proceso)
delete process.env.K_PUENTE; delete process.env.BRIDGE_API_KEY;         // sin llave saliente: timbre/puente = no-op (nada sale)
process.env.BRIDGE_SEND_URL = 'http://127.0.0.1:9/api/send';           // por si algo intentara salir: puerto muerto

const { query, run } = require('../lib/seb/db.js');
const handler = require('../api/seb-panel.js');
const ACC = require('../lib/seb/acceso.js');
const DEMO = require('../lib/seb/demo.js');
const U = require('../lib/seb/universo.js');
const MSJ = require('../lib/seb/mensajeria.js');
const PROG = require('../lib/seb/programados.js');
const CV = require('../lib/seb/citas-vivas.js');

const TENANT_DEMO = 4;
const TEL_DEMO = '5210000000042';   // comprador en el universo demo (carril de pruebas → telComprador lo respeta)
const TEL_T0 = '5210000000043';     // comprador de prueba en el universo 0
const PRE = 'pv2:' + Date.now().toString(36) + ':';   // prefijo de todas las claves de esta corrida
const nuevaClave = acc => PRE + acc + ':' + Math.random().toString(36).slice(2, 10);

let pasos = 0, ok = 0, fallos = [];
function check(nombre, cond, detalle) {
    pasos++;
    if (cond) { ok++; console.log('  ✅', nombre); }
    else { fallos.push(nombre); console.log('  ❌', nombre, detalle != null ? '→ ' + (typeof detalle === 'string' ? detalle : JSON.stringify(detalle)).slice(0, 300) : ''); }
}

// ── llamada al handler como si fuera Vercel ──
function llamar({ method, query: q, body, cookie, key }) {
    return new Promise((resolve) => {
        const headers = { origin: 'https://fyrachat.vercel.app' };
        if (cookie) headers.cookie = 'fyra_v=' + cookie;
        if (key) headers['x-api-key'] = key;
        const req = { method: method || 'GET', query: q || {}, body: body || {}, headers, socket: { remoteAddress: '127.0.0.1' } };
        const res = { _status: 200, setHeader() { }, status(n) { this._status = n; return this; }, json(o) { resolve({ status: this._status, body: o }); }, end() { resolve({ status: this._status, body: null }); } };
        handler(req, res).catch(e => resolve({ status: 500, body: { ok: false, error: 'handler: ' + e.message } }));
    });
}

(async () => {
    const t0 = Date.now();
    console.log('FYRACHAT v2 — prueba e2e (tenant demo', TENANT_DEMO + ', tels', TEL_DEMO, '/', TEL_T0 + ')');
    let sesion = null, tenantDemo = null;
    const rastro = { chats_t0: [], queue_ids: [], prog_ids: [], casilla_ids: [], match_ids: [] };
    try {
        tenantDemo = await DEMO.asegurarTenantDemo();
        check('tenant demo existe y es id ' + TENANT_DEMO, Number(tenantDemo.id) === TENANT_DEMO, tenantDemo);
        await MSJ.ensureEnvios();
        const tk = await ACC.crearTicket(tenantDemo.telefono);   // misma puerta que el link de acceso: ticket → sesión (cookie)
        sesion = tk.ok ? await ACC.canjearTicket(tk.token, 'prueba-v2', '127.0.0.1') : { ok: false, error: tk.error };
        check('sesión de vendedor demo abierta', !!(sesion && sesion.token && sesion.tenant.demo), sesion);
        const D = (method, action, body, q) => llamar({ method, query: Object.assign({ action }, q || {}), body: Object.assign({ action }, body || {}), cookie: sesion.token });
        const P = (method, action, body, q) => llamar({ method, query: Object.assign({ action }, q || {}), body: Object.assign({ action }, body || {}), key: process.env.K_PANEL });

        // limpieza previa del demo (por si quedó algo de otra corrida)
        await DEMO.reset(tenantDemo);

        // ══ 0) NUEVO COMPRADOR (delegar_v2 silencio) — crea el chat delegado en el universo demo ══
        const autosR = await D('GET', 'autos_mios');
        check('autos_mios responde con autos', autosR.body && autosR.body.ok && Array.isArray(autosR.body.autos) && autosR.body.autos.length > 0, autosR.body);
        const autoA = autosR.body.autos[0], autoB = autosR.body.autos[1] || autosR.body.autos[0];
        const claveDel = nuevaClave('delegar');
        const del0 = await D('POST', 'delegar_v2', { telefono: TEL_DEMO, nombre: 'Prueba Vdos', auto_id: autoA.id, entrada: { modo: 'silencio' }, clave: claveDel });
        check('delegar_v2 (silencio) crea el chat delegado', del0.body && del0.body.ok && del0.body.chat_id && del0.body.simulado, del0.body);
        const CHAT = del0.body.chat_id;
        const del0b = await D('POST', 'delegar_v2', { telefono: TEL_DEMO, nombre: 'Prueba Vdos', auto_id: autoA.id, entrada: { modo: 'silencio' }, clave: claveDel });
        check('delegar_v2 misma clave → repetido (no ejecuta dos veces)', del0b.body && del0b.body.ok && del0b.body.repetido === true && Number(del0b.body.chat_id) === Number(CHAT), del0b.body);

        // ══ 1) INBOX ══
        const inb = await D('GET', 'inbox', null, { limit: 40 });
        const fila = inb.body && inb.body.ok ? (inb.body.chats || []).find(c => Number(c.chat_id) === Number(CHAT)) : null;
        check('inbox lista el chat del universo demo con auto y bot n/a', !!fila && fila.bot === 'n/a' && fila.delegado === true && fila.telefono === TEL_DEMO, inb.body);
        const inbQ = await D('GET', 'inbox', null, { q: 'Prueba Vdos' });
        check('inbox busca por nombre en servidor', inbQ.body && inbQ.body.ok && (inbQ.body.chats || []).some(c => Number(c.chat_id) === Number(CHAT)), inbQ.body);

        // ══ 2) HILO (sin antes → marca leído; desde → solo lo nuevo; antes → historial sin marcar leído) ══
        await run('UPDATE conversaciones SET no_leidos=3 WHERE id=?', [CHAT]);
        const h1 = await D('GET', 'hilo', null, { chat_id: CHAT, limit: 40 });
        check('hilo devuelve chat + mensajes (renglón sistema del delegar) y hay_mas=false', h1.body && h1.body.ok && h1.body.chat && Number(h1.body.chat.chat_id) === Number(CHAT) && Array.isArray(h1.body.mensajes) && h1.body.mensajes.length >= 1 && h1.body.hay_mas === false, h1.body);
        const nl1 = (await query('SELECT no_leidos FROM conversaciones WHERE id=?', [CHAT]))[0];
        check('hilo sin `antes` marca leído (no_leidos=0)', Number(nl1.no_leidos) === 0, nl1);
        const ultTs = h1.body.mensajes.length ? h1.body.mensajes[h1.body.mensajes.length - 1].ts : Date.now();
        const hd = await D('GET', 'hilo', null, { chat_id: CHAT, desde: ultTs });
        check('hilo &desde=<ts> devuelve SOLO lo nuevo (0 ahora)', hd.body && hd.body.ok && hd.body.mensajes.length === 0, hd.body);
        await run('UPDATE conversaciones SET no_leidos=2 WHERE id=?', [CHAT]);
        const ha = await D('GET', 'hilo', null, { chat_id: CHAT, antes: ultTs + 1, limit: 5 });
        const nl2 = (await query('SELECT no_leidos FROM conversaciones WHERE id=?', [CHAT]))[0];
        check('hilo con `antes` NO marca leído (no_leidos sigue en 2) y trae historial', ha.body && ha.body.ok && Number(nl2.no_leidos) === 2 && ha.body.mensajes.length >= 1, { nl2, n: ha.body && ha.body.mensajes && ha.body.mensajes.length });
        await run('UPDATE conversaciones SET no_leidos=0 WHERE id=?', [CHAT]);

        // ══ 3) ENVIAR — misma clave ×2 = 1 envío en `envios` ══
        const claveEnv = nuevaClave('enviar');
        const e1 = await D('POST', 'enviar', { chat_id: CHAT, texto: 'Hola, soy tu vendedor de prueba 👋', clave: claveEnv });
        check('enviar manual → ok + simulado + mensaje', e1.body && e1.body.ok && e1.body.simulado && e1.body.mensaje && e1.body.mensaje.msg_id, e1.body);
        const e2 = await D('POST', 'enviar', { chat_id: CHAT, texto: 'Hola, soy tu vendedor de prueba 👋', clave: claveEnv });
        check('enviar misma clave → repetido:true', e2.body && e2.body.ok && e2.body.repetido === true, e2.body);
        const envRows = await query('SELECT clave, estado, intentos FROM envios WHERE clave=?', [claveEnv]);
        const nMsg = await query("SELECT COUNT(*) n FROM mensajes WHERE conversacion_id=? AND direccion='out' AND texto LIKE '%soy tu vendedor de prueba%'", [CHAT]);
        check('envios: 1 recibo (simulado, intentos 1) y 1 solo renglón en el hilo', envRows.length === 1 && envRows[0].estado === 'simulado' && Number(envRows[0].intentos) === 1 && Number(nMsg[0].n) === 1, { envRows, nMsg });
        const hd2 = await D('GET', 'hilo', null, { chat_id: CHAT, desde: ultTs });
        check('hilo &desde ahora trae el manual nuevo con emisor dueno', hd2.body && hd2.body.ok && hd2.body.mensajes.length === 1 && hd2.body.mensajes[0].emisor === 'dueno', hd2.body && hd2.body.mensajes);
        const accEnv = await query("SELECT sesion_id, tipo FROM acciones WHERE tenant_id=? AND chat_id=? AND tipo='manual' ORDER BY id DESC LIMIT 1", [TENANT_DEMO, CHAT]);
        check('acciones.registrar con sesion_id de la sesión', accEnv.length === 1 && Number(accEnv[0].sesion_id) === Number(sesion.sid), { accEnv, sid: sesion.sid });

        // ══ 4) FOCO ══
        const f1 = await D('POST', 'foco', { chat_id: CHAT, auto_id: autoB.id });
        check('foco cambia el auto (catálogo del universo)', f1.body && f1.body.ok && f1.body.auto && Number(f1.body.auto.id) === Number(autoB.id), f1.body);
        const fMal = await D('POST', 'foco', { chat_id: CHAT, auto_id: 999999999 });
        check('foco con auto fuera del catálogo → 403', fMal.status === 403, fMal);

        // ══ 5) DELEGAR v2 con entrada fotos (idempotente por clave) ══
        const claveDF = nuevaClave('delegar-fotos');
        const df1 = await D('POST', 'delegar_v2', { telefono: TEL_DEMO, nombre: 'Prueba Vdos', auto_id: autoA.id, entrada: { modo: 'fotos' }, clave: claveDF });
        check('delegar_v2 fotos → ya_delegado + acción ejecutada (enviado=true/texto)', df1.body && df1.body.ok && df1.body.ya_delegado === true && df1.body.accion_ejecutada === 'fotos' && (df1.body.enviado === true || typeof df1.body.enviado === 'string'), df1.body);
        const fotosAntes = await query("SELECT COUNT(*) n FROM mensajes WHERE conversacion_id=? AND tipo='image'", [CHAT]);
        const df2 = await D('POST', 'delegar_v2', { telefono: TEL_DEMO, nombre: 'Prueba Vdos', auto_id: autoA.id, entrada: { modo: 'fotos' }, clave: claveDF });
        const fotosDespues = await query("SELECT COUNT(*) n FROM mensajes WHERE conversacion_id=? AND tipo='image'", [CHAT]);
        check('delegar_v2 fotos misma clave → repetido, sin fotos nuevas', df2.body && df2.body.repetido === true && Number(fotosAntes[0].n) === Number(fotosDespues[0].n) && Number(fotosAntes[0].n) > 0, { df2: df2.body, fotosAntes, fotosDespues });

        // ══ 6) ACCION v2 info ══
        const ai = await D('POST', 'accion_v2', { chat_id: CHAT, accion: 'info', clave: nuevaClave('info') });
        check('accion_v2 info → enviado = TEXTO del machote', ai.body && ai.body.ok && typeof ai.body.enviado === 'string' && ai.body.enviado.length > 20, ai.body);
        const aiMal = await D('POST', 'accion_v2', { chat_id: CHAT, accion: 'cita', clave: nuevaClave('x') });
        check('accion_v2 con acción no permitida → 400', aiMal.status === 400, aiMal.body);

        // ══ 7) COTIZAR v2 ══
        const cSin = await D('POST', 'cotizar_v2', { chat_id: CHAT, clave: nuevaClave('cot0') });
        check('cotizar_v2 sin enganche → 400 necesita enganche', cSin.status === 400 && cSin.body.necesita === 'enganche', cSin.body);
        const c1 = await D('POST', 'cotizar_v2', { chat_id: CHAT, enganche: 50000, plazo: 48, clave: nuevaClave('cot') });
        check('cotizar_v2 → texto_tarjeta + enviado = tarjeta (string)', c1.body && c1.body.ok && c1.body.texto_tarjeta && typeof c1.body.enviado === 'string' && c1.body.enviado === c1.body.texto_tarjeta, c1.body);

        // ══ 8) CITA v2 (simulada: máquina citas_match + casillas, sin CRM/Calendar) ══
        const manana = new Date(Date.now() + 2 * 86400000); const fIso = manana.toISOString().slice(0, 10);
        const ci = await D('POST', 'cita_v2', { chat_id: CHAT, fecha_iso: fIso, hora: '11:00', clave: nuevaClave('cita') });
        check('cita_v2 → ok + enviado = machote de confirmación (string) + cita_match_id', ci.body && ci.body.ok && typeof ci.body.enviado === 'string' && /quedó tu cita/.test(ci.body.enviado) && ci.body.cita && ci.body.cita.cita_match_id, ci.body);
        if (ci.body && ci.body.cita && ci.body.cita.cita_match_id) rastro.match_ids.push(ci.body.cita.cita_match_id);
        const cm = await D('GET', 'citas_mias', null, { estado: 'proximas' });
        const laCita = cm.body && cm.body.ok ? (cm.body.citas || []).find(x => Number(x.id) === Number(ci.body.cita && ci.body.cita.cita_match_id)) : null;
        check('citas_mias(proximas) muestra la cita con comprador, auto y casillas', !!laCita && laCita.estado === 'confirmada' && laCita.comprador && Number(laCita.comprador.chat_id) === Number(CHAT) && laCita.auto && laCita.auto.nombre && Array.isArray(laCita.recordatorios) && laCita.recordatorios.length > 0 && laCita.fecha === fIso && laCita.hora === '11:00', cm.body);
        const cmP = await D('GET', 'citas_mias', null, { estado: 'pasadas' });
        check('citas_mias(pasadas) no la incluye', cmP.body && cmP.body.ok && !(cmP.body.citas || []).some(x => Number(x.id) === Number(laCita && laCita.id)), cmP.body);

        // ══ 9) RECORDATORIO v2 ×3 (tope 2) + recordatorios_mios ══
        const cu = Date.now() + 3600000;
        const r1 = await D('POST', 'recordatorio_v2', { chat_id: CHAT, cuando_ts: cu, texto: 'Te aviso 1', clave: nuevaClave('rec1') });
        const r2 = await D('POST', 'recordatorio_v2', { chat_id: CHAT, cuando_ts: cu + 60000, texto: 'Te aviso 2', clave: nuevaClave('rec2') });
        const r3 = await D('POST', 'recordatorio_v2', { chat_id: CHAT, cuando_ts: cu + 120000, texto: 'Te aviso 3', clave: nuevaClave('rec3') });
        check('recordatorio_v2 ×2 → ok con id', r1.body && r1.body.ok && r1.body.id && r2.body && r2.body.ok && r2.body.id, { r1: r1.body, r2: r2.body });
        check('recordatorio_v2 3º → rechazado por tope (409)', r3.status === 409 && r3.body && r3.body.ok === false && r3.body.tope === 2, r3);
        const rm = await D('GET', 'recordatorios_mios', null, { chat_id: CHAT });
        check('recordatorios_mios lista los 2 pendientes', rm.body && rm.body.ok && rm.body.pendientes === 2 && rm.body.recordatorios.length === 2, rm.body);
        const rc = await D('POST', 'recordatorio_cancelar_v2', { id: r2.body.id });
        check('recordatorio_cancelar_v2 cancela uno del universo', rc.body && rc.body.ok && rc.body.cancelado === 1, rc.body);

        // ══ 10) REACTIVAR — intención, 0 envíos ══
        const envAntes = await query("SELECT COUNT(*) n FROM mensajes WHERE conversacion_id=? AND direccion='out'", [CHAT]);
        const ra = await D('POST', 'reactivar', { chat_id: CHAT, clave: nuevaClave('react') });
        const envDespues = await query("SELECT COUNT(*) n FROM mensajes WHERE conversacion_id=? AND direccion='out'", [CHAT]);
        check('reactivar crea la intención (programado_ts) y NO manda nada', ra.body && ra.body.ok && ra.body.programado_ts > Date.now() && ra.body.programado_id && Number(envAntes[0].n) === Number(envDespues[0].n), { ra: ra.body, envAntes, envDespues });

        // ══ 11) BOT_ESTADO (demo → n/a) ══
        const be = await D('POST', 'bot_estado', { chat_id: CHAT, estado: 'humano' });
        check('bot_estado en universo ≠0 → n/a', be.body && be.body.ok && be.body.bot === 'n/a', be.body);

        // ══ 11b) DEMO_RESPONDER por chat_id ══
        const dr = await D('POST', 'demo_responder', { chat_id: CHAT, texto: 'sí me interesa' });
        check('demo_responder acepta chat_id', dr.body && dr.body.ok && Number(dr.body.chat_id) === Number(CHAT), dr.body);

        // ══ 11c) AUTO_SUBIR — error por campo ══
        const as = await D('POST', 'auto_subir', { marca: 'Mazda', modelo: '', anio: 2020, precio: 250000, km: 1000, fotos: [], clave: nuevaClave('auto') });
        check('auto_subir inválido → {ok:false, error, campo}', as.status === 400 && as.body && as.body.ok === false && as.body.campo === 'modelo' && /modelo/.test(as.body.error), as.body);

        // ══ 12) SOLTAR v2 ══
        const so = await D('POST', 'soltar_v2', { chat_id: CHAT });
        check('soltar_v2 → ok', so.body && so.body.ok, so.body);
        const eTras = await D('POST', 'enviar', { chat_id: CHAT, texto: 'ya sin delegación', clave: nuevaClave('env-post') });
        check('enviar tras soltar (tenant≠0 sin delegación viva) → 403', eTras.status === 403, eTras);

        // ══ 13) AUTOS_MIOS ══
        const am = await D('GET', 'autos_mios');
        check('autos_mios → lista con nombre/precio/estado', am.body && am.body.ok && am.body.autos.every(a => a.nombre && a.estado), am.body);

        // ══════════ UNIVERSO 0 con tel de prueba (K_PANEL) ══════════
        console.log('— universo 0 (tel de prueba) —');
        const md = await P('POST', 'manual_directo', { telefono: TEL_T0, texto: 'Hola desde manual_directo (prueba)', manual: true, clave: PRE + 'md' });
        check('manual_directo t0 → enviado (simulado) + recibo en envios', md.body && md.body.ok && md.body.enviado && md.body.simulado && md.body.chat_id, md.body);
        if (md.body && md.body.chat_id) rastro.chats_t0.push(md.body.chat_id);
        const mdRec = await query('SELECT estado, tenant_id FROM envios WHERE clave=?', [PRE + 'md']);
        check('envios tiene el recibo del manual (t0, simulado)', mdRec.length === 1 && mdRec[0].estado === 'simulado' && Number(mdRec[0].tenant_id) === 0, mdRec);
        // resolver: sugerencia encolada → aprobar
        const ins = await run("INSERT INTO seb_queue (telefono, borrador, estado, intencion, tools_usadas, dedupe_key, creado_en) VALUES (?,?,?,?,?,?,?)", [TEL_T0, 'Borrador de prueba v2', 'pendiente', 'prueba', '{}', PRE + 'q', Date.now()]);
        const qid = Number(ins.lastInsertRowid); rastro.queue_ids.push(qid);
        const rs = await P('POST', 'resolver', { queue_id: qid, resolucion: 'aprobado', texto_final: 'Borrador de prueba v2' });
        check('resolver t0 → enviado por la puerta (clave resolver:<qid>)', rs.body && rs.body.ok && rs.body.enviado && rs.body.simulado && rs.body.clave === 'resolver:' + qid, rs.body);
        const rsRec = await query('SELECT estado FROM envios WHERE clave=?', ['resolver:' + qid]);
        check('envios tiene el recibo del resolver', rsRec.length === 1 && rsRec[0].estado === 'simulado', rsRec);
        const rs2 = await P('POST', 'resolver', { queue_id: qid, resolucion: 'aprobado', texto_final: 'Borrador de prueba v2' });
        check('resolver segunda vez → ya_enviado (candado del QID)', rs2.body && rs2.body.enviado === false && rs2.body.ya_enviado === true, rs2.body);

        // ══ PROGRAMADO con puente caído: NO se marca enviado (intentos+1); al volver, sale (simulado) ══
        const pr = await PROG.crear({ tel: TEL_T0, nombre: 'Prueba', texto: 'Recordatorio de prueba v2', cuandoTs: Date.now() - 1000, conFoto: false, tenantId: 0 });
        check('programado creado (vencido) en t0', pr.ok && pr.id, pr);
        if (pr.id) rastro.prog_ids.push(pr.id);
        MSJ._prueba.fallarPuente = true;
        const d1 = await PROG.despachar({ ahora: Date.now(), tel: TEL_T0 });
        MSJ._prueba.fallarPuente = false;
        const pRow1 = (await query('SELECT estado, intentos, ultimo_error FROM mensajes_programados WHERE id=?', [pr.id]))[0];
        check('despachar con puente caído → sigue pendiente, intentos=1, error anotado', d1.fallidos === 1 && pRow1.estado === 'pendiente' && Number(pRow1.intentos) === 1 && /caído/.test(pRow1.ultimo_error || ''), { d1, pRow1 });
        const d2 = await PROG.despachar({ ahora: Date.now(), tel: TEL_T0 });
        const pRow2 = (await query('SELECT estado, intentos FROM mensajes_programados WHERE id=?', [pr.id]))[0];
        const pRec = await query('SELECT estado, intentos FROM envios WHERE clave=?', ['prog:' + pr.id]);
        check('despachar con puente vivo → enviado (simulado) con el MISMO recibo (intentos 2)', d2.enviados === 1 && pRow2.estado === 'enviado' && pRec.length === 1 && pRec[0].estado === 'simulado' && Number(pRec[0].intentos) === 2, { d2, pRow2, pRec });

        // ══ CASILLA al comprador en tenant≠0 con manual reciente del vendedor → se POSPONE 15 min ══
        const chatC = await U.chatDe(TENANT_DEMO, TEL_DEMO, { crear: true, visible: true, nombre: 'Prueba Vdos' });
        const now = Date.now();
        const insM = await run("INSERT INTO citas_match (comprador_tel, comprador_nombre, dueno_tel, dueno, auto_id, auto_nombre, fecha, hora, cita_ts, match_ts, estado, updated, tenant_id, chat_id) VALUES (?,?,?,?,?,?,?,?,?,?,'match',?,?,?)",
            [TEL_DEMO, 'Prueba Vdos', tenantDemo.telefono, tenantDemo.nombre, autoA.id, autoA.nombre, 'mañana', '11am', now + 86400000, now, now, TENANT_DEMO, chatC.id]);
        const mid = Number(insM.lastInsertRowid); rastro.match_ids.push(mid);
        const insK = await run("INSERT INTO cita_casillas (cita_match_id, tenant_id, chat_id, tipo, para, tel, due_ts, texto, estado, created, updated) VALUES (?,?,?,?,?,?,?,?,'pendiente',?,?)",
            [mid, TENANT_DEMO, chatC.id, 'vispera', 'comprador', TEL_DEMO, now, 'Recordatorio de prueba (casilla)', now, now]);
        const kid = Number(insK.lastInsertRowid); rastro.casilla_ids.push(kid);
        await run("INSERT INTO mensajes (conversacion_id, msg_id, ts, direccion, emisor, texto, tipo, ai_generated, created_at) VALUES (?,?,?,?,?,?,?,?,?)", [chatC.id, PRE + 'manual-vend', now - 60000, 'out', 'dueno', 'te marco ahorita (manual del vendedor)', 'text', 0, now]);
        const k1 = await CV.casillaEjecutar(kid);
        const kRow = (await query('SELECT estado, due_ts, error FROM cita_casillas WHERE id=?', [kid]))[0];
        check('casilla comprador (tenant≠0) con manual <15 min → pospuesta (+15 min), sigue pendiente', k1.pospuesta === true && kRow.estado === 'pendiente' && Number(kRow.due_ts) >= now + 14 * 60000 && /pospuesta/.test(kRow.error || ''), { k1, kRow });
        await run('UPDATE mensajes SET ts=? WHERE msg_id=?', [now - 20 * 60000, PRE + 'manual-vend']);   // el manual ya tiene 20 min
        const k2 = await CV.casillaEjecutar(kid, { forzar: true });
        const kRow2 = (await query('SELECT estado, error FROM cita_casillas WHERE id=?', [kid]))[0];
        check('misma casilla con el manual ya viejo → enviada (simulada, carril)', k2.enviada === true && k2.simulado === true && kRow2.estado === 'enviada', { k2, kRow2 });

        // ══ cancelación determinista (tenant≠0) sin IA ══
        const cd = CV.clasificarCancelacionDeterminista;
        check('clasificarCancelacionDeterminista: claro / ambiguo / nada', cd('ya no voy a poder ir, cancela').cancela === true && cd('se me complicó, no sé si llegue').ambiguo === true && cd('se me complicó, no sé si llegue').cancela === false && cd('perfecto ahí nos vemos').cancela === false && cd('perfecto ahí nos vemos').ambiguo === false, null);
        check('mensajeria.origenPuente traduce el origen interno a la etiqueta del puente', MSJ.origenPuente('boton:fotos') === 'boton' && MSJ.origenPuente('cita') === 'maquina_cita' && MSJ.origenPuente('rescate') === 'programado' && MSJ.origenPuente('manual') === 'manual' && MSJ.origenPuente('delegar') === 'delegar', null);

        // ══ cero envíos reales: ningún recibo de esta corrida salió del carril ══
        const reales = await query("SELECT COUNT(*) n FROM envios WHERE (clave LIKE ? OR clave=? OR clave=?) AND estado='enviado'", [PRE + '%', 'resolver:' + qid, 'prog:' + pr.id]);
        check('CERO envíos reales (todo simulado)', Number(reales[0].n) === 0, reales);
    } catch (e) {
        check('sin excepción en el recorrido', false, e.stack || e.message);
    } finally {
        // ══════════ LIMPIEZA TOTAL ══════════
        console.log('— limpieza —');
        const rep = {};
        try {
            if (tenantDemo) rep.demo = (await DEMO.reset(tenantDemo)).borrado;
            // universo 0: chats de los tels de prueba de esta corrida + sus rastros
            const chatsT0 = await query("SELECT id FROM conversaciones WHERE COALESCE(tenant_id,0)=0 AND telefono IN (?,?)", [TEL_T0, TEL_DEMO]);
            const ids = chatsT0.map(c => Number(c.id));
            if (ids.length) {
                const ph = ids.map(() => '?').join(',');
                await run(`DELETE FROM mensajes WHERE conversacion_id IN (${ph})`, ids);
                await run(`DELETE FROM acciones WHERE chat_id IN (${ph})`, ids).catch(() => { });
                await run(`DELETE FROM delegaciones WHERE chat_id IN (${ph})`, ids).catch(() => { });
                await run(`DELETE FROM cita_casillas WHERE chat_id IN (${ph})`, ids).catch(() => { });
                await run(`DELETE FROM citas_match WHERE chat_id IN (${ph})`, ids).catch(() => { });
                await run(`DELETE FROM conversaciones WHERE id IN (${ph})`, ids);
            }
            rep.chats_t0 = ids.length;
            await run("DELETE FROM wa_conversations WHERE telefono IN (?,?)", [TEL_T0, TEL_DEMO]).catch(() => { });
            await run("DELETE FROM chats_activos WHERE telefono IN (?,?) AND COALESCE(tenant_id,0)=0", [TEL_T0, TEL_DEMO]).catch(() => { });
            await run("DELETE FROM seb_entrenamiento WHERE telefono=?", [TEL_T0]).catch(() => { });
            await run("DELETE FROM seb_queue WHERE telefono=?", [TEL_T0]).catch(() => { });
            await run("DELETE FROM mensajes_programados WHERE telefono IN (?,?)", [TEL_T0, TEL_DEMO]).catch(() => { });
            await run("DELETE FROM rescates WHERE telefono IN (?,?)", [TEL_T0, TEL_DEMO]).catch(() => { });
            const rEnv = await run("DELETE FROM envios WHERE clave LIKE ? OR tenant_id=? OR clave LIKE ? OR clave LIKE ?", [PRE + '%', TENANT_DEMO, 'resolver:' + (rastro.queue_ids[0] || -1), 'prog:' + (rastro.prog_ids[0] || -1)]);
            rep.envios = Number(rEnv.rowsAffected) || 0;
            if (sesion && sesion.sid) {
                await run("DELETE FROM accesos_log WHERE sesion_id=?", [sesion.sid]).catch(() => { });
                await run("DELETE FROM sesiones_vendedor WHERE id=?", [sesion.sid]).catch(() => { });
            }
            await run("DELETE FROM tickets_acceso WHERE tenant_id=? AND usado=1 AND creado >= ?", [TENANT_DEMO, t0 - 1000]).catch(() => { });   // el ticket de ESTA corrida
            rep.sesion = 'borrada';
        } catch (e) { rep.error = e.message; }
        console.log('  limpieza:', JSON.stringify(rep));
        console.log('\nRESULTADO: ' + ok + '/' + pasos + ' pasos OK' + (fallos.length ? ' — FALLOS: ' + fallos.join(' | ') : '') + ' (' + Math.round((Date.now() - t0) / 100) / 10 + ' s)');
        process.exit(fallos.length ? 1 : 0);
    }
})();
