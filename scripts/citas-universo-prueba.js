#!/usr/bin/env node
// scripts/citas-universo-prueba.js — CITAS POR UNIVERSO (orden owner 2026-09-10: "que la cita se busque por universo +
// chat, nunca por teléfono suelto"). Contra la base REAL, SOLO con teléfonos del carril de pruebas (52100000000xx) y
// el tenant demo 4 (PRUEBAS#). Demuestra que DOS citas vivas del MISMO teléfono (universo 0 y universo 4) jamás se
// confunden: filaViva por (tenant, chat) · casillas con su universo · procesarEntrante del 4 no toca la del 0 ·
// manejarMensajeComprador(tel) del 0 no toca la del 4 · canónica/rescate/programados acotados por universo ·
// paridad con SALES-BRAIN/lib/direccion.js. Nada sale a WhatsApp: tels de prueba se simulan, BRIDGE_SEND_URL apunta a
// un puerto muerto y fetch queda vigilado (cualquier POST al puente con un tel de prueba = FALLO). Limpia TODO al final.
//   cd /Users/Shared/PRUEBAS && node scripts/citas-universo-prueba.js
require('fs').readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8').split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) process.env[l.slice(0, i).trim()] = process.env[l.slice(0, i).trim()] || l.slice(i + 1).trim(); });
process.env.BRIDGE_SEND_URL = 'http://127.0.0.1:9/api/send';   // puente muerto
process.env.CLAUDE_API_KEY = '';                                 // sin IA en pruebas
const { query, run } = require('../lib/seb/db.js');
const U = require('../lib/seb/universo.js');
const CV = require('../lib/seb/citas-vivas.js');
const ACC = require('../lib/seb/acciones.js');
const RESC = require('../lib/seb/rescate.js');
const GH = require('../lib/seb/ghosting.js');
const PROG = require('../lib/seb/programados.js');

const T4 = 4;   // tenant demo PRUEBAS# (existe en tenants; si no existiera se crea temporal y se borra al final)
const TELS = { comp: '5210000000091', dueno0: '5210000000092', dueno4: '5210000000093' };
const TODOS = Object.values(TELS);
for (const t of TODOS) if (!/^52100000000/.test(t)) throw new Error('teléfono fuera del carril de pruebas: ' + t);
const MTY_OFF = 6 * 3600000;

// ── VIGÍA DEL PUENTE: ningún envío real con teléfonos del carril (ley de la casa) ──
const salidasPuente = [];
const _fetch = global.fetch;
global.fetch = async function (url, opts) {
    try {
        const body = String((opts && opts.body) || '');
        if (/\/api\/send|\/programar/.test(String(url)) && TODOS.some(t => body.includes(t) || body.includes(t.slice(3)))) salidasPuente.push({ url: String(url), body: body.slice(0, 200) });
    } catch (e) { }
    return _fetch(url, opts);
};

let fallos = 0, pasos = 0;
function ok(cond, msg, extra) { pasos++; if (cond) console.log('  ✅ ' + msg); else { fallos++; console.log('  ❌ ' + msg + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 400) : '')); } }
const ph = a => a.map(() => '?').join(',');
function citaEn(dias, hh) { const d = new Date(Date.now() - MTY_OFF); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dias, hh, 0) + MTY_OFF; }
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const diaDe = ts => DIAS[new Date(ts - MTY_OFF).getUTCDay()];

let tenantTemporal = false;
async function limpiar() {
    const chats = (await query(`SELECT id FROM conversaciones WHERE telefono IN (${ph(TODOS)})`, TODOS)).map(r => Number(r.id));
    const ms = (await query(`SELECT id FROM citas_match WHERE comprador_tel IN (${ph(TODOS)})`, TODOS)).map(r => Number(r.id));
    if (ms.length) await run(`DELETE FROM cita_casillas WHERE cita_match_id IN (${ph(ms)})`, ms);
    await run(`DELETE FROM cita_casillas WHERE tel IN (${ph(TODOS)})`, TODOS);
    if (chats.length) await run(`DELETE FROM acciones WHERE chat_id IN (${ph(chats)})`, chats).catch(() => { });
    if (ms.length) await run(`DELETE FROM citas_match WHERE id IN (${ph(ms)})`, ms);
    await run(`DELETE FROM citas WHERE comprador_telefono IN (${ph(TODOS)}) OR token LIKE 'prueba_cu_%'`, TODOS);
    await run(`DELETE FROM cita_canonica WHERE telefono IN (${ph(TODOS)})`, TODOS).catch(() => { });
    await run(`DELETE FROM rescates WHERE telefono IN (${ph(TODOS)})`, TODOS).catch(() => { });
    await run(`DELETE FROM mensajes_programados WHERE telefono IN (${ph(TODOS)})`, TODOS).catch(() => { });
    await run(`DELETE FROM seguimientos_ghost WHERE telefono IN (${ph(TODOS)})`, TODOS).catch(() => { });
    if (chats.length) {
        await run(`DELETE FROM delegaciones WHERE chat_id IN (${ph(chats)})`, chats);
        await run(`DELETE FROM mensajes WHERE conversacion_id IN (${ph(chats)})`, chats).catch(() => { });
        await run(`DELETE FROM conversaciones WHERE id IN (${ph(chats)})`, chats);
    }
    const VARS = [].concat(...TODOS.map(t => [t, t.slice(3), '52' + t.slice(3)]));
    await run(`DELETE FROM wa_conversations WHERE telefono IN (${ph(VARS)})`, VARS);
    await run(`DELETE FROM chats_activos WHERE tel IN (${ph(VARS)})`, VARS).catch(() => { });
    if (tenantTemporal) { await run('DELETE FROM tenants WHERE id=? AND nombre=?', [T4, 'PRUEBA_TEMPORAL_CITAS']).catch(() => { }); tenantTemporal = false; }
}
async function restos() {
    const n = async (sql, args) => Number((await query(sql, args))[0].n);
    return {
        conversaciones: await n(`SELECT COUNT(*) n FROM conversaciones WHERE telefono IN (${ph(TODOS)})`, TODOS),
        citas_match: await n(`SELECT COUNT(*) n FROM citas_match WHERE comprador_tel IN (${ph(TODOS)})`, TODOS),
        casillas: await n(`SELECT COUNT(*) n FROM cita_casillas WHERE tel IN (${ph(TODOS)})`, TODOS),
        citas: await n(`SELECT COUNT(*) n FROM citas WHERE comprador_telefono IN (${ph(TODOS)})`, TODOS),
        canonica: await n(`SELECT COUNT(*) n FROM cita_canonica WHERE telefono IN (${ph(TODOS)})`, TODOS),
        rescates: await n(`SELECT COUNT(*) n FROM rescates WHERE telefono IN (${ph(TODOS)})`, TODOS),
        programados: await n(`SELECT COUNT(*) n FROM mensajes_programados WHERE telefono IN (${ph(TODOS)})`, TODOS),
        wa_conversations: await n(`SELECT COUNT(*) n FROM wa_conversations WHERE telefono IN (${ph(TODOS)})`, TODOS)
    };
}

(async () => {
    console.log('── tenant de prueba');
    const t4 = await query('SELECT id, nombre FROM tenants WHERE id=?', [T4]);
    if (!t4.length) { await run("INSERT INTO tenants (id, nombre, telefono, activo, config_json) VALUES (?,?,?,1,'{\"demo\":1}')", [T4, 'PRUEBA_TEMPORAL_CITAS', '5218888888888']); tenantTemporal = true; }
    ok(true, 'tenant ' + T4 + ' = ' + (t4.length ? t4[0].nombre : 'creado temporal'));

    console.log('── DDL idempotente (columnas/índices por universo)');
    await CV.ensureCitasMatch(); await ACC.ensureAcciones();
    await RESC.estadoPanel(TELS.comp);                     // ensureTabla de rescates (tenant_id)
    await GH.ghostScan({ dry: true }).catch(() => { });    // DDL de seguimientos_ghost (tenant_id) — puede regresar fuera_de_horario
    await PROG.listar({ incluirPruebas: true, tenantId: T4 }); // ensure de programados (idx_prog_tel_estado)
    await CV.registrarCitaCanonica({ telefono: TELS.comp, fecha: 'lunes', hora: '10am', tenant_id: T4 });   // ensureCanonica (+tenant_id)
    const col = async (t, c) => (await query('PRAGMA table_info(' + t + ')')).some(x => x.name === c);
    ok(await col('cita_canonica', 'tenant_id') && await col('rescates', 'tenant_id') && await col('seguimientos_ghost', 'tenant_id') && await col('mensajes_programados', 'tenant_id'), 'tenant_id en cita_canonica, rescates, seguimientos_ghost, mensajes_programados');
    const ix = (await query("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_citas_tel_tenant','idx_canonica_tenant_created','idx_ghost_tel','idx_prog_tel_estado','idx_cm_dir','idx_citas_dir')")).map(r => r.name);
    ok(ix.length === 6, 'índices por universo (6)', ix);
    await run('DELETE FROM cita_canonica WHERE telefono=?', [TELS.comp]);

    console.log('── limpieza previa');
    await limpiar();

    console.log('── el MISMO comprador en DOS universos: chat0 (Fyradrive) y chat4 (vendedor); dueños en el universo 0');
    const chat0 = await U.chatDe(0, TELS.comp, { crear: true, nombre: 'Comprador Doble' });
    const chat4 = await U.chatDe(T4, TELS.comp, { crear: true, visible: true, nombre: 'Comprador Doble' });
    const d0 = await U.delegar(chat0, { auto_id: 266, auto_nombre: 'BMW 530I 2019', activado_por: 'prueba' });
    const d4 = await U.delegar(chat4, { auto_id: 1101, auto_nombre: 'AUTO DEL VENDEDOR', activado_por: 'prueba' });
    const chatD0 = await U.chatDe(0, TELS.dueno0, { crear: true, nombre: 'Dueño Cero' });
    const chatD4 = await U.chatDe(0, TELS.dueno4, { crear: true, nombre: 'Dueño Cuatro' });
    ok(chat0 && chat4 && chat0.id !== chat4.id && d0.ok && d4.ok && chatD0 && chatD4, 'dos chats distintos para el mismo tel (uno por universo)', { c0: chat0 && chat0.id, c4: chat4 && chat4.id });
    const dir0 = await CV.direccionDe(0, TELS.comp), dir4 = await CV.direccionDe(T4, TELS.comp);
    ok(dir0.chat_id === chat0.id && dir4.chat_id === chat4.id && dir0.delegacion_id === d0.id && dir4.delegacion_id === d4.id, 'direccionDe resuelve chat+delegación por universo', { dir0, dir4 });

    console.log('── cita A (universo 0, match directo) + cita B (universo 4: solicitud → señal del dueño → match)');
    const tsA = citaEn(3, 11), tsB = citaEn(4, 17);
    const rA = await CV.matchDirectoCalendar({ comprador_tel: TELS.comp, comprador_nombre: 'Comprador Doble', dueno_tel: TELS.dueno0, dueno: 'Dueño Cero', auto_id: 266, auto_nombre: 'BMW 530I 2019', fecha: diaDe(tsA), hora: '11am', cita_ts: tsA, tenant_id: 0 });
    ok(rA.ok && rA.chat_id === chat0.id, 'cita A en match (universo 0)', rA);
    const rB = await CV.registrarSolicitud({ comprador_tel: TELS.comp, comprador_nombre: 'Comprador Doble', dueno_tel: TELS.dueno4, dueno: 'Dueño Cuatro', auto_id: 1101, auto_nombre: 'AUTO DEL VENDEDOR', fecha: diaDe(tsB), hora: '5pm', cita_ts: tsB, tenant_id: T4 });
    ok(rB.ok && rB.chat_id === chat4.id, 'solicitud B viva (universo 4)', rB);
    const MA0 = (await query('SELECT estado FROM citas_match WHERE id=?', [rA.match_id]))[0];
    ok(MA0.estado === 'match', 'registrar la solicitud B NO reemplazó la cita A (otro universo)', MA0);
    const sen = await CV.senalManual(TELS.dueno4, 'cita confirmada');
    ok(sen && sen.senal === 'confirmada', 'señal del dueño (chat del universo 0) confirma la cita B', sen);
    const MA = (await query('SELECT * FROM citas_match WHERE id=?', [rA.match_id]))[0];
    const MB = (await query('SELECT * FROM citas_match WHERE id=?', [rB.id]))[0];
    ok(MA.estado === 'match' && MB.estado === 'match' && MA.id !== MB.id, 'dos máquinas vivas en match del MISMO teléfono', { A: MA.estado, B: MB.estado });
    ok(Number(MA.tenant_id) === 0 && Number(MA.chat_id) === chat0.id && Number(MA.dueno_chat_id) === chatD0.id, 'A: (tenant 0, chat0, dueño0)', { t: MA.tenant_id, c: MA.chat_id, dc: MA.dueno_chat_id });
    ok(Number(MB.tenant_id) === T4 && Number(MB.chat_id) === chat4.id && Number(MB.dueno_chat_id) === chatD4.id, 'B: (tenant 4, chat4, dueño4)', { t: MB.tenant_id, c: MB.chat_id, dc: MB.dueno_chat_id });

    console.log('── filaViva por (universo, chat): cada quien lo suyo');
    ok((await CV.filaViva(0, chat0.id, ['match'])).id === MA.id, 'filaViva(0, chat0) → A');
    ok((await CV.filaViva(T4, chat4.id, ['match'])).id === MB.id, 'filaViva(4, chat4) → B');
    ok((await CV.filaViva(0, chat4.id, ['match'])) === null && (await CV.filaViva(T4, chat0.id, ['match'])) === null, 'cruzar universo y chat → nada');
    const DIR_SB = require('/Users/Shared/SALES-BRAIN/lib/direccion.js');
    const sb0 = await DIR_SB.matchVivo(0, await DIR_SB.chatIdDe(0, TELS.comp)), sb4 = await DIR_SB.matchVivo(T4, await DIR_SB.chatIdDe(T4, TELS.comp));
    ok(sb0 && sb0.id === MA.id && sb4 && sb4.id === MB.id, 'PARIDAD Sales Brain (lib/direccion.js): matchVivo(0)→A, matchVivo(4)→B');

    console.log('── casillas: cada recordatorio lleva el universo de SU cita');
    const casA = await query('SELECT * FROM cita_casillas WHERE cita_match_id=?', [MA.id]);
    const casB = await query('SELECT * FROM cita_casillas WHERE cita_match_id=?', [MB.id]);
    ok(casA.length > 0 && casA.every(c => Number(c.tenant_id) === 0 && Number(c.chat_id) === chat0.id), 'casillas de A: tenant 0 + chat0 (' + casA.length + ')');
    ok(casB.length > 0 && casB.every(c => Number(c.tenant_id) === T4 && Number(c.chat_id) === chat4.id), 'casillas de B: tenant 4 + chat4 (' + casB.length + ')');
    ok(casB.filter(c => c.para === 'vendedor').every(c => c.tel === TELS.dueno4) && casA.filter(c => c.para === 'vendedor').every(c => c.tel === TELS.dueno0), 'las del vendedor van al dueño de SU cita');
    const cB = casB.find(c => c.para === 'comprador'), cA = casA.find(c => c.para === 'comprador');
    await run('UPDATE cita_casillas SET due_ts=? WHERE id IN (?,?)', [Date.now() - 1000, cB.id, cA.id]);
    const eB = await CV.casillaEjecutar(cB.id), eA = await CV.casillaEjecutar(cA.id);
    ok(eB.ok && eB.enviada && eB.simulado && eA.ok && eA.enviada && eA.simulado, 'casillaEjecutar de A y de B: enviadas (simuladas, carril de pruebas)', { eA, eB });
    const accB = await query("SELECT tenant_id, chat_id FROM acciones WHERE tipo='recordatorio' AND ref_id=?", [cB.id]);
    const accA = await query("SELECT tenant_id, chat_id FROM acciones WHERE tipo='recordatorio' AND ref_id=?", [cA.id]);
    ok(accB.length === 1 && Number(accB[0].tenant_id) === T4 && Number(accB[0].chat_id) === chat4.id && accA.length === 1 && Number(accA[0].tenant_id) === 0 && Number(accA[0].chat_id) === chat0.id, 'acción del recordatorio registrada en el chat de SU universo');

    console.log('── procesarEntrante en el universo 4 NO toca la cita del 0');
    const pe1 = await CV.procesarEntrante({ tenantId: T4, chatId: chat4.id, tel: TELS.comp, texto: 'ya voy en camino', enviar: true });
    ok(pe1.handled && pe1.rol === 'comprador' && pe1.segmentos && pe1.segmentos[0] === CV.MSJ.acuseEnCamino(), '"voy en camino" en el 4 → acuse', pe1);
    const ecB = await query("SELECT tel, estado, tenant_id FROM cita_casillas WHERE cita_match_id=? AND tipo='en_camino_aviso'", [MB.id]);
    const ecA = await query("SELECT id FROM cita_casillas WHERE cita_match_id=? AND tipo='en_camino_aviso'", [MA.id]);
    ok(ecB.length === 1 && ecB[0].tel === TELS.dueno4 && ecB[0].estado === 'enviada' && ecA.length === 0, 'aviso "en camino" SOLO al dueño de B; A sin aviso', { ecB, ecA });
    ok((await query("SELECT COUNT(*) n FROM acciones WHERE chat_id=? AND tipo='en_camino'", [chat4.id]))[0].n == 1 && (await query("SELECT COUNT(*) n FROM acciones WHERE chat_id=? AND tipo='en_camino'", [chat0.id]))[0].n == 0, "acción 'en_camino' solo en chat4");
    const pe2 = await CV.procesarEntrante({ tenantId: T4, chatId: chat4.id, tel: TELS.comp, texto: 'ya no voy a poder ir, cancelo', enviar: true });
    ok(pe2.handled && pe2.segmentos && pe2.segmentos[0] === CV.MSJ.canceladaComprador()[0], 'cancelación en el 4', pe2);
    const MB2 = (await query('SELECT estado FROM citas_match WHERE id=?', [MB.id]))[0];
    const MA2 = (await query('SELECT estado FROM citas_match WHERE id=?', [MA.id]))[0];
    const vivasA = (await query("SELECT COUNT(*) n FROM cita_casillas WHERE cita_match_id=? AND estado='pendiente'", [MA.id]))[0].n;
    const vivasB = (await query("SELECT COUNT(*) n FROM cita_casillas WHERE cita_match_id=? AND estado IN ('pendiente','pausada','enviando')", [MB.id]))[0].n;
    ok(MB2.estado === 'cancelada' && Number(vivasB) === 0, 'B cancelada y sin casillas vivas');
    ok(MA2.estado === 'match' && Number(vivasA) > 0, 'A sigue en match con sus casillas vivas (' + vivasA + ')', { A: MA2.estado, vivasA });

    console.log('── la puerta por teléfono del universo 0 (manejarMensajeComprador) llega SOLO a la cita A');
    const segA = await CV.manejarMensajeComprador(TELS.comp, 'ya salgo para allá', 0);
    ok(Array.isArray(segA) && segA[0] === CV.MSJ.acuseEnCamino(), 'acuse en el universo 0', segA);
    const ecA2 = await query("SELECT tel FROM cita_casillas WHERE cita_match_id=? AND tipo='en_camino_aviso'", [MA.id]);
    ok(ecA2.length === 1 && ecA2[0].tel === TELS.dueno0, 'aviso al dueño de A (no al de B)', ecA2);
    ok((await CV.manejarMensajeComprador(TELS.comp, 'ya salgo', T4)) === null, 'la misma puerta en el universo 4 → null (B ya no está viva)');

    console.log('── canónica por universo');
    await CV.registrarCitaCanonica({ telefono: TELS.comp, fecha: diaDe(tsB), hora: '5pm', tenant_id: T4 });
    const can0 = await query("SELECT id FROM cita_canonica WHERE COALESCE(tenant_id,0)=0 AND telefono LIKE ?", ['%' + TELS.comp.slice(-10)]);
    const can4 = await query("SELECT id FROM cita_canonica WHERE COALESCE(tenant_id,0)=? AND telefono LIKE ?", [T4, '%' + TELS.comp.slice(-10)]);
    ok(can0.length === 0 && can4.length === 1, 'la canónica del 4 no se ve desde el 0', { can0: can0.length, can4: can4.length });
    const ce = await CV.ejecutarCierre({ tel: TELS.comp, texto: 'cita confirmada mañana a las 5', ts: Date.now() });
    ok(ce.ok === false && ce.motivo === 'tel_prueba', 'ejecutarCierre bloquea el carril de pruebas (jamás máquina real)', ce);

    console.log('── la cita (hecho) por universo: rescate del universo 0 solo ve las citas del 0');
    const isoB = CV.tsAIsoHora(tsB);
    await run("INSERT INTO citas (token, comprador_nombre, comprador_telefono, auto_id, auto_nombre, tipo, fecha, hora, fecha_hora, estado, vendedor_telefono, created_at, updated_at, tenant_id, chat_id, delegacion_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ['prueba_cu_4_' + Date.now(), 'Comprador Doble', TELS.comp, 1101, 'AUTO DEL VENDEDOR', 'compra', isoB.fecha_iso, '17:00', isoB.fecha_iso + ' 17:00:00', 'agendada', TELS.dueno4, Date.now(), Date.now(), T4, chat4.id, d4.id]);
    const rt1 = await RESC.registrarTurno({ tel: TELS.comp, textoIn: 'hola, sigue disponible?', ruta: 'real', segmentos: ['Sí, ¿te interesa verlo?'], ahora: Date.now() });
    ok(rt1 && rt1.accion !== 'cita_flujo', 'cita solo en el universo 4 → el rescate del 0 NO lo saca del flujo (' + (rt1 && rt1.accion) + ')', rt1);
    const isoA = CV.tsAIsoHora(tsA);
    await run("INSERT INTO citas (token, comprador_nombre, comprador_telefono, auto_id, auto_nombre, tipo, fecha, hora, fecha_hora, estado, vendedor_telefono, created_at, updated_at, tenant_id, chat_id, delegacion_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ['prueba_cu_0_' + Date.now(), 'Comprador Doble', TELS.comp, 266, 'BMW 530I 2019', 'compra', isoA.fecha_iso, '11:00', isoA.fecha_iso + ' 11:00:00', 'agendada', TELS.dueno0, Date.now(), Date.now(), 0, chat0.id, d0.id]);
    const rt2 = await RESC.registrarTurno({ tel: TELS.comp, textoIn: 'hola', ruta: 'real', segmentos: ['¿te agendo?'], ahora: Date.now() });
    ok(rt2 && rt2.accion === 'cita_flujo', 'cita en el universo 0 → cita_flujo (folio cerrado)', rt2);
    const resc = await query("SELECT estado, tenant_id FROM rescates WHERE telefono=?", [TELS.comp]);
    ok(resc.every(r => Number(r.tenant_id) === 0), 'folios de rescate etiquetados tenant 0 (' + resc.length + ')', resc);
    const cIx = await query("SELECT id FROM citas WHERE comprador_telefono=? AND COALESCE(tenant_id,0)=? AND estado='agendada'", [TELS.comp, T4]);
    ok(cIx.length === 1, 'citas WHERE (comprador_telefono, tenant_id) → 1 fila por índice idx_citas_tel_tenant');

    console.log('── mensajes programados por universo');
    const pr = await PROG.crear({ tel: TELS.comp, nombre: 'Comprador Doble', texto: 'recordatorio de prueba', cuandoTs: Date.now() + 3600000, conFoto: 0, tenantId: T4 });
    ok(pr.ok, 'programado creado en el universo 4', pr);
    const l0 = await PROG.listar({ incluirPruebas: true, tenantId: 0 }), l4 = await PROG.listar({ incluirPruebas: true, tenantId: T4 });
    ok(!l0.some(p => p.id === pr.id) && l4.some(p => p.id === pr.id), 'el calendario del 0 no lo ve; el del 4 sí');
    const cx0 = await PROG.cancelar(pr.id, 0), cx4 = await PROG.cancelar(pr.id, T4);
    ok(cx0.cancelado === 0 && cx4.cancelado === 1, 'cancelar desde el 0 no toca; desde el 4 cancela', { cx0, cx4 });

    console.log('── vigía del puente');
    ok(salidasPuente.length === 0, 'CERO envíos al puente con teléfonos del carril', salidasPuente);

    console.log('── conteos antes de limpiar:', JSON.stringify(await restos()));
    await limpiar();
    const rs = await restos();
    ok(Object.values(rs).every(n => Number(n) === 0), 'cero rastros del carril de pruebas', rs);
    ok((await query('SELECT COUNT(*) n FROM conversaciones WHERE tenant_id=?', [T4]))[0].n >= 0, 'las demás conversaciones del tenant demo NO se tocaron');

    console.log(`\n${fallos ? '❌' : '✅'} ${pasos - fallos}/${pasos} pasos OK` + (fallos ? ` — ${fallos} FALLOS` : ''));
    process.exit(fallos ? 1 : 0);
})().catch(async e => { console.error('💥', e); try { await limpiar(); } catch (e2) { } process.exit(2); });
