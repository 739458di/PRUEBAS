#!/usr/bin/env node
// scripts/universo-prueba.js — PRUEBA de la Etapa 2 (base por universo) contra la base REAL,
// SOLO con teléfonos del carril de pruebas (52100000000xx) y el tenant 99 (no existe en el puente).
// Ejercita: chatDe / guardarEstado / delegar / cambiarFoco / soltar / backfill parcial y verifica la
// PARIDAD del dual-write con wa_conversations / chats_activos. Limpia sus filas al final.
//   cd /Users/Shared/PRUEBAS && node scripts/universo-prueba.js
require('fs').readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8').split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) process.env[l.slice(0, i).trim()] = process.env[l.slice(0, i).trim()] || l.slice(i + 1).trim(); });
const { query, run } = require('../lib/seb/db.js');
const U = require('../lib/seb/universo.js');

const T99 = 99;
const TELS = { t0a: '5210000000091', t0b: '5210000000092', t99a: '5210000000094', t99b: '5210000000095', bf0: '5210000000096', bf99: '5210000000097' };
const TODOS = Object.values(TELS);
for (const t of TODOS) if (!/^52100000000/.test(t)) throw new Error('teléfono fuera del carril de pruebas: ' + t);

let fallos = 0, pasos = 0;
function ok(cond, msg, extra) { pasos++; if (cond) console.log('  ✅ ' + msg); else { fallos++; console.log('  ❌ ' + msg + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); } }

async function limpiar() {
    const ph = TODOS.map(() => '?').join(',');
    const ids = (await query(`SELECT id FROM conversaciones WHERE telefono IN (${ph})`, TODOS)).map(r => Number(r.id));
    if (ids.length) {
        const ph2 = ids.map(() => '?').join(',');
        await run(`DELETE FROM delegaciones WHERE chat_id IN (${ph2})`, ids);
        await run(`DELETE FROM mensajes WHERE conversacion_id IN (${ph2})`, ids).catch(() => { });
        await run(`DELETE FROM conversaciones WHERE id IN (${ph2})`, ids);
    }
    await run(`DELETE FROM delegaciones WHERE tenant_id=?`, [T99]);
    // las 3 formas del teléfono (521+10 / 10 / 52+10): el test mete una fila vieja de 10 dígitos a propósito
    const VARS = [].concat(...TODOS.map(t => [t, t.slice(3), '52' + t.slice(3)]));
    const phV = VARS.map(() => '?').join(',');
    await run(`DELETE FROM wa_conversations WHERE telefono IN (${phV})`, VARS);
    await run(`DELETE FROM chats_activos WHERE tel IN (${phV})`, VARS);
}

(async () => {
    console.log('── ensureUniverso (DDL idempotente)');
    await U.ensureUniverso();
    const cols = (await query('PRAGMA table_info(conversaciones)')).map(c => c.name);
    ok(['estado_json', 'canal', 'estado_bot', 'auto_id_activo', 'platform', 'estado_ts'].every(c => cols.includes(c)), 'columnas nuevas en conversaciones');
    const ix = (await query("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_deleg_chat_hasta','idx_deleg_tenant_hasta','idx_conv_tenant_tel')")).map(r => r.name);
    ok(ix.length === 3, 'índices delegaciones + conversaciones(tenant_id, telefono)', ix);
    await U.ensureUniverso(); ok(true, 'ensureUniverso 2a vez (memo por proceso, sin DDL)');

    console.log('── limpieza previa');
    await limpiar();

    console.log('── tel12');
    ok(U.tel12('8120066355') === '5218120066355' && U.tel12('528120066355') === '5218120066355' && U.tel12('5218120066355') === '5218120066355' && U.tel12('+52 1 812 006 6355') === '5218120066355', 'normaliza 10 / 52+10 / 521+10 / con formato');
    ok(U.tel12('110127357112541') === '110127357112541' && U.tel12('fb_24729351210018522') === 'fb_24729351210018522', 'lo que no tiene forma MX se conserva');

    console.log('── chatDe (tenant 0 y 99)');
    ok((await U.chatDe(0, TELS.t0a)) === null, 'no existe antes de crear');
    const c0 = await U.chatDe(0, TELS.t0a, { crear: true, nombre: 'Prueba T0' });
    ok(c0 && c0.channel_thread_id === 'whatsapp:' + TELS.t0a && Number(c0.tenant_id) === 0, 'tenant 0 → hilo sin sufijo, tenant_id=0', c0);
    const c99 = await U.chatDe(T99, TELS.t99a, { crear: true, nombre: 'Prueba T99', visible: true });
    ok(c99 && c99.channel_thread_id === 'whatsapp:' + TELS.t99a + '#t99' && Number(c99.tenant_id) === 99, 'tenant 99 → hilo con sufijo #t99', c99);
    ok((await U.chatDe(0, TELS.t99a)) === null, 'el chat del universo 99 NO existe en el universo 0 (no cruza)');
    ok((await U.chatDe(0, '0000000091', { crear: true })).id === c0.id, 'chatDe con tel de 10 dígitos llega al MISMO chat (idempotente)');
    // tenant_id NULL histórico = tenant 0
    await run('UPDATE conversaciones SET tenant_id=NULL WHERE id=?', [c0.id]);
    ok((await U.chatDe(0, TELS.t0a)).id === c0.id, 'tenant_id NULL se lee como universo 0');
    await run('UPDATE conversaciones SET tenant_id=0 WHERE id=?', [c0.id]);

    console.log('── estado del bot + espejo wa_conversations (tenant 0)');
    let st = await U.leerEstado(0, TELS.t0a);
    ok(!st.existe && JSON.stringify(st.ej) === '{}' && st.auto_id_activo === null, 'sin estado: existe=false (como cur.length=0 de antes)');
    await U.guardarEstado(0, TELS.t0a, { estado_json: { mesa: [266], interes: [266] }, auto_id_activo: 266, estado: 'mesa' });
    st = await U.leerEstado(0, TELS.t0a);
    ok(st.existe && st.auto_id_activo === 266 && st.ej.mesa[0] === 266 && st.estado === 'mesa' && st.updated_at > 0, 'guardarEstado → columnas del chat', st);
    let wa = await query('SELECT * FROM wa_conversations WHERE telefono=?', [TELS.t0a]);
    ok(wa.length === 1 && Number(wa[0].auto_id_activo) === 266 && wa[0].estado === 'mesa' && JSON.parse(wa[0].estado_json).mesa[0] === 266 && Number(wa[0].updated_at) === st.updated_at, 'PARIDAD wa_conversations (INSERT espejo)', wa[0]);
    await U.guardarEstado(0, TELS.t0a, { estado_json: { mesa: [266, 1101] }, auto_id_activo: 1101, estado: 'aparador' });
    st = await U.leerEstado(0, TELS.t0a); wa = await query('SELECT * FROM wa_conversations WHERE telefono=?', [TELS.t0a]);
    ok(st.estado === 'mesa' && wa[0].estado === 'mesa', "estado solo se fija si estaba vacío (COALESCE, como el INSERT de antes)");
    ok(Number(wa[0].auto_id_activo) === 1101 && st.auto_id_activo === 1101 && JSON.parse(wa[0].estado_json).mesa.length === 2, 'PARIDAD wa_conversations (UPDATE espejo)');
    await U.guardarEstado(0, TELS.t0a, { auto_id_activo: null });
    st = await U.leerEstado(0, TELS.t0a); wa = await query('SELECT auto_id_activo, estado_json FROM wa_conversations WHERE telefono=?', [TELS.t0a]);
    ok(st.auto_id_activo === null && wa[0].auto_id_activo === null && JSON.parse(wa[0].estado_json).mesa.length === 2, 'auto_id_activo=null suelta la columna en ambos, sin tocar estado_json');
    await U.guardarEstado(0, TELS.t0a, { canal_si_nulo: 'owner' }); await U.guardarEstado(0, TELS.t0a, { canal_si_nulo: 'messenger' });
    st = await U.leerEstado(0, TELS.t0a); wa = await query('SELECT canal FROM wa_conversations WHERE telefono=?', [TELS.t0a]);
    ok(st.canal === 'owner' && wa[0].canal === 'owner', 'canal_si_nulo (marcarOwner) no pisa el canal ya puesto');
    await U.guardarEstado(0, TELS.t0a, { canal: 'messenger' });
    ok((await U.leerEstado(0, TELS.t0a)).canal === 'messenger', "canal forzado → 'messenger' (esMessenger)");

    console.log('── el foco del bot deja HISTORIAL en delegaciones (tenant 0)');
    let dl = await query('SELECT * FROM delegaciones WHERE chat_id=? ORDER BY id', [c0.id]);
    ok(dl.length === 2 && Number(dl[0].auto_id) === 266 && dl[0].hasta != null && Number(dl[1].auto_id) === 1101 && dl[1].hasta == null && dl[0].activado_por === 'bot', '266 → 1101: la primera cerrada, la segunda activa (activado_por=bot)', dl);
    const f0 = await U.focoDe(0, TELS.t0a);
    ok(f0 === null, 'focoDe tenant 0 = la COLUMNA (hoy null) — igual que wa_conversations.auto_id_activo de antes');

    console.log('── estado del universo 99: NO se espejea a wa_conversations');
    await U.guardarEstado(T99, TELS.t99a, { estado_json: { x: 1 } });
    ok((await query('SELECT COUNT(*) n FROM wa_conversations WHERE telefono=?', [TELS.t99a]))[0].n == 0, 'wa_conversations sin fila para el tel del universo 99');
    ok((await U.leerEstado(0, TELS.t99a)).existe === false, 'el estado del 99 no se ve desde el 0');

    console.log('── delegar / cambiarFoco / soltar (tenant 99) + espejo chats_activos');
    const d1 = await U.delegar(c99, { auto_id: 266, auto_nombre: 'BMW 530I 2019', activado_por: 'prueba', opener_texto: 'hola' });
    ok(d1.ok && d1.nueva && d1.delegacion.opener_pendiente === 1, 'delegar crea delegación activa', d1);
    let ca = await query('SELECT * FROM chats_activos WHERE tenant_id=? AND tel=? AND hasta IS NULL', [T99, TELS.t99a]);
    ok(ca.length === 1 && Number(ca[0].car_id) === 266 && ca[0].car_nombre === 'BMW 530I 2019' && ca[0].activado_por === 'prueba', 'PARIDAD chats_activos (INSERT espejo)', ca[0]);
    let f99 = await U.focoDe(T99, TELS.t99a);
    ok(f99 && f99.auto_id === 266 && f99.delegacion_id === d1.id, 'focoDe tenant 99 = delegación activa', f99);
    const d2 = await U.delegar(c99, { auto_id: 266, activado_por: 'prueba' });
    ok(d2.ok && !d2.nueva && d2.id === d1.id, 'delegar de nuevo con el MISMO auto = idempotente (no duplica)', d2);
    const cf = await U.cambiarFoco(c99, 1101, 'fyrachat', { activado_por: 'fyrachat', auto_nombre: 'Lincoln Navigator 2021', solo_si_activa: true });
    ok(cf.ok && cf.anterior && cf.anterior.id === d1.id && cf.delegacion.auto_id === 1101, 'cambiarFoco cierra la activa y abre otra', cf);
    dl = await query('SELECT id, auto_id, hasta, motivo FROM delegaciones WHERE chat_id=? ORDER BY id', [c99.id]);
    ok(dl.length === 2 && dl[0].hasta != null && dl[0].motivo === 'fyrachat' && dl[1].hasta == null, 'HISTORIAL: 2 filas, la vieja con hasta+motivo', dl);
    ca = await query('SELECT id, car_id, car_nombre, hasta FROM chats_activos WHERE tenant_id=? AND tel=?', [T99, TELS.t99a]);
    ok(ca.length === 1 && Number(ca[0].car_id) === 1101 && ca[0].car_nombre === 'Lincoln Navigator 2021' && ca[0].hasta == null, 'PARIDAD chats_activos: UNA fila viva con el auto nuevo (como el UPDATE de antes)', ca);
    ok(Number((await U.chatDe(T99, TELS.t99a)).auto_id_activo) === 1101, 'la columna auto_id_activo del chat también cambió');
    const cf2 = await U.cambiarFoco(c99, 1101, 'fyrachat', { solo_si_activa: true });
    ok(cf2.ok && cf2.sin_cambio, 'cambiarFoco al mismo auto = sin cambio');
    // solo_si_activa en un chat SIN delegación (tenant 99, tel b) → no crea nada (como el UPDATE viejo que no encontraba fila)
    const c99b = await U.chatDe(T99, TELS.t99b, { crear: true });
    const cf3 = await U.cambiarFoco(c99b, 266, 'fyrachat', { solo_si_activa: true });
    ok(!cf3.ok && (await query('SELECT COUNT(*) n FROM delegaciones WHERE chat_id=?', [c99b.id]))[0].n == 0, 'solo_si_activa sin delegación viva → no inventa una');
    const so = await U.soltar(c99, 'prueba');
    ok(so.ok && so.cerradas === 1, 'soltar cierra la activa', so);
    ok((await U.focoDe(T99, TELS.t99a)) === null && (await U.delegacionActiva(c99.id)) === null, 'sin delegación activa tras soltar');
    ca = await query('SELECT hasta FROM chats_activos WHERE tenant_id=? AND tel=?', [T99, TELS.t99a]);
    ok(ca.length === 1 && ca[0].hasta != null, 'PARIDAD chats_activos: hasta cerrado', ca);
    ok((await U.delegacionesDe(T99)).length === 0, 'delegacionesDe(99) vacío (lo que cargaría el puente)');
    const so2 = await U.soltar(c99, 'prueba'); ok(so2.ok && so2.cerradas === 0, 'soltar de nuevo = idempotente');

    console.log('── BACKFILL parcial (solo estos teléfonos): lo viejo → lo nuevo');
    // simular LO VIEJO: fila de wa_conversations sin chat + chats_activos abierta del 99 sin delegación + tenant_id NULL
    const tsViejo = Date.now() - 100000;
    await run("INSERT INTO wa_conversations (telefono, estado, estado_json, canal, auto_id_activo, platform, updated_at) VALUES (?,?,?,?,?,?,?)", ['0000000096', 'mesa', JSON.stringify({ mesa: [1023] }), 'owner', 1023, 'whatsapp', tsViejo]);   // 10 dígitos a propósito
    await run("INSERT INTO chats_activos (tenant_id, tel, car_id, car_nombre, comprador_nombre, activado_por, desde, opener_pendiente, opener_texto, created) VALUES (?,?,?,?,?,?,?,?,?,?)", [T99, TELS.bf99, 1023, 'Toyota Yaris S 2022', 'Jaime Prueba', 'fyrachat', tsViejo, 0, null, tsViejo]);
    await run("INSERT INTO conversaciones (channel_thread_id, telefono, nombre, ult_texto, ult_dir, ult_msg_ts, no_leidos, is_dueno_chat, source, created_at, tenant_id) VALUES (?,?,?,?,?,?,0,0,'whatsapp',?,NULL)", ['whatsapp:' + TELS.t0b, TELS.t0b, 'Nulo', '', 'in', tsViejo, tsViejo]);
    await run("INSERT INTO wa_conversations (telefono, estado_json, auto_id_activo, updated_at) VALUES (?,?,?,?)", [TELS.t0b, JSON.stringify({ mesa: [266] }), 266, tsViejo]);
    const dry = await U.backfillUniverso({ dry: true, telefonos: TODOS });
    ok(dry.dry && dry.wa_leidas === 3 && dry.chats_creados === 1 && dry.ca_abiertas === 1 && dry.deleg_desde_ca === 1, 'dry run cuenta sin escribir', dry);
    ok((await U.chatDe(0, TELS.bf0)) === null, 'dry run NO creó el chat');
    const bf = await U.backfillUniverso({ telefonos: TODOS });
    console.log('  reporte:', JSON.stringify(bf));
    ok(bf.tenant_null_a_0 === 1, 'tenant_id NULL → 0 (1 fila)');
    const cb = await U.chatDe(0, TELS.bf0);
    ok(cb && cb.channel_thread_id === 'whatsapp:' + TELS.bf0 && Number(cb.auto_id_activo) === 1023 && cb.canal === 'owner' && cb.estado_bot === 'mesa' && Number(cb.estado_ts) === tsViejo && JSON.parse(cb.estado_json).mesa[0] === 1023, 'wa_conversations (10 dígitos) → chat t0 creado con el tel normalizado y su estado', cb);
    const db0 = await U.delegacionActiva(cb.id);
    ok(db0 && Number(db0.auto_id) === 1023 && db0.activado_por === 'backfill' && Number(db0.desde) === tsViejo, 'foco viejo → delegación backfill (desde = updated_at, sin ult_msg_ts)', db0);
    const cb2 = await U.chatDe(0, TELS.t0b);
    ok(Number(cb2.tenant_id) === 0 && Number(cb2.auto_id_activo) === 266 && (await U.delegacionActiva(cb2.id)) && Number((await U.delegacionActiva(cb2.id)).desde) === tsViejo, 'chat existente (tenant NULL) → tenant 0 + estado + delegación con desde = ult_msg_ts', cb2);
    const c99bf = await U.chatDe(T99, TELS.bf99);
    ok(c99bf && c99bf.nombre === 'Jaime Prueba' && c99bf.channel_thread_id === 'whatsapp:' + TELS.bf99 + '#t99', 'chats_activos del 99 sin chat → chat creado en SU universo', c99bf);
    const d99 = await U.delegacionActiva(c99bf.id);
    ok(d99 && Number(d99.auto_id) === 1023 && d99.auto_nombre === 'Toyota Yaris S 2022' && Number(d99.desde) === tsViejo && /backfill:chats_activos/.test(d99.motivo), 'chats_activos → delegación (misma fecha)', d99);
    ok((await U.focoDe(T99, TELS.bf99)).auto_id === 1023, 'focoDe(99) ya lo ve');
    const bf2 = await U.backfillUniverso({ telefonos: TODOS });
    ok(bf2.chats_creados === 0 && bf2.deleg_desde_ca === 0 && bf2.deleg_desde_wa === 0 && bf2.estados_copiados === 0 && bf2.tenant_null_a_0 === 0, 'backfill 2a vez = idempotente (nada nuevo)', bf2);
    const dlBf = await query('SELECT COUNT(*) n FROM delegaciones WHERE chat_id IN (?,?,?)', [cb.id, cb2.id, c99bf.id]);
    ok(dlBf[0].n == 3, 'sin delegaciones duplicadas');
    // la única fila que sigue en chats_activos con hasta NULL para el 99 es la del backfill → lo que el puente uniría
    const dd = await U.delegacionesDe(T99);
    ok(dd.length === 1 && dd[0].tel === TELS.bf99, 'delegacionesDe(99) = 1 (con teléfono del chat, para el mapa del puente)', dd);

    console.log('── borrarEstado (reset del sandbox)');
    await U.guardarEstado(0, TELS.t0a, { estado_json: { a: 1 }, auto_id_activo: 266 });
    ok(await U.borrarEstado(0, TELS.t0a, 'reset_prueba'), 'borrarEstado ok');
    st = await U.leerEstado(0, TELS.t0a);
    ok(!st.existe && (await query('SELECT COUNT(*) n FROM wa_conversations WHERE telefono=?', [TELS.t0a]))[0].n == 0 && (await U.delegacionActiva(c0.id)) === null, 'sin estado, sin fila wa_conversations, sin delegación activa; el CHAT sigue (no se borra)');

    console.log('── conteos del carril antes de limpiar');
    console.log('  ', JSON.stringify({
        conversaciones: (await query(`SELECT COUNT(*) n FROM conversaciones WHERE telefono IN (${TODOS.map(() => '?').join(',')})`, TODOS))[0].n,
        delegaciones_t99: (await query('SELECT COUNT(*) n FROM delegaciones WHERE tenant_id=?', [T99]))[0].n,
        wa_conversations: (await query(`SELECT COUNT(*) n FROM wa_conversations WHERE telefono IN (${TODOS.map(() => '?').join(',')})`, TODOS))[0].n,
        chats_activos: (await query(`SELECT COUNT(*) n FROM chats_activos WHERE tel IN (${TODOS.map(() => '?').join(',')})`, TODOS))[0].n
    }));

    console.log('── limpieza final');
    await limpiar();
    const restos = {
        conversaciones: (await query(`SELECT COUNT(*) n FROM conversaciones WHERE telefono IN (${TODOS.map(() => '?').join(',')})`, TODOS))[0].n,
        delegaciones_t99: (await query('SELECT COUNT(*) n FROM delegaciones WHERE tenant_id=?', [T99]))[0].n,
        wa_conversations: (await query(`SELECT COUNT(*) n FROM wa_conversations WHERE telefono IN (${TODOS.map(() => '?').join(',')}) OR telefono IN (${TODOS.map(() => '?').join(',')})`, TODOS.concat(TODOS.map(t => t.slice(3)))))[0].n,
        chats_activos: (await query(`SELECT COUNT(*) n FROM chats_activos WHERE tel IN (${TODOS.map(() => '?').join(',')})`, TODOS))[0].n
    };
    ok(Object.values(restos).every(n => Number(n) === 0), 'cero rastros del carril de pruebas', restos);

    console.log(`\n${fallos ? '❌' : '✅'} ${pasos - fallos}/${pasos} pasos OK` + (fallos ? ` — ${fallos} FALLOS` : ''));
    process.exit(fallos ? 1 : 0);
})().catch(async e => { console.error('💥', e); try { await limpiar(); } catch (e2) { } process.exit(2); });
