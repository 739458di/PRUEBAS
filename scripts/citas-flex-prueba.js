// scripts/citas-flex-prueba.js — ESCENARIOS EXTREMOS del subsistema de visitas flexibles (TERRA MOTORS, sandbox: NADA sale a WhatsApp).
//   cd /Users/Shared/PRUEBAS && node scripts/citas-flex-prueba.js [n,n,...]
// Cada escenario usa su propio chat de prueba (números de prueba 52100000000NN libres) y un RELOJ FIJO (no toca el reloj virtual del universo ni los chats del owner).
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
    // número de prueba EXPLÍCITO del carril 52100000000NN; si ese número ya es de un chat que NO creó esta prueba, se busca otro (jamás se borra un chat ajeno)
    let tel = null, p = null; for (let k = 0; k < 60 && !tel; k++) { const cand = '52100000000' + String(10 + ((30 + n + k) % 90)).padStart(2, '0'); const v = (await query('SELECT id, nombre FROM conversaciones WHERE tenant_id = ? AND telefono = ?', [TEN, cand]))[0]; if (!v) { tel = cand; } else if (/^Prueba \d+$/.test(String(v.nombre || ''))) { await borrarChat(Number(v.id), cand); tel = cand; } } p = tel;
    const d = await DEMO.delegar({ tenant: T, tel, auto_id: AUTO_WEB, auto_nombre: 'Nissan Sentra Sr 2023', nombre: 'Prueba ' + n });
    const ch = (await query('SELECT id, telefono, nombre, tenant_id FROM conversaciones WHERE id = ?', [d.chat_id]))[0];
    await DEMO.salida(T, p, '¿Te late venir a verlo y manejarlo?', 'asistente');   // contexto mínimo: ya platicaban del auto
    return { id: Number(ch.id), telefono: String(ch.telefono), nombre: ch.nombre, tenant_id: TEN, tel, log: [] };
}
async function borrarChat(id, p) { for (const [tb, col] of [['citaf_casillas', 'chat_id'], ['citaf_eventos', 'chat_id'], ['citaf', 'chat_id'], ['seb_turnos', 'chat_id'], ['mensajes', 'conversacion_id'], ['delegaciones', 'chat_id'], ['acciones', 'chat_id'], ['envios', 'chat_id']]) await run('DELETE FROM ' + tb + ' WHERE ' + col + ' = ?', [id]).catch(() => { }); await run('DELETE FROM chats_activos WHERE tenant_id = ? AND tel = ?', [TEN, p]).catch(() => { }); await run('DELETE FROM conversaciones WHERE id = ?', [id]).catch(() => { }); }
function ioDe(ch) { const base = CITAF.ioPara(T, ch); return Object.assign({}, base, { mandar: async (tx) => { ch.log.push('🏢 ' + String(tx).replace(/\n/g, ' ⏎ ')); return base.mandar(tx); }, vendedor: async (tx) => { ch.log.push('   ▸vendedor: ' + tx); return base.vendedor(tx); }, sistema: async (tx) => { if (/NO salió|ventana original|ASISTIÓ|aclaración/i.test(tx)) ch.log.push('   · ' + tx); return base.sistema(tx); }, pin: async (a) => { ch.log.push('🏢 [pin de ubicación]'); return base.pin(a); } }); }
const autoDe = async (ch) => { const c = await CITAF.citaViva(TEN, ch.id); if (c && c.auto_id) return { id: Number(c.auto_id), nombre: c.auto_nombre }; return { id: 291, nombre: 'Nissan Sentra Sr 2023' }; };
async function di(ch, texto, now) { ch.log.push('👤 ' + texto); await DEMO.responder({ tenant: T, tel: ch.tel, texto }); const r = await CITAF.entrante({ tenant: T, chat: ch, auto: await autoDe(ch), io: ioDe(ch), ahoraFijo: now }); ch.log.push('   ⇒ evento: ' + (r.evento || (r.manejado ? '?' : 'no es de cita'))); await invariantes(ch, now); return r; }
async function reloj(ch, hasta) { const h = await CITAF.tick({ tenant: T, ioDe: async () => ioDe(ch), hasta, chatId: ch.id }); ch.log.push('   ⏱ reloj → ' + CITAF.fechaCorta(hasta) + ' · ' + (h.length ? h.map(x => x.tipo + (x.salio ? '' : '✗')).join(', ') : 'nada vencido')); await invariantes(ch, hasta); return h; }
async function vend(ch, evento, extra, now) { ch.log.push('🧑‍💼 vendedor: ' + evento + (extra && extra.datos ? ' ' + JSON.stringify(extra.datos) : '')); const r = await CITAF.vendedor(Object.assign({ tenant: T, chat: ch, evento, auto: await autoDe(ch), io: ioDe(ch), ahoraFijo: now }, extra || {})); await invariantes(ch, now); return r; }
const cita = async (ch) => (await query('SELECT * FROM citaf WHERE chat_id = ? ORDER BY id DESC LIMIT 1', [ch.id]))[0] || null;
const pend = async (ch) => (await query("SELECT tipo, due_ts, version FROM citaf_casillas WHERE chat_id = ? AND estado = 'pendiente' ORDER BY due_ts", [ch.id])).map(k => ({ tipo: k.tipo, due_ts: Number(k.due_ts), version: Number(k.version) }));
async function invariantes(ch, now) {
    const vivas = await query("SELECT id, version, estado, ultima_palabra up FROM citaf WHERE chat_id = ? AND estado IN ('viva','en_camino','pospuesta')", [ch.id]);
    ok(ch, vivas.length <= 1, 'INV: una sola visita viva por chat (hay ' + vivas.length + ')', true);
    const p = await query("SELECT k.tipo, k.version, c.version cv FROM citaf_casillas k JOIN citaf c ON c.id = k.cita_id WHERE k.chat_id = ? AND k.estado = 'pendiente'", [ch.id]);
    const v = vivas[0];
    if (v && v.estado !== 'pospuesta' && v.up !== 'ventana_vencida') ok(ch, p.length >= 1, 'INV: visita con cuándo vigente (' + v.estado + ') tiene su próximo checkpoint', true);
    if (v && v.estado === 'pospuesta') ok(ch, p.length === 0, 'INV: pospuesta = cero acciones programadas (había ' + p.length + ')', true);
    ok(ch, p.every(k => Number(k.version) === Number(k.cv)), 'INV: ninguna casilla pendiente de una realidad anterior', true);
    if (!v) ok(ch, p.length === 0, 'INV: visita terminada sin acciones futuras (quedaban ' + p.length + ')', true);
}
function ok(ch, cond, que, callado) { if (!cond) { fallas++; ch.log.push('   ❌ ' + que); ch.mal = (ch.mal || 0) + 1; } else if (!callado) ch.log.push('   ✅ ' + que); }
const hora = (ts) => CITAF.fechaCorta(Number(ts));
async function sit(ch, now) { const c = await cita(ch); const p = await pend(ch); ch.log.push('   = REALIDAD: ' + (c ? CITAF.situacionDe(T, c, now) : 'sin visita') + ' | PRÓXIMA: ' + (p[0] ? p[0].tipo + ' · ' + hora(p[0].due_ts) : '—')); return { c, p }; }

// turno COMPLETO por el panel (capa de cita + cerebro de Seb), igual que en FyraChat. Usa el reloj del universo (virtual en el sandbox).
process.env.K_PANEL = process.env.K_PANEL || 'citaf-llave-de-prueba'; process.env.K_PUENTE = process.env.K_PUENTE || 'citaf-llave-local';   // llaves que solo viven en este proceso (el cerebro exige que exista una)
process.env.BRIDGE_SEND_URL = 'http://127.0.0.1:9/api/send';   // por si algo intentara salir: puerto muerto (TERRA es sandbox: todo se simula en el hilo)
const panel = require('../api/seb-panel.js');
const llamar = (action, body) => new Promise((okk) => { const res = { setHeader() { }, status(c) { this.c = c; return this; }, json(j) { okk(j); return this; }, end() { okk(null); return this; } }; panel({ method: 'POST', query: { action, vendedor: String(TEN) }, body: Object.assign({ vendedor: String(TEN) }, body), headers: { 'x-api-key': process.env.K_PANEL, 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } }, res).catch(e => okk({ ok: false, error: e.message })); });
async function turno(ch, textoIn) {
    ch.log.push('👤 ' + textoIn + '   (turno completo: cita + cerebro de Seb)'); const desde = (await query('SELECT COALESCE(MAX(id),0) m FROM mensajes WHERE conversacion_id = ?', [ch.id]))[0].m;
    await DEMO.responder({ tenant: T, tel: ch.tel, texto: textoIn }); const r = await llamar('seb_turno', { chat_id: ch.id });
    const ms = await query("SELECT direccion d, emisor, texto FROM mensajes WHERE conversacion_id = ? AND id > ? ORDER BY id", [ch.id, desde]); for (const m of ms) if (m.d === 'out') ch.log.push((m.emisor === 'sistema' ? '   · ' : '🏢 ') + String(m.texto || '').replace(/\n/g, ' ⏎ ').slice(0, 200));
    return { r, outs: ms.filter(m => m.d === 'out' && m.emisor !== 'sistema').map(m => String(m.texto || '')) };
}
const DIAS_N = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']; const MAR = '2026-09-29', JUE = '2026-10-01';
const nRec = async (ch) => (await query("SELECT COUNT(*) n FROM citaf_casillas WHERE chat_id = ? AND estado = 'pendiente' AND para = 'comprador'", [ch.id]))[0].n;

const ESC = {
    1: ['"sábado 5pm" → recordatorios → "mejor a las 6" → mueren los de las 5 → flujo de las 6', async (ch) => {
        await di(ch, 'voy el sábado a las 5', at(MIE, 10)); await reloj(ch, at(VIE, 18, 5)); const v1 = (await cita(ch)).version; await di(ch, 'oye mejor a las 6', at(VIE, 19)); const s = await sit(ch, at(VIE, 19));
        ok(ch, s.c.estado === 'viva' && Number(s.c.ini_ts) === at(SAB, 18) && Number(s.c.version) === Number(v1) + 1, 'sigue VIVA, mismo sábado, 5 → 6 pm');
        const cx = await query("SELECT tipo, motivo FROM citaf_casillas WHERE chat_id = ? AND estado = 'cancelada' AND version = ?", [ch.id, v1]); ok(ch, cx.length >= 3 && cx.every(k => k.motivo), 'los pendientes de las 5 pm quedaron cancelados CON motivo (' + cx.map(k => k.tipo).join(', ') + ')');
        ok(ch, s.p.some(k => k.tipo === 'dia') && s.p.some(k => k.tipo === 'vence' && k.due_ts === at(SAB, 19, 30)), 'nació el flujo de las 6 pm (vence 7:30 pm)'); ok(ch, /Cita actualizada — .*5 pm → s[áa]bado 6 pm/.test(ch.log.join('\n')), 'aviso al vendedor: "Cita actualizada — … 5 pm → … 6 pm"');
    }],
    2: ['"sábado 5pm" → silencio a TODO → no se inventa cancelación → vence → aclaración a la mañana siguiente', async (ch) => {
        await di(ch, 'voy el sábado a las 5', at(MIE, 10)); const h = await reloj(ch, at(SAB, 18, 40)); let s = await sit(ch, at(SAB, 18, 40));
        ok(ch, ['r1', 'vispera', 'dia', 'empujon', 'marcar', 'vence'].every(x => h.some(k => k.tipo === x && k.salio)), 'con puro silencio corrieron los checkpoints que ya correspondían, en orden');
        ok(ch, s.c.estado === 'viva' && s.c.ultima_palabra === 'ventana_vencida', 'NO canceló, NO "no llegó": sigue VIVA con el dato "ventana vencida"'); ok(ch, /⚠️ Terminó la ventana de .* sin llegada acreditada/.test(ch.log.join('\n')), 'aviso al vendedor de ventana vencida (uno solo, sin perseguirlo)');
        ok(ch, s.p.length === 1 && s.p[0].tipo === 'aclaracion' && s.p[0].due_ts === at(DOM, 9, 30), 'única acción futura: aclaración el domingo 9:30 am');
        await reloj(ch, at(DOM, 9, 35)); ok(ch, /alcanzaste a pasar ayer/.test(ch.log.join('\n')), 'salió la pregunta para sacarnos de la duda');
    }],
    3: ['ventana vencida → aclaración → "sí fui" → REALIZADA', async (ch) => {
        await di(ch, 'voy el sábado a las 5', at(MIE, 10)); await reloj(ch, at(DOM, 9, 35)); await di(ch, 'sí fui, ya lo vi ayer', at(DOM, 10)); const s = await sit(ch, at(DOM, 10)); ok(ch, s.c.estado === 'realizada' && !s.p.length, 'REALIZADA por palabra clara del cliente; cero acciones futuras');
    }],
    4: ['ventana vencida → aclaración → "voy el martes" → VIVA martes', async (ch) => {
        await di(ch, 'voy el sábado a las 5', at(MIE, 10)); await reloj(ch, at(DOM, 9, 35)); await di(ch, 'no pude, pero voy el martes', at(DOM, 10)); const s = await sit(ch, at(DOM, 10));
        ok(ch, s.c.estado === 'viva' && s.c.ultima_palabra !== 'ventana_vencida' && CITAF._t.ymd(Number(s.c.ini_ts)) === MAR && s.c.precision === 'dia', 'VIVA + martes, hora abierta (misma visita, historia conservada)'); ok(ch, s.p.some(k => k.tipo === 'vence' && k.due_ts > at(MAR, 12)), 'nació el flujo del martes');
    }],
    5: ['ventana vencida → aclaración → silencio → NO se infiere "no llegó"', async (ch) => {
        await di(ch, 'voy el sábado a las 5', at(MIE, 10)); await reloj(ch, at(DOM, 9, 35)); const h = await reloj(ch, at('2026-10-20', 12)); const s = await sit(ch, at('2026-10-20', 12));
        ok(ch, s.c.estado === 'viva' && s.c.ultima_palabra === 'ventana_vencida' && !h.some(k => k.salio), '3 semanas de silencio: sigue VIVA + ventana vencida; nada más salió, nada se concluyó');
        const tb = await CITAF.tablero({ tenant: T }); const f = tb.filas.find(x => x.chat_id === ch.id); ok(ch, f && f.grupo === 'vencidas' && !!f.espera && !tb.sin_proxima.includes(f.cita_id), 'en la libreta aparece como "ventana vencida · sin resolver" con su razón de espera (no cuenta como olvidada)');
        await vend(ch, 'llego', null, at('2026-10-20', 13)); ok(ch, (await cita(ch)).estado === 'realizada', 'y el botón Llegó del vendedor sigue mandando');
    }],
    6: ['"hoy no alcanzo" → se pregunta el nuevo cuándo → "jueves" → VIVA jueves sin pasar por pospuesta', async (ch) => {
        await di(ch, 'voy el sábado a las 5', at(MIE, 10)); await di(ch, 'hoy no alcanzo', at(SAB, 15)); let s = await sit(ch, at(SAB, 15));
        ok(ch, s.c.estado === 'viva' && Number(s.c.en_duda) === 1 && /qué día te quedaría mejor/.test(ch.log.join('\n')), 'se le preguntó "¿qué día te quedaría mejor?"; NO entró a pospuesta'); ok(ch, (await nRec(ch)) === 0, 'los recordatorios de la fecha vieja ya no salen');
        await di(ch, 'el jueves', at(SAB, 15, 10)); s = await sit(ch, at(SAB, 15, 10)); const pasoPorPos = (await query("SELECT COUNT(*) n FROM citaf_eventos WHERE chat_id = ? AND evento = 'sin_fecha'", [ch.id]))[0].n;
        ok(ch, s.c.estado === 'viva' && CITAF._t.ymd(Number(s.c.ini_ts)) === JUE && Number(pasoPorPos) === 0, 'VIVA + jueves 1 oct, hora abierta; jamás pasó por pospuesta'); ok(ch, /Cita movida — .*s[áa]bado 5 pm → jueves, hora abierta/.test(ch.log.join('\n')), 'aviso: "Cita movida — … sábado 5 pm → jueves, hora abierta"');
    }],
    7: ['"hoy no alcanzo" → "yo te aviso" → POSPUESTA → ningún rescate automático', async (ch) => {
        await di(ch, 'voy el sábado a las 5', at(MIE, 10)); await di(ch, 'hoy no alcanzo', at(SAB, 15)); await di(ch, 'yo te aviso', at(SAB, 15, 10)); const s = await sit(ch, at(SAB, 15, 10));
        ok(ch, s.c.estado === 'pospuesta' && !s.p.length, 'POSPUESTA (sin cuándo) y CERO acciones programadas'); ok(ch, /quedó sin fecha \/ pendiente de que vuelva a indicar cuándo/.test(ch.log.join('\n')), 'aviso al vendedor: quedó sin fecha');
        const h = await reloj(ch, at('2026-11-15', 12)); ok(ch, !h.length && (await cita(ch)).estado === 'pospuesta', '7 semanas después: ni un rescate, ni un mensaje; sigue estacionada');
        const tb = await CITAF.tablero({ tenant: T }); const f = tb.filas.find(x => x.chat_id === ch.id); ok(ch, f && f.grupo === 'sin_fecha' && !f.dias.length, 'fuera del calendario; visible en "Sin fecha"');
    }],
    8: ['POSPUESTA → pregunta por financiamiento → se responde normal → sigue pospuesta', async (ch) => {
        const now = await CITAF.ahora(TEN); await di(ch, 'voy mañana a las 5', now); await di(ch, 'no alcanzo, yo te aviso cuando pueda', now + 5 * MIN); ok(ch, (await cita(ch)).estado === 'pospuesta', 'quedó pospuesta');
        const x = await turno(ch, 'oye y manejan financiamiento?'); const s = await sit(ch, now + 10 * MIN);
        ok(ch, x.outs.length >= 1, 'el flujo comercial contestó (' + x.outs.length + ' burbujas)'); ok(ch, s.c.estado === 'pospuesta' && !s.p.length, 'la visita sigue POSPUESTA: la plática comercial no la tocó');
    }],
    9: ['POSPUESTA → "puedo el martes" → VIVA martes → nace el flujo de nuevo', async (ch) => {
        await di(ch, 'voy el sábado a las 5', at(MIE, 10)); await di(ch, 'no voy a poder, yo te aviso', at(VIE, 10)); const id1 = (await cita(ch)).id; await di(ch, 'ya vi, puedo el martes', at(DOM, 12)); const s = await sit(ch, at(DOM, 12));
        ok(ch, s.c.estado === 'viva' && Number(s.c.id) === Number(id1) && CITAF._t.ymd(Number(s.c.ini_ts)) === MAR, 'la MISMA visita vuelve a VIVA + martes'); ok(ch, s.p.some(k => k.tipo === 'dia') && s.p.some(k => k.tipo === 'vence'), 'nació otra vez el flujo de cita'); ok(ch, /Nueva fecha — /.test(ch.log.join('\n')), 'aviso al vendedor: "Nueva fecha — …"');
    }],
    10: ['"ya voy" → EN CAMINO → "ya llegué" → REALIZADA', async (ch) => {
        await di(ch, 'voy el sábado a las 5', at(MIE, 10)); await di(ch, 'ya voy', at(SAB, 16, 20)); let s = await sit(ch, at(SAB, 16, 20)); ok(ch, s.c.estado === 'en_camino' && s.p.length === 1 && s.p[0].tipo === 'vence' && /🚗 .* va en camino para ver/.test(ch.log.join('\n')), 'EN CAMINO; mueren los recordatorios; aviso "🚗 … va en camino para ver …"');
        await di(ch, 'ya llegué', at(SAB, 16, 55)); s = await sit(ch, at(SAB, 16, 55)); ok(ch, s.c.estado === 'realizada' && !s.p.length && /✅ .* llegó para ver/.test(ch.log.join('\n')), 'REALIZADA por "ya llegué"; aviso "✅ … llegó para ver …"');
    }],
    11: ['sin respuesta → llega físicamente → vendedor pulsa Llegó → REALIZADA', async (ch) => {
        await di(ch, 'voy el sábado a las 5', at(MIE, 10)); await reloj(ch, at(SAB, 15)); await vend(ch, 'llego', null, at(SAB, 16, 50)); const s = await sit(ch, at(SAB, 16, 50)); ok(ch, s.c.estado === 'realizada' && !s.p.length, 'el hecho físico manda sobre el silencio: REALIZADA, sin acciones colgando');
    }],
    12: ['CANCELADA → una semana después "siempre sí, puedo mañana" → nueva visita viva', async (ch) => {
        await di(ch, 'voy el sábado a las 5', at(MIE, 10)); await di(ch, 'ya no me interesa, ya compré otro', at(VIE, 10)); const id1 = (await cita(ch)).id; ok(ch, (await cita(ch)).estado === 'cancelada' && !(await pend(ch)).length, 'cancelada, sin acciones futuras');
        await di(ch, 'oye siempre sí, puedo mañana', at('2026-10-02', 11)); const s = await sit(ch, at('2026-10-02', 11));
        ok(ch, s.c.estado === 'viva' && Number(s.c.id) !== Number(id1) && Number(s.c.previa_id) === Number(id1) && CITAF._t.ymd(Number(s.c.ini_ts)) === '2026-10-03', 'visita NUEVA viva (ligada a la cancelada): el estado final era de esa intención, no del cliente'); ok(ch, s.p.some(k => k.tipo === 'vence'), 'con su flujo completo');
    }],
    13: ['un solo mensaje: "No puedo mañana, mejor <día> a las 5. ¿Aceptan crédito?"', async (ch) => {
        const now = await CITAF.ahora(TEN); const d3 = CITAF._t.masDias(CITAF._t.ymd(now), 3); const nomDia = DIAS_N[new Date(at(d3, 12) - 6 * H).getUTCDay()];
        await di(ch, 'voy mañana a las 4', now); const x = await turno(ch, 'No puedo mañana, mejor el ' + nomDia + ' a las 5. ¿Aceptan crédito?'); const s = await sit(ch, now + 5 * MIN);
        ok(ch, s.c.estado === 'viva' && Number(s.c.ini_ts) === at(d3, 17) && s.c.precision === 'hora', 'cita: la de mañana dejó de aplicar → VIVA + ' + nomDia + ' 5 pm');
        ok(ch, x.r && x.r.comercial && x.r.comercial.ok && x.outs.some(o => /cr[eé]dito|financ|banco|enganche/i.test(o)), 'la pregunta de crédito la contestó el flujo comercial (' + ((x.r && x.r.comercial && x.r.comercial.tipo) || '?') + ')');
        ok(ch, x.outs.some(o => /ya quedó movida tu cita/i.test(o)), 'y además salió el acuse del cambio de cita'); const evs = (await query("SELECT evento FROM citaf_eventos WHERE chat_id = ? ORDER BY id", [ch.id])).map(e => e.evento); ok(ch, !evs.some(e => /credito|comercial/i.test(e)), 'la pregunta comercial NO se volvió evento ni estado de la cita (' + evs.join(' → ') + ')');
    }],
    14: ['EXTRA · IA y vendedor actualizan a la vez + nacimiento simultáneo', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); await DEMO.responder({ tenant: T, tel: ch.tel, texto: 'mejor el domingo a las 11' }); ch.log.push('👤 mejor el domingo a las 11   ‖   🧑‍💼 vendedor agenda lunes 5 pm (simultáneo)');
        await Promise.all([CITAF.entrante({ tenant: T, chat: ch, auto: await autoDe(ch), io: ioDe(ch), ahoraFijo: at(VIE, 10) }), CITAF.vendedor({ tenant: T, chat: ch, evento: 'agenda', datos: { dia_ini: LUN, hora_ini: '17:00' }, auto: await autoDe(ch), io: ioDe(ch), ahoraFijo: at(VIE, 10) })]);
        await invariantes(ch, at(VIE, 10, 1)); const s = await sit(ch, at(VIE, 10, 1)); const n = (await query('SELECT COUNT(*) n FROM citaf WHERE chat_id = ?', [ch.id]))[0].n;
        ok(ch, Number(n) === 1 && [at(DOM, 11), at(LUN, 17)].includes(Number(s.c.ini_ts)) && Number(s.c.version) === 3, 'ninguno pisó al otro a ciegas: 1 visita, versión 3, una sola verdad (' + hora(s.c.ini_ts) + ')');
        const dup = await query("SELECT tipo, due_ts, COUNT(*) n FROM citaf_casillas WHERE chat_id = ? AND estado = 'pendiente' GROUP BY tipo, due_ts HAVING n > 1", [ch.id]); ok(ch, !dup.length, 'cero recordatorios duplicados');
        const ch2 = await nuevoChat(63); await DEMO.responder({ tenant: T, tel: ch2.tel, texto: 'voy el sábado a las 4' });
        await Promise.all([CITAF.entrante({ tenant: T, chat: ch2, auto: await autoDe(ch2), io: ioDe(ch2), ahoraFijo: at(MIE, 10) }), CITAF.vendedor({ tenant: T, chat: ch2, evento: 'agenda', datos: { dia_ini: SAB, hora_ini: '16:00' }, auto: await autoDe(ch2), io: ioDe(ch2), ahoraFijo: at(MIE, 10) })]);
        const n2 = (await query("SELECT COUNT(*) n FROM citaf WHERE chat_id = ? AND estado IN ('viva','en_camino','pospuesta')", [ch2.id]))[0].n; ok(ch, Number(n2) === 1, 'dos procesos naciendo la misma visita a la vez → la base deja UNA'); await invariantes(ch2, at(MIE, 10, 1)); ch.mal = (ch.mal || 0) + (ch2.mal || 0); ch.extra = ch2;
    }],
    15: ['EXTRA · recordatorio ZOMBI de una realidad vieja', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); const c = await cita(ch); await di(ch, 'mejor el domingo a las 11', at(MIE, 12));
        await run("INSERT INTO citaf_casillas (cita_id, tenant_id, chat_id, clave, tipo, para, due_ts, estado, version) VALUES (?,?,?,?,?,?,?,?,?)", [c.id, TEN, ch.id, c.id + ':v1:dia:ZOMBI', 'dia', 'comprador', at(SAB, 9, 30), 'pendiente', 1]); ch.log.push('   (se siembra a propósito un recordatorio ZOMBI de la cita vieja del sábado)');
        const antes = ch.log.filter(l => l.startsWith('🏢')).length; const h = await CITAF.tick({ tenant: T, ioDe: async () => ioDe(ch), hasta: at(SAB, 9, 40), chatId: ch.id });
        ok(ch, h.some(x => x.tipo === 'dia' && !x.salio && /realidad anterior/.test(x.motivo)) && !ch.log.filter(l => l.startsWith('🏢')).slice(antes).some(l => /4 pm|s[áa]bado/i.test(l)), 'el zombi NO salió (pertenece a una realidad anterior); lo único que salió habla del domingo 11'); await invariantes(ch, at(SAB, 9, 40));
    }],
    16: ['EXTRA · cambia de auto (solo) y cambia auto + horario', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); const a = await cita(ch); await di(ch, 'oye mejor quiero ver la mazda', at(MIE, 11)); let s = await sit(ch, at(MIE, 11));
        ok(ch, /mazda/i.test(s.c.auto_nombre || '') && Number(s.c.ini_ts) === Number(a.ini_ts) && s.c.estado === 'viva' && Number(s.c.id) === Number(a.id), 'cambio de auto = EVENTO: mismo estado, mismo cuándo, auto nuevo (' + s.c.auto_nombre + ')');
        await di(ch, 'siempre sí el sentra, y voy el domingo a las 12', at(MIE, 12)); s = await sit(ch, at(MIE, 12)); ok(ch, /sentra/i.test(s.c.auto_nombre || '') && Number(s.c.ini_ts) === at(DOM, 12), 'auto y horario en un solo mensaje: ' + s.c.auto_nombre + ' · domingo 12 pm');
    }],
    17: ['EXTRA · "se me hizo tarde" → nueva hora · y retraso después de "ya voy"', async (ch) => {
        await di(ch, 'voy el sábado como a las 4', at(MIE, 10)); await di(ch, 'se me hizo tarde', at(SAB, 15, 50)); let s = await sit(ch, at(SAB, 15, 50));
        ok(ch, s.c.estado === 'viva' && s.c.ultima_palabra === 'se_retrasa' && s.c.precision !== 'hora' && /hora calculas/i.test(ch.log.join('\n')) && s.p.some(k => k.tipo === 'marcar_pregunta'), 'SE RETRASA: no canceló ni reprogramó sola; las 4 pm dejaron de ser dato; se preguntó la hora');
        await di(ch, 'sí, como a las 6', at(SAB, 16, 5)); s = await sit(ch, at(SAB, 16, 5)); ok(ch, s.c.precision === 'hora' && Number(s.c.ini_ts) === at(SAB, 18) && !s.p.some(k => k.tipo === 'marcar_pregunta'), 'nueva hora 6 pm; la pregunta pendiente murió');
        await di(ch, 'ya voy en camino', at(SAB, 17, 30)); await di(ch, 'uy hay muchísimo tráfico, voy a llegar tarde', at(SAB, 17, 50)); s = await sit(ch, at(SAB, 17, 50)); ok(ch, s.c.estado === 'en_camino' && /cuánto calculas/i.test(ch.log.join('\n')), 'retraso estando EN CAMINO: no se degrada; se pregunta en cuánto llega');
    }],
    18: ['EXTRA · mensaje ambiguo: no se inventa nada', async (ch) => {
        await di(ch, 'voy el sábado a las 4', at(MIE, 10)); const a = await cita(ch); await di(ch, 'mmm a ver si puedo, ando viendo unas cosas', at(VIE, 17)); const s = await sit(ch, at(VIE, 17));
        ok(ch, s.c.estado === 'viva' && Number(s.c.ini_ts) === Number(a.ini_ts) && s.c.ultima_palabra === 'incierto' && /sí vienes|lo movamos/i.test(ch.log.join('\n')), 'la cita sigue igual; salió la pregunta aclaratoria mínima');
        await di(ch, 'pues quién sabe', at(VIE, 17, 30)); ok(ch, /sigue sin dejar claro/.test(ch.log.join('\n')), 'segunda ambigüedad: ya no repregunta, te escala a ti');
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
