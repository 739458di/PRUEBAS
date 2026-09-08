#!/usr/bin/env node
// scripts/citas-prueba.js — PRUEBA del SISTEMA DE CITAS por universo (orden owner 2026-09-08) contra la base
// REAL, SOLO con teléfonos del carril de pruebas (52100000000xx) y el tenant 99 (no existe en el puente).
// Ejercita: agendar (match directo) → casillas con los MISMOS textos que planRecordatorios · mover (casillas
// viejas canceladas + nuevas) · casillaEjecutar idempotente · barredor · cita_entrante "voy en camino" (acción +
// casilla del vendedor) · Ley 5 · pausar/reanudar · cancelar · staff · backfill de dirección idempotente.
// Nada sale a WhatsApp: tels de prueba se simulan y BRIDGE_SEND_URL apunta a un puerto muerto (el aviso al
// owner de la confirmación del staff, por ejemplo, falla en silencio en vez de salir).
//   cd /Users/Shared/PRUEBAS && node scripts/citas-prueba.js
require('fs').readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8').split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) process.env[l.slice(0, i).trim()] = process.env[l.slice(0, i).trim()] || l.slice(i + 1).trim(); });
process.env.BRIDGE_SEND_URL = 'http://127.0.0.1:9/api/send';   // puente muerto: nada real sale (timbre/programar/owner)
process.env.CLAUDE_API_KEY = '';                                 // clasificadores por regex (sin IA en pruebas)
const { query, run } = require('../lib/seb/db.js');
const U = require('../lib/seb/universo.js');
const CV = require('../lib/seb/citas-vivas.js');
const ACC = require('../lib/seb/acciones.js');

const T99 = 99;
const TELS = { comp: '5210000000081', dueno: '5210000000082', staff: '5210000000083', comp0: '5210000000084', dueno0: '5210000000085' };
const TODOS = Object.values(TELS);
for (const t of TODOS) if (!/^52100000000/.test(t)) throw new Error('teléfono fuera del carril de pruebas: ' + t);
const MTY_OFF = 6 * 3600000;

let fallos = 0, pasos = 0;
function ok(cond, msg, extra) { pasos++; if (cond) console.log('  ✅ ' + msg); else { fallos++; console.log('  ❌ ' + msg + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 400) : '')); } }
const ph = a => a.map(() => '?').join(',');

async function limpiar() {
    const chats = (await query(`SELECT id FROM conversaciones WHERE telefono IN (${ph(TODOS)})`, TODOS)).map(r => Number(r.id));
    const ms = (await query(`SELECT id FROM citas_match WHERE comprador_tel IN (${ph(TODOS)})`, TODOS)).map(r => Number(r.id));
    const vs = (await query(`SELECT id FROM cita_vendedores WHERE tel IN (${ph(TODOS)}) OR comprador_tel IN (${ph(TODOS)})`, TODOS.concat(TODOS))).map(r => Number(r.id));
    if (ms.length) await run(`DELETE FROM cita_casillas WHERE cita_match_id IN (${ph(ms)})`, ms);
    if (vs.length) await run(`DELETE FROM cita_casillas WHERE staff_id IN (${ph(vs)})`, vs);
    await run(`DELETE FROM cita_casillas WHERE tel IN (${ph(TODOS)})`, TODOS);
    if (chats.length) await run(`DELETE FROM acciones WHERE chat_id IN (${ph(chats)})`, chats).catch(() => { });
    await run(`DELETE FROM acciones WHERE tenant_id=?`, [T99]).catch(() => { });
    if (ms.length) await run(`DELETE FROM citas_match WHERE id IN (${ph(ms)})`, ms);
    if (vs.length) await run(`DELETE FROM cita_vendedores WHERE id IN (${ph(vs)})`, vs);
    await run(`DELETE FROM citas WHERE comprador_telefono IN (${ph(TODOS)}) OR token LIKE 'prueba_citas_%'`, TODOS);
    if (chats.length) {
        await run(`DELETE FROM delegaciones WHERE chat_id IN (${ph(chats)})`, chats);
        await run(`DELETE FROM mensajes WHERE conversacion_id IN (${ph(chats)})`, chats).catch(() => { });
        await run(`DELETE FROM conversaciones WHERE id IN (${ph(chats)})`, chats);
    }
    await run(`DELETE FROM delegaciones WHERE tenant_id=?`, [T99]);
    const VARS = [].concat(...TODOS.map(t => [t, t.slice(3), '52' + t.slice(3)]));
    await run(`DELETE FROM wa_conversations WHERE telefono IN (${ph(VARS)})`, VARS);
    await run(`DELETE FROM chats_activos WHERE tel IN (${ph(VARS)})`, VARS);
}
async function restos() {
    return {
        conversaciones: Number((await query(`SELECT COUNT(*) n FROM conversaciones WHERE telefono IN (${ph(TODOS)})`, TODOS))[0].n),
        citas_match: Number((await query(`SELECT COUNT(*) n FROM citas_match WHERE comprador_tel IN (${ph(TODOS)})`, TODOS))[0].n),
        casillas: Number((await query(`SELECT COUNT(*) n FROM cita_casillas WHERE tel IN (${ph(TODOS)})`, TODOS))[0].n),
        citas: Number((await query(`SELECT COUNT(*) n FROM citas WHERE comprador_telefono IN (${ph(TODOS)})`, TODOS))[0].n),
        staff: Number((await query(`SELECT COUNT(*) n FROM cita_vendedores WHERE tel IN (${ph(TODOS)})`, TODOS))[0].n),
        acciones_t99: Number((await query('SELECT COUNT(*) n FROM acciones WHERE tenant_id=?', [T99]))[0].n),
        delegaciones_t99: Number((await query('SELECT COUNT(*) n FROM delegaciones WHERE tenant_id=?', [T99]))[0].n)
    };
}
// cita_ts en Monterrey: dentro de N días a las HH:00
function citaEn(dias, hh) { const d = new Date(Date.now() - MTY_OFF); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dias, hh, 0) + MTY_OFF; }
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const diaDe = ts => DIAS[new Date(ts - MTY_OFF).getUTCDay()];

(async () => {
    console.log('── DDL idempotente (dirección + casillas + acciones)');
    await CV.ensureCitasMatch(); await ACC.ensureAcciones();
    const colsCM = (await query('PRAGMA table_info(citas_match)')).map(c => c.name);
    ok(['tenant_id', 'chat_id', 'delegacion_id', 'dueno_chat_id'].every(c => colsCM.includes(c)), 'citas_match con dirección completa');
    const colsC = (await query('PRAGMA table_info(citas)')).map(c => c.name);
    ok(['tenant_id', 'chat_id', 'delegacion_id'].every(c => colsC.includes(c)), 'citas con dirección');
    const ix = (await query("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_cm_dir','idx_cm_dueno_chat','idx_casillas_estado_due','idx_casillas_match','idx_citas_dir','idx_acciones_chat_ts')")).map(r => r.name);
    ok(ix.length === 6, 'índices nuevos (6; los 2 de cita_vendedores nacen en ensureCitaVendedores, ver STAFF)', ix);

    console.log('── limpieza previa');
    await limpiar();

    console.log('── universo 99: chat delegado del comprador + chats del dueño y del staff (universo 0)');
    const chatC = await U.chatDe(T99, TELS.comp, { crear: true, visible: true, nombre: 'Prueba Comprador' });
    const dl = await U.delegar(chatC, { auto_id: 266, auto_nombre: 'BMW 530I 2019', activado_por: 'prueba' });
    const chatD = await U.chatDe(0, TELS.dueno, { crear: true, nombre: 'Dueño Prueba' });
    const chatS = await U.chatDe(0, TELS.staff, { crear: true, nombre: 'Staff Prueba' });
    ok(chatC && dl.ok && chatD && chatS, 'chats + delegación creados', { chatC: chatC && chatC.id, deleg: dl.id });
    const dir = await CV.direccionDe(T99, TELS.comp);
    ok(dir.tenant_id === 99 && dir.chat_id === chatC.id && dir.delegacion_id === dl.id, 'direccionDe(99, tel) = universo → chat → delegación', dir);
    ok((await CV.direccionDe(0, TELS.comp)).chat_id === null, 'el chat del universo 99 NO se ve desde el 0');

    console.log('── AGENDAR (match directo, tenant 99) → casillas con los MISMOS textos que planRecordatorios');
    const ts1 = citaEn(3, 11);
    const r1 = await CV.matchDirectoCalendar({ comprador_tel: TELS.comp, comprador_nombre: 'Prueba Comprador', dueno_tel: TELS.dueno, dueno: 'Dueño Prueba', auto_id: 266, auto_nombre: 'BMW 530I 2019', fecha: diaDe(ts1), hora: '11am', cita_ts: ts1, tenant_id: T99, cita_id: null });
    ok(r1.ok && r1.match_id && r1.chat_id === chatC.id && r1.casillas > 0, 'matchDirectoCalendar ok', r1);
    const M1 = (await query('SELECT * FROM citas_match WHERE id=?', [r1.match_id]))[0];
    ok(M1.estado === 'match' && Number(M1.tenant_id) === 99 && Number(M1.chat_id) === chatC.id && Number(M1.delegacion_id) === dl.id && Number(M1.dueno_chat_id) === chatD.id, 'fila con dirección completa (tenant, chat, delegación, dueno_chat)', { t: M1.tenant_id, c: M1.chat_id, d: M1.delegacion_id, dc: M1.dueno_chat_id });
    const ctx1 = { nombre: 'Prueba', dueno: 'Dueño', auto: 'BMW 530I 2019', hora: '11am', fecha: diaDe(ts1) };
    const plan1 = CV.planRecordatorios(Number(M1.match_ts), ts1, ctx1);
    const cas1 = await query("SELECT * FROM cita_casillas WHERE cita_match_id=? ORDER BY due_ts", [M1.id]);
    ok(cas1.length === plan1.length && cas1.length >= 4, 'una casilla por recordatorio del plan (' + cas1.length + ')', { cas: cas1.length, plan: plan1.length });
    const iguales = plan1.every((p, i) => cas1[i] && cas1[i].tipo === p.k && cas1[i].texto === p.texto && Number(cas1[i].due_ts) === p.ts && cas1[i].para === p.para);
    ok(iguales, 'textos/horas/destinatario IDÉNTICOS a planRecordatorios (paridad)', plan1.map((p, i) => [p.k, cas1[i] && cas1[i].tipo]));
    const json1 = JSON.parse(M1.recordatorios);
    ok(json1.length === plan1.length && json1.every((j, i) => j.texto === plan1[i].texto), 'FOTO del plan (JSON recordatorios) coherente (dual-write)');
    ok(cas1.every(c => c.estado === 'pendiente' && c.tel === (c.para === 'vendedor' ? TELS.dueno : TELS.comp) && Number(c.tenant_id) === 99 && Number(c.chat_id) === chatC.id), 'casillas pendientes, con tel correcto por destinatario y dirección');
    const acc1 = await query("SELECT tipo, actor FROM acciones WHERE chat_id=? ORDER BY id", [chatC.id]);
    ok(acc1.some(a => a.tipo === 'cita_match'), "acción 'cita_match' registrada en el chat", acc1);
    const r1b = await CV.matchDirectoCalendar({ comprador_tel: TELS.comp, dueno_tel: TELS.dueno, auto_id: 266, fecha: diaDe(ts1), hora: '11am', cita_ts: ts1, tenant_id: T99 });
    ok(r1b.ok && r1b.ya_existia && r1b.match_id === M1.id, 'agendar la MISMA cita otra vez = idempotente');

    console.log('── filaViva / procesarEntrante SIN cita viva no lee nada más');
    ok((await CV.filaViva(T99, chatC.id, ['match'])).id === M1.id, 'filaViva(99, chat, match) → 1 fila por índice');
    const pe0 = await CV.procesarEntrante({ tenantId: 0, chatId: chatC.id, tel: TELS.comp, texto: 'ya voy en camino' });
    ok(pe0.handled === false, 'el mismo chat_id en el universo 0 NO tiene cita (no cruza universos)');

    console.log('── MOVER (re-confirmar con hora nueva, reemplazar:1) → casillas viejas canceladas + nuevas');
    const ts2 = citaEn(4, 16);
    const r2 = await CV.matchDirectoCalendar({ comprador_tel: TELS.comp, comprador_nombre: 'Prueba Comprador', dueno_tel: TELS.dueno, dueno: 'Dueño Prueba', auto_id: 266, auto_nombre: 'BMW 530I 2019', fecha: diaDe(ts2), hora: '4pm', cita_ts: ts2, tenant_id: T99, reemplazar: true });
    ok(r2.ok && r2.match_id !== M1.id && r2.reemplazadas === 1, 'nuevo match; el viejo reemplazado', r2);
    const M1b = (await query('SELECT estado FROM citas_match WHERE id=?', [M1.id]))[0];
    const cas1b = await query("SELECT estado FROM cita_casillas WHERE cita_match_id=?", [M1.id]);
    ok(M1b.estado === 'reemplazada' && cas1b.length === cas1.length && cas1b.every(c => c.estado === 'cancelada'), 'viejo: estado reemplazada y TODAS sus casillas canceladas');
    const M2 = (await query('SELECT * FROM citas_match WHERE id=?', [r2.match_id]))[0];
    const cas2 = await query("SELECT * FROM cita_casillas WHERE cita_match_id=? ORDER BY due_ts", [M2.id]);
    ok(M2.estado === 'match' && cas2.length > 0 && cas2.every(c => c.estado === 'pendiente'), 'nuevo: casillas nuevas pendientes (' + cas2.length + ')');
    ok((await query("SELECT tipo FROM acciones WHERE chat_id=? AND tipo='cita_movida'", [chatC.id])).length === 1, "acción 'cita_movida'");

    console.log('── casillaEjecutar (puerta única) idempotente');
    const cComp = cas2.find(c => c.para === 'comprador');
    const rNo = await CV.casillaEjecutar(cComp.id);
    ok(rNo.ok === false && rNo.motivo === 'aun_no_toca', 'antes de tiempo → aun_no_toca (no manda)', rNo);
    await run('UPDATE cita_casillas SET due_ts=? WHERE id=?', [Date.now() - 1000, cComp.id]);
    const e1 = await CV.casillaEjecutar(cComp.id);
    ok(e1.ok && e1.enviada && e1.simulado, '1ª ejecución: enviada (simulada, carril pruebas)', e1);
    const e2 = await CV.casillaEjecutar(cComp.id);
    ok(e2.ok && e2.ya === true, '2ª ejecución: ya (NO reenvía)', e2);
    const cE = (await query('SELECT estado, intentos, enviado_ts, error FROM cita_casillas WHERE id=?', [cComp.id]))[0];
    ok(cE.estado === 'enviada' && Number(cE.intentos) === 1 && Number(cE.enviado_ts) > 0 && cE.error === 'simulado', 'estado enviada, intentos=1, enviado_ts', cE);
    ok((await query("SELECT 1 FROM acciones WHERE chat_id=? AND tipo='recordatorio' AND ref_id=?", [chatC.id, cComp.id])).length === 1, "acción 'recordatorio' registrada UNA vez");

    console.log('── barredor (cron): solo lo vencido, por índice');
    const cVend = cas2.find(c => c.para === 'vendedor');
    await run('UPDATE cita_casillas SET due_ts=? WHERE id=?', [Date.now() - 5000, cVend.id]);
    const b1 = await CV.barrerCasillas(50);
    ok(b1.enviadas >= 1, 'barrerCasillas envió la vencida', b1);
    ok((await query('SELECT estado FROM cita_casillas WHERE id=?', [cVend.id]))[0].estado === 'enviada', 'casilla del vendedor enviada por el barredor');
    const b2 = await CV.barrerCasillas(50);
    ok(!(b2.enviadas > 0 && (await query("SELECT COUNT(*) n FROM cita_casillas WHERE cita_match_id=? AND estado='enviada'", [M2.id]))[0].n > 2), 'segunda barrida: nada de este match se reenvía', b2);

    console.log('── cita_entrante (universo 99): "voy en camino" → acuse + acción + casilla del vendedor');
    const pe1 = await CV.procesarEntrante({ tenantId: T99, chatId: chatC.id, tel: TELS.comp, texto: 'ya voy en camino', enviar: true });
    ok(pe1.handled && pe1.rol === 'comprador' && Array.isArray(pe1.segmentos) && pe1.segmentos[0] === CV.MSJ.acuseEnCamino() && pe1.enviados === 1, 'acuse al comprador (texto idéntico, sale por el universo 99)', pe1);
    const cEC = await query("SELECT * FROM cita_casillas WHERE cita_match_id=? AND tipo='en_camino_aviso'", [M2.id]);
    ok(cEC.length === 1 && cEC[0].para === 'vendedor' && cEC[0].tel === TELS.dueno && cEC[0].estado === 'enviada' && cEC[0].texto === CV.MSJ.acreditacionVendedor({ dueno: 'Dueño', auto: 'BMW 530I 2019' }), 'casilla del VENDEDOR (acreditación) creada y ejecutada al instante', cEC[0]);
    ok((await query("SELECT 1 FROM acciones WHERE chat_id=? AND tipo='en_camino' AND actor='comprador'", [chatC.id])).length === 1, "acción 'en_camino'");
    console.log('── Ley 5: el vendedor escribió a mano hace <15 min → el bot calla (solo registra)');
    const pe2 = await CV.procesarEntrante({ tenantId: T99, chatId: chatC.id, tel: TELS.comp, texto: 'ya voy en camino', enviar: true, vendedor_ultimo_ts: Date.now() - 60000 });
    ok(pe2.handled && pe2.callado === 'ley5' && !pe2.enviados, 'callado por ley 5', pe2);
    ok((await query("SELECT 1 FROM acciones WHERE chat_id=? AND tipo='entrada'", [chatC.id])).length === 1, "acción 'entrada' (registro sin respuesta)");
    ok((await query("SELECT COUNT(*) n FROM cita_casillas WHERE cita_match_id=? AND tipo='en_camino_aviso'", [M2.id]))[0].n == 1, 'no nació otra casilla de aviso');
    const pe3 = await CV.procesarEntrante({ tenantId: T99, chatId: chatC.id, tel: TELS.comp, texto: 'hola, qué onda', enviar: true });
    ok(pe3.handled && pe3.rol === 'comprador' && (pe3.segmentos === null || pe3.segmentos.length === 0), 'texto sin señal → nada (sigue el flujo normal)', pe3);

    console.log('── pausar / reanudar casillas (Calendar ⏸/▶️)');
    const pend = await query("SELECT id FROM cita_casillas WHERE cita_match_id=? AND estado='pendiente'", [M2.id]);
    const nP = await CV.cancelarCasillas({ cita_match_id: M2.id }, 'pausada');
    ok(nP === pend.length && nP > 0, 'pausar → ' + nP + ' casillas pausadas');
    await run('UPDATE cita_casillas SET due_ts=? WHERE id=?', [Date.now() - 1000, pend[0].id]);   // una venció durante la pausa
    const nR = await CV.reanudarCasillas({ cita_match_id: M2.id });
    const estR = await query('SELECT id, estado FROM cita_casillas WHERE id IN (' + ph(pend) + ')', pend.map(p => p.id));
    ok(nR === pend.length - 1 && estR.find(x => x.id === pend[0].id).estado === 'saltada' && estR.filter(x => x.estado === 'pendiente').length === pend.length - 1, 'reanudar → la vencida SALTADA, el resto pendiente de nuevo', estR);

    console.log('── CANCELAR (misma máquina que el WhatsApp del comprador y el botón del Calendar)');
    const pe4 = await CV.procesarEntrante({ tenantId: T99, chatId: chatC.id, tel: TELS.comp, texto: 'ya no voy a poder ir, cancelo', enviar: true });
    ok(pe4.handled && pe4.segmentos && pe4.segmentos[0] === CV.MSJ.canceladaComprador()[0], 'cancelación detectada → texto idéntico', pe4);
    const M2c = (await query('SELECT estado FROM citas_match WHERE id=?', [M2.id]))[0];
    const casC = await query("SELECT estado FROM cita_casillas WHERE cita_match_id=? AND estado IN ('pendiente','pausada','enviando')", [M2.id]);
    ok(M2c.estado === 'cancelada' && casC.length === 0, 'match cancelado y CERO casillas vivas');
    const accC = await query("SELECT COUNT(*) n FROM acciones WHERE chat_id=? AND tipo='cita_cancelada'", [chatC.id]);
    await CV.ejecutarCancelacion(M2, { por: 'owner' });
    ok((await query("SELECT COUNT(*) n FROM acciones WHERE chat_id=? AND tipo='cita_cancelada'", [chatC.id]))[0].n == Number(accC[0].n) + 1, 'cancelar de nuevo: registra pero no re-avisa (idempotente)');
    ok((await CV.procesarEntrante({ tenantId: T99, chatId: chatC.id, tel: TELS.comp, texto: 'ya voy' })).handled === false, 'tras cancelar: sin cita viva → no procesa');

    console.log('── STAFF (vendedor asignado) por dirección');
    const ts3 = citaEn(3, 12);
    const tok = 'prueba_citas_' + Date.now();
    const insC = await run("INSERT INTO citas (token, comprador_nombre, comprador_telefono, auto_id, auto_nombre, tipo, fecha, hora, fecha_hora, estado, vendedor_telefono, created_at, updated_at, tenant_id, chat_id, delegacion_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [tok, 'Prueba Comprador', TELS.comp, 266, 'BMW 530I 2019', 'compra', CV.tsAIsoHora(ts3).fecha_iso, '12:00', CV.tsAIsoHora(ts3).fecha_iso + ' 12:00:00', 'agendada', TELS.dueno, Date.now(), Date.now(), T99, chatC.id, dl.id]);
    const citaId = Number(insC.lastInsertRowid);
    const si = await CV.staffInvitar({ cita_id: citaId, nombre: 'Staff Prueba', tel: TELS.staff });
    ok(si.ok && si.enviado, 'staffInvitar (invitación simulada)', si);
    const V = (await query('SELECT * FROM cita_vendedores WHERE id=?', [si.id]))[0];
    ok(Number(V.chat_id) === chatS.id && Number(V.comprador_chat_id) === chatC.id && Number(V.tenant_id) === 99, 'silla con dirección (chat del staff en t0 + chat del comprador en t99)', { c: V.chat_id, cc: V.comprador_chat_id, t: V.tenant_id });
    const ixV = (await query("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_cv_chat','idx_cv_comp_chat','idx_cv_estado_cita')")).map(r => r.name);
    ok(ixV.length === 3, 'índices de cita_vendedores por dirección (3)', ixV);
    const st1 = await CV.manejarMensajeStaff(TELS.staff, 'sí claro, ahí estaré', chatS.id);
    ok(Array.isArray(st1) && st1.length === 1 && /quedamos/.test(st1[0]), 'el staff confirma por WhatsApp (por chat)', st1);
    const casS = await query("SELECT tipo, para, tel, estado FROM cita_casillas WHERE staff_id=? ORDER BY due_ts", [V.id]);
    ok(casS.length === 2 && casS.every(c => c.para === 'staff' && c.tel === TELS.staff && c.estado === 'pendiente') && casS[0].tipo === 'vispera' && casS[1].tipo === 'dia', 'casillas del staff (víspera + día) pendientes', casS);
    ok((await CV.manejarMensajeStaff(TELS.dueno, 'sí', chatD.id)) === null, 'un chat sin silla → null (no es staff)');
    // "voy en camino" con match vivo → también al staff (casilla en_camino_staff)
    const r4 = await CV.matchDirectoCalendar({ comprador_tel: TELS.comp, comprador_nombre: 'Prueba Comprador', dueno_tel: TELS.dueno, dueno: 'Dueño Prueba', auto_id: 266, auto_nombre: 'BMW 530I 2019', fecha: diaDe(ts3), hora: '12pm', cita_ts: ts3, tenant_id: T99, cita_id: citaId });
    const pe5 = await CV.procesarEntrante({ tenantId: T99, chatId: chatC.id, tel: TELS.comp, texto: 'voy en camino', enviar: true });
    const casSt = await query("SELECT estado, tel FROM cita_casillas WHERE staff_id=? AND tipo='en_camino_staff'", [V.id]);
    ok(pe5.handled && casSt.length === 1 && casSt[0].estado === 'enviada' && casSt[0].tel === TELS.staff, 'en camino → casilla del STAFF ejecutada', casSt);
    ok(Number((await query("SELECT COUNT(*) n FROM cita_casillas WHERE cita_match_id=? AND estado='pendiente'", [r4.match_id]))[0].n) > 0, 'casillas del nuevo match (con cita_id) vivas');

    console.log('── BACKFILL de dirección (idempotente) sobre filas legado sin dirección (universo 0)');
    const chat0 = await U.chatDe(0, TELS.comp0, { crear: true, nombre: 'Legacy Comp' });
    const chatD0 = await U.chatDe(0, TELS.dueno0, { crear: true, nombre: 'Legacy Dueño' });
    const tsL = citaEn(5, 10);
    const recsL = [{ k: 'vispera', ts: tsL - 14 * 3600000, para: 'comprador', texto: 'Qué tal Legacy, buenas noches. Te recuerdo tu cita de mañana a las 10am. Seguimos en pie?', enviado: 0 }, { k: 'sello', ts: Date.now() - 1000, para: 'comprador', texto: 'ya enviado', enviado: 1 }];
    const insL = await run("INSERT INTO citas_match (comprador_tel, comprador_nombre, dueno_tel, dueno, auto_id, auto_nombre, fecha, hora, cita_ts, match_ts, estado, recordatorios, updated) VALUES (?,?,?,?,?,?,?,?,?,?,'match',?,?)",
        [TELS.comp0, 'Legacy Comp', TELS.dueno0, 'Legacy Dueño', 266, 'BMW 530I 2019', diaDe(tsL), '10am', tsL, Date.now(), JSON.stringify(recsL), Date.now()]);
    const idL = Number(insL.lastInsertRowid);
    await run("INSERT INTO citas (token, comprador_nombre, comprador_telefono, auto_id, auto_nombre, tipo, fecha, hora, fecha_hora, estado, vendedor_telefono, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ['prueba_citas_L' + Date.now(), 'Legacy Comp', TELS.comp0, 266, 'BMW 530I 2019', 'compra', CV.tsAIsoHora(tsL).fecha_iso, '10:00', CV.tsAIsoHora(tsL).fecha_iso + ' 10:00:00', 'agendada', TELS.dueno0, Date.now(), Date.now()]);
    const dry = await CV.backfillDireccionCitas({ dry: true, telefonos: TODOS });
    ok(dry.dry && dry.match_ligadas === 1 && dry.dueno_ligados === 1 && dry.casillas_creadas === 1 && dry.citas_ligadas === 1, 'dry run cuenta sin escribir', dry);
    ok((await query('SELECT chat_id FROM citas_match WHERE id=?', [idL]))[0].chat_id == null, 'dry run NO escribió');
    const bf = await CV.backfillDireccionCitas({ telefonos: TODOS });
    console.log('  reporte:', JSON.stringify(bf));
    const ML = (await query('SELECT * FROM citas_match WHERE id=?', [idL]))[0];
    ok(Number(ML.tenant_id) === 0 && Number(ML.chat_id) === chat0.id && Number(ML.dueno_chat_id) === chatD0.id, 'match legado ligado (tenant 0, chat, dueno_chat)', { t: ML.tenant_id, c: ML.chat_id, dc: ML.dueno_chat_id });
    const casL = await query("SELECT tipo, texto, estado, due_ts FROM cita_casillas WHERE cita_match_id=?", [idL]);
    ok(casL.length === 1 && casL[0].tipo === 'vispera' && casL[0].texto === recsL[0].texto && casL[0].estado === 'pendiente', 'casilla creada desde el JSON (solo la no enviada)', casL);
    const cL = (await query("SELECT tenant_id, chat_id FROM citas WHERE comprador_telefono=? ORDER BY id DESC LIMIT 1", [TELS.comp0]))[0];
    ok(Number(cL.tenant_id) === 0 && Number(cL.chat_id) === chat0.id, 'cita (hecho) legado ligada');
    const bf2 = await CV.backfillDireccionCitas({ telefonos: TODOS });
    ok(bf2.match_ligadas === 0 && bf2.dueno_ligados === 0 && bf2.casillas_creadas === 0 && bf2.citas_ligadas === 0 && bf2.staff_ligados === 0, 'backfill 2ª vez = idempotente (nada nuevo)', bf2);
    ok((await query("SELECT COUNT(*) n FROM cita_casillas WHERE cita_match_id=?", [idL]))[0].n == 1, 'sin casillas duplicadas');
    // compatibilidad: las funciones por teléfono (tenant 0) llegan a la MISMA fila por dirección
    const segL = await CV.manejarMensajeComprador(TELS.comp0, 'ya salgo para allá', 0);
    ok(Array.isArray(segL) && segL[0] === CV.MSJ.acuseEnCamino(), 'manejarMensajeComprador(tel) del tenant 0 sigue funcionando (resuelve dirección)', segL);
    const segD = await CV.manejarMensajeDueno(TELS.dueno0, 'sí, disponible');
    ok(segD === null, 'el dueño sin solicitud viva (ya en match) → null');

    console.log('── conteos del carril antes de limpiar');
    console.log('  ', JSON.stringify(await restos()));
    console.log('── limpieza final');
    await limpiar();
    const rs = await restos();
    ok(Object.values(rs).every(n => Number(n) === 0), 'cero rastros del carril de pruebas', rs);

    console.log(`\n${fallos ? '❌' : '✅'} ${pasos - fallos}/${pasos} pasos OK` + (fallos ? ` — ${fallos} FALLOS` : ''));
    process.exit(fallos ? 1 : 0);
})().catch(async e => { console.error('💥', e); try { await limpiar(); } catch (e2) { } process.exit(2); });
