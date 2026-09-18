// lib/seb/citas-flex.js
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// CITAS FLEXIBLES (orden owner 2026-09-18 · SOLO universos con config.citas_flex = 1 → TERRA MOTORS)
//
//  La cita es una VENTANA [ini, fin] (hora exacta = ventana de ancho cero; "el sábado"; "entre jueves y
//  viernes"). Único dato obligatorio: el DÍA. Nace ya confirmada (vendedor = dueño); su acta de
//  nacimiento es el acuse en el chat.
//
//  TRES CAPAS:
//   1) la CITA (estados: viva · en_camino · esperando_cierre → realizada · no_llego · cancelada ·
//      pospuesta · sin_cierre · reemplazada)
//   2) las CASILLAS (recordatorios hijos). La línea del tiempo = planear(cita, ahora): función PURA.
//      Un evento jamás toca mensajes sueltos: cambia la cita y la línea se RECONCILIA sola.
//      Cada casilla REVISA A SU MAMÁ justo antes de salir (estado, versión, silencio real).
//   3) los EVENTOS (único disparador): comprador (lector IA con salida forzada → el CÓDIGO decide),
//      vendedor (botones) y reloj (tick).
//
//  LEYES: el silencio NUNCA cancela · la cita nunca estorba ("ya voy"/"llegó" valen desde cualquier
//  estado) · ningún estado sin reloj (cierre obligatorio) · "se me complicó" es POSPONER, no cancelar ·
//  angostar conserva la ventana original (si no llega hoy y él dijo "sábado o domingo", el domingo sigue).
//
//  RELOJ VIRTUAL (solo sandbox): citaf_reloj.offset_ms → ahora(t) = Date.now() + offset. Permite
//  adelantar el tiempo y ver qué saldría. En universo real offset = 0 y el tick lo llama el cron.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const { query, run } = require('./db.js');

const HAIKU = 'claude-haiku-4-5-20251001';
const H = 3600000, MIN = 60000, DIA = 86400000, TZ = 6 * H;   // Monterrey = UTC-6 fijo
const VIVAS = ['viva', 'en_camino', 'esperando_cierre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// ── tiempo local ─────────────────────────────────────────────────────────────────────────────
const L = ts => new Date(Number(ts) - TZ);
const ymd = ts => L(ts).toISOString().slice(0, 10);
const dow = ts => L(ts).getUTCDay();
const at = (d, h, m) => { const [y, mo, da] = String(d).split('-').map(Number); return Date.UTC(y, mo - 1, da, h, m || 0) + TZ; };
const masDias = (d, n) => ymd(at(d, 12, 0) + n * DIA);
const hm = ts => { const d = L(ts); let h = d.getUTCHours(); const m = d.getUTCMinutes(); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return h + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + ap; };
const diaLargo = ts => { const d = L(ts); return DIAS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' de ' + MESES[d.getUTCMonth()]; };
const fechaCorta = ts => { const d = L(ts); return DIAS[d.getUTCDay()].slice(0, 3) + ' ' + d.getUTCDate() + ' ' + MESES[d.getUTCMonth()].slice(0, 3) + ' · ' + hm(ts); };
const Cap = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

// ── configuración del lote ───────────────────────────────────────────────────────────────────
const HORARIO_DEF = { 0: [10, 15], 1: [9, 19], 2: [9, 19], 3: [9, 19], 4: [9, 19], 5: [9, 19], 6: [9, 19] };   // [abre, cierra] hora local; null = cerrado
const SILENCIO = [21, 8];        // nada sale entre 21:00 y 08:00
const FRANJAS = { manana: [8, 12], mediodia: [12, 14], tarde: [15, 19], noche: [18, 21], tarde_noche: [17, 21] };
function cfgDe(t) { let c = t && t.config; if (!c || typeof c !== 'object') { try { c = JSON.parse((t && t.config_json) || '{}') || {}; } catch (e) { c = {}; } } return c; }
const activo = t => Number(cfgDe(t).citas_flex) === 1;
function horarioDe(t) { const h = cfgDe(t).horario; return (h && typeof h === 'object') ? Object.assign({}, HORARIO_DEF, h) : HORARIO_DEF; }
function abreCierra(t, d) { const hr = horarioDe(t)[dow(at(d, 12, 0))]; if (!hr) return null; const f = x => at(d, Math.floor(x), Math.round((x % 1) * 60)); return { abre: f(hr[0]), cierra: f(hr[1]) }; }
function horarioTexto(t, d) { const ac = abreCierra(t, d); return ac ? ('de ' + hm(ac.abre) + ' a ' + hm(ac.cierra)) : 'cerrado'; }
// saca un instante del horario de silencio (lo recorre a las 08:30 del día que toque)
function fueraDeSilencio(ts) { const h = L(ts).getUTCHours() + L(ts).getUTCMinutes() / 60; if (h >= SILENCIO[0]) return at(masDias(ymd(ts), 1), 8, 30); if (h < SILENCIO[1]) return at(ymd(ts), 8, 30); return ts; }

// ── tablas ───────────────────────────────────────────────────────────────────────────────────
let _listo = false;
async function asegurar() {
    if (_listo) return;
    await run(`CREATE TABLE IF NOT EXISTS citaf (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, tel TEXT, nombre TEXT,
        auto_id INTEGER, auto_nombre TEXT, ini_ts INTEGER NOT NULL, fin_ts INTEGER NOT NULL, ini0_ts INTEGER NOT NULL, fin0_ts INTEGER NOT NULL, precision TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'viva', en_duda INTEGER DEFAULT 0, suave INTEGER DEFAULT 0, confirmada_dia INTEGER DEFAULT 0, callar_hasta_ts INTEGER, avisa_ts INTEGER,
        ultimo_in_ts INTEGER, ultima_palabra TEXT, version INTEGER DEFAULT 1, version_ts INTEGER, datos_json TEXT, previa_id INTEGER, resultado TEXT, razon TEXT, created INTEGER, updated INTEGER)`);
    await run(`CREATE TABLE IF NOT EXISTS citaf_casillas (id INTEGER PRIMARY KEY AUTOINCREMENT, cita_id INTEGER NOT NULL, tenant_id INTEGER, chat_id INTEGER, clave TEXT UNIQUE,
        tipo TEXT NOT NULL, para TEXT NOT NULL DEFAULT 'comprador', due_ts INTEGER NOT NULL, estado TEXT NOT NULL DEFAULT 'pendiente', motivo TEXT, texto TEXT, sent_ts INTEGER, version INTEGER)`);
    await run(`CREATE TABLE IF NOT EXISTS citaf_eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, cita_id INTEGER, tenant_id INTEGER, chat_id INTEGER, ts INTEGER, fuente TEXT, evento TEXT, detalle TEXT)`);
    await run(`CREATE TABLE IF NOT EXISTS citaf_reloj (tenant_id INTEGER PRIMARY KEY, offset_ms INTEGER NOT NULL DEFAULT 0)`);
    await run('CREATE INDEX IF NOT EXISTS ix_citaf_chat ON citaf (tenant_id, chat_id, estado)').catch(() => { });
    await run('CREATE INDEX IF NOT EXISTS ix_citafc_due ON citaf_casillas (tenant_id, estado, due_ts)').catch(() => { });
    _listo = true;
}
async function offsetDe(tId) { await asegurar(); const r = (await query('SELECT offset_ms FROM citaf_reloj WHERE tenant_id = ?', [Number(tId)]))[0]; return r ? Number(r.offset_ms) || 0 : 0; }
async function ahora(tId) { return Date.now() + await offsetDe(tId); }
async function ponerOffset(tId, ms) { await asegurar(); await run('INSERT INTO citaf_reloj (tenant_id, offset_ms) VALUES (?,?) ON CONFLICT(tenant_id) DO UPDATE SET offset_ms = excluded.offset_ms', [Number(tId), Math.max(0, Math.round(ms))]); }
const datosDe = c => { try { return JSON.parse(c.datos_json || '{}') || {}; } catch (e) { return {}; } };
async function citaViva(tId, chatId) { await asegurar(); return (await query(`SELECT * FROM citaf WHERE tenant_id = ? AND chat_id = ? AND estado IN ('viva','en_camino','esperando_cierre') ORDER BY id DESC LIMIT 1`, [Number(tId), Number(chatId)]))[0] || null; }
async function ultimaCita(tId, chatId) { await asegurar(); return (await query('SELECT * FROM citaf WHERE tenant_id = ? AND chat_id = ? ORDER BY id DESC LIMIT 1', [Number(tId), Number(chatId)]))[0] || null; }
async function citaPorId(id) { return (await query('SELECT * FROM citaf WHERE id = ?', [Number(id)]))[0] || null; }
async function bitacora(c, ts, fuente, evento, detalle) { await run('INSERT INTO citaf_eventos (cita_id, tenant_id, chat_id, ts, fuente, evento, detalle) VALUES (?,?,?,?,?,?,?)', [c ? Number(c.id) : null, c ? Number(c.tenant_id) : null, c ? Number(c.chat_id) : null, ts, fuente, evento, detalle == null ? null : (typeof detalle === 'string' ? detalle : JSON.stringify(detalle))]).catch(() => { }); }
async function guardar(c, campos, ts) { const k = Object.keys(campos); if (!k.length) return c; await run('UPDATE citaf SET ' + k.map(x => x + ' = ?').join(', ') + ', updated = ? WHERE id = ?', k.map(x => campos[x]).concat([ts, Number(c.id)])); return Object.assign(c, campos, { updated: ts }); }

// ── ventana a partir de los datos que leyó la IA (el CÓDIGO calcula las fechas) ───────────────
//  → { ok, ini, fin, precision, fuera_horario, motivo }
function ventanaDe(t, d, now) {
    const hoy = ymd(now);
    const okF = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const okH = s => /^\d{1,2}:\d{2}$/.test(String(s || ''));
    if (!okF(d.dia_ini)) return { ok: false, motivo: 'sin_dia' };
    if (d.dia_ini < hoy) return { ok: false, motivo: 'dia_pasado' };
    if (d.dia_ini > masDias(hoy, 45)) return { ok: false, motivo: 'muy_lejos' };
    const dFin = okF(d.dia_fin) && d.dia_fin > d.dia_ini ? d.dia_fin : d.dia_ini;
    const aI = abreCierra(t, d.dia_ini), aF = abreCierra(t, dFin);
    if (!aI || !aF) return { ok: false, motivo: 'cerrado' };
    if (dFin !== d.dia_ini) {   // VENTANA DE DÍAS (máx 3 días de ancho)
        if (at(dFin, 12, 0) - at(d.dia_ini, 12, 0) > 2 * DIA + H) return { ok: false, motivo: 'ventana_ancha' };
        return { ok: true, ini: Math.max(aI.abre, d.dia_ini === hoy ? now : 0), fin: aF.cierra, precision: 'dias' };
    }
    const hhmm = s => { const [h, m] = String(s).split(':').map(Number); return at(d.dia_ini, h, m); };
    let ini, fin, precision;
    if (okH(d.hora_ini) && okH(d.hora_fin) && String(d.hora_fin).padStart(5, '0') > String(d.hora_ini).padStart(5, '0')) { ini = hhmm(d.hora_ini); fin = hhmm(d.hora_fin); precision = 'franja'; }
    else if (okH(d.hora_ini)) { ini = fin = hhmm(d.hora_ini); precision = 'hora'; }
    else if (FRANJAS[d.franja]) { ini = at(d.dia_ini, FRANJAS[d.franja][0], 0); fin = at(d.dia_ini, FRANJAS[d.franja][1], 0); precision = 'franja'; }
    else { ini = aI.abre; fin = aI.cierra; precision = 'dia'; }
    let fuera = false;
    if (precision === 'hora') { if (ini < aI.abre || ini > aI.cierra) fuera = true; }
    else if (precision === 'franja') { const i2 = Math.max(ini, aI.abre), f2 = Math.min(fin, aI.cierra); if (f2 - i2 < 30 * MIN) fuera = true; else { ini = i2; fin = f2; } }
    if (fuera) return { ok: true, fuera_horario: true, ini: Math.max(aI.abre, d.dia_ini === hoy ? now : 0), fin: aI.cierra, precision: 'dia' };
    if (d.dia_ini === hoy) { if (fin < now - 5 * MIN && precision !== 'hora') return { ok: false, motivo: 'ya_paso' }; if (precision === 'hora' && ini < now - 20 * MIN) return { ok: false, motivo: 'ya_paso' }; if (precision !== 'hora') ini = Math.max(ini, now); }
    return { ok: true, ini, fin, precision };
}
function cuandoLargo(t, c) {
    const p = c.precision;
    if (p === 'hora') return Cap(diaLargo(c.ini_ts)) + ' a las ' + hm(c.ini_ts);
    if (p === 'franja') return Cap(diaLargo(c.ini_ts)) + ', entre ' + hm(c.ini_ts) + ' y ' + hm(c.fin_ts);
    if (p === 'dia') return Cap(diaLargo(c.ini_ts)) + ', a la hora que te acomode. Ese día estamos ' + horarioTexto(t, ymd(c.ini_ts));
    const ds = []; for (let d = ymd(c.ini_ts); d <= ymd(c.fin_ts); d = masDias(d, 1)) ds.push(d);
    return 'Entre ' + diaLargo(c.ini_ts) + ' y ' + diaLargo(c.fin_ts) + ', a la hora que te acomode.\n' + ds.map(d => Cap(DIAS[dow(at(d, 12, 0))]) + ' ' + horarioTexto(t, d)).join(' · ');
}
function cuandoCorto(c, now) {
    const rel = d => d === ymd(now) ? 'hoy' : (d === masDias(ymd(now), 1) ? 'mañana' : 'el ' + DIAS[dow(at(d, 12, 0))]);
    const p = c.precision, d = ymd(c.ini_ts);
    if (p === 'hora') return rel(d) + ' a las ' + hm(c.ini_ts);
    if (p === 'franja') return rel(d) + ' entre ' + hm(c.ini_ts) + ' y ' + hm(c.fin_ts);
    if (p === 'dia') return rel(d);
    return 'entre ' + rel(d) + ' y ' + rel(ymd(c.fin_ts));
}

// ── PLANTILLAS (borrador sobrio — el owner las calibra; override por universo en config.citaf_textos) ──
const TXT = {
    nace: x => 'Listo' + x.n + ', ya quedó tu cita confirmada ✅\n' + (x.auto ? x.auto + '\n' : '') + x.cuando + (x.recibe ? '\nTe recibe ' + x.recibe + '.' : '') + (x.pin ? '\nTe paso la ubicación 📍' : ''),
    cambio: x => 'Listo' + x.n + ', ya quedó movida tu cita ✅\n' + (x.auto ? x.auto + '\n' : '') + x.cuando,
    angosta_hoy: x => 'Perfecto' + x.n + ', ' + x.corto + ' te esperamos. Hoy estamos hasta las ' + x.cierre + '.' + (x.pin ? ' Te dejo otra vez la ubicación 📍' : ''),
    fuera_horario: x => x.nombre_coma + 'ese día estamos ' + x.horario + '. ¿Alcanzas en ese horario?',
    r1: x => 'Hola' + x.n + ', ¿cómo vas? Aquí seguimos con tu cita para ver ' + x.elauto + ': ' + x.corto + '. Cualquier cambio me avisas y lo movemos sin problema.',
    vispera_hora: x => 'Hola' + x.n + ', te recuerdo tu cita de mañana a las ' + x.hora + ' para ver ' + x.elauto + '. Si necesitas moverla me dices.',
    vispera_sin_hora: x => 'Hola' + x.n + ', mañana te esperamos para ver ' + x.elauto + '. ¿Como a qué hora crees caer? Es solo para tenerte el auto listo, sin compromiso.',
    dia_hora: x => 'Buen día' + x.n + '. Hoy es tu cita a las ' + x.hora + ' para ver ' + x.elauto + '. ¿Seguimos en pie?',
    dia_sin_hora: x => 'Buen día' + x.n + '. Hoy te esperamos para ver ' + x.elauto + ', estamos hasta las ' + x.cierre + '. ¿Sí alcanzas a venir hoy?',
    dia_multi: x => 'Buen día' + x.n + '. Hoy o mañana te esperamos para ver ' + x.elauto + '. Hoy estamos hasta las ' + x.cierre + '. Me avisas cuando vengas.',
    dia_ultimo: x => 'Buen día' + x.n + '. Hoy estamos hasta las ' + x.cierre + ' para que veas ' + x.elauto + '. ¿Sí alcanzas a venir hoy?',
    empujon: x => x.nombre_coma + '¿sí te esperamos hoy? Si se te complicó no pasa nada, lo movemos.',
    confirma_dia: x => 'Perfecto' + x.n + ', aquí nos vemos.',
    confirma_antes: x => 'Perfecto' + x.n + ', ahí nos vemos.',
    me_avisas: x => x.nombre_coma + 'me avisas cuando vengas en camino para recibirte.',
    ya_voy: x => 'Va' + x.n + ', aquí te esperamos.' + (x.referencia ? ' ' + x.referencia : ''),
    ya_llegue: x => 'Va' + x.n + ', ahorita salen a recibirte.',
    llega_tarde: x => 'Sin problema' + x.n + ', aquí te esperamos.',
    se_complico: x => 'Sin problema' + x.n + '. ¿Te queda mejor ' + x.opA + ' o ' + x.opB + '?',
    promete_avisar: x => 'Va' + x.n + ', sin presión. Quedo pendiente.',
    cancela: x => 'Entendido' + x.n + ', gracias por avisar. Cualquier cosa aquí andamos.',
    revision: x => 'Hola' + x.n + ', ¿cómo vas? ¿Sí se te acomoda venir a ver ' + x.elauto + '?',
    revision_suave: x => 'Hola' + x.n + ', hoy también estamos por aquí hasta las ' + x.cierre + ' por si se te acomoda pasar a ver ' + x.elauto + '.',
    auto_vendido: x => x.nombre_coma + 'te aviso antes de que des la vuelta: ' + x.elauto + ' se acaba de vender. ¿Te muestro opciones parecidas para que aproveches tu visita?',
    mueve_vendedor: x => x.nombre_coma + 'una disculpa, necesitamos mover tu cita. ¿Qué otro día te queda bien?'
};
function texto(t, clave, x) { const o = cfgDe(t).citaf_textos; if (o && typeof o[clave] === 'string' && o[clave].trim()) return o[clave].replace(/\{(\w+)\}/g, (m, k) => x[k] == null ? '' : String(x[k])); return TXT[clave](x); }
function slots(t, c, now) {
    const nom = String(c.nombre || '').trim().split(/\s+/)[0]; const n1 = nom && nom !== '.' && !/^\+?\d/.test(nom) ? Cap(nom.toLowerCase()) : '';
    const ac = abreCierra(t, ymd(Math.max(now, 0))) || {};
    return { n: n1 ? ' ' + n1 : '', nombre_coma: n1 ? n1 + ', ' : '', auto: c.auto_nombre || '', elauto: c.auto_nombre ? 'el ' + c.auto_nombre : 'el auto', cuando: cuandoLargo(t, c), corto: cuandoCorto(c, now), hora: hm(c.ini_ts), cierre: ac.cierra ? hm(ac.cierra) : '', recibe: cfgDe(t).recibe || '', referencia: cfgDe(t).referencia || '' };
}

// ═══ LA LÍNEA DEL TIEMPO: función PURA de (cita, ahora). Devuelve las casillas que DEBEN existir de aquí en adelante. ═══
function planear(t, c, now) {
    const P = []; const v = Number(c.version) || 1; const T0 = Number(c.version_ts) || Number(c.created) || now;
    const add = (tipo, due, para, suf) => { if (due == null) return; P.push({ clave: c.id + ':v' + v + ':' + tipo + (suf ? ':' + suf : ''), tipo, para: para || 'comprador', due_ts: Math.round(due) }); };
    if (c.estado === 'esperando_cierre') {   // RELOJ DEL VENDEDOR que no contesta "¿llegó?"
        const base = Number(c.updated) || now; const m = at(masDias(ymd(base), 1), 10, 0);
        add('cierre_2', m, 'vendedor'); add('sin_cierre', m + DIA, 'sistema'); return P;
    }
    if (c.estado !== 'viva' && c.estado !== 'en_camino') return P;
    const A = Number(c.ini_ts), F = Number(c.fin_ts), dA = ymd(A), dF = ymd(F), multi = dA !== dF, conHora = c.precision === 'hora' || c.precision === 'franja';
    // CIERRE obligatorio (hora exacta: 90 min de espera; ventana: 30 min tras el fin)
    add('cierre', F + (c.precision === 'hora' ? 90 : 30) * MIN, 'vendedor');
    if (c.estado === 'en_camino') return P;   // ya viene: nada más le escribe
    const callar = Number(c.callar_hasta_ts) || 0;
    // REVISIÓN tras "yo te aviso"
    if (c.avisa_ts && Number(c.avisa_ts) < F) add('revision', fueraDeSilencio(Number(c.avisa_ts)), 'comprador', ymd(Number(c.avisa_ts)));
    if (c.suave) {   // ventana original reabierta tras no llegar en la angosta: UN solo mensaje suave por día, sin empujones
        for (let d = dA; d <= dF; d = masDias(d, 1)) { const ac = abreCierra(t, d); if (ac) add('revision_suave', Math.max(ac.abre + 30 * MIN, at(d, 9, 30)), 'comprador', d); }
        return P.filter(x => x.due_ts > now);
    }
    if (c.en_duda) {   // "se me complicó": ya se le ofrecieron 2 opciones; solo una revisión suave en cada día que le quede a la ventana
        for (let d = masDias(ymd(now), 1); d <= dF; d = masDias(d, 1)) add('revision', at(d, 10, 0), 'comprador', d);
        return P.filter(x => x.due_ts > now);
    }
    // MENSAJE DEL DÍA (cada día de la ventana). Con hora: a más tardar 2 h antes. Nació/se movió ese mismo día → ese día ya cuenta como confirmado.
    const Dde = d => { let x = at(d, 9, 30); if (d === dA && conHora) x = Math.min(x, A - 2 * H); return Math.max(x, at(d, 8, 0)); };
    for (let d = dA; d <= dF; d = masDias(d, 1)) {
        if (d === ymd(T0)) continue;
        const ultimo = d === dF; const Dts = Dde(d);
        if (!(c.confirmada_dia && d === dA)) add(multi ? (ultimo ? 'dia_ultimo' : 'dia_multi') : 'dia', Dts, 'comprador', d);
        // EMPUJÓN y "márcale" solo en el ÚLTIMO día; salen únicamente si de verdad hubo silencio (la casilla lo revisa al salir)
        if (ultimo && !(c.confirmada_dia && d === dA)) {
            const limite = (!multi && conHora) ? A : F; const emp = Dts + (limite - Dts) / 2; const mar = emp + (limite - emp) / 2;
            if (limite - Dts >= 90 * MIN) { add('empujon', emp, 'comprador', d); add('marcar', mar, 'vendedor', d); }
        }
    }
    // "ME AVISAS CUANDO VENGAS": solo con el día confirmado y con hora/franja
    if (c.confirmada_dia && conHora && ymd(now) === dA) add('me_avisas', A - 60 * MIN, 'comprador');
    // RECORDATORIOS PREVIOS, proporcionales al hueco entre el nacimiento (o último cambio) y el mensaje del primer día
    const D1 = Dde(dA); const gap = D1 - T0;
    if (dA !== ymd(T0)) {
        const vis = at(masDias(dA, -1), 18, 0);
        const hayVis = vis - T0 >= 5 * H;
        if (hayVis) add('vispera', vis, 'comprador');
        const tope = hayVis ? vis : D1; const hueco = tope - T0;
        if (hueco >= 6 * DIA) { add('r1', fueraDeSilencio(T0 + hueco / 3), 'comprador', 'a'); add('r1', fueraDeSilencio(T0 + 2 * hueco / 3), 'comprador', 'b'); }
        else if (hueco >= 2 * DIA) add('r1', fueraDeSilencio(T0 + hueco / 2), 'comprador', 'a');
    }
    return P.filter(x => x.due_ts > now && !(callar && x.para === 'comprador' && x.due_ts <= callar && ['dia', 'dia_multi', 'dia_ultimo', 'empujon', 'me_avisas', 'r1', 'vispera'].includes(x.tipo)) && !(callar && x.tipo === 'marcar' && x.due_ts <= callar));
}
// Reconciliar = dejar en la tabla EXACTAMENTE el plan: lo pendiente que ya no está en el plan se cancela (con motivo); lo nuevo nace. Lo ya enviado/saltado es historia.
async function reconciliar(t, c, now, motivo) {
    const plan = planear(t, c, now); const claves = new Set(plan.map(p => p.clave));
    const pend = await query("SELECT id, clave FROM citaf_casillas WHERE cita_id = ? AND estado = 'pendiente'", [Number(c.id)]);
    for (const p of pend) if (!claves.has(p.clave)) await run("UPDATE citaf_casillas SET estado = 'cancelada', motivo = ? WHERE id = ?", [motivo || 'la cita cambió', Number(p.id)]);
    for (const p of plan) await run('INSERT OR IGNORE INTO citaf_casillas (cita_id, tenant_id, chat_id, clave, tipo, para, due_ts, estado, version) VALUES (?,?,?,?,?,?,?,?,?)', [Number(c.id), Number(c.tenant_id), Number(c.chat_id), p.clave, p.tipo, p.para, p.due_ts, 'pendiente', Number(c.version) || 1]);
    // una casilla pendiente cuyo horario cambió en el plan (misma clave) se actualiza
    for (const p of plan) await run("UPDATE citaf_casillas SET due_ts = ? WHERE clave = ? AND estado = 'pendiente' AND due_ts <> ?", [p.due_ts, p.clave, p.due_ts]);
}

// ═══ LECTOR DE EVENTOS (IA chica, salida forzada). La IA solo TRADUCE la frase a evento + datos; el código decide todo lo demás. ═══
const EVENTOS = ['agenda_o_cambio', 'confirma', 'llega_tarde', 'promete_avisar', 'ya_voy', 'ya_llegue', 'se_complico', 'cancela', 'cambia_auto', 'no_es_de_cita', 'otra_cosa'];
const SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['razon', 'evento', 'confianza', 'dia_ini', 'dia_fin', 'hora_ini', 'hora_fin', 'franja', 'avisa_dia', 'avisa_hora', 'minutos_tarde', 'restriccion', 'asiste', 'condicion', 'a_cuenta', 'foraneo', 'tambien_pregunta', 'motivo'],
    properties: {
        razon: { type: 'string' }, evento: { type: 'string', enum: EVENTOS }, confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
        dia_ini: { type: 'string' }, dia_fin: { type: 'string' }, hora_ini: { type: 'string' }, hora_fin: { type: 'string' },
        franja: { type: 'string', enum: ['', 'manana', 'mediodia', 'tarde', 'noche', 'tarde_noche'] },
        avisa_dia: { type: 'string' }, avisa_hora: { type: 'string' }, minutos_tarde: { type: 'integer' },
        restriccion: { type: 'string' }, asiste: { type: 'string' }, condicion: { type: 'string' }, a_cuenta: { type: 'boolean' }, foraneo: { type: 'boolean' },
        tambien_pregunta: { type: 'boolean' }, motivo: { type: 'string' }
    }
};
async function haiku(system, content) {
    const apiKey = process.env.CLAUDE_API_KEY; if (!apiKey) return null;
    for (let i = 0; i < 2; i++) {
        try {
            const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: HAIKU, max_tokens: 500, system, messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema: SCHEMA } } }) });
            const j = await r.json(); const tx = j && j.content && j.content[0] && j.content[0].text; if (tx) return JSON.parse(tx);
        } catch (e) { }
    }
    return null;
}
const RE_LLEGUE = /\b(ya llegu[eé]|ya estoy (aqu[ií]|afuera|ah[ií])|estoy afuera|ya ando aqu[ií]|aqu[ií] estoy afuera)\b/i;
const RE_YAVOY = /\b(ya voy( en camino| para all[aá])?|voy en camino|voy para all[aá]|ya sal[ií]|voy saliendo|ya casi llego|estoy a \d+ ?(min|minutos))\b/i;
const RE_TIEMPO = /\b(hoy|ma[ñn]ana|pasado|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|fin de semana|semana|quincena|al rato|alrato|m[aá]s tarde|en la (ma[ñn]ana|tarde|noche)|medio ?d[ií]a|a las? \d|\d ?(am|pm)|voy|paso|pasar|ir a ver|verlo|verla|visita|cita|llego|caigo|vuelta)\b/i;
async function leer({ t, c, now, historial, nuevo, auto }) {
    // compuertas sin IA
    if (RE_LLEGUE.test(nuevo)) return { evento: 'ya_llegue', confianza: 'alta', razon: 'compuerta: ya llegué', tambien_pregunta: false };
    if (RE_YAVOY.test(nuevo) && !/\b(ma[ñn]ana|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i.test(nuevo)) return { evento: 'ya_voy', confianza: 'alta', razon: 'compuerta: ya voy', tambien_pregunta: false };
    if (!c && !RE_TIEMPO.test(nuevo)) return { evento: 'no_es_de_cita', confianza: 'alta', razon: 'compuerta: sin cita viva y sin palabra de tiempo/visita', tambien_pregunta: false };
    const hoy = ymd(now);
    const cal = []; for (let i = 0; i < 10; i++) { const d = masDias(hoy, i); cal.push(DIAS[dow(at(d, 12, 0))] + ' ' + d + ' (' + horarioTexto(t, d) + ')'); }
    const system =
        'Lees el mensaje NUEVO de un comprador de autos usados (WhatsApp, Monterrey) y lo traduces a UN evento del subsistema de CITAS (visitas para ver el auto en el lote). No redactas respuestas. ' +
        'Primero escribe la razón (qué quiso decir de verdad), luego el evento.\n' +
        'EVENTOS:\n' +
        '· agenda_o_cambio = da o cambia CUÁNDO viene a ver el auto: un día, una hora, un rango de horas o de días, o pregunta si puede ir en cierto momento ("cómo andas hoy a las 5", "puedo ir el sábado?", "entre jueves y viernes", "paso más al rato en la tarde", "mejor el otro sábado"). Llena dia_ini (YYYY-MM-DD, del calendario de abajo). dia_fin solo si dio un rango de días ("fin de semana" = sábado a domingo). hora_ini HH:MM 24 h solo si dio hora ("a las 5" viendo autos = 17:00; "a las 10" = 10:00; "5:30" = 17:30). hora_fin solo si dio rango de horas ("entre 1 y 3" = 13:00–15:00). franja si dijo mañana/mediodía/tarde/noche/tarde-noche sin hora. "al rato / más tarde / en un rato" sin hora = hoy sin hora (franja vacía, o la que mencione).\n' +
        '· confirma = dice que sí viene / sigue en pie ("sí", "ahí estaré", "claro", 👍) contestando a nuestro recordatorio o acuse. Si además da una hora nueva → agenda_o_cambio.\n' +
        '· ya_voy = ya va en camino. · ya_llegue = ya está en el lugar.\n' +
        '· llega_tarde = viene pero más tarde de lo pactado HOY, sin mover el día (minutos_tarde si lo dice; si da una hora nueva concreta usa agenda_o_cambio).\n' +
        '· promete_avisar = "yo te aviso", "déjame ver y te digo", "te confirmo mañana" (avisa_dia / avisa_hora si dijo cuándo avisa).\n' +
        '· se_complico = no puede venir / se le complicó / no alcanza a llegar, SIN dar fecha nueva y sin decir que ya no le interesa.\n' +
        '· cancela = SOLO si ya no le interesa, ya compró otro, o cancela en definitiva. "No puedo mañana" NO es cancela.\n' +
        '· cambia_auto = quiere que la visita sea para OTRO auto.\n' +
        '· no_es_de_cita = pregunta del auto, precio, fotos, ubicación, cotización, saludos, gracias, o algo que no toca la visita. "Llego a mi oficina a las 3 y te mando papeles" NO es visita.\n' +
        '· otra_cosa = sí es sobre la visita pero no cabe arriba (llevar mecánico, quién me atiende, que le lleven el auto, etc.).\n' +
        'IMPORTANTE: clasifica SOLO el mensaje NUEVO. La conversación anterior es contexto para entenderlo, no para sacar datos: los DATOS EXTRA y tambien_pregunta salen ÚNICAMENTE de lo que dice el mensaje NUEVO.\n' +
        'DATOS EXTRA (vacío si no aplica): restriccion ("solo fines de semana", "sale a las 6"), asiste (si va otra persona: quién), condicion (de qué depende: crédito, seguro, juntar enganche), a_cuenta (trae auto a cuenta), foraneo (viene de otra ciudad). ' +
        'tambien_pregunta = true si en el mismo mensaje además pregunta algo del auto/dinero/ubicación que hay que contestar. motivo = por qué cancela o se le complicó SOLO si lo dijo con sus letras (si no lo dijo, vacío).\n' +
        'confianza alta solo si un humano lo entendería sin dudar. Si abajo dice CITA VIVA: ninguna, NO hay nada que confirmar ni posponer aunque el historial muestre una cita vieja: solo existen agenda_o_cambio, ya_voy, ya_llegue y no_es_de_cita, y SIEMPRE llenas dia_ini si menciona cuándo viene.\n' +
        'AHORA: ' + DIAS[dow(now)] + ' ' + hoy + ' ' + L(now).toISOString().slice(11, 16) + ' (Monterrey).\nCALENDARIO:\n' + cal.join('\n');
    const content = 'AUTO EN FOCO: ' + (auto && auto.nombre ? auto.nombre : 'ninguno') + '\n' +
        'CITA VIVA: ' + (c ? (cuandoCorto(c, now) + ' · ventana original ' + fechaCorta(c.ini0_ts) + ' → ' + fechaCorta(c.fin0_ts) + ' · estado ' + c.estado + (c.en_duda ? ' (en duda: se le complicó)' : '') + (c.confirmada_dia ? ' (día confirmado)' : '')) : 'ninguna') + '\n' +
        'CONVERSACIÓN (lo último):\n' + historial.map(m => (m.quien === 'comprador' ? 'Comprador' : 'Lote') + ': ' + String(m.texto || '').slice(0, 260).replace(/\n+/g, ' / ')).join('\n') +
        '\nNUEVO del comprador: ' + String(nuevo || '').slice(0, 500);
    const r = await haiku(system, content);
    if (!r || !EVENTOS.includes(r.evento)) return { evento: c ? 'otra_cosa' : 'no_es_de_cita', confianza: 'baja', razon: r ? 'salida inválida' : 'sin IA disponible', tambien_pregunta: true };
    return r;
}

// ── opciones concretas para "se me complicó" (respetan su restricción de fin de semana) ──
function dosOpciones(t, c, now) {
    const soloFinde = /fin(es)? de semana|s[aá]bado|domingo|entre semana (trabaj|no puedo|no puede)|trabaj\w* entre semana|de lunes a viernes/i.test(String(datosDe(c).restriccion || ''));
    const sirve = d => { if (!abreCierra(t, d)) return false; const w = dow(at(d, 12, 0)); return soloFinde ? (w === 0 || w === 6) : true; };
    const ops = []; for (let i = 1; i <= 16 && ops.length < 2; i++) { const d = masDias(ymd(now), i); if (!sirve(d)) continue; if (ops.length === 1 && !soloFinde && i < 3) continue; ops.push(d); }
    const nom = d => d === masDias(ymd(now), 1) ? 'mañana ' + DIAS[dow(at(d, 12, 0))] : 'el ' + diaLargo(at(d, 12, 0));
    return { opA: nom(ops[0] || masDias(ymd(now), 1)), opB: nom(ops[1] || masDias(ymd(now), 7)) };
}

// ═══ PUERTA ÚNICA DE EVENTOS DEL COMPRADOR ═══
//  io = { mandar(texto), pin(autoInvId), vendedor(texto), sistema(texto) }  (la tubería la pone quien llama: sandbox → hilo; real → WhatsApp)
//  → { manejado, seguir_cerebro, evento, cita }
async function entrante({ tenant, chat, auto, io, textoNuevo }) {
    await asegurar();
    const t = tenant, tId = Number(t.id), chatId = Number(chat.id); const now = await ahora(tId);
    const ms = (await query('SELECT direccion d, emisor, texto, ts FROM mensajes WHERE conversacion_id = ? ORDER BY ts DESC, id DESC LIMIT 14', [chatId])).reverse().filter(m => m.emisor !== 'sistema');
    let nuevo = String(textoNuevo || '').trim();
    if (!nuevo) { let i = ms.length - 1; const r = []; while (i >= 0 && ms[i].d === 'in') { r.unshift(ms[i].texto); i--; } nuevo = r.join(' / '); }
    if (!nuevo) return { manejado: false };
    const historial = ms.slice(0, -1).slice(-9).map(m => ({ quien: m.d === 'in' ? 'comprador' : 'lote', texto: m.texto }));
    let c = await citaViva(tId, chatId);
    const ev = await leer({ t, c, now, historial, nuevo, auto });
    // sin cita viva NO existe "confirma / se complicó / te aviso": si trae un día, es una agenda (el historial viejo confunde a la IA); si no, no es de cita
    if (!c && !['agenda_o_cambio', 'ya_voy', 'ya_llegue', 'no_es_de_cita'].includes(ev.evento)) { if (/^\d{4}-\d{2}-\d{2}$/.test(String(ev.dia_ini || ''))) { ev.evento = 'agenda_o_cambio'; if (ev.confianza === 'baja') ev.confianza = 'media'; } else ev.evento = 'no_es_de_cita'; }
    const E = ev.evento;
    // v1: el cerebro decide su etapa por la ÚLTIMA dirección del hilo; si esta capa ya escribió, él calla. Por eso un mensaje mixto
    // (cita + pregunta) lo resuelve esta capa y la pregunta se ESCALA al vendedor; el cerebro solo corre cuando el mensaje NO es de cita.
    const seguir = false;
    if (c) await guardar(c, { ultimo_in_ts: now }, now);
    const notaLector = '🗓 Lector de cita · ' + E + ' (' + (ev.confianza || '?') + ') · ' + String(ev.razon || '').slice(0, 160);
    if (E === 'no_es_de_cita') return { manejado: false, evento: E, nota: notaLector };   // la nota la escribe quien llama DESPUÉS del cerebro (si no, el cerebro cree que ya contestamos)
    await io.sistema(notaLector);
    if (ev.tambien_pregunta) await io.vendedor('💬 En el mismo mensaje también preguntó algo que no es de la cita: "' + nuevo.slice(0, 160) + '". Contéstale tú.');
    const extras = c ? datosDe(c) : {};
    for (const k of ['restriccion', 'asiste', 'condicion']) if (ev[k]) extras[k] = ev[k];
    // compuerta DESPUÉS del modelo: los datos booleanos solo valen si el mensaje NUEVO lo dice con sus letras
    if (ev.a_cuenta && /(a cuenta|tom[ae]n? mi|recib\w* mi|dejar(l[oa])? mi|dar mi (auto|carro|camioneta)|mi (auto|carro|camioneta) (como|de) (enganche|pago))/i.test(nuevo)) extras.a_cuenta = true;
    if (ev.foraneo && /(soy de|vengo de|voy desde|vivo en|estoy en|desde) [a-záéíóúñ]/i.test(nuevo)) extras.foraneo = true;
    const fin = async (o) => { if (c) { await reconciliar(t, c, now, o && o.motivo); } return Object.assign({ manejado: true, seguir_cerebro: seguir, evento: E, cita: c ? Number(c.id) : null }, o || {}); };
    const notaDatos = () => { const x = []; if (extras.restriccion) x.push('restricción: ' + extras.restriccion); if (extras.asiste) x.push('asiste: ' + extras.asiste); if (extras.condicion) x.push('depende de: ' + extras.condicion); if (extras.a_cuenta) x.push('trae auto a cuenta'); if (extras.foraneo) x.push('foráneo'); return x.length ? ' · ' + x.join(' · ') : ''; };
    const nombreV = (chat.nombre && chat.nombre !== '.') ? chat.nombre : ('+' + String(chat.telefono || '').replace(/^521/, '52 1 '));

    // ── AGENDA o CAMBIO (nace · angosta · mueve · revive) ──
    if (E === 'agenda_o_cambio' && ev.confianza !== 'baja') {
        const v = ventanaDe(t, ev, now);
        if (!v.ok) {
            if (v.motivo === 'ventana_ancha' || v.motivo === 'muy_lejos' || v.motivo === 'sin_dia') { await bitacora(c, now, 'comprador', 'intencion', { motivo: v.motivo, nuevo }); return { manejado: false, evento: 'intencion', nota: notaLector + ' → INTENCIÓN (sin día o ventana muy ancha): no es cita todavía' }; }   // no es cita: intención → la atiende el flujo normal
            await io.vendedor('🔴 ' + nombreV + ' propuso un momento que no pude agendar (' + v.motivo + '): "' + nuevo.slice(0, 140) + '"'); await bitacora(c, now, 'comprador', 'otra_cosa', { motivo: v.motivo, nuevo }); return fin({ escalado: true });
        }
        if (auto && auto.vendido) { await io.mandar(texto(t, 'auto_vendido', slots(t, Object.assign({ nombre: chat.nombre, auto_nombre: auto.nombre }, v, { ini_ts: v.ini, fin_ts: v.fin }), now))); await io.vendedor('🔴 ' + nombreV + ' quiso agendar un auto que ya no está activo: ' + auto.nombre); return { manejado: true, seguir_cerebro: false, evento: E }; }
        const hoyMismo = ymd(v.ini) === ymd(now);
        if (!c) {   // NACE (o REVIVE ligada a la anterior)
            const prev = await ultimaCita(tId, chatId);
            const ins = await run(`INSERT INTO citaf (tenant_id, chat_id, tel, nombre, auto_id, auto_nombre, ini_ts, fin_ts, ini0_ts, fin0_ts, precision, estado, confirmada_dia, ultimo_in_ts, ultima_palabra, version, version_ts, datos_json, previa_id, created, updated)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [tId, chatId, String(chat.telefono || ''), chat.nombre || '', auto && auto.id ? Number(auto.id) : null, auto && auto.nombre ? auto.nombre : null, v.ini, v.fin, v.ini, v.fin, v.precision, 'viva', hoyMismo ? 1 : 0, now, 'agenda', 1, now, JSON.stringify(extras), prev ? Number(prev.id) : null, now, now]);
            c = await citaPorId(Number(ins.lastInsertRowid));
            await bitacora(c, now, 'comprador', prev ? 'revive' : 'nace', { ventana: [v.ini, v.fin], precision: v.precision, fuera_horario: !!v.fuera_horario, nuevo });
            const x = slots(t, c, now); x.pin = !!(auto && auto.id);
            if (v.fuera_horario) { await io.mandar(texto(t, 'fuera_horario', Object.assign(x, { horario: horarioTexto(t, ymd(v.ini)) }))); await io.vendedor('⚠️ ' + nombreV + ' pidió venir fuera de horario: "' + nuevo.slice(0, 120) + '". Le dije el horario; si lo esperas, escríbele tú la hora.'); }
            await io.mandar(texto(t, 'nace', x)); if (x.pin) await io.pin(Number(auto.id));
            await io.vendedor('🔔 Cita nueva' + (prev ? ' (regresa: ya había agendado antes)' : '') + ' · ' + nombreV + ' · ' + (c.auto_nombre || 'sin auto') + ' · ' + cuandoCorto(c, now) + notaDatos());
            return fin();
        }
        // ya hay cita viva: ¿ANGOSTA (cae dentro de la ventana original) o MUEVE?
        const dentro = v.ini >= Number(c.ini0_ts) - 5 * MIN && v.fin <= Number(c.fin0_ts) + 5 * MIN;
        const campos = { ini_ts: v.ini, fin_ts: v.fin, precision: v.precision, version: (Number(c.version) || 1) + 1, version_ts: now, en_duda: 0, suave: 0, avisa_ts: null, callar_hasta_ts: null, confirmada_dia: hoyMismo ? 1 : 0, estado: 'viva', ultima_palabra: dentro ? 'da_hora' : 'cambia', datos_json: JSON.stringify(extras) };
        if (!dentro) { campos.ini0_ts = v.ini; campos.fin0_ts = v.fin; }
        await guardar(c, campos, now); await bitacora(c, now, 'comprador', dentro ? 'angosta' : 'mueve', { ventana: [v.ini, v.fin], precision: v.precision, nuevo });
        const x = slots(t, c, now); x.pin = !!c.auto_id && hoyMismo;
        if (v.fuera_horario) { await io.mandar(texto(t, 'fuera_horario', Object.assign(x, { horario: horarioTexto(t, ymd(v.ini)) }))); await io.vendedor('⚠️ ' + nombreV + ' pidió venir fuera de horario: "' + nuevo.slice(0, 120) + '"'); }
        else if (hoyMismo) { await io.mandar(texto(t, 'angosta_hoy', x)); if (x.pin) await io.pin(Number(c.auto_id)); }
        else await io.mandar(texto(t, 'cambio', x));
        await io.vendedor('🔔 ' + nombreV + (dentro ? ' precisó su cita: ' : ' MOVIÓ su cita: ') + cuandoCorto(c, now) + notaDatos());
        return fin({ motivo: dentro ? 'precisó la hora' : 'movió la cita' });
    }

    // ── LLEGAR vale desde CUALQUIER estado (ley: la cita nunca estorba) ──
    if (E === 'ya_voy' || E === 'ya_llegue') {
        if (!c) {   // sin cita viva: si su cita murió hace nada (mismo día o ayer) REVIVE esa misma; si no, nace al vuelo (relámpago) ligada a la anterior
            const prev = await ultimaCita(tId, chatId);
            if (prev && ['no_llego', 'pospuesta', 'sin_cierre'].includes(prev.estado) && ymd(Number(prev.fin0_ts)) >= masDias(ymd(now), -1)) { c = prev; await guardar(c, { version: Number(c.version) + 1, version_ts: now, fin_ts: Math.max(Number(c.fin_ts), now + H) }, now); await bitacora(c, now, 'comprador', 'revive_misma', { estaba: prev.estado, nuevo }); }
        }
        if (!c) {
            const prev = await ultimaCita(tId, chatId); const ac = abreCierra(t, ymd(now)); const finV = ac ? Math.max(ac.cierra, now + H) : now + 3 * H;
            const ins = await run(`INSERT INTO citaf (tenant_id, chat_id, tel, nombre, auto_id, auto_nombre, ini_ts, fin_ts, ini0_ts, fin0_ts, precision, estado, confirmada_dia, ultimo_in_ts, ultima_palabra, version, version_ts, datos_json, previa_id, created, updated)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [tId, chatId, String(chat.telefono || ''), chat.nombre || '', auto && auto.id ? Number(auto.id) : null, auto && auto.nombre ? auto.nombre : null, now, finV, now, finV, 'dia', 'en_camino', 1, now, E, 1, now, JSON.stringify(extras), prev ? Number(prev.id) : null, now, now]);
            c = await citaPorId(Number(ins.lastInsertRowid)); await bitacora(c, now, 'comprador', 'nace_relampago', { nuevo });
        }
        if (E === 'ya_llegue') { await guardar(c, { estado: 'en_camino', ultima_palabra: 'ya_llegue', en_duda: 0, confirmada_dia: 1 }, now); await bitacora(c, now, 'comprador', 'ya_llegue', { nuevo }); await io.mandar(texto(t, 'ya_llegue', slots(t, c, now))); await io.vendedor('🚨 YA LLEGÓ ' + nombreV + ' · ' + (c.auto_nombre || '') + ' — sal a recibirlo. Marca "Llegó" en la cita.'); return fin({ motivo: 'ya llegó' }); }
        await guardar(c, { estado: 'en_camino', ultima_palabra: 'ya_voy', en_duda: 0, confirmada_dia: 1 }, now); await bitacora(c, now, 'comprador', 'ya_voy', { nuevo });
        await io.mandar(texto(t, 'ya_voy', slots(t, c, now))); if (c.auto_id && !(await query("SELECT 1 FROM citaf_eventos WHERE cita_id = ? AND evento = 'pin_enviado' LIMIT 1", [Number(c.id)]))[0]) { await io.pin(Number(c.auto_id)); await bitacora(c, now, 'sistema', 'pin_enviado', null); }
        await io.vendedor('🚗 ' + nombreV + ' YA VIENE EN CAMINO · ' + (c.auto_nombre || '') + notaDatos()); return fin({ motivo: 'ya viene en camino' });
    }
    if (!c) return { manejado: false, evento: E };   // lo demás solo tiene sentido con cita viva

    if (E === 'confirma') {
        const esHoy = ymd(now) >= ymd(Number(c.ini_ts));
        await guardar(c, { confirmada_dia: esHoy ? 1 : Number(c.confirmada_dia) || 0, en_duda: 0, ultima_palabra: 'confirma', datos_json: JSON.stringify(extras) }, now); await bitacora(c, now, 'comprador', esHoy ? 'confirma_dia' : 'confirma_antes', { nuevo });
        await io.mandar(texto(t, esHoy ? 'confirma_dia' : 'confirma_antes', slots(t, c, now)));
        if (esHoy) await io.vendedor('✅ ' + nombreV + ' confirmó que viene hoy · ' + cuandoCorto(c, now));
        return fin({ motivo: 'confirmó' });
    }
    if (E === 'llega_tarde') {
        const mins = Math.max(0, Math.min(240, Number(ev.minutos_tarde) || 0)) || 45; const campos = { ultima_palabra: 'llega_tarde', confirmada_dia: ymd(now) >= ymd(Number(c.ini_ts)) ? 1 : (Number(c.confirmada_dia) || 0), en_duda: 0 };
        if (c.precision === 'hora') { campos.ini_ts = Number(c.ini_ts) + mins * MIN; campos.fin_ts = Number(c.fin_ts) + mins * MIN; if (Number(c.ini0_ts) === Number(c.ini_ts) && Number(c.fin0_ts) === Number(c.fin_ts)) { campos.ini0_ts = campos.ini_ts; campos.fin0_ts = campos.fin_ts; } }   // misma cita, se recorre (no nace otra)
        await guardar(c, campos, now); await bitacora(c, now, 'comprador', 'llega_tarde', { minutos: mins, nuevo });
        await io.mandar(texto(t, 'llega_tarde', slots(t, c, now))); await io.vendedor('⏳ ' + nombreV + ' avisa que llega tarde (~' + mins + ' min) · ' + (c.auto_nombre || '')); return fin({ motivo: 'avisó que llega tarde' });
    }
    if (E === 'promete_avisar') {
        let av = null; if (/^\d{4}-\d{2}-\d{2}$/.test(ev.avisa_dia || '')) { const [h, m] = /^\d{1,2}:\d{2}$/.test(ev.avisa_hora || '') ? ev.avisa_hora.split(':').map(Number) : [11, 0]; av = at(ev.avisa_dia, h, m); }
        if (!av || av <= now) av = (L(now).getUTCHours() < 14 && ymd(now) >= ymd(Number(c.ini_ts))) ? now + 3 * H : at(masDias(ymd(now), 1), 11, 0);
        const finHoy = at(ymd(now), 23, 59);
        if (av >= Number(c.fin_ts)) {   // promete avisar FUERA de la ventana → deja de ser cita (intención con fecha de siguiente contacto)
            await guardar(c, { estado: 'pospuesta', razon: 'prometió avisar después de la ventana', avisa_ts: av, ultima_palabra: 'promete_avisar' }, now); await bitacora(c, now, 'comprador', 'pospuesta', { siguiente_contacto: av, nuevo });
            await io.mandar(texto(t, 'promete_avisar', slots(t, c, now))); await io.vendedor('🟡 ' + nombreV + ' dijo "yo te aviso" para después de su ventana. La cita pasa a INTENCIÓN · siguiente contacto sugerido: ' + fechaCorta(av)); return fin({ motivo: 'pospuesta' });
        }
        await guardar(c, { avisa_ts: av, callar_hasta_ts: finHoy, ultima_palabra: 'promete_avisar', datos_json: JSON.stringify(extras) }, now); await bitacora(c, now, 'comprador', 'promete_avisar', { revision: av, nuevo });
        await io.mandar(texto(t, 'promete_avisar', slots(t, c, now))); await io.vendedor('🟡 ' + nombreV + ' dijo "yo te aviso". Hoy ya no se le insiste; reviso con él ' + fechaCorta(av)); return fin({ motivo: 'dijo "yo te aviso": hoy no se le insiste' });
    }
    if (E === 'se_complico') {
        const ops = dosOpciones(t, c, now);
        await guardar(c, { en_duda: 1, ultima_palabra: 'se_complico', razon: ev.motivo || null, datos_json: JSON.stringify(extras) }, now); await bitacora(c, now, 'comprador', 'se_complico', { opciones: ops, nuevo });
        await io.mandar(texto(t, 'se_complico', Object.assign(slots(t, c, now), ops))); await io.vendedor('🟡 A ' + nombreV + ' se le complicó' + (ev.motivo ? ' (' + ev.motivo + ')' : '') + '. Le ofrecí ' + ops.opA + ' o ' + ops.opB + '. La cita sigue viva, en duda.'); return fin({ motivo: 'se le complicó: ya contestó, no se le insiste' });
    }
    if (E === 'cancela' && ev.confianza === 'alta') {
        await guardar(c, { estado: 'cancelada', razon: ev.motivo || 'canceló el comprador', ultima_palabra: 'cancela' }, now); await bitacora(c, now, 'comprador', 'cancela', { motivo: ev.motivo, nuevo });
        await io.mandar(texto(t, 'cancela', slots(t, c, now))); await io.vendedor('❌ ' + nombreV + ' CANCELÓ su cita' + (ev.motivo ? ': ' + ev.motivo : '') + ' · ' + (c.auto_nombre || '')); return fin({ motivo: 'canceló el comprador' });
    }
    if (E === 'cambia_auto') { await bitacora(c, now, 'comprador', 'cambia_auto', { nuevo }); await io.vendedor('🔁 ' + nombreV + ' quiere ver OTRO auto en su cita (' + cuandoCorto(c, now) + '): "' + nuevo.slice(0, 140) + '". Cambia el auto en foco y la cita lo sigue.'); return { manejado: true, seguir_cerebro: false, evento: E, cita: Number(c.id), escalado: true }; }
    // otra_cosa · cancela sin certeza · agenda con confianza baja → ESCALA, la línea sigue igual
    await guardar(c, { datos_json: JSON.stringify(extras) }, now); await bitacora(c, now, 'comprador', 'otra_cosa', { evento_leido: E, nuevo });
    await io.vendedor('🔴 ' + nombreV + ' dijo algo de su cita que no sé resolver: "' + nuevo.slice(0, 160) + '". Contéstale tú; la cita sigue igual (' + cuandoCorto(c, now) + ').');
    return { manejado: true, seguir_cerebro: false, evento: 'otra_cosa', cita: Number(c.id), escalado: true };
}

// ═══ EVENTOS DEL VENDEDOR (botones) ═══  evento: llego | no_llego | auto_vendido | mueve | resultado
async function vendedor({ tenant, chat, evento, resultado, razon, auto, io }) {
    await asegurar(); const t = tenant, tId = Number(t.id); const now = await ahora(tId);
    let c = await citaViva(tId, Number(chat.id)); const ult = c || await ultimaCita(tId, Number(chat.id));
    if (evento === 'llego') {   // válido SIEMPRE: viva, muerta o inexistente (nace ya realizada)
        if (!c && ult && ['no_llego', 'pospuesta', 'sin_cierre', 'cancelada'].includes(ult.estado) && now - Number(ult.updated) < 3 * DIA) c = ult;
        if (!c) { const ins = await run(`INSERT INTO citaf (tenant_id, chat_id, tel, nombre, auto_id, auto_nombre, ini_ts, fin_ts, ini0_ts, fin0_ts, precision, estado, confirmada_dia, version, version_ts, datos_json, previa_id, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [tId, Number(chat.id), String(chat.telefono || ''), chat.nombre || '', auto && auto.id ? Number(auto.id) : null, auto && auto.nombre ? auto.nombre : null, now, now, now, now, 'dia', 'realizada', 1, 1, now, '{}', ult ? Number(ult.id) : null, now, now]); c = await citaPorId(Number(ins.lastInsertRowid)); await bitacora(c, now, 'vendedor', 'llego_sin_cita', null); }
        else { await guardar(c, { estado: 'realizada' }, now); await bitacora(c, now, 'vendedor', 'llego', null); }
        await reconciliar(t, c, now, 'llegó'); await io.sistema('✅ Cita REALIZADA. Falta el resultado: compró · apartó · no compró · sigue pensando.'); return { ok: true, cita: Number(c.id), estado: 'realizada' };
    }
    if (evento === 'resultado') { if (!ult) return { ok: false, error: 'sin cita' }; await guardar(ult, { resultado: String(resultado || ''), razon: razon || ult.razon || null }, now); await bitacora(ult, now, 'vendedor', 'resultado', { resultado, razon }); return { ok: true, cita: Number(ult.id), resultado }; }
    if (!c) return { ok: false, error: 'no hay cita viva en este chat' };
    if (evento === 'no_llego') {
        const aviso = ['se_complico', 'promete_avisar'].includes(String(c.ultima_palabra)) || Number(c.en_duda) === 1;   // avisó → no es plantón
        await guardar(c, { estado: aviso ? 'pospuesta' : 'no_llego' }, now); await bitacora(c, now, 'vendedor', aviso ? 'pospuesta' : 'no_llego', null); await reconciliar(t, c, now, 'cerrada por el vendedor');
        await io.sistema(aviso ? '🟡 Cerrada como POSPUESTA (había avisado). Pasa a intención; si regresa o llega, revive sola.' : '⚪ Cerrada como NO LLEGÓ. Si aparece después, "Llegó" sigue funcionando.'); return { ok: true, cita: Number(c.id), estado: aviso ? 'pospuesta' : 'no_llego' };
    }
    if (evento === 'auto_vendido' || evento === 'mueve') {
        await guardar(c, { estado: 'cancelada', razon: evento === 'auto_vendido' ? 'auto vendido con cita viva' : 'la movió el vendedor' }, now); await bitacora(c, now, 'vendedor', evento, null); await reconciliar(t, c, now, evento === 'auto_vendido' ? 'el auto se vendió' : 'la movió el vendedor');
        await io.mandar(texto(t, evento === 'auto_vendido' ? 'auto_vendido' : 'mueve_vendedor', slots(t, c, now))); return { ok: true, cita: Number(c.id), estado: 'cancelada' };
    }
    return { ok: false, error: 'evento desconocido' };
}

// ═══ EL RELOJ: ejecuta las casillas vencidas. Cada una REVISA A SU MAMÁ antes de salir. ═══
async function tick({ tenant, ioDe, hasta }) {
    await asegurar(); const t = tenant, tId = Number(t.id); const now = hasta || await ahora(tId); const hechas = [];
    for (let vuelta = 0; vuelta < 40; vuelta++) {
        const k = (await query("SELECT * FROM citaf_casillas WHERE tenant_id = ? AND estado = 'pendiente' AND due_ts <= ? ORDER BY due_ts ASC, id ASC LIMIT 1", [tId, now]))[0]; if (!k) break;
        const c = await citaPorId(k.cita_id); const io = await ioDe(c); const cuando = Number(k.due_ts);
        const saltar = async (m) => { await run("UPDATE citaf_casillas SET estado = 'saltada', motivo = ?, sent_ts = ? WHERE id = ?", [m, cuando, Number(k.id)]); await io.sistema('⏱ ' + fechaCorta(cuando) + ' · ' + k.tipo + ' NO salió: ' + m); hechas.push({ tipo: k.tipo, due_ts: cuando, salio: false, motivo: m }); };
        const salio = async (tx) => { await run("UPDATE citaf_casillas SET estado = 'enviada', texto = ?, sent_ts = ? WHERE id = ?", [tx, cuando, Number(k.id)]); hechas.push({ tipo: k.tipo, due_ts: cuando, salio: true }); };
        if (!c || Number(k.version) !== Number(c.version)) { await saltar('la cita cambió después de programarla'); continue; }
        const x = slots(t, c, cuando); const acD = abreCierra(t, ymd(cuando)); if (acD) x.cierre = hm(acD.cierra);
        const nombreV = (c.nombre && c.nombre !== '.') ? c.nombre : ('+' + String(c.tel || ''));
        const hablo = async (desdeTipo) => { const p = (await query("SELECT sent_ts FROM citaf_casillas WHERE cita_id = ? AND tipo IN (" + desdeTipo.map(() => '?').join(',') + ") AND estado = 'enviada' ORDER BY sent_ts DESC LIMIT 1", [Number(c.id)].concat(desdeTipo)))[0]; return p && Number(c.ultimo_in_ts) > Number(p.sent_ts); };
        // ── casillas del sistema / vendedor ──
        if (k.tipo === 'cierre') {
            if (!['viva', 'en_camino'].includes(c.estado)) { await saltar('la cita ya estaba ' + c.estado); continue; }
            if (Number(c.en_duda) === 1 || (String(c.ultima_palabra) === 'promete_avisar' && c.estado === 'viva')) { await guardar(c, { estado: 'pospuesta', razon: c.razon || 'avisó que se le complicó y ya no concretó' }, cuando); await bitacora(c, cuando, 'reloj', 'pospuesta', null); await salio('cierre automático: pospuesta'); await io.sistema('⏱ ' + fechaCorta(cuando) + ' · Terminó la ventana. Como había avisado, se cierra como POSPUESTA (no plantón) y pasa a intención.'); await reconciliar(t, c, cuando, 'terminó la ventana'); continue; }
            if (c.estado === 'viva' && Number(c.fin0_ts) > Number(c.fin_ts) + H) {   // angostó y no llegó, pero SU ventana original sigue: se reabre suave
                const dSig = masDias(ymd(Number(c.fin_ts)), 1); const ac = abreCierra(t, dSig);
                await guardar(c, { ini_ts: ac ? ac.abre : at(dSig, 9, 0), fin_ts: Number(c.fin0_ts), precision: ymd(Number(c.fin0_ts)) === dSig ? 'dia' : 'dias', suave: 1, confirmada_dia: 0, version: Number(c.version) + 1, version_ts: cuando }, cuando);
                await bitacora(c, cuando, 'reloj', 'reabre_ventana_original', null); await salio('reabre ventana original'); await io.sistema('⏱ ' + fechaCorta(cuando) + ' · No llegó en la hora que precisó, pero su ventana original sigue abierta hasta ' + fechaCorta(Number(c.fin0_ts)) + '. No se cierra: mañana un solo mensaje suave.'); await reconciliar(t, c, cuando, 'reabre la ventana original'); continue;
            }
            await guardar(c, { estado: 'esperando_cierre' }, cuando); await bitacora(c, cuando, 'reloj', 'pregunta_cierre', null); await salio('¿llegó?');
            await io.vendedor('❓ ¿Llegó ' + nombreV + ' a ver ' + (c.auto_nombre || 'el auto') + '? Ciérrala con "Llegó" o "No llegó".'); await reconciliar(t, c, cuando, 'terminó la ventana'); continue;
        }
        if (k.tipo === 'cierre_2') { if (c.estado !== 'esperando_cierre') { await saltar('ya la cerraron'); continue; } await salio('¿llegó? (2)'); await io.vendedor('❓ Sigue sin cierre la cita de ' + nombreV + ' de ayer. ¿Llegó o no llegó?'); continue; }
        if (k.tipo === 'sin_cierre') { if (c.estado !== 'esperando_cierre') { await saltar('ya la cerraron'); continue; } await guardar(c, { estado: 'sin_cierre' }, cuando); await bitacora(c, cuando, 'reloj', 'sin_cierre', null); await salio('sin cierre'); await io.sistema('⏱ ' + fechaCorta(cuando) + ' · Nadie dijo si llegó: queda como SIN CIERRE (se cuenta aparte; tus números no mienten).'); continue; }
        if (k.tipo === 'marcar') {
            if (c.estado !== 'viva' || Number(c.confirmada_dia) === 1 || Number(c.en_duda) === 1) { await saltar(c.estado !== 'viva' ? 'la cita ya estaba ' + c.estado : 'ya contestó'); continue; }
            if (await hablo(['empujon', 'dia', 'dia_ultimo'])) { await saltar('el comprador sí escribió después del recordatorio'); continue; }
            await salio('márcale'); await io.vendedor('📞 Márcale a ' + nombreV + ': no ha confirmado su cita de hoy (' + cuandoCorto(c, cuando) + ' · ' + (c.auto_nombre || '') + '). Ya se le escribió dos veces.'); continue;
        }
        // ── casillas al comprador ──
        if (c.estado !== 'viva') { await saltar('la cita ya estaba ' + c.estado); continue; }
        if (Number(c.callar_hasta_ts) >= cuando && k.tipo !== 'revision') { await saltar('dijo "yo te aviso": hoy no se le insiste'); continue; }
        if (Number(c.en_duda) === 1 && !['revision'].includes(k.tipo)) { await saltar('se le complicó: en duda, no se le insiste'); continue; }
        let tx = null;
        if (k.tipo === 'r1') { if (Number(c.ultimo_in_ts) > cuando - 6 * H) { await saltar('platicó hace menos de 6 h: no hace falta recordarle'); continue; } tx = texto(t, 'r1', x); }
        else if (k.tipo === 'vispera') tx = texto(t, c.precision === 'hora' ? 'vispera_hora' : 'vispera_sin_hora', x);
        else if (k.tipo === 'dia') { if (Number(c.confirmada_dia) === 1) { await saltar('el día ya estaba confirmado'); continue; } tx = texto(t, (c.precision === 'hora' || c.precision === 'franja') ? 'dia_hora' : 'dia_sin_hora', x); }
        else if (k.tipo === 'dia_multi') tx = texto(t, 'dia_multi', x);
        else if (k.tipo === 'dia_ultimo') tx = texto(t, 'dia_ultimo', x);
        else if (k.tipo === 'empujon') { if (Number(c.confirmada_dia) === 1 || await hablo(['dia', 'dia_ultimo'])) { await saltar('ya contestó el mensaje del día'); continue; } tx = texto(t, 'empujon', x); }
        else if (k.tipo === 'me_avisas') { if (Number(c.confirmada_dia) !== 1) { await saltar('no ha confirmado el día'); continue; } tx = texto(t, 'me_avisas', x); }
        else if (k.tipo === 'revision') tx = texto(t, 'revision', x);
        else if (k.tipo === 'revision_suave') tx = texto(t, 'revision_suave', x);
        if (!tx) { await saltar('tipo desconocido'); continue; }
        await io.sistema('⏱ ' + fechaCorta(cuando) + ' · sale: ' + k.tipo); await io.mandar(tx); await salio(tx);
    }
    return hechas;
}

// ═══ LECTURA PARA LA UI ═══
async function estado({ tenant, chat }) {
    await asegurar(); const tId = Number(tenant.id); const off = await offsetDe(tId); const now = Date.now() + off;
    const c = await citaViva(tId, Number(chat.id)) || await ultimaCita(tId, Number(chat.id));
    const out = { ok: true, reloj: { offset_ms: off, ahora_ts: now, ahora: fechaCorta(now), virtual: off > 0 }, horario_hoy: horarioTexto(tenant, ymd(now)), cita: null, casillas: [], eventos: [], historial: [] };
    const sig = (await query("SELECT MIN(due_ts) d FROM citaf_casillas WHERE tenant_id = ? AND estado = 'pendiente'", [tId]))[0]; out.reloj.siguiente_ts = sig && sig.d ? Number(sig.d) : null;
    if (!c) return out;
    out.cita = { id: Number(c.id), estado: c.estado, viva: VIVAS.includes(c.estado), en_duda: !!Number(c.en_duda), suave: !!Number(c.suave), confirmada_dia: !!Number(c.confirmada_dia), precision: c.precision, auto: c.auto_nombre, cuando: cuandoCorto(c, now), ventana: fechaCorta(c.ini_ts) + (Number(c.fin_ts) !== Number(c.ini_ts) ? ' → ' + fechaCorta(c.fin_ts) : ''), ventana_original: (Number(c.ini0_ts) !== Number(c.ini_ts) || Number(c.fin0_ts) !== Number(c.fin_ts)) ? fechaCorta(c.ini0_ts) + ' → ' + fechaCorta(c.fin0_ts) : null, ini_ts: Number(c.ini_ts), fin_ts: Number(c.fin_ts), datos: datosDe(c), resultado: c.resultado || null, razon: c.razon || null, version: Number(c.version), previa_id: c.previa_id ? Number(c.previa_id) : null };
    out.casillas = (await query('SELECT tipo, para, due_ts, estado, motivo, sent_ts FROM citaf_casillas WHERE cita_id = ? ORDER BY due_ts ASC, id ASC', [Number(c.id)])).map(k => ({ tipo: k.tipo, para: k.para, due_ts: Number(k.due_ts), cuando: fechaCorta(k.due_ts), estado: k.estado, motivo: k.motivo || null }));
    out.eventos = (await query('SELECT ts, fuente, evento, detalle FROM citaf_eventos WHERE cita_id = ? ORDER BY id ASC', [Number(c.id)])).map(e => ({ cuando: fechaCorta(e.ts), fuente: e.fuente, evento: e.evento }));
    out.historial = (await query('SELECT id, estado, ini_ts, resultado FROM citaf WHERE tenant_id = ? AND chat_id = ? AND id <> ? ORDER BY id DESC LIMIT 6', [tId, Number(chat.id), Number(c.id)])).map(h => ({ id: Number(h.id), estado: h.estado, cuando: fechaCorta(h.ini_ts), resultado: h.resultado || null }));
    return out;
}
// citas vivas del universo → fila verde del inbox
async function vivasPorChat(tId) { await asegurar(); const r = await query("SELECT chat_id, ini_ts, auto_nombre, estado, confirmada_dia FROM citaf WHERE tenant_id = ? AND estado IN ('viva','en_camino')", [Number(tId)]).catch(() => []); const m = {}; for (const x of r) m[Number(x.chat_id)] = { cita_ts: Number(x.ini_ts), auto: x.auto_nombre || null, estado: 'confirmada' }; return m; }
async function reset(tId) { await asegurar(); for (const tb of ['citaf_casillas', 'citaf_eventos', 'citaf', 'citaf_reloj']) await run('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [Number(tId)]).catch(() => { }); }

module.exports = { activo, asegurar, ahora, offsetDe, ponerOffset, entrante, vendedor, tick, estado, planear, reconciliar, ventanaDe, vivasPorChat, reset, citaViva, fechaCorta, horarioDe, _t: { at, ymd, masDias, hm, fueraDeSilencio, leer, dosOpciones, cuandoCorto, cuandoLargo } };
