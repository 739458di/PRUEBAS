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
const VIVAS = ['viva', 'en_camino', 'esperando_cierre', 'pospuesta'];   // 'pospuesta' = PENDIENTE DE REAGENDAR: la intención sigue viva, sin fecha, con rescate programado
const VIVAS_SQL = "('viva','en_camino','esperando_cierre','pospuesta')";
// DESTINOS FINALES: realizada (ASISTIÓ) · cancelada / no_llego / sin_cierre (NO ASISTIÓ: por su palabra · se agotó el rescate o lo cerró el vendedor · nadie supo)
class Conflicto extends Error { }
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
    // UNA SOLA VISITA VIVA POR CHAT, garantizada por la base (dos procesos que intenten nacerla a la vez: el segundo choca y se convierte en CAMBIO de la primera)
    await run("UPDATE citaf SET estado = 'reemplazada' WHERE estado IN " + VIVAS_SQL + " AND id NOT IN (SELECT MAX(id) FROM citaf WHERE estado IN " + VIVAS_SQL + " GROUP BY tenant_id, chat_id)").catch(() => { });
    await run('CREATE UNIQUE INDEX IF NOT EXISTS ux_citaf_viva ON citaf (tenant_id, chat_id) WHERE estado IN ' + VIVAS_SQL).catch(e => console.error('[citaf] índice único:', e.message));
    await run('CREATE INDEX IF NOT EXISTS ix_citafc_due ON citaf_casillas (tenant_id, estado, due_ts)').catch(() => { });
    _listo = true;
}
async function offsetDe(tId) { await asegurar(); const r = (await query('SELECT offset_ms FROM citaf_reloj WHERE tenant_id = ?', [Number(tId)]))[0]; return r ? Number(r.offset_ms) || 0 : 0; }
async function ahora(tId) { return Date.now() + await offsetDe(tId); }
async function ponerOffset(tId, ms) { await asegurar(); await run('INSERT INTO citaf_reloj (tenant_id, offset_ms) VALUES (?,?) ON CONFLICT(tenant_id) DO UPDATE SET offset_ms = excluded.offset_ms', [Number(tId), Math.max(0, Math.round(ms))]); }
const datosDe = c => { try { return JSON.parse(c.datos_json || '{}') || {}; } catch (e) { return {}; } };
async function citaViva(tId, chatId) { await asegurar(); return (await query('SELECT * FROM citaf WHERE tenant_id = ? AND chat_id = ? AND estado IN ' + VIVAS_SQL + ' ORDER BY id DESC LIMIT 1', [Number(tId), Number(chatId)]))[0] || null; }
async function ultimaCita(tId, chatId) { await asegurar(); return (await query('SELECT * FROM citaf WHERE tenant_id = ? AND chat_id = ? ORDER BY id DESC LIMIT 1', [Number(tId), Number(chatId)]))[0] || null; }
async function citaPorId(id) { return (await query('SELECT * FROM citaf WHERE id = ?', [Number(id)]))[0] || null; }
async function bitacora(c, ts, fuente, evento, detalle) { await run('INSERT INTO citaf_eventos (cita_id, tenant_id, chat_id, ts, fuente, evento, detalle) VALUES (?,?,?,?,?,?,?)', [c ? Number(c.id) : null, c ? Number(c.tenant_id) : null, c ? Number(c.chat_id) : null, ts, fuente, evento, detalle == null ? null : (typeof detalle === 'string' ? detalle : JSON.stringify(detalle))]).catch(() => { }); }
// ESCRITURA CON TESTIGO (idempotencia entre IA, botones del vendedor y reloj): solo escribe si la cita sigue como la leí. Si otro proceso la cambió
// en medio → Conflicto → quien llama RELEE la realidad y vuelve a aplicar su evento sobre la verdad nueva (jamás pisa a ciegas).
async function guardar(c, campos, ts) {
    const k = Object.keys(campos); if (!k.length) return c;
    const nuevo = Math.max(Number(ts) || 0, (Number(c.updated) || 0) + 1);
    const r = await run('UPDATE citaf SET ' + k.map(x => x + ' = ?').join(', ') + ', updated = ? WHERE id = ? AND updated = ?', k.map(x => campos[x]).concat([nuevo, Number(c.id), Number(c.updated) || 0]));
    if (!Number(r.rowsAffected)) throw new Conflicto('la cita ' + c.id + ' cambió mientras la actualizaba');
    return Object.assign(c, campos, { updated: nuevo });
}
async function conReintento(fn) { let ult = null; for (let i = 0; i < 4; i++) { try { return await fn(i); } catch (e) { if (!(e instanceof Conflicto) && !/UNIQUE constraint/i.test(String(e && e.message))) throw e; ult = e; await new Promise(r => setTimeout(r, 40 + Math.random() * 120)); } } throw ult; }

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
        if (aF.cierra - aI.abre > 56 * H) return { ok: false, motivo: 'ventana_ancha' };   // amplitud máx ≈ 50 h (tolerancia para tres días seguidos de lote); más ancho = intención, no visita
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
    retraso_ok: x => 'Sin problema' + x.n + ', aquí te esperamos.',
    se_retrasa_pregunta: x => 'Sin problema' + x.n + '. ¿Sigues viniendo hoy? ¿Como a qué hora calculas?',
    se_retrasa_camino: x => 'Sin problema' + x.n + ', con calma. ¿Como en cuánto calculas llegar?',
    incierto: x => x.nombre_coma + 'para tenerte ' + x.elauto + ' listo: ¿sí vienes ' + x.corto + ' o prefieres que lo movamos?',
    cambio_auto: x => 'Va' + x.n + ', entonces ' + x.corto + ' te esperamos para ver ' + x.elauto + '.',
    pide_dia: x => 'Va' + x.n + '. ¿Qué día te queda bien para venir a verlo?',
    rescate_1: x => 'Hola' + x.n + ', ¿cómo vas? ¿Te busco un espacio para que vengas a ver ' + x.elauto + '? Tú dime qué día te acomoda.',
    rescate_2: x => 'Hola' + x.n + ', sigo al pendiente. Si todavía quieres ver ' + x.elauto + ' dime qué día te queda y te lo tengo listo.',
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
    // LEY "ninguna visita viva sin próxima acción": la ÚLTIMA casilla de cada estado vivo jamás se filtra por estar en el pasado (se recorre a ya).
    const ya = now + MIN;
    if (c.estado === 'esperando_cierre') {   // RELOJ DEL VENDEDOR que no contesta "¿llegó?"
        const m = at(masDias(ymd(T0), 1), 10, 0);
        if (m > now) add('cierre_2', m, 'vendedor'); add('sin_cierre', Math.max(m + DIA, ya), 'sistema'); return P;
    }
    if (c.estado === 'pospuesta') {   // PENDIENTE DE REAGENDAR: la intención sigue viva, sin fecha → RESCATE (2 toques) y, si nunca vuelve, destino final
        const finde = soloFinde(c); const sig = (desde, dias) => { let d = masDias(ymd(desde), dias); if (finde) { for (let i = 0; i < 7 && ![4, 5].includes(dow(at(d, 12, 0))); i++) d = masDias(d, 1); } return at(d, 11, 0); };   // solo puede en fin de semana → se le busca jueves/viernes
        const r1 = (c.avisa_ts && Number(c.avisa_ts) > T0) ? fueraDeSilencio(Number(c.avisa_ts)) : sig(T0, String(c.ultima_palabra) === 'promete_avisar' ? 2 : 1);
        const r2 = sig(r1, 4); const finR = Math.max(at(masDias(ymd(r2), 3), 11, 0), ya);
        if (r1 > now) add('rescate', r1, 'comprador', '1'); if (r2 > now) add('rescate', r2, 'comprador', '2'); add('fin_rescate', finR, 'sistema'); return P;
    }
    if (c.estado !== 'viva' && c.estado !== 'en_camino') return P;
    const A = Number(c.ini_ts), F = Number(c.fin_ts), dA = ymd(A), dF = ymd(F), multi = dA !== dF, conHora = c.precision === 'hora' || c.precision === 'franja';
    // CIERRE obligatorio (hora exacta: 90 min de espera; ventana: 30 min tras el fin)
    add('cierre', Math.max(F + (c.precision === 'hora' ? 90 : 30) * MIN, ya), 'vendedor');
    if (c.estado === 'en_camino') return P;   // ya viene: nada más le escribe
    // PREGUNTA ABIERTA ("se retrasa" sin nueva hora · mensaje ambiguo): si no contesta, el silencio es un evento → el vendedor le marca
    if (['se_retrasa', 'incierto'].includes(String(c.ultima_palabra))) add('marcar_pregunta', T0 + (String(c.ultima_palabra) === 'se_retrasa' ? 40 : 90) * MIN, 'vendedor');
    const callar = Number(c.callar_hasta_ts) || 0;
    // REVISIÓN tras "yo te aviso"
    if (c.avisa_ts && Number(c.avisa_ts) < F) add('revision', fueraDeSilencio(Number(c.avisa_ts)), 'comprador', ymd(Number(c.avisa_ts)));
    if (c.suave) {   // ventana original reabierta tras no llegar en la angosta: UN solo mensaje suave por día, sin empujones
        for (let d = dA; d <= dF; d = masDias(d, 1)) { const ac = abreCierra(t, d); if (ac) add('revision_suave', Math.max(ac.abre + 30 * MIN, at(d, 9, 30)), 'comprador', d); }
        return P.filter(x => x.due_ts > now || x.tipo === 'cierre');
    }
    if (c.en_duda) {   // "se me complicó": ya se le ofrecieron 2 opciones; solo una revisión suave en cada día que le quede a la ventana
        for (let d = masDias(ymd(now), 1); d <= dF; d = masDias(d, 1)) add('revision', at(d, 10, 0), 'comprador', d);
        return P.filter(x => x.due_ts > now || x.tipo === 'cierre');
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
    return P.filter(x => (x.due_ts > now || x.tipo === 'cierre') && !(callar && x.para === 'comprador' && x.due_ts <= callar && ['dia', 'dia_multi', 'dia_ultimo', 'empujon', 'me_avisas', 'r1', 'vispera'].includes(x.tipo)) && !(callar && x.tipo === 'marcar' && x.due_ts <= callar));
}
// Reconciliar = dejar en la tabla EXACTAMENTE el plan: lo pendiente que ya no está en el plan se cancela (con motivo); lo nuevo nace. Lo ya enviado/saltado es historia.
async function reconciliar(t, cOId, now, motivo) {
    const c = await citaPorId(typeof cOId === 'object' ? cOId.id : cOId); if (!c) return;   // se planea sobre lo que ES verdad ahora (no sobre la copia de quien llama): dos procesos casi simultáneos convergen al mismo plan
    const plan = planear(t, c, now); const claves = new Set(plan.map(p => p.clave));
    const pend = await query("SELECT id, clave FROM citaf_casillas WHERE cita_id = ? AND estado = 'pendiente'", [Number(c.id)]);
    for (const p of pend) if (!claves.has(p.clave)) await run("UPDATE citaf_casillas SET estado = 'cancelada', motivo = ? WHERE id = ?", [motivo || 'la cita cambió', Number(p.id)]);
    for (const p of plan) await run('INSERT OR IGNORE INTO citaf_casillas (cita_id, tenant_id, chat_id, clave, tipo, para, due_ts, estado, version) VALUES (?,?,?,?,?,?,?,?,?)', [Number(c.id), Number(c.tenant_id), Number(c.chat_id), p.clave, p.tipo, p.para, p.due_ts, 'pendiente', Number(c.version) || 1]);
    // una casilla pendiente cuyo horario cambió en el plan (misma clave) se actualiza
    for (const p of plan) await run("UPDATE citaf_casillas SET due_ts = ? WHERE clave = ? AND estado = 'pendiente' AND due_ts <> ?", [p.due_ts, p.clave, p.due_ts]);
}

// ═══ LECTOR DE EVENTOS (IA chica, salida forzada). La IA NO inventa estados: traduce la frase a "qué cambió objetivamente en la realidad"
//     = le pica al botón correcto de una lista CERRADA. El código decide todo lo demás. ═══
const EVENTOS = ['agenda_o_cambio', 'confirma', 'se_retrasa', 'promete_avisar', 'ya_voy', 'ya_llegue', 'se_complico', 'cancela', 'cambia_auto', 'incierto', 'no_es_de_cita', 'otra_cosa'];
const SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['razon', 'evento', 'confianza', 'dia_ini', 'dia_fin', 'hora_ini', 'hora_fin', 'franja', 'avisa_dia', 'avisa_hora', 'avisara', 'minutos_tarde', 'auto_texto', 'restriccion', 'asiste', 'condicion', 'a_cuenta', 'foraneo', 'tambien_pregunta', 'motivo'],
    properties: {
        razon: { type: 'string' }, evento: { type: 'string', enum: EVENTOS }, confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
        dia_ini: { type: 'string' }, dia_fin: { type: 'string' }, hora_ini: { type: 'string' }, hora_fin: { type: 'string' },
        franja: { type: 'string', enum: ['', 'manana', 'mediodia', 'tarde', 'noche', 'tarde_noche'] },
        avisa_dia: { type: 'string' }, avisa_hora: { type: 'string' }, avisara: { type: 'boolean' }, minutos_tarde: { type: 'integer' }, auto_texto: { type: 'string' },
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
const RE_FRENO = /\b(tarde|tr[aá]fico|retras|demor|no alcanz|complic|ma[ñn]ana|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|mejor|pero)\b/i;   // si trae algo de esto NO es un "ya voy" limpio: que lo lea la IA
const RE_TIEMPO = /\b(hoy|ma[ñn]ana|pasado|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|fin de semana|semana|quincena|al rato|alrato|m[aá]s tarde|en la (ma[ñn]ana|tarde|noche)|medio ?d[ií]a|a las? \d|\d ?(am|pm)|voy|paso|pasar|ir a ver|verlo|verla|visita|cita|llego|caigo|vuelta)\b/i;
// hora de reloj dicha con sus letras ("como a las 6", "a las 5:30 pm") → 'HH:MM' de HOY; viendo autos, 1–7 = tarde; si ya pasó y cabe en pm → pm
function horaDeReloj(txt, now) {
    const m = String(txt || '').match(/\b(?:a|como a|tipo|para) las?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|de la tarde|de la noche|de la ma[ñn]ana)?/i) || String(txt || '').match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i); if (!m) return null;
    let h = Number(m[1]); const mi = Number(m[2] || 0); const suf = String(m[3] || '').toLowerCase(); if (h > 23 || mi > 59) return null;
    if (/pm|tarde|noche/.test(suf)) { if (h < 12) h += 12; } else if (!/am|ma[ñn]ana/.test(suf)) { if (h >= 1 && h <= 7) h += 12; else if (h <= 11 && at(ymd(now), h, mi) < now && at(ymd(now), h + 12, mi) > now) h += 12; }
    return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}
async function leer({ t, c, now, historial, nuevo, auto }) {
    // compuertas sin IA (evidencia FÍSICA limpia)
    if (RE_LLEGUE.test(nuevo)) return { evento: 'ya_llegue', confianza: 'alta', razon: 'compuerta: ya llegué', tambien_pregunta: false };
    if (RE_YAVOY.test(nuevo) && !RE_FRENO.test(nuevo)) return { evento: 'ya_voy', confianza: 'alta', razon: 'compuerta: ya voy', tambien_pregunta: false };
    if (!c && !RE_TIEMPO.test(nuevo)) return { evento: 'no_es_de_cita', confianza: 'alta', razon: 'compuerta: sin cita viva y sin palabra de tiempo/visita', tambien_pregunta: false };
    const hoy = ymd(now);
    const cal = []; for (let i = 0; i < 16; i++) { const d = masDias(hoy, i); cal.push(DIAS[dow(at(d, 12, 0))] + ' ' + d + ' (' + horarioTexto(t, d) + ')'); }
    const system =
        'Lees el mensaje NUEVO de un comprador de autos usados (WhatsApp, Monterrey) y decides QUÉ CAMBIÓ OBJETIVAMENTE en la realidad de su VISITA al lote para ver el auto. ' +
        'No redactas respuestas ni inventas estados: eliges UN evento de la lista cerrada (como picarle al botón correcto). Primero escribe la razón (qué quiso decir de verdad), luego el evento.\n' +
        'EVENTOS:\n' +
        '· agenda_o_cambio = da o cambia CUÁNDO viene: un día, una hora, un rango de horas o de días, o pregunta si puede ir en cierto momento ("cómo andas hoy a las 5", "paso el viernes", "entre viernes y sábado", "voy el fin de semana", "mañana en la tarde", "mejor mañana a las 11", "sí, como a las 6", "la próxima semana entre viernes y sábado"). Llena dia_ini (YYYY-MM-DD del calendario). dia_fin solo si dio un rango de días ("fin de semana" = sábado a domingo). hora_ini HH:MM 24 h solo si dio hora ("a las 5" viendo autos = 17:00; "a las 10" = 10:00; "como a las 4" = 16:00). hora_fin solo si dio rango de horas. franja si dijo mañana/mediodía/tarde/noche/tarde-noche sin hora. "al rato / más tarde" sin hora = hoy sin hora. "la próxima semana" = la semana que empieza el lunes siguiente.\n' +
        '· confirma = dice que sí viene / sigue en pie ("sí", "ahí estaré", "claro", 👍) contestando a nuestro recordatorio, acuse o pregunta. Si además da una hora o día nuevo → agenda_o_cambio.\n' +
        '· ya_voy = ya va en camino (movimiento físico). · ya_llegue = ya está en el lugar (hecho físico).\n' +
        '· se_retrasa = SIGUE viniendo HOY pero va tarde / se le hizo tarde / hay tráfico, SIN dar una nueva hora concreta (minutos_tarde solo si dice cuánto: "media hora" = 30). NO es cancelar ni cambiar de día. Si menciona una HORA DE RELOJ ("como a las 6", "llego a las 5:30") NUNCA es se_retrasa: es agenda_o_cambio con hora_ini, aunque venga de un retraso.\n' +
        '· promete_avisar = "yo te aviso", "déjame ver y te digo", "te confirmo mañana" SIN decir que no puede (avisa_dia / avisa_hora si dijo cuándo avisa).\n' +
        '· se_complico = NO puede venir / no alcanza a llegar / se le complicó, SIN dar fecha nueva y sin decir que ya no le interesa. avisara = true si además dice que él avisa cuándo pueda ("yo te aviso cuándo").\n' +
        '· cancela = SOLO si ya no le interesa, ya compró otro, o cancela en definitiva. "No puedo mañana" NO es cancela.\n' +
        '· cambia_auto = quiere que la visita sea para OTRO auto y no toca el cuándo.\n' +
        '· incierto = habla de la visita pero NO permite saber si sigue viniendo ni cuándo ("a ver si puedo", "ando viendo", "quién sabe", "depende", "luego vemos"). Ante la duda entre eventos, incierto: jamás inventes una cancelación ni una reprogramación.\n' +
        '· no_es_de_cita = pregunta del auto, precio, fotos, ubicación, cotización, saludos, gracias. "Llego a mi oficina a las 3 y te mando papeles" NO es visita.\n' +
        '· otra_cosa = sí es sobre la visita pero no cabe arriba (llevar mecánico, quién me atiende, que le lleven el auto).\n' +
        'JERARQUÍA DE EVIDENCIA si el mensaje trae varias cosas o se contradice: manda lo MÁS FÍSICO y lo ÚLTIMO que dijo: ya llegué > ya voy > declaración explícita actual (hora/día/"ya no voy") > declaración aproximada > suposición. Ej.: "sí voy a las 5 / no mejor mañana" = agenda_o_cambio para mañana.\n' +
        'auto_texto = el auto que AHORA quiere ver con sus palabras ("la mazda", "el yaris 2022") SOLO si pide cambiar de auto; vacío si no. Si cambia auto Y da cuándo → agenda_o_cambio con auto_texto lleno.\n' +
        'IMPORTANTE: clasifica SOLO el mensaje NUEVO. La conversación anterior es contexto para entenderlo, no para sacar datos: los DATOS EXTRA y tambien_pregunta salen ÚNICAMENTE de lo que dice el mensaje NUEVO.\n' +
        'DATOS EXTRA (vacío si no aplica): restriccion ("solo fines de semana", "sale a las 6"), asiste (si va otra persona: quién), condicion (de qué depende: crédito, seguro, juntar enganche), a_cuenta (trae auto a cuenta), foraneo (viene de otra ciudad). ' +
        'tambien_pregunta = true si en el mismo mensaje además pregunta algo del auto/dinero/ubicación que hay que contestar. motivo = por qué cancela o se le complicó SOLO si lo dijo con sus letras (si no lo dijo, vacío).\n' +
        'confianza alta solo si un humano lo entendería sin dudar. Si abajo dice VISITA VIVA: ninguna, NO hay nada que confirmar ni posponer aunque el historial muestre una cita vieja: solo existen agenda_o_cambio, ya_voy, ya_llegue y no_es_de_cita, y SIEMPRE llenas dia_ini si menciona cuándo viene.\n' +
        'AHORA: ' + DIAS[dow(now)] + ' ' + hoy + ' ' + L(now).toISOString().slice(11, 16) + ' (Monterrey).\nCALENDARIO:\n' + cal.join('\n');
    const content = 'AUTO EN FOCO: ' + (auto && auto.nombre ? auto.nombre : 'ninguno') + '\n' +
        'VISITA VIVA: ' + (c ? (situacionDe(t, c, now) + ' · ventana original ' + fechaCorta(c.ini0_ts) + ' → ' + fechaCorta(c.fin0_ts)) : 'ninguna') + '\n' +
        'CONVERSACIÓN (lo último):\n' + historial.map(m => (m.quien === 'comprador' ? 'Comprador' : 'Lote') + ': ' + String(m.texto || '').slice(0, 260).replace(/\n+/g, ' / ')).join('\n') +
        '\nNUEVO del comprador: ' + String(nuevo || '').slice(0, 500);
    const r = await haiku(system, content);
    if (!r || !EVENTOS.includes(r.evento)) return { evento: c ? 'incierto' : 'no_es_de_cita', confianza: 'baja', razon: r ? 'salida inválida' : 'sin IA disponible', tambien_pregunta: true };
    return r;
}

// SITUACIÓN ACTUAL INTERPRETABLE (una frase): qué es verdad AHORA de esta visita
function situacionDe(t, c, now) {
    const e = c.estado, up = String(c.ultima_palabra || '');
    if (e === 'realizada') return 'ASISTIÓ' + (c.resultado ? ' · ' + c.resultado : ' · falta el resultado');
    if (e === 'cancelada') return 'NO ASISTIÓ · canceló' + (c.razon ? ': ' + c.razon : '');
    if (e === 'no_llego') return 'NO ASISTIÓ' + (c.razon ? ' · ' + c.razon : '');
    if (e === 'sin_cierre') return 'Sin cierre: nadie dijo si llegó';
    if (e === 'reemplazada') return 'Reemplazada';
    if (e === 'pospuesta') return 'PENDIENTE DE REAGENDAR (sin fecha)' + (c.razon ? ' · ' + c.razon : '') + (c.avisa_ts ? ' · dijo que avisa ' + fechaCorta(c.avisa_ts) : '');
    if (e === 'esperando_cierre') return 'Terminó la ventana (' + cuandoCorto(c, now) + '): falta que el vendedor diga si llegó';
    if (e === 'en_camino') return (up === 'ya_llegue' ? 'YA LLEGÓ: está en el lugar' : 'EN CAMINO') + (up === 'se_retrasa' ? ' · avisó retraso' : '');
    let s = 'Viene ' + cuandoCorto(c, now);
    if (up === 'se_retrasa') s = 'SE RETRASA: la hora anterior ya no es confiable; se le preguntó a qué hora calcula (' + cuandoCorto(c, now) + ')';
    else if (up === 'incierto') s += ' · INCIERTO: no quedó claro si sigue viniendo; se le preguntó';
    else if (Number(c.en_duda)) s += ' · EN DUDA: se le complicó; se le ofrecieron dos opciones';
    else if (Number(c.suave)) s += ' · no llegó en la hora que precisó; su ventana original sigue abierta';
    else if (Number(c.confirmada_dia)) s += ' · día confirmado';
    else if (up === 'promete_avisar') s += ' · dijo "yo te aviso"';
    else s += ' · sin confirmar';
    return s;
}
const CONCRECION = { hora: 'hora exacta', franja: 'rango de horas', dia: 'solo el día', dias: 'rango de días' };

function soloFinde(c) { return /fin(es)? de semana|s[aá]bado|domingo|entre semana (trabaj|no puedo|no puede)|trabaj\w* entre semana|de lunes a viernes/i.test(String(datosDe(c).restriccion || '')); }
// ── opciones concretas para "se me complicó" (respetan su restricción de fin de semana) ──
function dosOpciones(t, c, now) {
    const finde = soloFinde(c);
    const sirve = d => { if (!abreCierra(t, d)) return false; const w = dow(at(d, 12, 0)); return finde ? (w === 0 || w === 6) : true; };
    const ops = []; for (let i = 1; i <= 16 && ops.length < 2; i++) { const d = masDias(ymd(now), i); if (!sirve(d)) continue; if (ops.length === 1 && !finde && i < 3) continue; ops.push(d); }
    const nom = d => d === masDias(ymd(now), 1) ? 'mañana ' + DIAS[dow(at(d, 12, 0))] : 'el ' + diaLargo(at(d, 12, 0));
    return { opA: nom(ops[0] || masDias(ymd(now), 1)), opB: nom(ops[1] || masDias(ymd(now), 7)) };
}
// ── CAMBIO DE AUTO: match ÚNICO contra el catálogo del universo, con código (la IA solo trajo sus palabras) ──
const normz = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').trim();
const STOP = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'ese', 'esa', 'este', 'esta', 'otro', 'otra', 'mejor', 'quiero', 'ver', 'auto', 'carro', 'coche', 'camioneta', 'troca', 'que', 'y', 'a', 'al', 'en', 'me', 'interesa', 'mas']);
function autoDeTexto(catalogo, txt) {
    const tk = normz(txt).split(/\s+/).filter(x => x && !STOP.has(x) && (x.length >= 2 || /\d/.test(x))); if (!tk.length) return { n: 0 };
    const hits = (catalogo || []).filter(a => { const nt = normz(a.nombre).split(/\s+/); return tk.every(x => /^\d+$/.test(x) ? nt.includes(x) : nt.some(y => y === x || (x.length >= 4 && y.startsWith(x)))); });
    return hits.length === 1 ? { n: 1, auto: hits[0] } : { n: hits.length };
}
const MOTIVOS = { confirma: 'confirmó', se_retrasa: 'se retrasa: la hora anterior ya no vale', promete_avisar: 'dijo "yo te aviso": hoy no se le insiste', se_complico: 'se le complicó: ya contestó, no se le insiste', cancela: 'canceló el comprador', incierto: 'incierto: se le preguntó directo', ya_voy: 'ya viene en camino', ya_llegue: 'ya llegó' };
const motivoDe = campos => campos && campos.estado === 'pospuesta' ? 'pendiente de reagendar: la cita anterior ya no está vigente' : (MOTIVOS[String(campos && campos.ultima_palabra)] || undefined);
const nombreVis = ch => (ch.nombre && ch.nombre !== '.') ? ch.nombre : ('+' + String(ch.telefono || ch.tel || '').replace(/^521/, '52 1 '));
const notaDatos = x => { const o = []; if (x.restriccion) o.push('restricción: ' + x.restriccion); if (x.asiste) o.push('asiste: ' + x.asiste); if (x.condicion) o.push('depende de: ' + x.condicion); if (x.a_cuenta) o.push('trae auto a cuenta'); if (x.foraneo) o.push('foráneo'); return o.length ? ' · ' + o.join(' · ') : ''; };

// ═══ PUERTA ÚNICA DE "CUÁNDO": nace · angosta · mueve · revive. La usan POR IGUAL la IA que leyó al comprador, el botón del vendedor,
//     el botón "Agendar cita" / auto-botón (cita_v2) y el cerebro de Seb cuando él cierra la cita. Misma realidad → mismo resultado. ═══
async function aplicarAgenda({ t, chat, auto, io, now, v, fuente, extras, nuevo }) {
    const tId = Number(t.id), chatId = Number(chat.id); const nombreV = nombreVis(chat); const hoyMismo = ymd(v.ini) === ymd(now); const delComprador = fuente !== 'vendedor';
    let c = await citaViva(tId, chatId);
    if (!c) {   // NACE (o REVIVE ligada a la anterior)
        const prev = await ultimaCita(tId, chatId);
        const ins = await run(`INSERT INTO citaf (tenant_id, chat_id, tel, nombre, auto_id, auto_nombre, ini_ts, fin_ts, ini0_ts, fin0_ts, precision, estado, confirmada_dia, ultimo_in_ts, ultima_palabra, version, version_ts, datos_json, previa_id, created, updated)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [tId, chatId, String(chat.telefono || ''), chat.nombre || '', auto && auto.id ? Number(auto.id) : null, auto && auto.nombre ? auto.nombre : null, v.ini, v.fin, v.ini, v.fin, v.precision, 'viva', (hoyMismo && delComprador) ? 1 : 0, delComprador ? now : null, 'agenda', 1, now, JSON.stringify(extras || {}), prev ? Number(prev.id) : null, now, now]);   // si otro proceso la nació a la vez → UNIQUE → conReintento la vuelve CAMBIO
        c = await citaPorId(Number(ins.lastInsertRowid)); await reconciliar(t, c.id, now);   // nace YA con su próxima acción (antes de mandar nada)
        await bitacora(c, now, fuente, prev ? 'revive' : 'nace', { ventana: [v.ini, v.fin], precision: v.precision, fuera_horario: !!v.fuera_horario, nuevo });
        const x = slots(t, c, now); x.pin = !!(c.auto_id);
        if (v.fuera_horario) { await io.mandar(texto(t, 'fuera_horario', Object.assign(x, { horario: horarioTexto(t, ymd(v.ini)) }))); await io.vendedor('⚠️ ' + nombreV + ' pidió venir fuera de horario: "' + String(nuevo || '').slice(0, 120) + '". Le dije el horario; si lo esperas, escríbele tú la hora.'); }
        await io.mandar(texto(t, 'nace', x)); if (x.pin) { await io.pin(Number(c.auto_id)); await bitacora(c, now, 'sistema', 'pin_enviado', null); }
        await io.vendedor('🔔 Visita nueva' + (prev ? ' (regresa: ya había agendado antes)' : '') + (fuente === 'vendedor' ? ' (la agendaste tú)' : '') + ' · ' + nombreV + ' · ' + (c.auto_nombre || 'sin auto') + ' · ' + cuandoCorto(c, now) + notaDatos(extras || {}));
        return { cita: Number(c.id), tipo: prev ? 'revive' : 'nace' };
    }
    // ya hay visita viva (incluye PENDIENTE DE REAGENDAR y ESPERANDO CIERRE): REPROGRAMAR conserva la intención y MUEVE la visita; no la mata
    const dentro = ['viva', 'en_camino'].includes(c.estado) && v.ini >= Number(c.ini0_ts) - 5 * MIN && v.fin <= Number(c.fin0_ts) + 5 * MIN;
    const antes = cuandoCorto(c, now), estadoAntes = c.estado;
    const campos = { ini_ts: v.ini, fin_ts: v.fin, precision: v.precision, version: (Number(c.version) || 1) + 1, version_ts: now, en_duda: 0, suave: 0, avisa_ts: null, callar_hasta_ts: null, confirmada_dia: (hoyMismo && delComprador) ? 1 : 0, estado: 'viva', ultima_palabra: dentro ? 'da_hora' : 'cambia', razon: null, datos_json: JSON.stringify(extras || datosDe(c)) };
    if (delComprador) campos.ultimo_in_ts = now;
    if (!dentro) { campos.ini0_ts = v.ini; campos.fin0_ts = v.fin; }
    await guardar(c, campos, now); await reconciliar(t, c.id, now, dentro ? 'precisó la hora' : 'reprogramó: la realidad anterior ya no vale');
    await bitacora(c, now, fuente, dentro ? 'angosta' : (estadoAntes === 'pospuesta' ? 'reagenda' : 'reprograma'), { antes, ventana: [v.ini, v.fin], precision: v.precision, nuevo });
    const x = slots(t, c, now); x.pin = !!c.auto_id && hoyMismo;
    if (v.fuera_horario) { await io.mandar(texto(t, 'fuera_horario', Object.assign(x, { horario: horarioTexto(t, ymd(v.ini)) }))); await io.vendedor('⚠️ ' + nombreV + ' pidió venir fuera de horario: "' + String(nuevo || '').slice(0, 120) + '"'); }
    else if (hoyMismo) { await io.mandar(texto(t, 'angosta_hoy', x)); if (x.pin) await io.pin(Number(c.auto_id)); }
    else await io.mandar(texto(t, 'cambio', x));
    await io.vendedor('🔔 ' + nombreV + (dentro ? ' precisó su visita: ' : (estadoAntes === 'pospuesta' ? ' REAGENDÓ: ' : ' REPROGRAMÓ (antes ' + antes + '): ')) + cuandoCorto(c, now) + (c.auto_nombre ? ' · ' + c.auto_nombre : '') + notaDatos(extras || {}));
    return { cita: Number(c.id), tipo: dentro ? 'angosta' : 'reprograma' };
}
// CAMBIO DE AUTO conservando la visita → { ok, auto } | { ok:false, n }
async function aplicarAuto({ t, chat, io, now, c, auto_texto, fuente }) {
    const cat = await io.catalogo(); const m = autoDeTexto(cat, auto_texto);
    if (m.n !== 1) return { ok: false, n: m.n };
    if (Number(m.auto.id) === Number(c.auto_id)) return { ok: true, auto: m.auto, igual: true };
    const antes = c.auto_nombre; await guardar(c, { auto_id: Number(m.auto.id), auto_nombre: m.auto.nombre }, now);
    await bitacora(c, now, fuente || 'comprador', 'cambia_auto', { antes, ahora: m.auto.nombre }); try { await io.ponerFoco(m.auto); } catch (e) { }
    return { ok: true, auto: m.auto, antes };
}

// ═══ PUERTA ÚNICA DE EVENTOS DEL COMPRADOR ═══
//  io = { mandar, pin, vendedor, sistema, catalogo, ponerFoco }  (la tubería la pone quien llama: sandbox → hilo; real → WhatsApp)
//  → { manejado, seguir_cerebro, evento, cita }
async function entrante({ tenant, chat, auto, io, textoNuevo, ahoraFijo }) {
    await asegurar();
    const t = tenant, tId = Number(t.id), chatId = Number(chat.id); const now = ahoraFijo || await ahora(tId);
    const ms = (await query('SELECT direccion d, emisor, texto, ts FROM mensajes WHERE conversacion_id = ? ORDER BY ts DESC, id DESC LIMIT 16', [chatId])).reverse().filter(m => m.emisor !== 'sistema');
    let nuevo = String(textoNuevo || '').trim(); let nIn = 1;
    if (!nuevo) { let i = ms.length - 1; const r = []; while (i >= 0 && ms[i].d === 'in') { r.unshift(ms[i].texto); i--; } nuevo = r.join(' / '); nIn = r.length || 1; }
    if (!nuevo) return { manejado: false };
    const historial = ms.slice(0, ms.length - nIn).slice(-9).map(m => ({ quien: m.d === 'in' ? 'comprador' : 'lote', texto: m.texto }));
    const c0 = await citaViva(tId, chatId);
    const ev = await leer({ t, c: c0, now, historial, nuevo, auto });   // la IA lee UNA vez; lo que sigue es código y se puede reintentar sin volver a leer
    // sin visita viva NO existe "confirma / se complicó / te aviso": si trae un día, es una agenda (el historial viejo confunde a la IA); si no, no es de cita
    if (!c0 && !['agenda_o_cambio', 'ya_voy', 'ya_llegue', 'no_es_de_cita'].includes(ev.evento)) { if (/^\d{4}-\d{2}-\d{2}$/.test(String(ev.dia_ini || ''))) { ev.evento = 'agenda_o_cambio'; if (ev.confianza === 'baja') ev.confianza = 'media'; } else ev.evento = 'no_es_de_cita'; }
    if (c0 && ev.evento === 'se_retrasa') { const hr = horaDeReloj(nuevo, now); if (hr) { ev.evento = 'agenda_o_cambio'; ev.dia_ini = ymd(now); ev.dia_fin = ''; ev.hora_ini = hr; ev.hora_fin = ''; ev.franja = ''; if (ev.confianza === 'baja') ev.confianza = 'media'; ev.razon = '(dio hora de reloj → nueva hora, no "retraso") ' + (ev.razon || ''); } }
    // la IA no inventa: cancelación o agenda SIN certeza = INCIERTO (se pregunta), jamás se ejecuta
    if (c0 && ((ev.evento === 'cancela' && ev.confianza !== 'alta') || (ev.evento === 'agenda_o_cambio' && ev.confianza === 'baja'))) { ev.razon = '(' + ev.evento + ' sin certeza → incierto) ' + (ev.razon || ''); ev.evento = 'incierto'; }
    const notaLector = '🗓 Lector de cita · ' + ev.evento + ' (' + (ev.confianza || '?') + ') · ' + String(ev.razon || '').slice(0, 160);
    if (ev.evento === 'no_es_de_cita') return { manejado: false, evento: ev.evento, nota: notaLector };   // la nota la escribe quien llama DESPUÉS del cerebro
    await io.sistema(notaLector);
    if (ev.tambien_pregunta) await io.vendedor('💬 En el mismo mensaje también preguntó algo que no es de la visita: "' + nuevo.slice(0, 160) + '". Contéstale tú.');
    return conReintento((intento) => aplicarComprador({ t, chat, auto, io, now, ev, nuevo, intento }));
}
async function aplicarComprador({ t, chat, auto, io, now, ev, nuevo, intento }) {
    const tId = Number(t.id), chatId = Number(chat.id); const nombreV = nombreVis(chat); let E = ev.evento;
    let c = await citaViva(tId, chatId);   // SIEMPRE la realidad fresca (en un reintento ya es la que dejó el otro proceso)
    const extras = c ? datosDe(c) : {};
    for (const k of ['restriccion', 'asiste', 'condicion']) if (ev[k]) extras[k] = ev[k];
    // compuerta DESPUÉS del modelo: los datos booleanos solo valen si el mensaje NUEVO lo dice con sus letras
    if (ev.a_cuenta && /(a cuenta|tom[ae]n? mi|recib\w* mi|dejar(l[oa])? mi|dar mi (auto|carro|camioneta)|mi (auto|carro|camioneta) (como|de) (enganche|pago))/i.test(nuevo)) extras.a_cuenta = true;
    if (ev.foraneo && /(soy de|vengo de|voy desde|vivo en|estoy en|desde) [a-záéíóúñ]/i.test(nuevo)) extras.foraneo = true;
    const R = (o) => Object.assign({ manejado: true, seguir_cerebro: false, evento: E, cita: c ? Number(c.id) : null }, o || {});
    const G = async (campos, motivo) => { await guardar(c, Object.assign({ ultimo_in_ts: now, datos_json: JSON.stringify(extras) }, campos), now); if (motivo !== false) await reconciliar(t, c.id, now, motivo || motivoDe(campos)); };   // PRIMERO la realidad y su próxima acción, DESPUÉS los mensajes

    // ── CAMBIO DE AUTO (solo, o junto con un cambio de cuándo): la visita se conserva ──
    let cambioAuto = null;
    if (c && String(ev.auto_texto || '').trim()) {
        cambioAuto = await aplicarAuto({ t, chat, io, now, c, auto_texto: ev.auto_texto });
        if (cambioAuto.ok && !cambioAuto.igual) auto = { id: cambioAuto.auto.id, nombre: cambioAuto.auto.nombre };
        if (!cambioAuto.ok) await io.vendedor('🔁 ' + nombreV + ' quiere ver OTRO auto en su visita ("' + String(ev.auto_texto).slice(0, 80) + '") y ' + (cambioAuto.n ? 'hay varios que embonan' : 'no lo encontré en tu catálogo') + '. La visita sigue igual (' + cuandoCorto(c, now) + ').');
    }
    if (E === 'cambia_auto') {
        if (!c) return { manejado: false, evento: E };
        if (!cambioAuto || !cambioAuto.ok) return { manejado: false, evento: E, cita: Number(c.id) };   // que el cerebro le muestre opciones; la visita no se toca
        if (!cambioAuto.igual) { await io.mandar(texto(t, 'cambio_auto', slots(t, c, now))); if (c.auto_id) await io.pin(Number(c.auto_id)); await io.vendedor('🔁 ' + nombreV + ' CAMBIÓ DE AUTO: ahora viene por ' + c.auto_nombre + ' (antes ' + (cambioAuto.antes || 's/auto') + ') · ' + cuandoCorto(c, now)); }
        await reconciliar(t, c.id, now); return R();
    }

    // ── CUÁNDO: nace · angosta · reprograma · reagenda ──
    if (E === 'agenda_o_cambio') {
        const v = ventanaDe(t, ev, now);
        if (!v.ok) {
            if (!c && ['ventana_ancha', 'muy_lejos', 'sin_dia'].includes(v.motivo)) { await bitacora(null, now, 'comprador', 'intencion', { motivo: v.motivo, nuevo }); return { manejado: false, evento: 'intencion', nota: '🗓 INTENCIÓN sin ventana concreta (' + v.motivo + '): todavía no es visita; la atiende el flujo normal' }; }
            if (c) { E = 'incierto'; ev.razon = 'dio un cuándo que no se puede agendar (' + v.motivo + ')'; }   // no se inventa fecha: se pregunta
            else { await io.vendedor('🔴 ' + nombreV + ' propuso un momento que no pude agendar (' + v.motivo + '): "' + nuevo.slice(0, 140) + '"'); return R({ escalado: true }); }
        } else {
            if (auto && auto.vendido) { await io.mandar(texto(t, 'auto_vendido', slots(t, { nombre: chat.nombre, auto_nombre: auto.nombre, ini_ts: v.ini, fin_ts: v.fin, precision: v.precision }, now))); await io.vendedor('🔴 ' + nombreV + ' quiso agendar un auto que ya no está activo: ' + auto.nombre); return R(); }
            const r = await aplicarAgenda({ t, chat, auto, io, now, v, fuente: 'comprador', extras, nuevo }); return R({ cita: r.cita, tipo: r.tipo });
        }
    }

    // ── EVIDENCIA FÍSICA: vale desde CUALQUIER estado (la cita nunca estorba) y manda sobre todo lo anterior ──
    if (E === 'ya_voy' || E === 'ya_llegue') {
        if (!c) {   // sin visita viva: si murió hace nada (hoy o ayer) REVIVE esa misma; si no, nace al vuelo (relámpago) ligada a la anterior
            const prev = await ultimaCita(tId, chatId);
            if (prev && ['no_llego', 'sin_cierre'].includes(prev.estado) && ymd(Number(prev.fin0_ts)) >= masDias(ymd(now), -1)) { c = prev; await guardar(c, { estado: 'en_camino', version: Number(c.version) + 1, version_ts: now, fin_ts: Math.max(Number(c.fin_ts), now + H) }, now); await bitacora(c, now, 'comprador', 'revive_misma', { estaba: prev.estado, nuevo }); }
            else {
                const ac = abreCierra(t, ymd(now)); const finV = ac ? Math.max(ac.cierra, now + H) : now + 3 * H;
                const ins = await run(`INSERT INTO citaf (tenant_id, chat_id, tel, nombre, auto_id, auto_nombre, ini_ts, fin_ts, ini0_ts, fin0_ts, precision, estado, confirmada_dia, ultimo_in_ts, ultima_palabra, version, version_ts, datos_json, previa_id, created, updated)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [tId, chatId, String(chat.telefono || ''), chat.nombre || '', auto && auto.id ? Number(auto.id) : null, auto && auto.nombre ? auto.nombre : null, now, finV, now, finV, 'dia', 'en_camino', 1, now, E, 1, now, JSON.stringify(extras), prev ? Number(prev.id) : null, now, now]);
                c = await citaPorId(Number(ins.lastInsertRowid)); await bitacora(c, now, 'comprador', 'nace_relampago', { nuevo });
            }
        }
        const finHoy = (abreCierra(t, ymd(now)) || {}).cierra || now + 3 * H;
        const campos = { estado: 'en_camino', ultima_palabra: E, en_duda: 0, suave: 0, confirmada_dia: 1, avisa_ts: null, razon: null, version: Number(c.version) + 1, version_ts: now };
        if (Number(c.fin_ts) < now + H) campos.fin_ts = Math.max(finHoy, now + H);   // llegó/viene fuera de su ventana (antes, después o estaba pospuesta): la realidad física manda
        await G(campos);
        if (E === 'ya_llegue') { await bitacora(c, now, 'comprador', 'ya_llegue', { nuevo }); await io.mandar(texto(t, 'ya_llegue', slots(t, c, now))); await io.vendedor('🚨 YA LLEGÓ ' + nombreV + ' · ' + (c.auto_nombre || '') + ' — sal a recibirlo. Marca "Llegó" en la visita.'); return R(); }
        await bitacora(c, now, 'comprador', 'ya_voy', { nuevo }); await io.mandar(texto(t, 'ya_voy', slots(t, c, now)));
        if (c.auto_id && !(await query("SELECT 1 FROM citaf_eventos WHERE cita_id = ? AND evento = 'pin_enviado' LIMIT 1", [Number(c.id)]))[0]) { await io.pin(Number(c.auto_id)); await bitacora(c, now, 'sistema', 'pin_enviado', null); }
        await io.vendedor('🚗 ' + nombreV + ' YA VIENE EN CAMINO · ' + (c.auto_nombre || '') + notaDatos(extras)); return R();
    }
    if (!c) return { manejado: false, evento: E };   // lo demás solo tiene sentido con visita viva
    const pend = c.estado === 'pospuesta';

    if (E === 'confirma') {
        if (pend) { await G({ ultima_palabra: 'confirma' }); await bitacora(c, now, 'comprador', 'sigue_interesado', { nuevo }); await io.mandar(texto(t, 'pide_dia', slots(t, c, now))); return R(); }   // sigue interesado pero sin fecha → se obtiene la variable que falta
        if (c.estado === 'en_camino') { await G({}); return R(); }   // evidencia más fuerte ya registrada: un "sí" no la degrada
        const esHoy = ymd(now) >= ymd(Number(c.ini_ts));
        await G({ confirmada_dia: esHoy ? 1 : Number(c.confirmada_dia) || 0, en_duda: 0, ultima_palabra: 'confirma' }); await bitacora(c, now, 'comprador', esHoy ? 'confirma_dia' : 'confirma_antes', { nuevo });
        await io.mandar(texto(t, esHoy ? 'confirma_dia' : 'confirma_antes', slots(t, c, now)));
        if (esHoy) await io.vendedor('✅ ' + nombreV + ' confirmó que viene hoy · ' + cuandoCorto(c, now));
        return R();
    }
    if (E === 'se_retrasa' && !pend && ymd(now) >= ymd(Number(c.ini_ts))) {
        const mins = Math.max(0, Math.min(240, Number(ev.minutos_tarde) || 0)); const finHoy = (abreCierra(t, ymd(now)) || {}).cierra || now + 3 * H; const enCamino = c.estado === 'en_camino';
        if (mins) {   // dijo cuánto: la MISMA visita se recorre
            const campos = { ultima_palabra: enCamino ? c.ultima_palabra : 'confirma', confirmada_dia: 1, en_duda: 0, estado: enCamino ? 'en_camino' : 'viva', version: Number(c.version) + 1, version_ts: now };
            if (c.precision === 'hora') { campos.ini_ts = Math.max(Number(c.ini_ts), now) + mins * MIN; campos.fin_ts = campos.ini_ts; if (Number(c.ini0_ts) === Number(c.ini_ts) && Number(c.fin0_ts) === Number(c.fin_ts)) { campos.ini0_ts = campos.ini_ts; campos.fin0_ts = campos.fin_ts; } }
            else if (!enCamino && ymd(Number(c.ini_ts)) === ymd(now)) { campos.ini_ts = campos.fin_ts = Math.round((now + mins * MIN) / (5 * MIN)) * 5 * MIN; campos.precision = 'hora'; }   // "llego en media hora" = hora nueva concreta
            else campos.fin_ts = Math.max(Number(c.fin_ts), Math.min(finHoy, now + mins * MIN + H));
            await G(campos); await bitacora(c, now, 'comprador', 'se_retrasa', { minutos: mins, nuevo });
            await io.mandar(texto(t, 'retraso_ok', slots(t, c, now))); await io.vendedor('⏳ ' + nombreV + ' avisa que llega tarde (~' + mins + ' min) · ' + (c.auto_nombre || '')); return R();
        }
        // NO dijo a qué hora: la hora anterior DEJA de ser confiable (no se cancela, no se reprograma sola) → se pregunta la nueva realidad
        const campos = { ultima_palabra: 'se_retrasa', en_duda: 0, version: Number(c.version) + 1, version_ts: now, estado: enCamino ? 'en_camino' : 'viva' };
        if (!enCamino) { campos.ini_ts = now; campos.fin_ts = Math.max(finHoy, now + 2 * H); campos.precision = 'dia'; if (ymd(Number(c.fin0_ts)) <= ymd(now)) { campos.ini0_ts = campos.ini_ts; campos.fin0_ts = campos.fin_ts; } }
        else campos.fin_ts = Math.max(Number(c.fin_ts), finHoy);
        await G(campos); await bitacora(c, now, 'comprador', 'se_retrasa', { sin_hora: true, nuevo });
        await io.mandar(texto(t, enCamino ? 'se_retrasa_camino' : 'se_retrasa_pregunta', slots(t, c, now))); await io.vendedor('⏳ ' + nombreV + ' SE RETRASA y no dijo a qué hora. La hora anterior ya no es confiable; le pregunté a qué hora calcula · ' + (c.auto_nombre || ''));
        return R();
    }
    if (E === 'promete_avisar') {
        let av = null; if (/^\d{4}-\d{2}-\d{2}$/.test(ev.avisa_dia || '')) { const [h, m] = /^\d{1,2}:\d{2}$/.test(ev.avisa_hora || '') ? ev.avisa_hora.split(':').map(Number) : [11, 0]; av = at(ev.avisa_dia, h, m); }
        const dijoCuando = !!av && av > now;
        if (!dijoCuando) av = (L(now).getUTCHours() < 14 && ymd(now) >= ymd(Number(c.ini_ts))) ? now + 3 * H : at(masDias(ymd(now), 1), 11, 0);
        if (pend || av >= Number(c.fin_ts)) {   // avisa FUERA de la ventana (o ya estaba pendiente) → la cita actual deja de estar vigente; la intención sigue: PENDIENTE DE REAGENDAR con rescate
            await G({ estado: 'pospuesta', razon: 'dijo "yo te aviso"', avisa_ts: dijoCuando ? av : null, ultima_palabra: 'promete_avisar', en_duda: 0, version: Number(c.version) + 1, version_ts: now }); await bitacora(c, now, 'comprador', 'pendiente_reagendar', { avisa: dijoCuando ? av : null, nuevo });
            await io.mandar(texto(t, 'promete_avisar', slots(t, c, now))); await io.vendedor('🟡 ' + nombreV + ' dijo "yo te aviso". La visita queda PENDIENTE DE REAGENDAR (sin fecha); si no vuelve, lo rescato yo.'); return R();
        }
        await G({ avisa_ts: av, callar_hasta_ts: at(ymd(now), 23, 59), ultima_palabra: 'promete_avisar' }); await bitacora(c, now, 'comprador', 'promete_avisar', { revision: av, nuevo });
        await io.mandar(texto(t, 'promete_avisar', slots(t, c, now))); await io.vendedor('🟡 ' + nombreV + ' dijo "yo te aviso". Hoy ya no se le insiste; reviso con él ' + fechaCorta(av)); return R();
    }
    if (E === 'se_complico') {
        if (pend) { await G({ ultima_palabra: 'se_complico' }); await io.mandar(texto(t, 'promete_avisar', slots(t, c, now))); return R(); }
        const quedaOtroDia = ymd(Number(c.fin0_ts)) > ymd(now) && ymd(Number(c.ini0_ts)) <= ymd(now) && c.estado === 'viva';   // su ventana de varios días aún tiene otro día
        const ops = dosOpciones(t, c, now);
        if (ev.avisara || !quedaOtroDia) {   // "no alcanzo, yo te aviso" · o ya no le queda día: la cita actual muere, la intención NO → PENDIENTE DE REAGENDAR
            await G({ estado: 'pospuesta', razon: 'se le complicó' + (ev.motivo ? ': ' + ev.motivo : ''), avisa_ts: null, en_duda: 0, ultima_palabra: ev.avisara ? 'promete_avisar' : 'se_complico', version: Number(c.version) + 1, version_ts: now }); await bitacora(c, now, 'comprador', 'pendiente_reagendar', { avisara: !!ev.avisara, opciones: ev.avisara ? null : ops, nuevo });
            await io.mandar(texto(t, ev.avisara ? 'promete_avisar' : 'se_complico', Object.assign(slots(t, c, now), ops)));
            await io.vendedor('🟡 A ' + nombreV + ' se le complicó' + (ev.motivo ? ' (' + ev.motivo + ')' : '') + '. La visita queda PENDIENTE DE REAGENDAR' + (ev.avisara ? ' (él avisa)' : ' · le ofrecí ' + ops.opA + ' o ' + ops.opB) + '. Si no vuelve, lo rescato yo.'); return R();
        }
        await G({ en_duda: 1, ultima_palabra: 'se_complico', razon: ev.motivo || null }); await bitacora(c, now, 'comprador', 'se_complico', { opciones: ops, nuevo });
        await io.mandar(texto(t, 'se_complico', Object.assign(slots(t, c, now), ops))); await io.vendedor('🟡 A ' + nombreV + ' se le complicó' + (ev.motivo ? ' (' + ev.motivo + ')' : '') + '. Le ofrecí ' + ops.opA + ' o ' + ops.opB + '. Su ventana sigue abierta, en duda.'); return R();
    }
    if (E === 'cancela') {   // (solo llega aquí con confianza alta)
        await G({ estado: 'cancelada', razon: ev.motivo || 'canceló el comprador', ultima_palabra: 'cancela' }); await bitacora(c, now, 'comprador', 'cancela', { motivo: ev.motivo, nuevo });
        await io.mandar(texto(t, 'cancela', slots(t, c, now))); await io.vendedor('❌ ' + nombreV + ' CANCELÓ en definitiva' + (ev.motivo ? ': ' + ev.motivo : '') + ' · ' + (c.auto_nombre || '')); return R();
    }
    if (E === 'incierto' || E === 'se_retrasa') {   // (se_retrasa de una visita que no es hoy = no se sabe qué quiso decir)
        if (String(c.ultima_palabra) === 'incierto') { await G({}); await bitacora(c, now, 'comprador', 'incierto_otra_vez', { nuevo }); await io.vendedor('🔴 ' + nombreV + ' sigue sin dejar claro si viene: "' + nuevo.slice(0, 160) + '". Ya le pregunté una vez; márcale tú. La visita sigue igual (' + cuandoCorto(c, now) + ').'); return R({ escalado: true }); }
        if (pend) { await G({ ultima_palabra: 'incierto' }); await io.mandar(texto(t, 'pide_dia', slots(t, c, now))); return R(); }
        await G({ ultima_palabra: 'incierto', version: Number(c.version) + 1, version_ts: now }); await bitacora(c, now, 'comprador', 'incierto', { razon: ev.razon, nuevo });
        await io.mandar(texto(t, 'incierto', slots(t, c, now))); await io.vendedor('🟠 ' + nombreV + ' escribió algo que no deja claro si sigue viniendo: "' + nuevo.slice(0, 140) + '". Le pregunté directo; si no contesta te aviso para que le marques.'); return R();
    }
    // otra_cosa → ESCALA, la línea sigue igual
    await G({}); await bitacora(c, now, 'comprador', 'otra_cosa', { evento_leido: E, nuevo });
    await io.vendedor('🔴 ' + nombreV + ' dijo algo de su visita que no sé resolver: "' + nuevo.slice(0, 160) + '". Contéstale tú; la visita sigue igual (' + cuandoCorto(c, now) + ').');
    return R({ evento: 'otra_cosa', escalado: true });
}

// ═══ EVENTOS DEL VENDEDOR (botones / panel / "Agendar cita" / auto-botón). Pasan por las MISMAS puertas que lo que lee la IA. ═══
//  evento: llego | no_llego | agenda {dia_ini, dia_fin?, hora_ini?, hora_fin?, franja?} | mueve | auto_vendido | cambia_auto {auto_texto} | descartar | resultado
async function vendedor(args) { await asegurar(); return conReintento(() => aplicarVendedor(args)); }
async function aplicarVendedor({ tenant, chat, evento, resultado, razon, auto, io, datos, ahoraFijo }) {
    const t = tenant, tId = Number(t.id); const now = ahoraFijo || await ahora(tId);
    let c = await citaViva(tId, Number(chat.id)); const ult = c || await ultimaCita(tId, Number(chat.id));
    if (evento === 'agenda') {
        const v = ventanaDe(t, datos || {}, now); if (!v.ok) return { ok: false, error: 'no se puede agendar: ' + v.motivo };
        if (v.fuera_horario) v.fuera_horario = false;   // el vendedor sabe a qué hora lo espera
        if (datos && /^\d{1,2}:\d{2}$/.test(String(datos.hora_ini || '')) && v.precision === 'dia') { const [h, m] = datos.hora_ini.split(':').map(Number); v.ini = v.fin = at(datos.dia_ini, h, m); v.precision = 'hora'; }
        const r = await aplicarAgenda({ t, chat, auto, io, now, v, fuente: 'vendedor', extras: c ? datosDe(c) : {}, nuevo: null }); return { ok: true, cita: r.cita, tipo: r.tipo };
    }
    if (evento === 'llego') {   // HECHO FÍSICO: válido SIEMPRE (viva, pendiente, muerta o inexistente → nace ya realizada). Manda sobre cualquier cosa anterior.
        if (!c && ult && ['no_llego', 'sin_cierre', 'cancelada'].includes(ult.estado) && now - Number(ult.updated) < 3 * DIA) c = ult;
        if (!c) { const ins = await run(`INSERT INTO citaf (tenant_id, chat_id, tel, nombre, auto_id, auto_nombre, ini_ts, fin_ts, ini0_ts, fin0_ts, precision, estado, confirmada_dia, version, version_ts, datos_json, previa_id, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [tId, Number(chat.id), String(chat.telefono || ''), chat.nombre || '', auto && auto.id ? Number(auto.id) : null, auto && auto.nombre ? auto.nombre : null, now, now, now, now, 'dia', 'realizada', 1, 1, now, '{}', ult ? Number(ult.id) : null, now, now]); c = await citaPorId(Number(ins.lastInsertRowid)); await bitacora(c, now, 'vendedor', 'llego_sin_cita', null); }
        else { await guardar(c, { estado: 'realizada', razon: null }, now); await bitacora(c, now, 'vendedor', 'llego', null); }
        await reconciliar(t, c.id, now, 'llegó'); await io.sistema('✅ ASISTIÓ. Falta el resultado: compró · apartó · no compró · sigue pensando.'); return { ok: true, cita: Number(c.id), estado: 'realizada' };
    }
    if (evento === 'resultado') { if (!ult) return { ok: false, error: 'sin visita' }; await guardar(ult, { resultado: String(resultado || ''), razon: razon || ult.razon || null }, now); await bitacora(ult, now, 'vendedor', 'resultado', { resultado, razon }); return { ok: true, cita: Number(ult.id), resultado }; }
    if (!c) return { ok: false, error: 'no hay visita viva en este chat' };
    if (evento === 'cambia_auto') { const r = await aplicarAuto({ t, chat, io, now, c, auto_texto: String((datos && datos.auto_texto) || ''), fuente: 'vendedor' }); if (!r.ok) return { ok: false, error: r.n ? 'varios autos embonan' : 'no encontré ese auto en el catálogo' }; await reconciliar(t, c.id, now); return { ok: true, cita: Number(c.id), auto: r.auto.nombre }; }
    const aPendiente = async (motivo, plantilla, campos) => {   // NO asistió a ESTA cita, pero la intención no muere: PENDIENTE DE REAGENDAR + rescate
        await guardar(c, Object.assign({ estado: 'pospuesta', razon: motivo, en_duda: 0, suave: 0, avisa_ts: null, version: Number(c.version) + 1, version_ts: now }, campos || {}), now); await reconciliar(t, c.id, now, motivo); await bitacora(c, now, 'vendedor', evento, { motivo });
        if (plantilla) await io.mandar(texto(t, plantilla, slots(t, c, now))); return { ok: true, cita: Number(c.id), estado: 'pospuesta' };
    };
    if (evento === 'no_llego') {
        const aviso = ['se_complico', 'promete_avisar'].includes(String(c.ultima_palabra)) || Number(c.en_duda) === 1;
        const r = await aPendiente(aviso ? 'avisó y no concretó' : 'no llegó (plantón)', null); await io.sistema((aviso ? '🟡 No llegó, pero había avisado.' : '⚪ NO LLEGÓ a esta cita.') + ' La visita queda PENDIENTE DE REAGENDAR: mañana lo busco yo para moverla. Si aparece, "Llegó" sigue funcionando.'); return r;
    }
    if (evento === 'mueve') return aPendiente('la movió el vendedor', 'mueve_vendedor');
    if (evento === 'auto_vendido') return aPendiente('el auto se vendió con la visita viva', 'auto_vendido', { auto_id: null });
    if (evento === 'descartar') { await guardar(c, { estado: 'no_llego', razon: razon || 'lo cerró el vendedor: ya no va a venir' }, now); await bitacora(c, now, 'vendedor', 'descartar', { razon }); await reconciliar(t, c.id, now, 'la cerró el vendedor'); await io.sistema('⚫ NO ASISTIÓ (definitivo): la cerraste tú.'); return { ok: true, cita: Number(c.id), estado: 'no_llego' }; }
    return { ok: false, error: 'evento desconocido' };
}

// ═══ EL RELOJ: el paso del tiempo también es realidad. Ejecuta las casillas vencidas; cada una REVISA A SU MAMÁ antes de salir. ═══
//  Idempotente entre procesos (cron, botones del reloj, dos pestañas): la casilla se RECLAMA (pendiente→enviando) antes de ejecutarse.
async function tick({ tenant, ioDe, hasta, chatId }) {
    await asegurar(); const t = tenant, tId = Number(t.id); const now = hasta || await ahora(tId); const hechas = [];
    const soloChat = chatId ? ' AND chat_id = ' + Number(chatId) : '';
    await run("UPDATE citaf_casillas SET estado = 'pendiente' WHERE tenant_id = ? AND estado = 'enviando' AND sent_ts < ?", [tId, Date.now() - 5 * MIN]).catch(() => { });   // reclamo huérfano (proceso que murió a medias) → se reintenta
    // AUTOCURACIÓN del invariante: toda visita viva debe tener una próxima acción. Si alguna quedó sin casilla pendiente, se re-planea.
    try { const hu = await query('SELECT id FROM citaf c WHERE tenant_id = ? AND estado IN ' + VIVAS_SQL + soloChat + " AND NOT EXISTS (SELECT 1 FROM citaf_casillas k WHERE k.cita_id = c.id AND k.estado IN ('pendiente','enviando'))", [tId]); for (const h of hu) { await reconciliar(t, h.id, now, 'autocuración'); await bitacora({ id: h.id, tenant_id: tId, chat_id: null }, now, 'reloj', 'autocuracion', null); } } catch (e) { }
    let choques = 0;
    for (let vuelta = 0; vuelta < 60; vuelta++) {
        const k = (await query("SELECT * FROM citaf_casillas WHERE tenant_id = ? AND estado = 'pendiente' AND due_ts <= ?" + soloChat + ' ORDER BY due_ts ASC, id ASC LIMIT 1', [tId, now]))[0]; if (!k) break;
        const rec = await run("UPDATE citaf_casillas SET estado = 'enviando', sent_ts = ? WHERE id = ? AND estado = 'pendiente'", [Date.now(), Number(k.id)]); if (!Number(rec.rowsAffected)) continue;   // otro proceso la ganó
        const c = await citaPorId(k.cita_id); const io = await ioDe(c); const cuando = Number(k.due_ts);
        const saltar = async (m) => { await run("UPDATE citaf_casillas SET estado = 'saltada', motivo = ?, sent_ts = ? WHERE id = ?", [m, cuando, Number(k.id)]); await io.sistema('⏱ ' + fechaCorta(cuando) + ' · ' + k.tipo + ' NO salió: ' + m); hechas.push({ tipo: k.tipo, due_ts: cuando, salio: false, motivo: m }); };
        const salio = async (tx) => { await run("UPDATE citaf_casillas SET estado = 'enviada', texto = ?, sent_ts = ? WHERE id = ?", [tx, cuando, Number(k.id)]); hechas.push({ tipo: k.tipo, due_ts: cuando, salio: true }); };
        try {
            if (!c || Number(k.version) !== Number(c.version)) { await saltar('pertenece a una realidad anterior (la visita cambió después de programarla)'); continue; }
            const x = slots(t, c, cuando); const acD = abreCierra(t, ymd(cuando)); if (acD) x.cierre = hm(acD.cierra);
            const nombreV = nombreVis(c);
            const hablo = async (tipos) => { const p = (await query('SELECT sent_ts FROM citaf_casillas WHERE cita_id = ? AND tipo IN (' + tipos.map(() => '?').join(',') + ") AND estado = 'enviada' ORDER BY sent_ts DESC LIMIT 1", [Number(c.id)].concat(tipos)))[0]; return p && Number(c.ultimo_in_ts) > Number(p.sent_ts); };
            // ── casillas del sistema / vendedor ──
            if (k.tipo === 'cierre') {
                if (!['viva', 'en_camino'].includes(c.estado)) { await saltar('la visita ya estaba ' + c.estado); continue; }
                if (c.estado === 'viva' && (Number(c.en_duda) === 1 || String(c.ultima_palabra) === 'promete_avisar')) {   // terminó la ventana y él HABÍA AVISADO: no es plantón → PENDIENTE DE REAGENDAR con rescate
                    await guardar(c, { estado: 'pospuesta', razon: c.razon || 'avisó que se le complicó y ya no concretó', en_duda: 0, version: Number(c.version) + 1, version_ts: cuando }, cuando); await bitacora(c, cuando, 'reloj', 'pendiente_reagendar', null); await salio('terminó la ventana: pendiente de reagendar');
                    await io.sistema('⏱ ' + fechaCorta(cuando) + ' · Terminó la ventana. Como había avisado, NO es plantón: queda PENDIENTE DE REAGENDAR y lo rescato yo.'); await reconciliar(t, c.id, cuando, 'terminó la ventana'); continue;
                }
                if (c.estado === 'viva' && Number(c.fin0_ts) > Number(c.fin_ts) + H) {   // precisó una hora y no llegó, pero SU ventana original sigue: se reabre suave
                    const dSig = masDias(ymd(Number(c.fin_ts)), 1); const ac = abreCierra(t, dSig);
                    await guardar(c, { ini_ts: ac ? ac.abre : at(dSig, 9, 0), fin_ts: Number(c.fin0_ts), precision: ymd(Number(c.fin0_ts)) === dSig ? 'dia' : 'dias', suave: 1, confirmada_dia: 0, ultima_palabra: 'silencio', version: Number(c.version) + 1, version_ts: cuando }, cuando);
                    await bitacora(c, cuando, 'reloj', 'reabre_ventana_original', null); await salio('reabre ventana original'); await io.sistema('⏱ ' + fechaCorta(cuando) + ' · No llegó en la hora que precisó, pero su ventana original sigue abierta hasta ' + fechaCorta(Number(c.fin0_ts)) + '. No se cierra: mañana un solo mensaje suave.'); await reconciliar(t, c.id, cuando, 'reabre la ventana original'); continue;
                }
                await guardar(c, { estado: 'esperando_cierre', version_ts: cuando }, cuando); await bitacora(c, cuando, 'reloj', 'termino_ventana', null); await salio('¿llegó?');
                await io.vendedor('❓ ¿Llegó ' + nombreV + ' a ver ' + (c.auto_nombre || 'el auto') + '? Ciérrala con "Llegó" o "No llegó".'); await reconciliar(t, c.id, cuando, 'terminó la ventana'); continue;
            }
            if (k.tipo === 'cierre_2') { if (c.estado !== 'esperando_cierre') { await saltar('ya la cerraron'); continue; } await salio('¿llegó? (2)'); await io.vendedor('❓ Sigue sin cierre la visita de ' + nombreV + ' de ayer. ¿Llegó o no llegó?'); continue; }
            if (k.tipo === 'sin_cierre') { if (c.estado !== 'esperando_cierre') { await saltar('ya la cerraron'); continue; } await guardar(c, { estado: 'sin_cierre' }, cuando); await bitacora(c, cuando, 'reloj', 'sin_cierre', null); await salio('sin cierre'); await io.sistema('⏱ ' + fechaCorta(cuando) + ' · Nadie dijo si llegó: queda como SIN CIERRE (se cuenta aparte; tus números no mienten).'); continue; }
            if (k.tipo === 'fin_rescate') { if (c.estado !== 'pospuesta') { await saltar('ya no estaba pendiente'); continue; } await guardar(c, { estado: 'no_llego', razon: (c.razon ? c.razon + ' · ' : '') + 'no retomó tras el rescate' }, cuando); await bitacora(c, cuando, 'reloj', 'no_asistio_definitivo', null); await salio('fin del rescate'); await io.sistema('⏱ ' + fechaCorta(cuando) + ' · Se agotó el rescate sin respuesta: NO ASISTIÓ (definitivo). Si regresa, nace una visita nueva ligada a esta.'); continue; }
            if (k.tipo === 'marcar') {
                if (c.estado !== 'viva' || Number(c.confirmada_dia) === 1 || Number(c.en_duda) === 1) { await saltar(c.estado !== 'viva' ? 'la visita ya estaba ' + c.estado : 'ya contestó'); continue; }
                if (await hablo(['empujon', 'dia', 'dia_ultimo'])) { await saltar('el comprador sí escribió después del recordatorio'); continue; }
                await bitacora(c, cuando, 'reloj', 'silencio_2', null); await salio('márcale'); await io.vendedor('📞 Márcale a ' + nombreV + ': no ha confirmado su visita de hoy (' + cuandoCorto(c, cuando) + ' · ' + (c.auto_nombre || '') + '). Ya se le escribió dos veces.'); continue;
            }
            if (k.tipo === 'marcar_pregunta') {
                if (!['viva', 'en_camino'].includes(c.estado) || !['se_retrasa', 'incierto'].includes(String(c.ultima_palabra)) || Number(c.ultimo_in_ts) > Number(c.version_ts)) { await saltar('ya contestó la pregunta'); continue; }
                await bitacora(c, cuando, 'reloj', 'silencio_a_pregunta', null); await salio('márcale'); await io.vendedor('📞 Márcale a ' + nombreV + ': ' + (String(c.ultima_palabra) === 'se_retrasa' ? 'dijo que se retrasa y no ha dicho a qué hora llega' : 'no quedó claro si sigue viniendo y no ha contestado') + ' · ' + (c.auto_nombre || '')); continue;
            }
            // ── casillas al comprador ──
            if (k.tipo === 'rescate') {
                if (c.estado !== 'pospuesta') { await saltar('ya no estaba pendiente de reagendar'); continue; }
                if (Number(c.ultimo_in_ts) > cuando - 24 * H) { await saltar('platicó hace menos de 24 h: no hace falta rescatarlo todavía'); continue; }
                const tx = texto(t, /:2$/.test(String(k.clave)) ? 'rescate_2' : 'rescate_1', x); await io.sistema('⏱ ' + fechaCorta(cuando) + ' · sale: rescate'); await io.mandar(tx); await salio(tx); continue;
            }
            if (c.estado !== 'viva') { await saltar('la visita ya estaba ' + c.estado); continue; }
            if (Number(c.callar_hasta_ts) >= cuando && k.tipo !== 'revision') { await saltar('dijo "yo te aviso": hoy no se le insiste'); continue; }
            if (Number(c.en_duda) === 1 && !['revision'].includes(k.tipo)) { await saltar('se le complicó: en duda, no se le insiste'); continue; }
            let tx = null;
            if (k.tipo === 'r1') { if (Number(c.ultimo_in_ts) > cuando - 6 * H) { await saltar('platicó hace menos de 6 h: no hace falta recordarle'); continue; } tx = texto(t, 'r1', x); }
            else if (k.tipo === 'vispera') tx = texto(t, c.precision === 'hora' ? 'vispera_hora' : 'vispera_sin_hora', x);
            else if (k.tipo === 'dia') { if (Number(c.confirmada_dia) === 1) { await saltar('el día ya estaba confirmado'); continue; } tx = texto(t, (c.precision === 'hora' || c.precision === 'franja') ? 'dia_hora' : 'dia_sin_hora', x); }
            else if (k.tipo === 'dia_multi') tx = texto(t, 'dia_multi', x);
            else if (k.tipo === 'dia_ultimo') tx = texto(t, 'dia_ultimo', x);
            else if (k.tipo === 'empujon') { if (Number(c.confirmada_dia) === 1 || await hablo(['dia', 'dia_ultimo'])) { await saltar('ya contestó el mensaje del día'); continue; } await bitacora(c, cuando, 'reloj', 'silencio_1', null); tx = texto(t, 'empujon', x); }
            else if (k.tipo === 'me_avisas') { if (Number(c.confirmada_dia) !== 1) { await saltar('no ha confirmado el día'); continue; } tx = texto(t, 'me_avisas', x); }
            else if (k.tipo === 'revision') tx = texto(t, 'revision', x);
            else if (k.tipo === 'revision_suave') tx = texto(t, 'revision_suave', x);
            if (!tx) { await saltar('tipo desconocido'); continue; }
            await io.sistema('⏱ ' + fechaCorta(cuando) + ' · sale: ' + k.tipo); await io.mandar(tx); await salio(tx);
        } catch (e) {
            // la visita cambió justo mientras esta casilla corría (IA o vendedor ganaron): se suelta el reclamo y la siguiente vuelta la revisa contra la realidad nueva
            await run("UPDATE citaf_casillas SET estado = 'pendiente' WHERE id = ? AND estado = 'enviando'", [Number(k.id)]).catch(() => { });
            if (!(e instanceof Conflicto) || ++choques > 5) { if (!(e instanceof Conflicto)) console.error('[citaf] tick:', e.message); break; }
        }
    }
    return hechas;
}

// ═══ LECTURA PARA LA UI ═══
const FINALES = ['realizada', 'cancelada', 'no_llego', 'sin_cierre', 'reemplazada'];
async function estado({ tenant, chat }) {
    await asegurar(); const tId = Number(tenant.id); const off = await offsetDe(tId); const now = Date.now() + off;
    const c = await citaViva(tId, Number(chat.id)) || await ultimaCita(tId, Number(chat.id));
    const out = { ok: true, reloj: { offset_ms: off, ahora_ts: now, ahora: fechaCorta(now), virtual: off > 0 }, horario_hoy: horarioTexto(tenant, ymd(now)), cita: null, casillas: [], eventos: [], historial: [] };
    const sig = (await query("SELECT MIN(due_ts) d FROM citaf_casillas WHERE tenant_id = ? AND estado = 'pendiente'", [tId]))[0]; out.reloj.siguiente_ts = sig && sig.d ? Number(sig.d) : null;
    if (!c) return out;
    out.cita = { id: Number(c.id), estado: c.estado, viva: VIVAS.includes(c.estado), situacion: situacionDe(tenant, c, now), concrecion: CONCRECION[c.precision] || c.precision, en_duda: !!Number(c.en_duda), suave: !!Number(c.suave), confirmada_dia: !!Number(c.confirmada_dia), precision: c.precision, auto: c.auto_nombre, cuando: c.estado === 'pospuesta' ? 'sin fecha' : cuandoCorto(c, now), ventana: fechaCorta(c.ini_ts) + (Number(c.fin_ts) !== Number(c.ini_ts) ? ' → ' + fechaCorta(c.fin_ts) : ''), ventana_original: (Number(c.ini0_ts) !== Number(c.ini_ts) || Number(c.fin0_ts) !== Number(c.fin_ts)) ? fechaCorta(c.ini0_ts) + ' → ' + fechaCorta(c.fin0_ts) : null, ini_ts: Number(c.ini_ts), fin_ts: Number(c.fin_ts), datos: datosDe(c), resultado: c.resultado || null, razon: c.razon || null, version: Number(c.version), previa_id: c.previa_id ? Number(c.previa_id) : null };
    out.casillas = (await query('SELECT tipo, para, due_ts, estado, motivo, sent_ts FROM citaf_casillas WHERE cita_id = ? ORDER BY due_ts ASC, id ASC', [Number(c.id)])).map(k => ({ tipo: k.tipo, para: k.para, due_ts: Number(k.due_ts), cuando: fechaCorta(k.due_ts), estado: k.estado, motivo: k.motivo || null }));
    out.eventos = (await query('SELECT ts, fuente, evento, detalle FROM citaf_eventos WHERE cita_id = ? ORDER BY id ASC', [Number(c.id)])).map(e => ({ cuando: fechaCorta(e.ts), fuente: e.fuente, evento: e.evento }));
    out.historial = (await query('SELECT id, estado, ini_ts, resultado FROM citaf WHERE tenant_id = ? AND chat_id = ? AND id <> ? ORDER BY id DESC LIMIT 6', [tId, Number(chat.id), Number(c.id)])).map(h => ({ id: Number(h.id), estado: h.estado, cuando: fechaCorta(h.ini_ts), resultado: h.resultado || null }));
    return out;
}
// ═══ LA LIBRETA: todas las visitas vivas del universo, cada una con su situación y su PRÓXIMA ACCIÓN. Métrica: VISITAS VIVAS SIN PRÓXIMA ACCIÓN = 0 ═══
const ACCION_TXT = { r1: 'recordatorio', vispera: 'mensaje de un día antes', dia: 'mensaje del día (pide confirmar)', dia_multi: 'mensaje del día', dia_ultimo: 'mensaje del último día', empujon: 'segundo intento', marcar: 'avisarte que le marques', marcar_pregunta: 'avisarte que le marques (no contestó la pregunta)', me_avisas: '"me avisas cuando vengas"', revision: 'revisar cómo va', revision_suave: 'mensaje suave', cierre: 'preguntarte si llegó', cierre_2: 'volver a preguntarte si llegó', sin_cierre: 'cerrar como "sin cierre"', rescate: 'rescate: buscarlo para reagendar', fin_rescate: 'cerrar como NO ASISTIÓ (rescate agotado)' };
async function tablero({ tenant }) {
    await asegurar(); const tId = Number(tenant.id); const off = await offsetDe(tId); const now = Date.now() + off;
    const cs = await query('SELECT * FROM citaf WHERE tenant_id = ? AND estado IN ' + VIVAS_SQL + ' ORDER BY ini_ts ASC', [tId]);
    const ids = cs.map(c => Number(c.id)); const ph = ids.map(() => '?').join(',');
    const ks = ids.length ? await query('SELECT cita_id, tipo, para, due_ts, estado, sent_ts FROM citaf_casillas WHERE cita_id IN (' + ph + ") AND estado IN ('pendiente','enviando','enviada') ORDER BY due_ts ASC, id ASC", ids) : [];
    const es = ids.length ? await query('SELECT cita_id, ts, fuente, evento FROM citaf_eventos WHERE id IN (SELECT MAX(id) FROM citaf_eventos WHERE cita_id IN (' + ph + ") AND evento <> 'pin_enviado' GROUP BY cita_id)", ids) : [];
    const ultE = {}; for (const e of es) ultE[Number(e.cita_id)] = e;
    const filas = cs.map(c => {
        const mias = ks.filter(k => Number(k.cita_id) === Number(c.id)); const prox = mias.find(k => k.estado !== 'enviada') || null;
        const marcado = mias.filter(k => k.estado === 'enviada' && /^marcar/.test(k.tipo) && Number(k.sent_ts) >= Number(c.ultimo_in_ts || 0)).pop();
        let atencion = null;
        if (c.estado === 'en_camino' && String(c.ultima_palabra) === 'ya_llegue') atencion = 'YA LLEGÓ: sal a recibirlo y márcalo';
        else if (c.estado === 'esperando_cierre') atencion = 'Dime si llegó o no llegó';
        else if (marcado) atencion = 'Márcale: no contesta';
        else if (ultE[Number(c.id)] && ['otra_cosa', 'incierto_otra_vez'].includes(ultE[Number(c.id)].evento)) atencion = 'Contéstale tú: dijo algo que no sé resolver';
        const u = ultE[Number(c.id)];
        const grupo = atencion ? 'atencion' : (c.estado === 'en_camino' ? 'en_camino' : (c.estado === 'pospuesta' ? 'rescate' : (ymd(Number(c.ini_ts)) <= ymd(now) ? 'hoy' : 'proximas')));
        return { cita_id: Number(c.id), chat_id: Number(c.chat_id), nombre: nombreVis(c), auto: c.auto_nombre || null, estado: c.estado, grupo, cuando: c.estado === 'pospuesta' ? 'sin fecha' : cuandoCorto(c, now), ini_ts: Number(c.ini_ts), concrecion: CONCRECION[c.precision] || c.precision, situacion: situacionDe(tenant, c, now), ultimo: u ? { cuando: fechaCorta(u.ts), fuente: u.fuente, evento: u.evento } : null, proxima: prox ? { tipo: prox.tipo, texto: ACCION_TXT[prox.tipo] || prox.tipo, para: prox.para, due_ts: Number(prox.due_ts), cuando: fechaCorta(prox.due_ts), vencida: Number(prox.due_ts) < now - 15 * MIN } : null, atencion, datos: datosDe(c) };
    });
    const sinProx = filas.filter(f => !f.proxima);
    return { ok: true, ahora: fechaCorta(now), virtual: off > 0, vivas: filas.length, sin_proxima_accion: sinProx.length, sin_proxima: sinProx.map(f => f.cita_id), vencidas: filas.filter(f => f.proxima && f.proxima.vencida).length, filas };
}
// citas vivas del universo → fila verde del inbox
async function vivasPorChat(tId) { await asegurar(); const r = await query("SELECT chat_id, ini_ts, auto_nombre, estado, confirmada_dia FROM citaf WHERE tenant_id = ? AND estado IN ('viva','en_camino')", [Number(tId)]).catch(() => []); const m = {}; for (const x of r) m[Number(x.chat_id)] = { cita_ts: Number(x.ini_ts), auto: x.auto_nombre || null, estado: 'confirmada' }; return m; }
async function reset(tId) { await asegurar(); for (const tb of ['citaf_casillas', 'citaf_eventos', 'citaf', 'citaf_reloj']) await run('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [Number(tId)]).catch(() => { }); }

// ═══ LA TUBERÍA (una sola, la usan el panel, el cron y las pruebas): sandbox → hilo; universo real → WhatsApp por la puerta de mensajes ═══
function ioPara(tC, chC) {
    const MSJ = require('./mensajeria.js'), DEMO = require('./demo.js'), U = require('./universo.js');
    const demo = DEMO.esDemo(tC); let n = 0; const base = 'citaf:' + Number(chC.id) + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 6);
    const nota = async (txt) => { try { if (demo) await DEMO.sistema(tC, String(chC.telefono), txt); else { const ts = Date.now(); await run("INSERT OR IGNORE INTO mensajes (conversacion_id, msg_id, ts, direccion, emisor, texto, tipo, ai_generated, created_at) VALUES (?,?,?,?,?,?,?,?,?)", [Number(chC.id), 'citaf-nota:' + ts + ':' + (n++), ts, 'out', 'sistema', txt, 'text', 1, ts]); } } catch (e) { } };
    const mandar = (extra) => MSJ.enviar(Object.assign({ tenantId: Number(tC.id), chatId: Number(chC.id), origen: 'sb', clave: base + ':' + (n++), manual: false, accion: 'cita_flex' }, extra));
    return {
        mandar: (tx) => mandar({ texto: tx }),
        pin: async (autoInvId) => { const pe = (await query('SELECT image_b64, lat, lng, name, maps_link FROM punto_envio WHERE auto_id = ?', [Number(autoInvId)]).catch(() => []))[0]; if (!pe) return; await mandar({ imagen: pe.image_b64 || null, imagen_ref: pe.image_b64 ? 'ubic-img:' + Number(autoInvId) : null, location: (pe.lat != null && pe.lng != null) ? { lat: pe.lat, lng: pe.lng, name: pe.name || '', maps_link: pe.maps_link || undefined } : null }); },
        vendedor: (txt) => nota(txt),   // TODO número real: además WhatsApp al vendedor del lote
        sistema: (txt) => nota(txt),
        catalogo: async () => (await query("SELECT i.id, i.fyradrive_web_id web, i.marca, i.modelo, i.anio FROM autos_universo au JOIN inventario_autos i ON i.id = au.inv_auto_id WHERE au.tenant_id = ? AND au.activo = 1 AND i.estado = 'activo'", [Number(tC.id)]).catch(() => [])).map(a => ({ id: Number(a.id), web: a.web == null ? null : Number(a.web), nombre: [a.marca, a.modelo, a.anio].filter(Boolean).join(' ') })),
        ponerFoco: async (a) => { const ch = await U.chatDe(Number(tC.id), String(chC.telefono), { crear: false }); if (ch) await U.cambiarFoco(ch, a.web || a.id, 'fyrachat', { activado_por: 'cita_flex', auto_nombre: a.nombre, solo_si_activa: true }); }
    };
}
// reloj REAL (cron cada 10 min): todos los universos con citas_flex. Misma función tick, misma puerta.
async function tickTodos() {
    await asegurar(); const U = require('./universo.js'); const out = [];
    const ts = await query("SELECT id, telefono, nombre, config_json FROM tenants WHERE activo = 1 AND config_json LIKE '%citas_flex%'").catch(() => []);
    for (const t of ts) { if (!activo(t)) continue; try { const h = await tick({ tenant: t, ioDe: async (c) => ioPara(t, (await U.chatPorId(Number(c.chat_id))) || { id: c.chat_id, telefono: c.tel }) }); out.push({ tenant: Number(t.id), casillas: h.length }); } catch (e) { out.push({ tenant: Number(t.id), error: e.message }); } }
    return out;
}

module.exports = { activo, asegurar, ahora, offsetDe, ponerOffset, entrante, vendedor, tick, tickTodos, estado, tablero, planear, reconciliar, ventanaDe, vivasPorChat, reset, citaViva, fechaCorta, horarioDe, ioPara, situacionDe, Conflicto, _t: { at, ymd, masDias, hm, fueraDeSilencio, leer, dosOpciones, cuandoCorto, cuandoLargo, autoDeTexto } };
