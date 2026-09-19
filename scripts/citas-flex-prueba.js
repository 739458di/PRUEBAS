// scripts/citas-flex-prueba.js — ESCENARIOS EXTREMOS del subsistema de visitas flexibles (TERRA MOTORS, sandbox: NADA sale a WhatsApp).
//   cd /Users/Shared/PRUEBAS && node scripts/citas-flex-prueba.js [n,n,...]
// Cada escenario usa su propio chat de prueba (tel 52100000001xx) y un RELOJ FIJO (no toca el reloj virtual del universo ni los chats del owner).
// En cada paso se verifican los INVARIANTES: 1 sola visita viva por chat · visita viva ⇒ próxima acción pendiente · toda casilla pendiente pertenece a la realidad actual.
const fs = require('fs'), path = require('path'); const RAIZ = path.join(__dirname, '..');
fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) process.env[l.slice(0, i).trim()] = process.env[l.slice(0, i).trim()] || l.slice(i + 1).trim(); });
const { query, run } = require('../lib/seb/db.js'); const DEMO = require('../lib/seb/demo.js'); const CITAF = require('../lib/seb/citas-flex.js');
const { at } = CITAF._t; const H = 3600000, MIN = 60000;
const TEN = 9, AUTO_WEB = 1081, AUTO2_INV = 236;   // Sentra (catálogo de TERRA) · Mazda 3 (segundo auto SOLO durante la prueba)
const MIE = '2026-09-23', VIE = '2026-09-25', SAB = '2026-09-26', DOM = '2026-09-27', LUN = '2026-09-28';
const soloEstos = (process.argv[2] || '').split(',').map(Number).filter(Boolean);
let T, fallas = 0; const resumen = [];

async function nuevoChat(n) {
    const tel = '52100000001' + String(n).padStart(2, '0'); const p = DEMO.telComprador(tel);
    const v = (await query('SELECT id FROM conversaciones WHERE tenant_id = ? AND telefono = ?', [TEN, p]))[0]; if (v) await borrarChat(Number(v.id), p);
    const d = await DEMO.delegar({ tenant: T, tel, auto_id: AUTO_WEB, auto_nombre: 'Nissan Sentra Sr 2023', nombre: 'Prueba ' + n });
    const ch = (await query('SELECT id, telefono, nombre, tenant_id FROM conversaciones WHERE id = ?', [d.chat_id]))[0];
    await DEMO.salida(T, p, '¿Te late venir a verlo y manejarlo?', 'asistente');   // contexto mínimo: ya platicaban del auto
    return { id: Number(ch.id), telefono: String(ch.telefono), nombre: ch.nombre, tenant_id: TEN, tel, log: [] };
}
async function borrarChat(id, p) { for (const [tb, col] of [['citaf_casillas', 'chat_id'], ['citaf_eventos', 'chat_id'], ['citaf', 'chat_id'], ['seb_turnos', 'chat_id'], ['mensajes', 'conversacion_id'], ['delegaciones', 'chat_id'], ['acciones', 'chat_id'], ['envios', 'chat_id']]) await run('DELETE FROM ' + tb + ' WHERE ' + col + ' = ?', [id]).catch(() => { }); await run('DELETE FROM chats_activos WHERE tenant_id = ? AND tel = ?', [TEN, p]).catch(() => { }); await run('DELETE FROM conversaciones WHERE id = ?', [id]).catch(() => { }); }
function ioDe(ch) { const base = CITAF.ioPara(T, ch); return Object.assign({}, base, { mandar: async (tx) => { ch.log.push('🏢 ' + String(tx).replace(/\n/g, ' ⏎ ')); return base.mandar(tx); }, vendedor: async (tx) => { ch.log.push('   ▸vendedor: ' + tx); return base.vendedor(tx); }, sistema: async (tx) => { if (/NO salió|REABRE|Terminó|ASISTIÓ|PENDIENTE|SIN CIERRE|rescate/i.test(tx)) ch.log.push('   · ' + tx); return base.sistema(tx); }, pin: async (a) => { ch.log.push('🏢 [pin de ubicación]'); return base.pin(a); } }); }
const autoDe = async (ch) => { const c = await CITAF.citaViva(TEN, ch.id); if (c && c.auto_id) return { id: Number(c.auto_id), nombre: c.auto_nombre }; return { id: 291, nombre: 'Nissan Sentra Sr 2023' }; };
async function di(ch, texto, now) { ch.log.push('👤 ' + texto); await DEMO.responder({ tenant: T, tel: ch.tel, texto }); const r = await CITAF.entrante({ tenant: T, chat: ch, auto: await autoDe(ch), io: ioDe(ch), ahoraFijo: now }); ch.log.push('   ⇒ evento: ' + (r.evento || (r.manejado ? '?' : 'no es de cita'))); await invariantes(ch, now); return r; }
async function reloj(ch, hasta) { const h = await CITAF.tick({ tenant: T, ioDe: async () => ioDe(ch), hasta, chatId: ch.id }); ch.log.push('   ⏱ reloj → ' + CITAF.fechaCorta(hasta) + ' · ' + (h.length ? h.map(x => x.tipo + (x.salio ? '' : '✗')).join(', ') : 'nada vencido')); await invariantes(ch, hasta); return h; }
async function vend(ch, evento, extra, now) { ch.log.push('🧑‍💼 vendedor: ' + evento + (extra && extra.datos ? ' ' + JSON.stringify(extra.datos) : '')); const r = await CITAF.vendedor(Object.assign({ tenant: T, chat: ch, evento, auto: await autoDe(ch), io: ioDe(ch), ahoraFijo: now }, extra || {})); await invariantes(ch, now); return r; }
const cita = async (ch) => (await query('SELECT * FROM citaf WHERE chat_id = ? ORDER BY id DESC LIMIT 1', [ch.id]))[0] || null;
const pend = async (ch) => (await query("SELECT tipo, due_ts, version FROM citaf_casillas WHERE chat_id = ? AND estado = 'pendiente' ORDER BY due_ts", [ch.id])).map(k => ({ tipo: k.tipo, due_ts: Number(k.due_ts), version: Number(k.version) }));
async function invariantes(ch, now) {
    const vivas = await query("SELECT id, version, estado FROM citaf WHERE chat_id = ? AND estado IN ('viva','en_camino','esperando_cierre','pospuesta')", [ch.id]);
    ok(ch, vivas.length <= 1, 'INV: una sola visita viva por chat (hay ' + vivas.length + ')', true);
    const p = await query("SELECT k.tipo, k.version, c.version cv, c.estado ce FROM citaf_casillas k JOIN citaf c ON c.id = k.cita_id WHERE k.chat_id = ? AND k.estado = 'pendiente'", [ch.id]);
    if (vivas.length) ok(ch, p.length >= 1, 'INV: visita viva (' + vivas[0].estado + ') con próxima acción pendiente', true);
    ok(ch, p.every(k => Number(k.version) === Number(k.cv)), 'INV: ninguna casilla pendiente de una realidad anterior', true);
    if (!vivas.length) ok(ch, p.length === 0, 'INV: visita terminada sin acciones futuras (quedaban ' + p.length + ')', true);
}
function ok(ch, cond, que, callado) { if (!cond) { fallas++; ch.log.push('   ❌ ' + que); ch.mal = (ch.mal || 0) + 1; } else if (!callado) ch.log.push('   ✅ ' + que); }
const hora = (ts) => CITAF.fechaCorta(Number(ts));
async function sit(ch, now) { const c = await cita(ch); const p = await pend(ch); ch.log.push('   = REALIDAD: ' + (c ? CITAF.situacionDe(T, c, now) : 'sin visita') + ' | PRÓXIMA: ' + (p[0] ? p[0].tipo + ' · ' + hora(p[0].due_ts) : '—')); return { c, p }; }

const ESC = {
    1: ['"Voy sábado como a las 4" → confirma → llega', async (ch) => {
        await di(ch, 'va, voy el sábado como a las 4', at(MIE, 10)); let s = await sit(ch, at(MIE, 10)); ok(ch, s.c && s.c.estado === 'viva' && s.c.precision === 'hora' && Number(s.c.ini_ts) === at(SAB, 16), 'nace: sábado 4 pm, hora exacta');
        await reloj(ch, at(VIE, 18, 5)); await reloj(ch, at(SAB, 9, 35)); await di(ch, 'sí claro, ahí estaré', at(SAB, 9, 50)); s = await sit(ch, at(SAB, 9, 50));
        ok(ch, Number(s.c.confirmada_dia) === 1 && !s.p.some(k => k.tipo === 'empujon' || k.tipo === 'marcar') && s.p.some(k => k.tipo === 'me_avisas'), 'confirmó el día: mueren empujón y "márcale", nace "me avisas"');
        await reloj(ch, at(SAB, 15, 5)); await vend(ch, 'llego', null, at(SAB, 15, 58)); s = await sit(ch, at(SAB, 16)); ok(ch, s.c.estado === 'realizada' && !s.p.length, 'ASISTIÓ y no queda ninguna acción');
    }],
    2: ['"…como a las 4" → "se me hizo tarde" → nueva hora → llega', async (ch) => {
        await di(ch, 'voy el sábado como a las 4', at(MIE, 10)); await reloj(ch, at(SAB, 9, 35)); await di(ch, 'sí ahí nos vemos', at(SAB, 10));
        await di(ch, 'se me hizo tarde', at(SAB, 15, 50)); let s = await sit(ch, at(SAB, 15, 50));
        ok(ch, s.c.estado === 'viva' && s.c.ultima_palabra === 'se_retrasa' && s.c.precision !== 'hora', 'SE RETRASA: sigue viva, NO canceló, NO reprogramó sola, las 4 pm ya no son dato confiable');
        ok(ch, /hora calculas/i.test(ch.log.join('\n')), 'se le preguntó la nueva realidad ("¿como a qué hora calculas?")'); ok(ch, s.p.some(k => k.tipo === 'marcar_pregunta'), 'si calla, el silencio dispara "márcale"');
        await di(ch, 'sí, como a las 6', at(SAB, 16, 5)); s = await sit(ch, at(SAB, 16, 5)); ok(ch, s.c.precision === 'hora' && Number(s.c.ini_ts) === at(SAB, 18) && !s.p.some(k => k.tipo === 'marcar_pregunta'), 'nueva hora 6 pm; la pregunta pendiente murió');
        await di(ch, 'ya llegué', at(SAB, 18, 10)); await vend(ch, 'llego', null, at(SAB, 18, 12)); s = await sit(ch, at(SAB, 18, 12)); ok(ch, s.c.estado === 'realizada', 'ASISTIÓ');
    }],
    3: ['Hora prevista → silencio → segundo intento → responde → llega', async (ch) => {
        await di(ch, 'paso el sábado a las 4', at(MIE, 10)); await reloj(ch, at(SAB, 9, 35)); const h = await reloj(ch, at(SAB, 13)); ok(ch, h.some(x => x.tipo === 'empujon' && x.salio), 'silencio al mensaje del día → salió el segundo intento');
        await di(ch, 'sí voy, perdón andaba ocupado', at(SAB, 13, 20)); const h2 = await reloj(ch, at(SAB, 15, 30)); ok(ch, !h2.some(x => x.tipo === 'marcar' && x.salio), 'respondió: ya NO se le pide al vendedor que le marque');
        await di(ch, 'ya voy en camino', at(SAB, 15, 40)); await vend(ch, 'llego', null, at(SAB, 16, 5)); const s = await sit(ch, at(SAB, 16, 5)); ok(ch, s.c.estado === 'realizada', 'ASISTIÓ');
    }],
    4: ['Hora prevista → silencio absoluto → vence la ventana', async (ch) => {
        await di(ch, 'el sábado a las 4 paso', at(MIE, 10)); const h = await reloj(ch, at(SAB, 18)); ok(ch, ['dia', 'empujon', 'marcar', 'cierre'].every(x => h.some(k => k.tipo === x && k.salio)), 'salieron en orden: mensaje del día → segundo intento → "márcale" → "¿llegó?"');
        let s = await sit(ch, at(SAB, 18)); ok(ch, s.c.estado === 'esperando_cierre', 'el silencio NO canceló: espera la palabra del vendedor');
        await vend(ch, 'no_llego', null, at(SAB, 18, 30)); s = await sit(ch, at(SAB, 18, 30)); ok(ch, s.c.estado === 'pospuesta' && s.p.some(k => k.tipo === 'rescate'), 'no llegó a ESTA cita → PENDIENTE DE REAGENDAR con rescate programado (no limbo)');
        const h2 = await reloj(ch, at('2026-10-10', 12)); s = await sit(ch, at('2026-10-10', 12)); ok(ch, h2.filter(k => k.tipo === 'rescate' && k.salio).length === 2 && s.c.estado === 'no_llego' && !s.p.length, '2 rescates sin respuesta → NO ASISTIÓ (definitivo), sin acciones colgando');
    }],
    5: ['"No alcanzo, mejor mañana"', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); const v1 = (await cita(ch)).version;
        await di(ch, 'no alcanzo a llegar, mejor mañana', at(SAB, 15, 30)); const s = await sit(ch, at(SAB, 15, 30));
        ok(ch, s.c.estado === 'viva' && CITAF._t.ymd(Number(s.c.ini_ts)) === DOM && Number(s.c.version) > Number(v1), 'REPROGRAMÓ a domingo: la intención sigue viva'); ok(ch, s.p.every(k => k.due_ts > at(SAB, 15, 30)) && s.p.some(k => k.tipo === 'cierre' && k.due_ts > at(DOM, 12)), 'las acciones de la cita del sábado murieron; las nuevas son del domingo');
    }],
    6: ['"No alcanzo, yo te aviso cuándo"', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); await di(ch, 'no alcanzo a llegar, yo te aviso cuando pueda reagendar', at(SAB, 15, 30)); let s = await sit(ch, at(SAB, 15, 30));
        ok(ch, s.c.estado === 'pospuesta', 'la cita actual dejó de estar vigente; la intención sigue: PENDIENTE DE REAGENDAR'); ok(ch, s.p.some(k => k.tipo === 'rescate') && s.p.some(k => k.tipo === 'fin_rescate'), 'hay estrategia futura de rescate y un fin (nunca limbo)');
        const h = await reloj(ch, at('2026-09-29', 12)); ok(ch, h.some(k => k.tipo === 'rescate' && k.salio), 'como no volvió a escribir, salió el rescate');
        await di(ch, 'va, el jueves a las 5', at('2026-09-29', 13)); s = await sit(ch, at('2026-09-29', 13)); ok(ch, s.c.estado === 'viva' && Number(s.c.ini_ts) === at('2026-10-01', 17) && !s.p.some(k => /rescate/.test(k.tipo)), 'contestó al rescate → la MISMA visita revive con fecha nueva; el rescate murió');
    }],
    7: ['Reprograma varias veces', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); await di(ch, 'mejor el domingo a las 11', at(MIE, 12)); await di(ch, 'oye siempre no, mejor el lunes a las 5', at(MIE, 15)); await di(ch, 'perdón, siempre sí el sábado a las 4', at(MIE, 18));
        const s = await sit(ch, at(MIE, 18)); const n = (await query('SELECT COUNT(*) n FROM citaf WHERE chat_id = ?', [ch.id]))[0].n; const evs = (await query("SELECT evento FROM citaf_eventos WHERE chat_id = ? AND evento IN ('nace','reprograma','angosta')", [ch.id])).map(e => e.evento);
        ok(ch, Number(n) === 1 && Number(s.c.version) === 4 && Number(s.c.ini_ts) === at(SAB, 16), 'UNA sola visita (no 4), versión 4, realidad actual = sábado 4 pm'); ok(ch, evs.length === 4, 'la historia conserva los 4 momentos (' + evs.join(' → ') + ')');
    }],
    8: ['Cambia de auto pero mantiene la cita', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); const antes = await cita(ch); await di(ch, 'oye mejor quiero ver la mazda', at(MIE, 11)); const s = await sit(ch, at(MIE, 11));
        ok(ch, /mazda/i.test(s.c.auto_nombre || '') && Number(s.c.ini_ts) === Number(antes.ini_ts) && s.c.estado === 'viva' && Number(s.c.id) === Number(antes.id), 'mismo día y hora, misma visita, auto nuevo: ' + s.c.auto_nombre);
    }],
    9: ['Cambia auto y horario a la vez', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); await di(ch, 'mejor quiero ver la mazda y voy el domingo a las 12', at(MIE, 11)); const s = await sit(ch, at(MIE, 11));
        ok(ch, /mazda/i.test(s.c.auto_nombre || '') && Number(s.c.ini_ts) === at(DOM, 12), 'auto = ' + s.c.auto_nombre + ' · cuándo = domingo 12 pm'); ok(ch, /mazda/i.test(ch.log.filter(l => l.startsWith('🏢')).pop() || ''), 'el acuse ya habla del auto nuevo');
    }],
    10: ['"Ya voy" sin haber confirmado', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); await reloj(ch, at(SAB, 9, 35)); await di(ch, 'ya voy', at(SAB, 15, 20)); const s = await sit(ch, at(SAB, 15, 20));
        ok(ch, s.c.estado === 'en_camino' && s.p.length === 1 && s.p[0].tipo === 'cierre', 'EN CAMINO (evidencia física manda): murieron empujón y "márcale"; solo queda recibirlo y cerrar');
    }],
    11: ['Cancela definitivamente', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); await di(ch, 'ya no me interesa, ya compré otro carro, gracias', at(VIE, 10)); const s = await sit(ch, at(VIE, 10));
        ok(ch, s.c.estado === 'cancelada' && !s.p.length, 'intención terminada por su palabra: cero acciones futuras'); const h = await reloj(ch, at(SAB, 18)); ok(ch, !h.some(k => k.salio), 'ningún recordatorio salió después de cancelar');
    }],
    12: ['Dos mensajes contradictorios muy cercanos', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10));
        ch.log.push('👤 sí ahí estaré a las 4  +  👤 no, mejor el domingo a las 11 (misma ráfaga)'); await DEMO.responder({ tenant: T, tel: ch.tel, texto: 'sí ahí estaré a las 4' }); await DEMO.responder({ tenant: T, tel: ch.tel, texto: 'no, mejor el domingo a las 11' });
        await CITAF.entrante({ tenant: T, chat: ch, auto: await autoDe(ch), io: ioDe(ch), ahoraFijo: at(VIE, 10) }); await invariantes(ch, at(VIE, 10)); let s = await sit(ch, at(VIE, 10)); ok(ch, Number(s.c.ini_ts) === at(DOM, 11), 'manda la declaración más reciente: domingo 11');
        ch.log.push('👤👤 dos turnos A LA VEZ: "mejor el lunes a las 5" y "mejor el martes a las 10"'); await DEMO.responder({ tenant: T, tel: ch.tel, texto: 'cambio de planes' });
        await Promise.all([CITAF.entrante({ tenant: T, chat: ch, auto: await autoDe(ch), io: ioDe(ch), ahoraFijo: at(VIE, 11), textoNuevo: 'mejor el lunes a las 5' }), CITAF.entrante({ tenant: T, chat: ch, auto: await autoDe(ch), io: ioDe(ch), ahoraFijo: at(VIE, 11, 1), textoNuevo: 'mejor el martes a las 10' })]);
        await invariantes(ch, at(VIE, 11, 2)); s = await sit(ch, at(VIE, 11, 2)); ok(ch, [at(LUN, 17), at('2026-09-29', 10)].includes(Number(s.c.ini_ts)), 'los dos se aplicaron en serie sobre la realidad fresca: quedó UNA verdad coherente (' + hora(s.c.ini_ts) + ')');
    }],
    13: ['IA y vendedor actualizan al mismo tiempo', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); await DEMO.responder({ tenant: T, tel: ch.tel, texto: 'mejor el domingo a las 11' }); ch.log.push('👤 mejor el domingo a las 11   ‖   🧑‍💼 vendedor agenda lunes 5 pm (simultáneo)');
        const r = await Promise.all([CITAF.entrante({ tenant: T, chat: ch, auto: await autoDe(ch), io: ioDe(ch), ahoraFijo: at(VIE, 10) }), CITAF.vendedor({ tenant: T, chat: ch, evento: 'agenda', datos: { dia_ini: LUN, hora_ini: '17:00' }, auto: await autoDe(ch), io: ioDe(ch), ahoraFijo: at(VIE, 10, 0, 1) })]);
        await invariantes(ch, at(VIE, 10, 1)); const s = await sit(ch, at(VIE, 10, 1)); const n = (await query('SELECT COUNT(*) n FROM citaf WHERE chat_id = ?', [ch.id]))[0].n;
        ok(ch, Number(n) === 1 && [at(DOM, 11), at(LUN, 17)].includes(Number(s.c.ini_ts)) && Number(s.c.version) === 3, 'ninguno pisó al otro a ciegas: 1 visita, versión 3 (los dos cambios quedaron en la historia), verdad final ' + hora(s.c.ini_ts));
        const dup = (await query("SELECT tipo, due_ts, COUNT(*) n FROM citaf_casillas WHERE chat_id = ? AND estado = 'pendiente' GROUP BY tipo, due_ts HAVING n > 1", [ch.id])); ok(ch, !dup.length, 'cero recordatorios duplicados');
        // nacimiento simultáneo (dos procesos intentan crear la visita a la vez)
        const ch2 = await nuevoChat(63); await DEMO.responder({ tenant: T, tel: ch2.tel, texto: 'voy el sábado a las 4' });
        await Promise.all([CITAF.entrante({ tenant: T, chat: ch2, auto: await autoDe(ch2), io: ioDe(ch2), ahoraFijo: at(MIE, 10) }), CITAF.vendedor({ tenant: T, chat: ch2, evento: 'agenda', datos: { dia_ini: SAB, hora_ini: '16:00' }, auto: await autoDe(ch2), io: ioDe(ch2), ahoraFijo: at(MIE, 10, 0, 1) })]);
        const n2 = (await query("SELECT COUNT(*) n FROM citaf WHERE chat_id = ? AND estado IN ('viva','en_camino','esperando_cierre','pospuesta')", [ch2.id]))[0].n; ok(ch, Number(n2) === 1, 'dos procesos naciendo la misma visita a la vez → la base deja UNA'); await invariantes(ch2, at(MIE, 10, 1)); ch.mal = (ch.mal || 0) + (ch2.mal || 0); ch.extra = ch2;
    }],
    14: ['Se reprograma y quedó un recordatorio viejo pendiente', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); const c = await cita(ch); await di(ch, 'mejor el domingo a las 11', at(MIE, 12));
        await run("INSERT INTO citaf_casillas (cita_id, tenant_id, chat_id, clave, tipo, para, due_ts, estado, version) VALUES (?,?,?,?,?,?,?,?,?)", [c.id, TEN, ch.id, c.id + ':v1:dia:ZOMBI', 'dia', 'comprador', at(SAB, 9, 30), 'pendiente', 1]); ch.log.push('   (se siembra a propósito un recordatorio ZOMBI de la cita vieja del sábado)');
        const antes = ch.log.filter(l => l.startsWith('🏢')).length; const h = await CITAF.tick({ tenant: T, ioDe: async () => ioDe(ch), hasta: at(SAB, 9, 40), chatId: ch.id }); ch.log.push('   ⏱ reloj → ' + hora(at(SAB, 9, 40)) + ' · ' + h.map(x => x.tipo + (x.salio ? '' : '✗ ' + x.motivo)).join(', '));
        ok(ch, h.some(x => x.tipo === 'dia' && !x.salio && /realidad anterior/.test(x.motivo)) && !ch.log.filter(l => l.startsWith('🏢')).slice(antes).some(l => /4 pm|s[áa]bado/i.test(l)), 'el zombi NO salió (se detectó que pertenece a una realidad anterior); lo único que salió habla del domingo 11'); await invariantes(ch, at(SAB, 9, 40));
    }],
    15: ['Aparece físicamente sin haber contestado nada', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); await reloj(ch, at(SAB, 13)); await vend(ch, 'llego', null, at(SAB, 15, 45)); const s = await sit(ch, at(SAB, 15, 45));
        ok(ch, s.c.estado === 'realizada' && !s.p.length, 'el HECHO FÍSICO manda sobre el silencio: ASISTIÓ; "márcale" y "¿llegó?" ya no salen');
    }],
    16: ['Llega antes de la hora', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); await di(ch, 'ya llegué, estoy afuera', at(SAB, 13, 10)); let s = await sit(ch, at(SAB, 13, 10)); ok(ch, s.c.estado === 'en_camino' && s.c.ultima_palabra === 'ya_llegue' && /YA LLEGÓ/.test(ch.log.join('\n')), 'alarma inmediata al vendedor aunque faltaban 3 h');
        await vend(ch, 'llego', null, at(SAB, 13, 12)); await vend(ch, 'resultado', { resultado: 'apartó' }, at(SAB, 14)); s = await sit(ch, at(SAB, 14)); ok(ch, s.c.estado === 'realizada' && s.c.resultado === 'apartó', 'ASISTIÓ · resultado guardado');
    }],
    17: ['Se retrasa después de decir "ya voy"', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); await di(ch, 'ya voy en camino', at(SAB, 15, 30)); await di(ch, 'oye hay muchísimo tráfico, voy a llegar tarde', at(SAB, 15, 50)); const s = await sit(ch, at(SAB, 15, 50));
        ok(ch, s.c.estado === 'en_camino', 'sigue EN CAMINO (no se degrada ni se cancela)'); ok(ch, /cuánto calculas/i.test(ch.log.join('\n')) && s.p.some(k => k.tipo === 'cierre' && k.due_ts >= at(SAB, 19)), 'se le preguntó en cuánto llega y el cierre se recorrió al fin del día');
    }],
    18: ['Mensaje ambiguo: no se sabe si sigue viniendo', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); const a = await cita(ch); await di(ch, 'mmm a ver si puedo, ando viendo unas cosas', at(VIE, 17)); let s = await sit(ch, at(VIE, 17));
        ok(ch, s.c.estado === 'viva' && Number(s.c.ini_ts) === Number(a.ini_ts) && s.c.ultima_palabra === 'incierto', 'NO inventó cancelación ni reprogramación: la cita sigue igual, marcada INCIERTA'); ok(ch, /sí vienes|lo movamos/i.test(ch.log.join('\n')) && s.p.some(k => k.tipo === 'marcar_pregunta'), 'disparó la pregunta que falta; si calla → "márcale"');
        await di(ch, 'pues quién sabe', at(VIE, 17, 30)); ok(ch, /sigue sin dejar claro/.test(ch.log.join('\n')), 'segunda ambigüedad: ya no repregunta, escala al vendedor');
    }]
};

(async () => {
    const t = (await query('SELECT id, telefono, nombre, config_json FROM tenants WHERE id = ?', [TEN]))[0]; T = { id: TEN, telefono: t.telefono, nombre: t.nombre, config_json: t.config_json, config: JSON.parse(t.config_json || '{}'), demo: true };
    if (!CITAF.activo(T)) throw new Error('TERRA no tiene citas_flex=1'); await CITAF.asegurar();
    await run("INSERT INTO autos_universo (inv_auto_id, tenant_id, rol, origen, activo, created, updated) SELECT ?,?,?,?,1,?,? WHERE NOT EXISTS (SELECT 1 FROM autos_universo WHERE inv_auto_id = ? AND tenant_id = ?)", [AUTO2_INV, TEN, 'dueno', 'prueba-citaf', Date.now(), Date.now(), AUTO2_INV, TEN]);
    const chats = [];
    try {
        for (const n of Object.keys(ESC).map(Number)) {
            if (soloEstos.length && !soloEstos.includes(n)) continue; const [titulo, fn] = ESC[n]; const ch = await nuevoChat(40 + n); chats.push(ch);
            const t0 = Date.now(); try { await fn(ch); } catch (e) { fallas++; ch.mal = (ch.mal || 0) + 1; ch.log.push('   ❌ EXCEPCIÓN: ' + e.message); }
            if (ch.extra) chats.push(ch.extra);
            console.log('\n━━ ' + n + '. ' + titulo + '  ' + (ch.mal ? '❌' : '✅') + '  (' + Math.round((Date.now() - t0) / 1000) + ' s)'); console.log(ch.log.join('\n')); resumen.push([n, titulo, !ch.mal]);
        }
    } finally {
        for (const ch of chats) await borrarChat(ch.id, ch.telefono);
        await run("DELETE FROM autos_universo WHERE tenant_id = ? AND origen = 'prueba-citaf'", [TEN]).catch(() => { });
    }
    const tb = await CITAF.tablero({ tenant: T }); console.log('\nLIBRETA DE TERRA tras la limpieza: ' + tb.vivas + ' visitas vivas · SIN PRÓXIMA ACCIÓN = ' + tb.sin_proxima_accion);
    console.log('\nRESULTADO: ' + resumen.filter(r => r[2]).length + '/' + resumen.length + ' escenarios OK · ' + fallas + ' verificaciones fallidas'); process.exit(fallas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
