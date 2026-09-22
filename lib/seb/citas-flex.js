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
const VIVAS = ['viva', 'en_camino', 'pospuesta'];   // 'pospuesta' = SIN CUÁNDO: estacionamiento PASIVO (fuera del subsistema activo: sin recordatorios ni rescates) hasta que aparezca otra realidad temporal
const VIVAS_SQL = "('viva','en_camino','esperando_cierre','pospuesta')";   // (esperando_cierre ya no se usa; se conserva en el predicado del índice único que ya existe)
// FINALES: realizada (ASISTIÓ: "ya llegué"/"sí fui" del cliente o botón Llegó) · cancelada (su palabra) · no_llego (SOLO por mano del vendedor; jamás por silencio ni por reloj).
// VENTANA VENCIDA no es estado: es `viva` + ultima_palabra='ventana_vencida' (la única realidad objetiva: terminó la ventana sin llegada acreditada).
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
const aLas = ts => (/^1(:|\s)/.test(hm(ts)) ? 'a la ' : 'a las ') + hm(ts);
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
    await run('CREATE INDEX IF NOT EXISTS ix_citafc_cita ON citaf_casillas (cita_id, estado)').catch(() => { });   // atajo por visita (la revisión de seguridad ya no lee toda la lista)
    await run('CREATE INDEX IF NOT EXISTS ix_citaf_estado ON citaf (tenant_id, estado)').catch(() => { });
    // MECÁNICAS RETIRADAS (orden owner 2026-09-19): "esperando cierre" que persigue al vendedor y rescates automáticos. Lo que quedó vivo de eso se normaliza UNA vez.
    try {
        await run('DELETE FROM citaf_reloj WHERE tenant_id < ' + RELOJ_BASE);   // el reloj ya no es por universo
        if ((await query("SELECT 1 x FROM citaf WHERE estado = 'esperando_cierre' LIMIT 1"))[0]) await run("UPDATE citaf SET estado = 'viva', ultima_palabra = 'ventana_vencida', version = version + 1 WHERE estado = 'esperando_cierre'");
        if ((await query("SELECT 1 x FROM citaf_casillas WHERE estado = 'pendiente' AND tipo IN ('rescate','fin_rescate','cierre','cierre_2','sin_cierre','revision') LIMIT 1"))[0]) await run("UPDATE citaf_casillas SET estado = 'cancelada', motivo = 'mecánica retirada' WHERE estado = 'pendiente' AND tipo IN ('rescate','fin_rescate','cierre','cierre_2','sin_cierre','revision')");
    } catch (e) { }
    await run('CREATE INDEX IF NOT EXISTS ix_citafc_due ON citaf_casillas (tenant_id, estado, due_ts)').catch(() => { });
    _listo = true;
}
// RELOJ DE LA PRUEBA: UNO POR CLIENTE (chat), no por universo — adelantar o rebobinar a un cliente jamás toca a los demás.
// Vive en la misma tabla citaf_reloj bajo la llave 1e9 + chat_id. Universo real: nadie mueve relojes → desfase 0 = hora real.
const RELOJ_BASE = 1000000000;
async function offsetDe(chatId) { await asegurar(); if (!chatId) return 0; const r = (await query('SELECT offset_ms FROM citaf_reloj WHERE tenant_id = ?', [RELOJ_BASE + Number(chatId)]))[0]; return r ? Number(r.offset_ms) || 0 : 0; }
async function ahora(tId, chatId) { return Date.now() + await offsetDe(chatId); }
async function ponerOffset(chatId, ms) { await asegurar(); await run('INSERT INTO citaf_reloj (tenant_id, offset_ms) VALUES (?,?) ON CONFLICT(tenant_id) DO UPDATE SET offset_ms = excluded.offset_ms', [RELOJ_BASE + Number(chatId), Math.round(ms)]); }
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
// día completo de lote (si es hoy, de ahora en adelante)
function diaCompleto(t, d, now) { const ac = abreCierra(t, d); if (!ac) return null; const ini = Math.max(ac.abre, d === ymd(now) ? now : 0); if (ac.cierra - ini < 20 * MIN) return null; return { ok: true, ini, fin: ac.cierra, precision: 'dia' }; }
// ═══ LA REGLA GENERAL ═══  REALIDAD ANTERIOR + EVIDENCIA → QUÉ PARTE CAMBIA. El evento dice qué pasó; aquí se decide qué pedazo del cuándo toca:
//   mantener (nada/bandera) · estrechar · abrir la hora · quitar un día · reemplazar (agenda) · quedarse sin cuándo. SOLO se invalida lo que la evidencia invalidó.
function reescribir(t, c, ev, now) {
    const okF = x => /^\d{4}-\d{2}-\d{2}$/.test(String(x || '')); const hoy = ymd(now);
    const dA = ymd(Number(c.ini_ts)), dF = ymd(Number(c.fin_ts)), multi = dA !== dF, conHora = c.precision === 'hora' || c.precision === 'franja';
    const viva = ['viva', 'en_camino'].includes(c.estado) && String(c.ultima_palabra) !== 'ventana_vencida' && !Number(c.en_duda);
    const dia = okF(ev.dia_ini) && ev.dia_ini >= hoy ? ev.dia_ini : null; const enV = d => !!d && d >= dA && d <= dF;
    if (ev.evento === 'confirma') {
        if (!viva || !dia) return { op: 'bandera' };
        if (!enV(dia)) return { op: 'agenda' };                                   // confirmó un día que NO era el suyo = dio un cuándo nuevo
        if (multi) { const v = diaCompleto(t, dia, now); return v ? { op: 'estrecha', v, modo: 'confirma_dia' } : { op: 'bandera' }; }   // eligió el día: los demás días de la ventana quedan invalidados
        return { op: 'bandera' };
    }
    // VENTANA DE VARIOS DÍAS y algo se cayó: mientras queden días por delante, la incertidumbre NO borra lo que sigue siendo compatible.
    //   cayó un día de la orilla → ese día sale, el resto sigue · no se sabe cuál → la ventana no se toca y se pregunta · "todo" solo vale si además dijo que él avisa
    const parcial = viva && multi && ((ev.evento === 'se_complico' && !(ev.alcance === 'todo' && ev.avisara)) || (ev.evento === 'promete_avisar' && ev.alcance === 'dia'));
    if (parcial) {
        const abiertos = []; for (let d = dA, k = 0; d <= dF && k < 8; d = masDias(d, 1), k++) if (abreCierra(t, d)) abiertos.push(d);
        const cae = dia && enV(dia) ? dia : null;
        if (cae && abiertos.length > 1 && (cae === abiertos[0] || cae === abiertos[abiertos.length - 1])) {
            const resto = abiertos.filter(d => d !== cae); const a = abreCierra(t, resto[0]), z = abreCierra(t, resto[resto.length - 1]);
            return { op: 'quita_dia', cae, modo: 'quita_dia', v: { ok: true, ini: Math.max(a.abre, resto[0] === hoy ? now : 0), fin: z.cierra, precision: resto.length > 1 ? 'dias' : 'dia' } };
        }
        if (abiertos.some(d => d > hoy)) return { op: 'pregunta' };
    }
    if (ev.evento === 'promete_avisar') {
        if (!viva || (ev.alcance !== 'hora' && !dia)) return { op: 'sin_cuando' };
        const d1 = dia || (multi ? null : dA);
        if (!d1) return { op: 'bandera' };                                        // ventana de varios días sin hora: no hay nada más que abrir
        if (!enV(d1)) return { op: 'agenda_dia', v: diaCompleto(t, d1, now) };    // nombró otro día que sí queda firme
        if (!multi && !conHora) return { op: 'bandera' };                         // ya estaba "ese día, hora abierta"
        const v = diaCompleto(t, d1, now); return v ? { op: 'abre_hora', v, modo: 'abre_hora' } : { op: 'sin_cuando' };
    }
    if (ev.evento === 'se_complico') {
        return { op: 'cae_todo' };
    }
    return { op: 'nada' };
}
const FRANJA_TXT = { manana: 'en la mañana', mediodia: 'al mediodía', tarde: 'en la tarde', noche: 'en la noche', tarde_noche: 'en la tarde-noche' };
function aproxTxt(c) { const a = (c && c.precision === 'dias') ? datosDe(c).hora_aprox : null; if (!a) return ''; if (/^\d{1,2}:\d{2}$/.test(a)) { const [h, m] = a.split(':').map(Number); return ', como ' + aLas(at('2026-01-01', h, m)); } return FRANJA_TXT[a] ? ', ' + FRANJA_TXT[a] : ''; }
function cuandoLargo(t, c) {
    const p = c.precision;
    if (p === 'hora') return Cap(diaLargo(c.ini_ts)) + ' ' + aLas(c.ini_ts);
    if (p === 'franja') return Cap(diaLargo(c.ini_ts)) + ', entre ' + hm(c.ini_ts) + ' y ' + hm(c.fin_ts);
    if (p === 'dia') return Cap(diaLargo(c.ini_ts)) + ', a la hora que te acomode. Ese día estamos ' + horarioTexto(t, ymd(c.ini_ts));
    const ds = []; for (let d = ymd(c.ini_ts); d <= ymd(c.fin_ts); d = masDias(d, 1)) ds.push(d);
    return 'Entre ' + diaLargo(c.ini_ts) + ' y ' + diaLargo(c.fin_ts) + (aproxTxt(c) || ', a la hora que te acomode') + '.\n' + ds.map(d => Cap(DIAS[dow(at(d, 12, 0))]) + ' ' + horarioTexto(t, d)).join(' · ');
}
// cuándo para el aviso al vendedor: "jueves, hora abierta" · "jueves 5 pm" · "jueves en la tarde (3 pm–7 pm)" · "sábado a domingo"
function cuandoAviso(c) {
    const d = ts => DIAS[dow(Number(ts))]; const p = c.precision;
    if (p === 'hora') return d(c.ini_ts) + ' ' + hm(c.ini_ts); if (p === 'franja') return d(c.ini_ts) + ' entre ' + hm(c.ini_ts) + ' y ' + hm(c.fin_ts);
    if (p === 'dia') return d(c.ini_ts) + ', hora abierta'; return d(c.ini_ts) + ' a ' + d(c.fin_ts) + ', hora abierta';
}
function cuandoCorto(c, now) {
    const rel = d => d === ymd(now) ? 'hoy' : (d === masDias(ymd(now), 1) ? 'mañana' : 'el ' + DIAS[dow(at(d, 12, 0))]);
    const p = c.precision, d = ymd(c.ini_ts);
    if (p === 'hora') return rel(d) + ' ' + aLas(c.ini_ts);
    if (p === 'franja') return rel(d) + ' entre ' + hm(c.ini_ts) + ' y ' + hm(c.fin_ts);
    if (p === 'dia') return rel(d);
    return 'entre ' + rel(d) + ' y ' + rel(ymd(c.fin_ts)) + aproxTxt(c);
}

// ── PLANTILLAS (borrador sobrio — el owner las calibra; override por universo en config.citaf_textos) ──
const TXT = {
    // NACE FORMAL: él llegó con día Y hora → se le corresponde con la formalidad de un registro (datos completos) y luego un cierre de servicio
    nace: x => 'Excelente' + x.n + '||Entonces te confirmo tu cita: ' + lc(x.cuando) + (x.lugar ? ' aquí en ' + x.lugar : '') + ' para ver ' + x.elauto + (x.recibe ? '. Te recibe ' + x.recibe : '') + (x.pin ? '||Te mando la ubicación' : ''),
    nace_cierre: x => 'Me avisas cualquier cosa' + x.n + ', para servirte',
    // NACE SUAVE: solo dijo el día (o "el fin de semana") → mano izquierda: la visita se registra por detrás y aquí solo se busca la hora, sin asustarlo con un compromiso
    nace_suave: x => 'Claro que sí' + x.n + '||' + (x.hoy ? 'Hoy estamos hasta las ' + x.cierre + ', a qué hora te esperamos?' : 'A qué hora te viene bien ' + x.corto + '?'),
    nace_suave_dias: x => 'Claro que sí' + x.n + ', ' + x.corto + ' aquí andamos||Traes alguna hora en mente?',
    posibilidad_adelanto: x => 'Sí claro' + x.n + '||Si alcanzas ' + x.alt_corto + ' me avisas cuando vayas saliendo y te tenemos el carro listo||Si no, dejamos ' + x.corto + ' como está',
    posibilidad_dentro: x => 'Sí claro' + x.n + '||Si alcanzas ' + x.alt_corto + ' me avisas cuando vayas saliendo y te tenemos el carro listo||Si no, seguimos ' + x.corto + ' como quedamos',
    posibilidad_atraso: x => 'Va' + x.n + ', por ahora dejamos ' + x.corto + '||Si ves que sí será ' + x.alt_corto + ' me avisas y lo movemos',
    cambio_sin_hora: x => 'Va' + x.n + ', sin problema||Te movemos la cita a ' + x.corto + ', a qué hora ' + (x.hoy ? 'nos alcanzas' : 'te esperamos') + '?',
    cambio: x => 'Va' + x.n + ', sin tema||Te muevo la cita: ' + lc(x.cuando),
    precisa: x => 'Va perfecto||Entonces nos vemos ' + x.corto + x.n + (x.pin ? '||Te mando la ubicación' : ''),
    ajuste: x => 'Va, sin tema||Entonces nos vemos ' + x.corto,
    reagenda: x => 'Va perfecto||Entonces nos vemos ' + x.corto + x.n,
    angosta_hoy: x => 'Va perfecto, ' + x.corto + ' aquí te esperamos||Hoy estamos hasta las ' + x.cierre + (x.pin ? '. Te dejo otra vez la ubicación' : '') + '||Me avisas cuando vengas',
    fuera_horario: x => x.nombre_coma + 'ese día estamos ' + x.horario + '. ¿Alcanzas en ese horario?',
    r1: x => 'Qué tal' + x.n + ', gusto en saludarte||Seguimos pendientes ' + (/^entre /.test(x.corto) ? '' : 'para ') + x.corto + ', me avisas cualquier cosa',
    vispera_hora: x => 'Qué tal' + x.n + ' ' + x.saludo + ', espero que te encuentres bien||Mañana sí nos vemos ' + x.alas + ' para ver ' + x.el + ' correcto?',
    vispera_sin_hora: x => 'Qué tal' + x.n + ' ' + x.saludo + ', espero que te encuentres bien||A qué horas te esperamos mañana para ver ' + x.el + '?',
    vispera_multi: x => 'Qué tal' + x.n + ' ' + x.saludo + '||Ya casi es ' + x.ventana_nombre + ', qué día te acomoda más para ver ' + x.el + ': ' + x.dias_lista + '?',
    vispera_avisa: x => 'Qué tal' + x.n + ' ' + x.saludo + '||Mañana nos vemos para ver ' + x.el + ', me avisas cuando vengas',
    dia_hora: x => 'Qué tal' + x.n + ' ' + x.saludo + ', cómo estás?||Hoy sí nos vemos ' + x.alas + ' para ver ' + x.el + ' correcto?',
    dia_sin_hora: x => 'Qué tal' + x.n + ' ' + x.saludo + ', cómo estás?||Hoy nos vemos para ver ' + x.el + ', estamos hasta las ' + x.cierre + '||A qué hora te esperamos?',
    dia_avisa: x => 'Qué tal' + x.n + ' ' + x.saludo + '||Hoy nos vemos para ver ' + x.el + ', estamos hasta las ' + x.cierre + '||Me avisas cuando vengas',
    dia_multi: x => 'Qué tal' + x.n + ' ' + x.saludo + '||Hoy lo ves o te queda mejor ' + x.otros_dias + '? Hoy estamos hasta las ' + x.cierre,
    dia_ultimo: x => 'Qué tal' + x.n + ' ' + x.saludo + ', cómo estás?||Hoy nos vemos para ver ' + x.el + ', estamos hasta las ' + x.cierre + '||A qué hora te esperamos?',
    empujon: x => 'Todo bien para hoy' + x.n + '?||Aquí te esperamos',
    confirma_dia: x => 'Perfecto, aquí nos vemos' + x.n + '||Me avisas cuando vengas',
    confirma_antes: x => 'Perfecto, ahí nos vemos' + x.n,
    confirma_hoy: x => 'Perfecto, aquí te esperamos hoy' + (x.cierre ? ', estamos hasta las ' + x.cierre : '') + '. Me avisas cuando vengas en camino.',
    me_avisas: x => Cap(x.saludo) + x.n + '||Me avisas cuando vengas para recibirte',
    ya_voy: x => 'Vava, aquí te esperamos' + x.n + (x.referencia ? '||' + x.referencia : ''),
    ya_llegue: x => 'Va, ahorita salen a recibirte.',
    retraso_ok: x => 'Sin tema, aquí te esperamos||Me avisas cuando vengas',
    se_retrasa_pregunta: x => 'Sin tema' + x.n + '||Como a qué hora calculas llegar?',
    se_retrasa_camino: x => 'Sin tema' + x.n + ', con calma. ¿Como en cuánto calculas llegar?',
    incierto: x => x.nombre_coma + 'para tenerte el auto listo: ¿sí nos vemos ' + x.corto + ' o prefieres que lo movamos?',
    cambio_auto: x => 'Va, entonces ' + x.corto + ' te esperamos para ver ' + x.elauto + '.',
    gracias: x => 'Gracias a ti' + x.n + '||' + (x.viva ? 'Estamos en contacto' : 'Para servirte'),
    pide_dia: x => 'Qué día y a qué hora te queda bien?',
    aclaracion: x => 'Qué tal' + x.n + ' ' + x.saludo + '||Sí alcanzaste a pasar ayer o todavía tienes pensado venir a ver ' + x.el + '?',
    aclaracion_duda: x => 'Qué tal' + x.n + ' ' + x.saludo + ', espero que te encuentres bien||Te sigue interesando ' + x.el + '?',
    realizada: x => 'Va, ahorita salen a recibirte.',
    ya_fue: x => 'Qué bueno' + x.n + ', gracias por avisar. Cualquier duda aquí andamos.',
    // SE LE COMPLICÓ: primero el acuse con tacto; en burbuja aparte se le ofrece reagendar (el día y la hora se piden DESPUÉS, si dice que sí)
    se_complico: x => 'Va' + x.n + ', sin tema||Gustas que te reagendemos?',
    se_complico_multi: x => 'Sin tema' + x.n + '. ¿Te sigue quedando ' + x.otros_dias + ' o prefieres otro día?',
    quita_dia: x => 'Sin tema, entonces nos vemos ' + x.corto + (x.hoy ? '||Me avisas cuando vengas' : '||Cualquier cambio me avisas'),
    pasa_ahorita: x => 'Sí claro' + x.n + ', pásale||Aquí te esperamos hasta las ' + x.cierre + ', me avisas cuando vengas en camino',
    quien_soy: x => 'Con ' + x.yo + ', para servirte',
    avisa_al_salir_hoy: x => 'Va, sin presión' + x.n + '||Hoy estamos' + (x.cierre ? ' hasta las ' + x.cierre : '') + ', me avisas cuando vengas',
    avisa_al_salir: x => 'Va, sin presión' + x.n + '||Nos vemos ' + x.corto + ', me avisas cuando vengas',
    promete_avisar: x => 'Vava' + x.n + ', sin tema||Aquí estamos para cuando gustes, me avisas',
    cancela: x => 'Entendido' + x.n + ', gracias por avisar. Cualquier cosa aquí andamos.',
    revision_suave: x => 'Qué tal' + x.n + ', ' + x.saludo + '||Hoy también estamos por aquí hasta las ' + x.cierre + ' por si se te acomoda pasar a ver ' + x.el + '.',
    auto_vendido: x => x.nombre_coma + 'te aviso antes de que des la vuelta: ' + x.elauto + ' se acaba de vender. ¿Te muestro opciones parecidas para que aproveches tu visita?',
    mueve_vendedor: x => x.nombre_coma + 'una disculpa, necesitamos mover tu cita. ¿Qué otro día te queda bien?'
};
const CLAVE_DE = new Map();     // texto base → { clave, nombre } (solo memoria del proceso; si se pierde, el mensaje sale tal cual la plantilla)
const lc = s0 => String(s0 || '').charAt(0).toLowerCase() + String(s0 || '').slice(1);
function texto(t, clave, x) { const o = cfgDe(t).citaf_textos; const tx = (o && typeof o[clave] === 'string' && o[clave].trim()) ? o[clave].replace(/\{(\w+)\}/g, (m, k) => x[k] == null ? '' : String(x[k])) : TXT[clave](x); if (CLAVE_DE.size > 400) CLAVE_DE.clear(); CLAVE_DE.set(tx, { clave, nombre: String(x.n || '').trim(), saludo: x.saludo || '' }); return tx; }
function slots(t, c, now) {
    const nom = String(c.nombre || '').trim().split(/\s+/)[0]; const n1 = nom && nom !== '.' && !/^\+?\d/.test(nom) ? Cap(nom.toLowerCase()) : '';
    const ac = abreCierra(t, ymd(Math.max(now, 0))) || {};
    const dd = []; for (let d = ymd(Number(c.ini_ts)), k = 0; d <= ymd(Number(c.fin_ts)) && k < 7; d = masDias(d, 1), k++) if (abreCierra(t, d)) dd.push(d);
    const o = (l, art) => { l = l.map(d => (art ? 'el ' : '') + DIAS[dow(at(d, 12, 0))]); return l.length > 1 ? l.slice(0, -1).join(', ') + ' o ' + l[l.length - 1] : (l[0] || ''); };
    const finde = dd.length >= 2 && dd.every(d => [5, 6, 0].includes(dow(at(d, 12, 0))));
    const pa = String(c.auto_nombre || '').trim().split(/\s+/); const corto_a = pa.length >= 2 ? ((/^\d+$/.test(pa[1]) || pa[1].length <= 2) ? pa[0] + ' ' + pa[1] : Cap(pa[1].toLowerCase())) : (pa[0] || '');
    const hL = L(now).getUTCHours(); const saludo = hL < 12 ? 'buen día' : (hL < 19 ? 'buenas tardes' : 'buenas noches');
    const alt = datosDe(c).alt; const alt_corto = alt ? cuandoCorto({ ini_ts: alt.ini_ts, fin_ts: alt.fin_ts, precision: alt.precision, estado: 'viva', datos_json: '{}' }, now) : '';
    return { alt_corto, saludo, el: corto_a ? 'el ' + corto_a : 'el auto', hoy: ymd(Number(c.ini_ts)) === ymd(now), dias_lista: o(dd, false), otros_dias: o(dd.filter(d => d > ymd(now)), true) || 'otro día', ventana_nombre: finde ? 'fin de semana' : 'la fecha', n: n1 ? ' ' + n1 : '', nombre_coma: n1 ? n1 + ', ' : '', auto: c.auto_nombre || '', elauto: c.auto_nombre ? 'el ' + c.auto_nombre : 'el auto', cuando: cuandoLargo(t, c), corto: cuandoCorto(c, now), hora: c.precision === 'franja' ? 'entre ' + hm(c.ini_ts) + ' y ' + hm(c.fin_ts) : hm(c.ini_ts), alas: c.precision === 'franja' ? 'entre ' + hm(c.ini_ts) + ' y ' + hm(c.fin_ts) : aLas(c.ini_ts), cierre: ac.cierra ? hm(ac.cierra) : '', recibe: cfgDe(t).recibe || '', yo: (cfgDe(t).recibe || cfgDe(t).vendedor_nombre || 'Sebastián') + (t && t.nombre ? ' de ' + Cap(String(t.nombre).toLowerCase()) : ''), referencia: cfgDe(t).referencia || '' };
}

// ═══ LA LÍNEA DEL TIEMPO: función PURA de (cita, ahora). Devuelve las casillas que DEBEN existir de aquí en adelante. ═══
function planear(t, c, now) {
    const P = []; const v = Number(c.version) || 1; const T0 = Number(c.version_ts) || Number(c.created) || now;
    const add = (tipo, due, para, suf) => { if (due == null) return; P.push({ clave: c.id + ':v' + v + ':' + tipo + (suf ? ':' + suf : ''), tipo, para: para || 'comprador', due_ts: Math.round(due) }); };
    const ya = now + MIN;
    // SIN CUÁNDO (pospuesta) = fuera del subsistema activo: CERO acciones programadas. Finales: nada.
    if (c.estado !== 'viva' && c.estado !== 'en_camino') return P;
    const A = Number(c.ini_ts), F = Number(c.fin_ts), dA = ymd(A), dF = ymd(F), multi = dA !== dF, conHora = c.precision === 'hora' || c.precision === 'franja';
    // VENTANA VENCIDA sin llegada acreditada: lo ÚNICO que sigue es UNA aclaración al cliente a la mañana siguiente. Si no contesta NO se concluye nada.
    if (String(c.ultima_palabra) === 'ventana_vencida') { add('aclaracion', Math.max(at(masDias(ymd(Math.max(F, T0)), 1), 9, 30), fueraDeSilencio(ya)), 'comprador'); return P; }
    // VENCIMIENTO de la ventana (hora exacta: 90 min de espera; ventana: 30 min tras el fin). Nunca se filtra: toda visita con cuándo tiene este checkpoint.
    add('vence', Math.max(F + (c.precision === 'hora' ? 90 : 30) * MIN, ya), 'sistema');
    if (c.estado === 'en_camino') return P;   // ya viene: nada más le escribe
    // PREGUNTA ABIERTA ("se retrasa" sin nueva hora · mensaje ambiguo): si no contesta, el vendedor recibe UN aviso para marcarle
    if (['se_retrasa', 'incierto'].includes(String(c.ultima_palabra))) add('marcar_pregunta', T0 + (String(c.ultima_palabra) === 'se_retrasa' ? 40 : 90) * MIN, 'vendedor');
    if (c.suave) {   // precisó una hora y no llegó, pero SU ventana original sigue: UN solo mensaje suave por día, sin empujones
        for (let d = dA; d <= dF; d = masDias(d, 1)) { const ac = abreCierra(t, d); if (ac) add('revision_suave', Math.max(ac.abre + 30 * MIN, at(d, 9, 30)), 'comprador', d); }
        return P.filter(x => x.due_ts > now || x.tipo === 'vence');
    }
    if (c.en_duda) return P.filter(x => x.due_ts > now || x.tipo === 'vence');   // "hoy no alcanzo": ya se le preguntó qué día; los recordatorios de la fecha vieja no salen
    // MENSAJE DEL DÍA (cada día de la ventana). Con hora: a más tardar 2 h antes. Nació/se movió ese mismo día → ese día ya cuenta como confirmado.
    const Dde = d => { let x = at(d, 9, 30); if (d === dA && conHora) x = Math.min(x, A - 2 * H); return Math.max(x, at(d, 8, 0)); };
    for (let d = dA; d <= dF; d = masDias(d, 1)) {
        if (d === ymd(T0)) continue;
        const ultimo = d === dF; const Dts = Dde(d);
        if (!(c.confirmada_dia && d === dA)) add(multi ? (ultimo ? 'dia_ultimo' : 'dia_multi') : 'dia', Dts, 'comprador', d);
        // SEGUNDO INTENTO y "márcale" solo en el ÚLTIMO día; la no-respuesta NO cambia la realidad: solo deja correr el checkpoint que ya correspondía
        if (ultimo && !(c.confirmada_dia && d === dA)) {
            const limite = (!multi && c.precision === 'hora') ? A : F; const emp = Dts + (limite - Dts) / 2; const mar = emp + (limite - emp) / 2;
            if (limite - Dts >= 90 * MIN) { add('empujon', emp, 'comprador', d); add('marcar', mar, 'vendedor', d); }
        }
    }
    // "ME AVISAS CUANDO VENGAS": solo con el día confirmado y con hora/franja
    if (c.confirmada_dia && conHora && ymd(now) === dA) add('me_avisas', A - 60 * MIN, 'comprador');
    // RECORDATORIOS PREVIOS, proporcionales al hueco entre el nacimiento (o último cambio) y el mensaje del primer día
    const D1 = Dde(dA);
    if (dA !== ymd(T0)) {
        const vis = at(masDias(dA, -1), 18, 0); const hayVis = vis - T0 >= 5 * H; if (hayVis) add('vispera', vis, 'comprador');
        const tope = hayVis ? vis : D1; const hueco = tope - T0;
        if (hueco >= 6 * DIA) { add('r1', fueraDeSilencio(T0 + hueco / 3), 'comprador', 'a'); add('r1', fueraDeSilencio(T0 + 2 * hueco / 3), 'comprador', 'b'); }
        else if (hueco >= 2 * DIA) add('r1', fueraDeSilencio(T0 + hueco / 2), 'comprador', 'a');
    }
    return P.filter(x => x.due_ts > now || x.tipo === 'vence');
}
// PLANTILLA de cada casilla al cliente (una sola fuente: la usa el reloj al enviar y el panel de entrenamiento al previsualizar)
function plantillaDe(c, tipo) {
    const conHora = c.precision === 'hora' || c.precision === 'franja';
    return ({ r1: 'r1', vispera: c.precision === 'hora' ? 'vispera_hora' : (c.precision === 'dias' ? 'vispera_multi' : (String(c.ultima_palabra) === 'promete_avisar' ? 'vispera_avisa' : 'vispera_sin_hora')), dia: conHora ? 'dia_hora' : (String(c.ultima_palabra) === 'promete_avisar' ? 'dia_avisa' : 'dia_sin_hora'), dia_multi: 'dia_multi', dia_ultimo: 'dia_ultimo', empujon: 'empujon', me_avisas: 'me_avisas', revision_suave: 'revision_suave', aclaracion: Number(c.en_duda) ? 'aclaracion_duda' : 'aclaracion' })[tipo] || null;
}
function vistaPrevia(t, c, k) {   // texto EXACTO que saldría (cliente) o descripción del aviso (vendedor/sistema)
    const pl = plantillaDe(c, k.tipo); if (pl && k.para === 'comprador') { const x = slots(t, c, k.due_ts); const ac = abreCierra(t, ymd(k.due_ts)); if (ac) x.cierre = hm(ac.cierra); return texto(t, pl, x).split('||').join('\n'); }
    const n = nombreVis(c);
    if (k.tipo === 'marcar') return '📞 Márcale a ' + n + ': no ha confirmado su visita de hoy. Ya se le escribió dos veces.';
    if (k.tipo === 'marcar_pregunta') return '📞 Márcale a ' + n + ': no contestó la pregunta que se le hizo.';
    if (k.tipo === 'vence') return efectoVence(t, c, k.due_ts).reabre ? '(interno) pasa la hora que precisó: se reabre su ventana original en modo suave' : '⚠️ Terminó la ventana de ' + n + ' sin llegada acreditada. (La visita sigue VIVA; mañana se le pregunta al cliente.)';
    return null;
}
// EFECTO DEL VENCIMIENTO (puro): precisó una hora y su ventana original sigue → se reabre suave; si no → viva + 'ventana_vencida'. Lo usan el reloj y la proyección.
function efectoVence(t, c, cuando) {
    if (c.estado === 'viva' && !Number(c.en_duda) && Number(c.fin0_ts) > Number(c.fin_ts) + H) { const dSig = masDias(ymd(Number(c.fin_ts)), 1); const ac = abreCierra(t, dSig); return { reabre: true, campos: { ini_ts: ac ? ac.abre : at(dSig, 9, 0), fin_ts: Number(c.fin0_ts), precision: ymd(Number(c.fin0_ts)) === dSig ? 'dia' : 'dias', suave: 1, confirmada_dia: 0, ultima_palabra: 'silencio', version: Number(c.version) + 1, version_ts: cuando } }; }
    return { reabre: false, campos: { estado: 'viva', ultima_palabra: 'ventana_vencida', suave: 0, version: Number(c.version) + 1, version_ts: cuando } };
}
// PROYECCIÓN (pura, sin base): "si de aquí en adelante nadie dice nada, ¿qué pasaría y cuándo?". Es el MISMO planear() encadenado con el MISMO efecto del vencimiento:
// un reflejo del motor, no una réplica. La usa el simulador para pintar el futuro y dejar mover el cursor del tiempo sin ejecutar nada.
function proyectar(t, c, now) {
    const out = []; let cc = Object.assign({}, c), cur = now; const visto = new Set();
    for (let vuelta = 0; vuelta < 6; vuelta++) {
        const P = planear(t, cc, cur).sort((a, b) => a.due_ts - b.due_ts); let cambio = false;
        for (const k of P) {
            const key = k.tipo + ':' + k.due_ts; if (!visto.has(key)) { visto.add(key); out.push({ tipo: k.tipo, para: k.para, due_ts: k.due_ts, cuando: fechaCorta(k.due_ts), condicion: ['empujon', 'marcar', 'marcar_pregunta'].includes(k.tipo) ? 'solo si sigue sin contestar' : (k.tipo === 'me_avisas' ? 'solo con el día confirmado' : null), efecto: k.tipo === 'vence' ? (efectoVence(t, cc, k.due_ts).reabre ? 'pasa la hora que precisó: se reabre su ventana original (modo suave)' : 'la ventana vence sin llegada acreditada: sigue VIVA, se te avisa y mañana se le pregunta') : null }); }
            if (k.tipo === 'vence') { Object.assign(cc, efectoVence(t, cc, k.due_ts).campos); cur = k.due_ts; cambio = true; break; }
        }
        if (!cambio) break;
    }
    return out;
}
// Reconciliar = dejar en la tabla EXACTAMENTE el plan: lo pendiente que ya no está en el plan se cancela (con motivo); lo nuevo nace. Lo ya enviado/saltado es historia.
async function reconciliar(t, cOId, now, motivo, _vuelta) {
    const c = await citaPorId(typeof cOId === 'object' ? cOId.id : cOId); if (!c) return;   // se planea sobre lo que ES verdad ahora (no sobre la copia de quien llama): dos procesos casi simultáneos convergen al mismo plan
    const plan = planear(t, c, now); const porClave = {}; plan.forEach(p => porClave[p.clave] = p);
    const pend = await query("SELECT id, clave, due_ts FROM citaf_casillas WHERE cita_id = ? AND estado = 'pendiente'", [Number(c.id)]);
    // RÁPIDO: 1 lectura + a lo más 3 escrituras por conciliación (antes eran 2 por cada recordatorio)
    const sobran = pend.filter(p => !porClave[p.clave]).map(p => Number(p.id));
    if (sobran.length) await run("UPDATE citaf_casillas SET estado = 'cancelada', motivo = ? WHERE estado = 'pendiente' AND id IN (" + sobran.map(() => '?').join(',') + ')', [motivo || 'la cita cambió'].concat(sobran));
    const ya = new Set(pend.map(p => p.clave)); const nuevas = plan.filter(p => !ya.has(p.clave));
    if (nuevas.length) await run('INSERT OR IGNORE INTO citaf_casillas (cita_id, tenant_id, chat_id, clave, tipo, para, due_ts, estado, version) VALUES ' + nuevas.map(() => '(?,?,?,?,?,?,?,?,?)').join(','), nuevas.flatMap(p => [Number(c.id), Number(c.tenant_id), Number(c.chat_id), p.clave, p.tipo, p.para, p.due_ts, 'pendiente', Number(c.version) || 1]));
    for (const p of pend) { const q = porClave[p.clave]; if (q && Number(q.due_ts) !== Number(p.due_ts)) await run("UPDATE citaf_casillas SET due_ts = ? WHERE id = ? AND estado = 'pendiente'", [q.due_ts, Number(p.id)]); }   // misma casilla, hora recalculada (raro)
    // CARRERA: si mientras yo planeaba otro proceso cambió la visita, mi plan ya es de una realidad anterior → se vuelve a conciliar contra la verdad nueva (converge: el último siempre limpia)
    const c2 = await citaPorId(c.id); if (c2 && (Number(c2.version) !== Number(c.version) || c2.estado !== c.estado || String(c2.ultima_palabra) !== String(c.ultima_palabra) || Number(c2.confirmada_dia) !== Number(c.confirmada_dia) || Number(c2.en_duda) !== Number(c.en_duda)) && (_vuelta || 0) < 3) return reconciliar(t, c.id, now, motivo, (_vuelta || 0) + 1);
}

// ═══ LECTOR DE EVENTOS (IA chica, salida forzada). La IA NO inventa estados: traduce la frase a "qué cambió objetivamente en la realidad"
//     = le pica al botón correcto de una lista CERRADA. El código decide todo lo demás. ═══
const EVENTOS = ['agenda_o_cambio', 'confirma', 'se_retrasa', 'promete_avisar', 'ya_voy', 'ya_llegue', 'ya_fue', 'se_complico', 'cancela', 'cambia_auto', 'incierto', 'no_es_de_cita', 'otra_cosa'];
const SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['razon', 'evento', 'confianza', 'dia_ini', 'dia_fin', 'hora_ini', 'hora_fin', 'franja', 'alcance', 'tentativo', 'sigue_interesado', 'avisa_dia', 'avisa_hora', 'avisara', 'minutos_tarde', 'auto_texto', 'restriccion', 'asiste', 'condicion', 'a_cuenta', 'foraneo', 'pregunta_comercial', 'motivo'],
    properties: {
        razon: { type: 'string' }, evento: { type: 'string', enum: EVENTOS }, confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
        dia_ini: { type: 'string' }, dia_fin: { type: 'string' }, hora_ini: { type: 'string' }, hora_fin: { type: 'string' },
        franja: { type: 'string', enum: ['', 'manana', 'mediodia', 'tarde', 'noche', 'tarde_noche'] },
        alcance: { type: 'string', enum: ['', 'hora', 'dia', 'todo'] }, tentativo: { type: 'boolean' }, sigue_interesado: { type: 'boolean' },
        avisa_dia: { type: 'string' }, avisa_hora: { type: 'string' }, avisara: { type: 'boolean' }, minutos_tarde: { type: 'integer' }, auto_texto: { type: 'string' },
        restriccion: { type: 'string' }, asiste: { type: 'string' }, condicion: { type: 'string' }, a_cuenta: { type: 'boolean' }, foraneo: { type: 'boolean' },
        pregunta_comercial: { type: 'string' }, motivo: { type: 'string' }
    }
};
async function haiku(system, content, schema) {
    const apiKey = process.env.CLAUDE_API_KEY; if (!apiKey) return null;
    for (let i = 0; i < 2; i++) {
        try {
            const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: HAIKU, max_tokens: 500, system, messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema: schema || SCHEMA } } }) });
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
    // "ya voy" / "ya llegué" NO deciden solos (orden del owner): una palabra suelta no acredita movimiento físico. La IA lo lee CON CONTEXTO; el código solo verifica después.
    if (c && ['viva', 'en_camino'].includes(c.estado) && /^\W*(ok(ey)?[, ]*|va[, ]*|sale[, ]*|perfecto[, ]*|excelente[, ]*)?(muchas |mil )?gracias[\w ,.!]{0,25}$/i.test(String(nuevo).trim()) && !RE_TIEMPO.test(nuevo)) return { evento: 'cortesia', confianza: 'alta', razon: 'compuerta: solo dio las gracias (la visita no cambia)', pregunta_comercial: '' };
    const candidatoFisico = RE_LLEGUE.test(nuevo) || RE_YAVOY.test(nuevo);
    if ((!c || c.estado === 'pospuesta') && !candidatoFisico && !RE_TIEMPO.test(nuevo) && !/\b(ya no|cancel|compr[eé])\b/i.test(nuevo)) return { evento: 'no_es_de_cita', confianza: 'alta', razon: 'compuerta: sin visita con cuándo y sin palabra de tiempo/visita', pregunta_comercial: '' };   // SIN CUÁNDO = fuera del subsistema: se platica normal (precio, crédito…)
    const hoy = ymd(now);
    const cal = []; for (let i = 0; i < 16; i++) { const d = masDias(hoy, i); cal.push(DIAS[dow(at(d, 12, 0))] + ' ' + d + ' (' + horarioTexto(t, d) + ')'); }
    const system =
        'Lees el mensaje NUEVO de un comprador de autos usados (WhatsApp, Monterrey) y decides QUÉ CAMBIÓ OBJETIVAMENTE en la realidad de su VISITA al lote para ver el auto. ' +
        'No redactas respuestas ni inventas estados: eliges UN evento de la lista cerrada (como picarle al botón correcto). Primero escribe la razón (qué quiso decir de verdad), luego el evento.\n' +
        'EVENTOS:\n' +
        '· agenda_o_cambio = da o cambia CUÁNDO viene: un día, una hora, un rango de horas o de días, o pregunta si puede ir en cierto momento ("cómo andas hoy a las 5", "paso el viernes", "entre viernes y sábado", "voy el fin de semana", "mañana en la tarde", "mejor mañana a las 11", "sí, como a las 6", "la próxima semana entre viernes y sábado"). Llena dia_ini (YYYY-MM-DD del calendario). dia_fin solo si dio un rango de días ("fin de semana" = de VIERNES a DOMINGO: dia_ini = viernes, dia_fin = domingo; si hoy ya es viernes, sábado o domingo de ese fin de semana, dia_ini = hoy). hora_ini HH:MM 24 h solo si dio hora ("a las 5" viendo autos = 17:00; "a las 10" = 10:00; "como a las 4" = 16:00). hora_fin solo si dio rango de horas. franja si dijo mañana/mediodía/tarde/noche/tarde-noche sin hora. "al rato / más tarde" sin hora = hoy sin hora. "la próxima semana" = la semana que empieza el lunes siguiente.\n' +
        '· confirma = (también: un "sí / sí por favor / va" contestando a "¿gustas que te reagendemos?" — quiere reagendar y todavía no da fecha) dice que sí viene / sigue en pie ("sí", "ahí estaré", "claro", 👍) contestando a nuestro recordatorio, acuse o pregunta. Si además da una hora o día nuevo → agenda_o_cambio.\n' +
        '· ya_voy = el comprador YA VA EN CAMINO AL LOTE en este momento para su visita (movimiento físico real: "ya voy para allá", "voy saliendo", "ya salí", "estoy a 10 min"). ENTIÉNDELO CON EL CONTEXTO: mira qué fue lo último que le dijo el Lote y de qué venían hablando. NO es ya_voy: "voy a mandarte los papeles", "ya voy a checar / a ver / a preguntar", "voy solo" o "voy con mi esposa" (eso es el dato asiste), "voy a ir el sábado" (eso es agenda_o_cambio), "ya voy" contestando a algo que le pedimos (documentos, un dato, una foto) o un "voy" de plática. Si hay visita para hoy o acaba de decir que él avisaba cuando saliera, un "ya voy" a secas SÍ es ya_voy. Si su visita es OTRO día y lo último del Lote fue pedirle algo (papeles, INE, un dato), un "ya voy" a secas NO es ya_voy. Si no se puede saber a dónde va → incierto (con visita viva) o no_es_de_cita. confianza alta SOLO si un humano leyendo la conversación no dudaría que viene en camino al lote.\n' +
        '· ya_llegue = ya está EN EL LOTE ahora (hecho físico: "ya llegué", "estoy afuera"). Mismo cuidado de contexto: "ya llegué a mi casa / a la oficina y te mando los papeles" NO es ya_llegue. · ya_fue = dice que YA FUE / ya pasó a verlo antes ("sí fui", "ayer pasé", "ya lo vi").\n' +
        '· se_retrasa = SIGUE viniendo HOY pero va tarde / se le hizo tarde / hay tráfico, SIN dar una nueva hora concreta (minutos_tarde solo si dice cuánto: "media hora" = 30). NO es cancelar ni cambiar de día. Si menciona una HORA DE RELOJ ("como a las 6", "llego a las 5:30") NUNCA es se_retrasa: es agenda_o_cambio con hora_ini, aunque venga de un retraso.\n' +
        '· promete_avisar = "yo te aviso / luego te digo / te confirmo": deja ALGO del cuándo pendiente de que él avise. QUÉ deja pendiente va en alcance: "hoy sí voy, yo te aviso cuando vaya", "el sábado sí, te aviso la hora", "te marco cuando salga" → alcance = hora (el día sigue firme; si nombra el día que queda, ponlo en dia_ini). "no sé qué día pueda, yo te aviso", "déjame ver y te digo" → alcance = todo. Un "yo te aviso" a secas: mira el contexto — si venía confirmando que sí viene ese día o le acabamos de preguntar la HORA, alcance = hora; si no se sabe, alcance = todo.\n' +
        '· se_complico = NO puede venir / no alcanza a llegar / se le complicó / NO PUDO ir (contestando si fue), SIN dar fecha nueva y sin decir que ya no le interesa. "No pude, pero sí me interesa" es se_complico (con sigue_interesado), NO promete_avisar. avisara = true si además dice que él avisa cuándo pueda ("yo te aviso cuándo").\n' +
        '· cancela = SOLO si ya no le interesa, ya compró otro, o cancela en definitiva. "No puedo mañana" NO es cancela.\n' +
        '· cambia_auto = quiere que la visita sea para OTRO auto y no toca el cuándo.\n' +
        '· incierto = habla de la visita pero NO permite saber si sigue viniendo ni cuándo ("a ver si puedo", "ando viendo", "quién sabe", "depende", "luego vemos"). Ante la duda entre eventos, incierto: jamás inventes una cancelación ni una reprogramación.\n' +
        '· no_es_de_cita = pregunta del auto, precio, fotos, ubicación, cotización, saludos, gracias. "Llego a mi oficina a las 3 y te mando papeles" NO es visita.\n' +
        '· otra_cosa = sí es sobre la visita pero no cabe arriba (llevar mecánico, quién me atiende, que le lleven el auto).\n' +
        'EL EVENTO DICE QUÉ PASÓ; dia_ini/hora_ini/alcance DICEN QUÉ PARTE DEL CUÁNDO TOCA. Valen para CUALQUIER evento, no solo agenda_o_cambio:\n' +
        '  – dia_ini/dia_fin/hora_ini/franja = el día u hora que el mensaje, leído con su contexto, deja FIRME o ELIGE. Ej.: visita "viernes o sábado", le preguntamos "¿vienes hoy o mañana?" y contesta "sí hoy" → confirma con dia_ini = hoy (eligió el día). "sí" a "¿sí alcanzas a venir hoy?" → confirma con dia_ini = hoy. Un "sí" que no deja claro cuál día → confirma con dia_ini vacío.\n' +
        '  – alcance = qué parte del cuándo ANTERIOR deja de valer: hora (la hora anterior ya no vale, el día sigue: "llego más tarde", "te aviso la hora"), dia (UN día ya no vale pero el resto de su ventana sí: pon SIEMPRE ESE día en dia_ini ("hoy" = la fecha de AHORA) — "hoy no puedo" con visita viernes-sábado → dia_ini = hoy, alcance = dia), todo (ya no queda ningún cuándo), vacío (no invalida nada: solo confirma o precisa). Si no se sabe qué parte cae ("se me atravesó un imprevisto") → alcance vacío: JAMÁS supongas que cayó todo.\n' +
        '  – sigue_interesado = true SOLO si dice con sus letras que el auto le sigue interesando / que sí quiere venir ("no pude pero sí me interesa").\n' +
        'tentativo = true cuando el cuándo nuevo lo presenta como POSIBILIDAD, no como elección: "si alcanzo voy el domingo", "chance voy antes", "a lo mejor puedo hoy", "chance hasta el martes", "y si mejor mañana?", "puede que llegue desde las 3". false cuando ELIGE: "mejor domingo", "voy a las 4", "cámbiala al martes". Una posibilidad NO reemplaza la cita vigente: el código la guarda aparte.\n' +
        'OJO con "si" sin acento: "oye si alcanzo a ir hoy", "si puedo mañana" = habla de ESE día → agenda_o_cambio con ese día y tentativo = true (no lo elige en firme), NO incierto. Solo es condicional cuando trae la condición completa ("si salgo temprano voy"). Un comentario al aire que NOMBRA otro momento ("y si mejor hoy?", "hoy como andas?") es una PROPUESTA de ese momento → agenda_o_cambio.\n' +
        'JERARQUÍA DE EVIDENCIA si el mensaje trae varias cosas o se contradice: manda lo MÁS FÍSICO y lo ÚLTIMO que dijo: ya llegué > ya voy > declaración explícita actual (hora/día/"ya no voy") > declaración aproximada > suposición. Ej.: "sí voy a las 5 / no mejor mañana" = agenda_o_cambio para mañana.\n' +
        'auto_texto = el auto que AHORA quiere ver con sus palabras ("la mazda", "el yaris 2022") SOLO si pide cambiar de auto; vacío si no. Si cambia auto Y da cuándo → agenda_o_cambio con auto_texto lleno.\n' +
        'IMPORTANTE: clasifica SOLO el mensaje NUEVO. La conversación anterior es contexto para entenderlo, no para sacar datos: los DATOS EXTRA y pregunta_comercial salen ÚNICAMENTE de lo que dice el mensaje NUEVO.\n' +
        'DATOS EXTRA (vacío si no aplica): restriccion ("solo fines de semana", "sale a las 6"), asiste (si va otra persona: quién), condicion (de qué depende: crédito, seguro, juntar enganche), a_cuenta (trae auto a cuenta), foraneo (viene de otra ciudad). ' +
        'UN MENSAJE PUEDE TRAER VARIAS COSAS: sepáralas. El evento y los datos describen SOLO lo que toca a la visita. pregunta_comercial = copia LITERAL de la parte del mensaje que pregunta algo que NO es de la visita (crédito, precio, fotos, ubicación, papeles…), vacío si no hay. Ej.: "No puedo mañana, mejor jueves a las 5. ¿Aceptan crédito?" → agenda_o_cambio jueves 17:00 + pregunta_comercial "¿Aceptan crédito?". La pregunta comercial JAMÁS cambia el evento de la visita. motivo = por qué cancela o se le complicó SOLO si lo dijo con sus letras (si no lo dijo, vacío).\n' +
        'confianza alta solo si un humano lo entendería sin dudar. Si abajo dice VISITA VIVA: ninguna, NO hay nada que confirmar ni posponer aunque el historial muestre una cita vieja: solo existen agenda_o_cambio, ya_voy, ya_llegue y no_es_de_cita, y SIEMPRE llenas dia_ini si menciona cuándo viene.\n' +
        'AHORA: ' + DIAS[dow(now)] + ' ' + hoy + ' ' + L(now).toISOString().slice(11, 16) + ' (Monterrey).\nCALENDARIO:\n' + cal.join('\n');
    const content = 'AUTO EN FOCO: ' + (auto && auto.nombre ? auto.nombre : 'ninguno') + '\n' +
        'VISITA VIVA: ' + (c ? (situacionDe(t, c, now) + ' · ventana original ' + fechaCorta(c.ini0_ts) + ' → ' + fechaCorta(c.fin0_ts)) : 'ninguna') + '\n' +
        'CONVERSACIÓN (lo último):\n' + historial.map(m => (m.quien === 'comprador' ? 'Comprador' : 'Lote') + ': ' + String(m.texto || '').slice(0, 260).replace(/\n+/g, ' / ')).join('\n') +
        '\nNUEVO del comprador: ' + String(nuevo || '').slice(0, 500);
    const r = await haiku(system, content);
    if (!r || !EVENTOS.includes(r.evento)) return { evento: (c && c.estado !== 'pospuesta') ? 'incierto' : 'no_es_de_cita', confianza: 'baja', razon: r ? 'salida inválida' : 'sin IA disponible', pregunta_comercial: '' };
    return r;
}

// SITUACIÓN ACTUAL INTERPRETABLE (una frase): qué es verdad AHORA de esta visita
function situacionDe(t, c, now) {
    const e = c.estado, up = String(c.ultima_palabra || '');
    if (e === 'realizada') return 'ASISTIÓ' + (c.resultado ? ' · ' + c.resultado : ' · falta el resultado');
    if (e === 'cancelada') return 'NO ASISTIÓ · canceló' + (c.razon ? ': ' + c.razon : '');
    if (e === 'no_llego') return 'NO ASISTIÓ (lo marcó el vendedor)' + (c.razon ? ' · ' + c.razon : '');
    if (e === 'sin_cierre') return 'Sin cierre: nadie dijo si llegó';
    if (e === 'reemplazada') return 'Reemplazada';
    if (e === 'pospuesta') return 'SIN FECHA: pendiente de que vuelva a indicar cuándo' + (c.razon ? ' · ' + c.razon : '');
    if (e === 'en_camino') return 'EN CAMINO' + (up === 'se_retrasa' ? ' · avisó retraso' : '');
    if (up === 'ventana_vencida') return 'VENTANA VENCIDA sin llegada acreditada (' + fechaCorta(c.fin_ts) + '). Sin respuesta NO se concluye nada: no se sabe si fue, si viene o si ya no';
    let s = 'Viene ' + cuandoCorto(c, now);
    if (up === 'promete_avisar') s = 'VIENE ' + cuandoCorto(c, now).toUpperCase() + ' · hora abierta: él avisa cuando salga';
    else if (up === 'se_retrasa') s = 'SE RETRASA: la hora anterior ya no es confiable; se le preguntó a qué hora calcula (' + cuandoCorto(c, now) + ')';
    else if (up === 'incierto') s += ' · INCIERTO: no quedó claro si sigue viniendo; se le preguntó';
    else if (Number(c.en_duda)) s = 'La fecha anterior ya no aplica (' + cuandoCorto(c, now) + '): dijo que no alcanza; se le ofreció reagendar ("¿gustas que te reagendemos?")';
    else if (Number(c.suave)) s += ' · no llegó en la hora que precisó; su ventana original sigue abierta';
    else if (Number(c.confirmada_dia)) s += ' · día confirmado';
    else s += ' · sin confirmar';
    if (altTxt(c)) s += ' · chance ' + altTxt(c).replace(/ \(.*\)$/, '') + ' (posibilidad sin confirmar; la cita sigue igual)';
    return s;
}
const CONCRECION = { hora: 'hora exacta', franja: 'rango de horas', dia: 'solo el día', dias: 'rango de días' };

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
async function aplicarAgenda({ t, chat, auto, io, now, v, fuente, extras, nuevo, modo }) {
    const tId = Number(t.id), chatId = Number(chat.id); const nombreV = nombreVis(chat); const hoyMismo = ymd(v.ini) === ymd(now); const delComprador = fuente !== 'vendedor';
    let c = await citaViva(tId, chatId);
    if (!c) {   // NACE (o REVIVE ligada a la anterior)
        const prev = await ultimaCita(tId, chatId);
        const ins = await run(`INSERT INTO citaf (tenant_id, chat_id, tel, nombre, auto_id, auto_nombre, ini_ts, fin_ts, ini0_ts, fin0_ts, precision, estado, confirmada_dia, ultimo_in_ts, ultima_palabra, version, version_ts, datos_json, previa_id, created, updated)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [tId, chatId, String(chat.telefono || ''), chat.nombre || '', auto && auto.id ? Number(auto.id) : null, auto && auto.nombre ? auto.nombre : null, v.ini, v.fin, v.ini, v.fin, v.precision, 'viva', (hoyMismo && delComprador) ? 1 : 0, delComprador ? now : null, 'agenda', 1, now, JSON.stringify(extras || {}), prev ? Number(prev.id) : null, now, now]);   // si otro proceso la nació a la vez → UNIQUE → conReintento la vuelve CAMBIO
        c = await citaPorId(Number(ins.lastInsertRowid)); await reconciliar(t, c.id, now);   // nace YA con su próxima acción (antes de mandar nada)
        await bitacora(c, now, fuente, prev ? 'revive' : 'nace', { ventana: [v.ini, v.fin], precision: v.precision, fuera_horario: !!v.fuera_horario, nuevo });
        const x = slots(t, c, now); const formal = v.precision === 'hora' || v.precision === 'franja' || !delComprador;
        x.pin = !!(c.auto_id) && formal; if (formal && c.auto_id) x.lugar = ((await query('SELECT name FROM punto_envio WHERE auto_id = ?', [Number(c.auto_id)]).catch(() => []))[0] || {}).name || '';
        if (v.fuera_horario) { await io.mandar(texto(t, 'fuera_horario', Object.assign(x, { horario: horarioTexto(t, ymd(v.ini)) }))); await io.vendedor('⚠️ ' + nombreV + ' pidió venir fuera de horario: "' + String(nuevo || '').slice(0, 120) + '". Le dije el horario; si lo esperas, escríbele tú la hora.'); }
        if (modo === 'ahorita') { await io.mandar(texto(t, 'pasa_ahorita', x)); if (c.auto_id) { await io.pin(Number(c.auto_id)); await bitacora(c, now, 'sistema', 'pin_enviado', null); } }
        else if (formal) { await io.mandar(texto(t, 'nace', x)); if (x.pin) { await io.pin(Number(c.auto_id)); await bitacora(c, now, 'sistema', 'pin_enviado', null); } await io.mandar(texto(t, 'nace_cierre', x)); }
        else { if (x.pin) { await io.pin(Number(c.auto_id)); await bitacora(c, now, 'sistema', 'pin_enviado', null); } if (!v.fuera_horario) await io.mandar(texto(t, v.precision === 'dias' ? 'nace_suave_dias' : 'nace_suave', x)); }   // mano izquierda: sin bloque de 'cita confirmada'; solo se busca la hora
        await io.vendedor('Nueva visita — ' + nombreV + ' / ' + (c.auto_nombre || 'sin auto') + ' / ' + cuandoAviso(c, now) + (prev ? ' (regresa: ya había agendado antes)' : '') + notaDatos(extras || {}));
        return { cita: Number(c.id), tipo: prev ? 'revive' : 'nace' };
    }
    // ya hay visita viva (incluye PENDIENTE DE REAGENDAR y ESPERANDO CIERRE): REPROGRAMAR conserva la intención y MUEVE la visita; no la mata
    const dentro = ['viva', 'en_camino'].includes(c.estado) && v.ini >= Number(c.ini0_ts) - 5 * MIN && v.fin <= Number(c.fin0_ts) + 5 * MIN;
    if (extras && extras.alt) delete extras.alt;   // el plan principal cambió de verdad: la posibilidad ya no aplica
    const antes = cuandoAviso(c, now), estadoAntes = (Number(c.en_duda) || String(c.ultima_palabra) === 'ventana_vencida') ? 'pospuesta' : c.estado, diaAntes = ymd(Number(c.ini_ts));
    const campos = { ini_ts: v.ini, fin_ts: v.fin, precision: v.precision, version: (Number(c.version) || 1) + 1, version_ts: now, en_duda: 0, suave: 0, avisa_ts: null, callar_hasta_ts: null, confirmada_dia: (hoyMismo && delComprador && modo !== 'quita_dia') ? 1 : 0, estado: c.estado === 'en_camino' && hoyMismo ? 'en_camino' : 'viva', ultima_palabra: modo === 'confirma_dia' ? 'confirma' : (modo === 'abre_hora' ? 'promete_avisar' : (dentro ? 'da_hora' : 'cambia')), razon: null, datos_json: JSON.stringify(extras || datosDe(c)) };
    if (delComprador) campos.ultimo_in_ts = now;
    // VENTANA ORIGINAL: si la evidencia redujo los DÍAS (eligió uno, o uno se cayó), los días descartados dejan de existir también ahí; si solo precisó la HORA dentro de su día, el resto de ese día sigue siendo suyo
    const mismosDias = ymd(v.ini) === ymd(Number(c.ini0_ts)) && ymd(v.fin) === ymd(Number(c.fin0_ts));
    if (!dentro || modo === 'abre_hora') { campos.ini0_ts = v.ini; campos.fin0_ts = v.fin; }
    else if (!mismosDias) { const a0 = abreCierra(t, ymd(v.ini)), z0 = abreCierra(t, ymd(v.fin)); campos.ini0_ts = Math.min(v.ini, Math.max(a0 ? a0.abre : v.ini, hoyMismo ? now : 0)); campos.fin0_ts = Math.max(v.fin, z0 ? z0.cierra : v.fin); }
    await guardar(c, campos, now); await reconciliar(t, c.id, now, modo === 'confirma_dia' ? 'eligió el día: los otros días de su ventana ya no valen' : (modo === 'abre_hora' ? 'la hora anterior ya no vale; el día sigue' : (modo === 'quita_dia' ? 'ese día se cayó; el resto de su ventana sigue' : (dentro ? 'precisó el cuándo' : 'reprogramó: la realidad anterior ya no vale'))));
    await bitacora(c, now, fuente, modo || (dentro ? 'angosta' : (estadoAntes === 'pospuesta' ? 'reagenda' : 'reprograma')), { antes, ventana: [v.ini, v.fin], precision: v.precision, nuevo });
    const x = slots(t, c, now); const pinPrevio = !!(await query("SELECT 1 x FROM citaf_eventos WHERE cita_id = ? AND evento = 'pin_enviado' LIMIT 1", [Number(c.id)]).catch(() => []))[0] || !!(await query("SELECT 1 x FROM mensajes WHERE conversacion_id = ? AND direccion = 'out' AND tipo = 'location' LIMIT 1", [chatId]).catch(() => []))[0];
    x.pin = !!c.auto_id && !modo && ((hoyMismo && dentro === false) || !pinPrevio);
    if (v.fuera_horario) { await io.mandar(texto(t, 'fuera_horario', Object.assign(x, { horario: horarioTexto(t, ymd(v.ini)) }))); await io.vendedor('⚠️ ' + nombreV + ' pidió venir fuera de horario: "' + String(nuevo || '').slice(0, 120) + '"'); }
    else if (modo === 'ahorita') await io.mandar(texto(t, 'pasa_ahorita', x));
    else if (modo === 'confirma_dia') await io.mandar(texto(t, hoyMismo ? 'confirma_hoy' : 'precisa', x));
    else if (modo === 'abre_hora') await io.mandar(texto(t, hoyMismo ? 'avisa_al_salir_hoy' : 'avisa_al_salir', x));
    else if (modo === 'quita_dia') await io.mandar(texto(t, 'quita_dia', x));
    else if (!dentro && v.precision === 'dia' && delComprador && diaAntes !== ymd(v.ini)) await io.mandar(texto(t, 'cambio_sin_hora', x));   // cambió de día sin dar hora: se le pregunta la hora en el mismo acuse
    else if (hoyMismo) { await io.mandar(texto(t, 'angosta_hoy', x)); if (x.pin) await io.pin(Number(c.auto_id)); }
    else { await io.mandar(texto(t, dentro ? 'precisa' : (estadoAntes === 'pospuesta' ? 'reagenda' : (diaAntes === ymd(v.ini) ? 'ajuste' : 'cambio')), x)); if (x.pin && dentro) { await io.pin(Number(c.auto_id)); await bitacora(c, now, 'sistema', 'pin_enviado', null); } }   // la redacción dice lo que de verdad pasó: afinar ≠ ajustar la hora ≠ mover de día
    const mismoDia = diaAntes === ymd(v.ini) && estadoAntes !== 'pospuesta'; const base = nombreV + ' / ' + (c.auto_nombre || 'sin auto') + ' / ';
    if (modo === 'ahorita') { await io.vendedor('🚗 ' + base + 'dice que puede pasar AHORITA (antes: ' + antes + '). Le dije que sí y que avise cuando venga en camino.'); return { cita: Number(c.id), tipo: 'ahorita' }; }
    if (modo === 'confirma_dia') { await io.vendedor('✅ ' + base + 'confirmó que viene ' + (hoyMismo ? 'HOY' : cuandoAviso(c, now)) + '. Hora aún abierta. (antes: ' + antes + ')' + notaDatos(extras || {})); return { cita: Number(c.id), tipo: modo }; }
    if (modo === 'abre_hora') { await io.vendedor('Cita actualizada — ' + base + 'sigue viniendo ' + (hoyMismo ? 'HOY' : cuandoAviso(c, now)) + ', pero ya no tiene hora definida: él avisa cuando salga. (antes: ' + antes + ')'); return { cita: Number(c.id), tipo: modo }; }
    if (modo === 'quita_dia') { await io.vendedor('Cita actualizada — ' + base + antes + ' → ' + cuandoAviso(c, now) + ' (dijo que ese día no puede; el resto de su ventana sigue)'); return { cita: Number(c.id), tipo: modo }; }
    await io.vendedor((estadoAntes === 'pospuesta' ? 'Nueva fecha — ' : ((mismoDia || dentro) ? 'Cita actualizada — ' : 'Cita movida — ')) + nombreV + ' / ' + (c.auto_nombre || 'sin auto') + ' / ' + (estadoAntes === 'pospuesta' ? '' : antes + ' → ') + cuandoAviso(c, now) + notaDatos(extras || {}));
    return { cita: Number(c.id), tipo: dentro ? 'precisa' : (estadoAntes === 'pospuesta' ? 'reagenda' : (diaAntes === ymd(v.ini) ? 'ajusta_hora' : 'cambia_dia')) };
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
// las DIMENSIONES de la realidad, por separado (para poder decir "qué dato exacto cambió")
const diaTxt = c => c.estado === 'pospuesta' ? 'sin fecha' : (ymd(Number(c.ini_ts)) === ymd(Number(c.fin_ts)) ? fechaCorta(c.ini_ts).split(' · ')[0] : fechaCorta(c.ini_ts).split(' · ')[0] + ' → ' + fechaCorta(c.fin_ts).split(' · ')[0]);
const horaTxt = c => c.estado === 'pospuesta' ? '—' : (c.precision === 'hora' ? hm(c.ini_ts) : (c.precision === 'franja' ? 'de ' + hm(c.ini_ts) + ' a ' + hm(c.fin_ts) : ('abierta' + (aproxTxt(c) ? ' (' + aproxTxt(c).replace(/^, /, '') + ')' : ''))));
function cambioDe(a, b) {   // comparación PURA de dos fotos → lista de lo que cambió (y nada más)
    if (!b) return []; if (!a) return ['Nace la visita: ' + b.dia + ' · hora ' + b.hora];
    const out = []; const E = { viva: 'viva', en_camino: 'en camino', pospuesta: 'sin fecha', realizada: 'realizada', cancelada: 'cancelada', no_llego: 'no llegó' };
    if (a.cita_id !== b.cita_id) out.push('Visita nueva (la anterior ya estaba cerrada)');
    if (a.estado !== b.estado) out.push('Estado: ' + (E[a.estado] || a.estado) + ' → ' + (E[b.estado] || b.estado));
    if (a.dia !== b.dia) out.push('Día: ' + a.dia + ' → ' + b.dia); else if (b.estado !== 'pospuesta') out.push('Día: ' + b.dia + ' (igual)');
    if (a.hora !== b.hora) out.push('Hora: ' + a.hora + ' → ' + b.hora); else if (b.estado !== 'pospuesta') out.push('Hora: ' + b.hora + ' (igual)');
    const bd = (x, k) => !!(x.banderas && x.banderas[k]);
    if (bd(a, 'dia_confirmado') !== bd(b, 'dia_confirmado')) out.push('Día confirmado: ' + (bd(a, 'dia_confirmado') ? 'sí' : 'no') + ' → ' + (bd(b, 'dia_confirmado') ? 'sí' : 'no'));
    if (bd(a, 'en_duda') !== bd(b, 'en_duda')) out.push(bd(b, 'en_duda') ? 'La fecha anterior dejó de aplicar (se le pidió nuevo día)' : 'Ya no está en duda');
    if ((a.posibilidad || '') !== (b.posibilidad || '')) out.push(b.posibilidad ? 'Posibilidad alterna: ' + b.posibilidad + ' — la cita vigente sigue igual' : 'La posibilidad alterna ' + (b.version !== a.version ? 'se resolvió' : 'venció') + '; queda solo el plan principal');
    if ((a.auto || '') !== (b.auto || '')) out.push('Auto: ' + (a.auto || '—') + ' → ' + (b.auto || '—'));
    if (a.version !== b.version) out.push('Versión ' + a.version + ' → ' + b.version + ': el plan se recalculó completo desde la nueva foto'); else out.push('Misma versión: el plan no cambió');
    return out;
}
const altTxt = c => { const a = datosDe(c).alt; return a ? cuandoCorto({ ini_ts: a.ini_ts, fin_ts: a.fin_ts, precision: a.precision, estado: 'viva', datos_json: '{}' }, Number(a.ts) || Number(c.ini_ts)) + ' (' + String(a.relacion || '').replace(/_/g, ' ') + ', tentativa)' : null; };
const foto = (t, c, now) => c ? { cita_id: Number(c.id), dia: diaTxt(c), hora: horaTxt(c), posibilidad: altTxt(c), estado: c.estado, cuando: c.estado === 'pospuesta' ? 'sin fecha' : cuandoCorto(c, now), ventana: fechaCorta(c.ini_ts) + (Number(c.fin_ts) !== Number(c.ini_ts) ? ' → ' + fechaCorta(c.fin_ts) : ''), concrecion: CONCRECION[c.precision] || c.precision, auto: c.auto_nombre || null, situacion: situacionDe(t, c, now), version: Number(c.version), banderas: { dia_confirmado: !!Number(c.confirmada_dia), en_duda: !!Number(c.en_duda), modo_suave: !!Number(c.suave), ultima_palabra: c.ultima_palabra || null }, datos: datosDe(c) } : null;
const pendientesDe = async (id) => id ? (await query("SELECT id, tipo, para, due_ts FROM citaf_casillas WHERE cita_id = ? AND estado = 'pendiente' ORDER BY due_ts", [Number(id)])).map(k => ({ id: Number(k.id), tipo: k.tipo, para: k.para, due_ts: Number(k.due_ts), cuando: fechaCorta(k.due_ts), texto_tipo: ACCION_TXT[k.tipo] || k.tipo })) : [];
function grabadora(io, T) {   // misma tubería, pero anotando lo que sale para la traza
    return Object.assign({}, io, { mandar: async (tx, ts) => { const r = await io.mandar(tx, ts); T.acciones.mensajes.push(typeof r === 'string' && r ? r : String(tx).split('||').join('\n')); return r; }, pin: async (a) => { T.acciones.mensajes.push('📍 [ubicación: captura + pin]'); return io.pin(a); }, vendedor: async (tx) => { T.acciones.avisos_vendedor.push(String(tx)); return io.vendedor(tx); } });
}
async function entrante(args) {
    const T = { entro: null, ahora: null, lectura: null, sin_ia: false, ajustes: [], antes: null, despues: null, acciones: { mensajes: [], avisos_vendedor: [], recordatorios_cancelados: [], recordatorios_creados: [] }, comercial: null };
    const tId = Number(args.tenant.id), chatId = Number(args.chat.id); await asegurar();
    const c0 = await citaViva(tId, chatId); const antesP = await pendientesDe(c0 && c0.id); const now0 = args.ahoraFijo || await ahora(tId, chatId); T.ahora = fechaCorta(now0); T.antes = foto(args.tenant, c0, now0);
    const r = await entrante0(Object.assign({}, args, { io: grabadora(args.io, T), _T: T }));
    try {
        const c1 = (await citaViva(tId, chatId)) || (r && r.cita ? await citaPorId(r.cita) : null) || (c0 ? await citaPorId(c0.id) : null); T.despues = foto(args.tenant, c1, now0); T.cambio = cambioDe(T.antes, T.despues);
        const ids = [...new Set([c0 && c0.id, c1 && c1.id].filter(Boolean).map(Number))]; const ahoraP = []; for (const id of ids) ahoraP.push(...await pendientesDe(id));
        const idsAntes = new Set(antesP.map(k => k.id)), idsAhora = new Set(ahoraP.map(k => k.id));
        const muertas = antesP.filter(k => !idsAhora.has(k.id)); if (muertas.length) { const m = await query('SELECT id, estado, motivo FROM citaf_casillas WHERE id IN (' + muertas.map(() => '?').join(',') + ')', muertas.map(k => k.id)); const pm = {}; m.forEach(x => pm[Number(x.id)] = x); T.acciones.recordatorios_cancelados = muertas.map(k => Object.assign({}, k, { motivo: (pm[k.id] || {}).motivo || null })); }
        T.acciones.recordatorios_creados = ahoraP.filter(k => !idsAntes.has(k.id));
    } catch (e) { }
    await tomarFoto(args.tenant, chatId, args.ahoraFijo ? now0 + 1000 : await ahora(tId, chatId));
    return Object.assign(r || {}, { traza: T });
}
async function entrante0({ tenant, chat, auto, io, textoNuevo, ahoraFijo, comercial, _T }) {
    await asegurar(); const TZ_ = _T || { ajustes: [] };
    const t = tenant, tId = Number(t.id), chatId = Number(chat.id); const now = ahoraFijo || await ahora(tId, chatId);
    const ms = (await query('SELECT direccion d, emisor, texto, ts FROM mensajes WHERE conversacion_id = ? ORDER BY ts DESC, id DESC LIMIT 16', [chatId])).reverse().filter(m => m.emisor !== 'sistema');
    let nuevo = String(textoNuevo || '').trim(); let nIn = 1;
    if (!nuevo) { let i = ms.length - 1; const r = []; while (i >= 0 && ms[i].d === 'in') { r.unshift(ms[i].texto); i--; } nuevo = r.join(' / '); nIn = r.length || 1; }
    if (!nuevo) return { manejado: false };
    TZ_.entro = nuevo;
    const historial = ms.slice(0, ms.length - nIn).slice(-9).map(m => ({ quien: m.d === 'in' ? 'comprador' : 'lote', texto: m.texto }));
    let c0 = await citaViva(tId, chatId); if (c0 && await podarAlt(t, c0, now)) c0 = await citaViva(tId, chatId);
    const ev = await leer({ t, c: c0, now, historial, nuevo, auto });   // la IA lee UNA vez; lo que sigue es código y se puede reintentar sin volver a leer
    Object.defineProperty(ev, '_aj', { value: TZ_.ajustes, enumerable: false }); TZ_.sin_ia = /^compuerta:/.test(String(ev.razon || '')); TZ_.lectura = JSON.parse(JSON.stringify(ev)); const evLeido = ev.evento;
    // sin visita viva NO existe "confirma / se complicó / te aviso": si trae un día, es una agenda (el historial viejo confunde a la IA); si no, no es de cita
    if (!c0 && !['agenda_o_cambio', 'ya_voy', 'ya_llegue', 'ya_fue', 'no_es_de_cita'].includes(ev.evento)) { if (/^\d{4}-\d{2}-\d{2}$/.test(String(ev.dia_ini || ''))) { ev.evento = 'agenda_o_cambio'; if (ev.confianza === 'baja') ev.confianza = 'media'; } else ev.evento = 'no_es_de_cita'; }
    // respondió a "¿como a qué hora calculas?" con una FRANJA ("en la tarde") → es su nueva hora aproximada de HOY, no otro retraso
    if (c0 && String(c0.ultima_palabra) === 'se_retrasa' && ['se_retrasa', 'incierto', 'promete_avisar', 'confirma', 'otra_cosa'].includes(ev.evento) && !ev.hora_ini && ymd(now) >= ymd(Number(c0.ini_ts))) { const mF = nuevo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/\b(en la manana|al mediodia|a mediodia|en la tarde|por la tarde|tarde noche|en la noche|por la noche)\b/); if (mF) { const f = /manana/.test(mF[1]) ? 'manana' : (/mediodia/.test(mF[1]) ? 'mediodia' : (/tarde noche/.test(mF[1]) ? 'tarde_noche' : (/noche/.test(mF[1]) ? 'noche' : 'tarde'))); { ev.evento = 'agenda_o_cambio'; ev.dia_ini = ymd(now); ev.dia_fin = ''; ev.franja = f; ev.hora_ini = ''; ev.hora_fin = ''; ev.tentativo = false; if (ev.confianza === 'baja') ev.confianza = 'media'; ev.razon = '(dio una franja de hoy → nueva hora aproximada) ' + (ev.razon || ''); } } }
    if (c0 && (['incierto', 'otra_cosa', 'confirma', 'no_es_de_cita'].includes(ev.evento) || (ev.evento === 'ya_voy' && /\?|\b(puedo|se puede|podr[ií]a)\b/i.test(nuevo))) && /\b(ahorita|ahora|en un rat(o|ito)|ya mismo)\b/i.test(nuevo) && /\b(pas(o|ar|arme)|ir|voy|vaya|llego|llegar|caigo|caer)\b/i.test(nuevo) && !/\b(no puedo|no alcanzo|no voy)\b/i.test(nuevo)) { ev.evento = 'agenda_o_cambio'; ev.dia_ini = ymd(now); ev.dia_fin = ''; ev.hora_ini = ''; ev.franja = ''; ev.tentativo = false; if (ev.confianza === 'baja') ev.confianza = 'media'; ev.razon = '(pregunta si puede pasar AHORITA → hoy desde ahora) ' + (ev.razon || ''); }
    // LA MISMA PREGUNTA NO SE REPITE: si ya le preguntamos a qué hora (se_retrasa) y vuelve sin hora, se acepta y se le pide que avise cuando venga
    if (c0 && ev.evento === 'se_retrasa' && String(c0.ultima_palabra) === 'se_retrasa' && !horaDeReloj(nuevo, now) && !(Number(ev.minutos_tarde) > 0)) { ev.evento = 'promete_avisar'; ev.alcance = 'hora'; ev.razon = '(ya se le preguntó la hora una vez: no se repite; queda hora abierta y que avise) ' + (ev.razon || ''); }
    if (c0 && ev.evento === 'se_retrasa') { const hr = horaDeReloj(nuevo, now); if (hr) { ev.evento = 'agenda_o_cambio'; ev.dia_ini = ymd(now); ev.dia_fin = ''; ev.hora_ini = hr; ev.hora_fin = ''; ev.franja = ''; if (ev.confianza === 'baja') ev.confianza = 'media'; ev.razon = '(dio hora de reloj → nueva hora, no "retraso") ' + (ev.razon || ''); } }
    // "YA VOY" / "YA LLEGUÉ" solo se ejecutan con certeza ALTA (activan avisos al vendedor y cierran la visita): sin certeza NO se activa nada
    if (['ya_voy', 'ya_llegue'].includes(ev.evento) && ev.confianza !== 'alta') { ev.razon = '(' + ev.evento + ' sin certeza: no se activa) ' + (ev.razon || ''); ev.evento = (c0 && c0.estado !== 'pospuesta') ? 'incierto' : 'no_es_de_cita'; }
    // "ya voy" A SECAS (sin "para allá / saliendo / en camino / estoy a X min") con una visita que NO es hoy = no se sabe a dónde va (puede ser "ya voy a mandarte lo que pediste"): NO se activa; se le pregunta
    if (c0 && ev.evento === 'ya_voy' && c0.estado === 'viva' && ymd(now) < ymd(Number(c0.ini_ts)) && !/(para all[aá]|pa'? ?all[aá]|en camino|saliendo|ya sal[ií]|rumbo|llego en|estoy a \d|\d+ ?min|casi llego|al lote|a verlo|a verla|a ver el)/i.test(nuevo)) { ev.evento = 'incierto'; ev.razon = '("ya voy" a secas y su visita no es hoy: no se activa, se pregunta) ' + (ev.razon || ''); }
    // "YO TE AVISO" con el DÍA firme (la visita es hoy y hoy mismo dijo que sí viene) = solo se abre la hora; NO se queda sin fecha
    if (c0 && ev.evento === 'promete_avisar' && ev.alcance !== 'hora' && ['viva', 'en_camino'].includes(c0.estado) && String(c0.ultima_palabra) !== 'ventana_vencida' && ymd(now) >= ymd(Number(c0.ini_ts)) && ymd(now) <= ymd(Number(c0.fin_ts)) && (Number(c0.confirmada_dia) || ['confirma', 'se_retrasa'].includes(String(c0.ultima_palabra))) && !/\b(no s[eé]|a ver si|chance|quiz[aá]s?|tal vez|otro d[ií]a|qu[eé] d[ií]a|mejor|ma[ñn]ana|semana|si voy|si puedo)\b/i.test(nuevo)) { ev.alcance = 'hora'; TZ_.ajustes.push('Hoy ya había dicho que sí viene: su "yo te aviso" solo deja abierta la HORA; el día sigue'); }
    // PREGUNTA ABIERTA DE SÍ/NO ("¿gustas que te reagendemos?"): un sí corto es un SÍ a esa pregunta, no un "yo te aviso"
    if (c0 && Number(c0.en_duda) && ['promete_avisar', 'incierto', 'otra_cosa', 'no_es_de_cita'].includes(ev.evento) && /^\W*(s[ií]|claro|va|ok|okey|sale|dale|por ?fa(vor)?|me parece|est[aá] bien)\b/i.test(nuevo) && nuevo.length < 40) { ev.evento = 'confirma'; ev.razon = '(contestó que sí a "¿te reagendamos?") ' + (ev.razon || ''); }
    // "FIN DE SEMANA" = viernes, sábado o domingo (definición del owner): si la IA lo dejó en sábado-domingo, se abre desde el viernes
    if (ev.evento === 'agenda_o_cambio' && /\bfin(de)?\b|fin de semana/i.test(nuevo) && /^\d{4}-\d{2}-\d{2}$/.test(String(ev.dia_ini || '')) && dow(at(ev.dia_ini, 12, 0)) === 6 && ev.dia_fin && dow(at(ev.dia_fin, 12, 0)) === 0 && masDias(ev.dia_ini, -1) >= ymd(now) && !/s[aá]bado/i.test(nuevo)) ev.dia_ini = masDias(ev.dia_ini, -1);
    // la IA no inventa: cancelación o agenda SIN certeza = INCIERTO (se pregunta), jamás se ejecuta
    if (c0 && ((ev.evento === 'cancela' && ev.confianza !== 'alta') || (ev.evento === 'agenda_o_cambio' && ev.confianza === 'baja'))) { ev.razon = '(' + ev.evento + ' sin certeza → incierto) ' + (ev.razon || ''); ev.evento = 'incierto'; }
    if (c0 && ['incierto', 'confirma'].includes(ev.evento) && /^\d{4}-\d{2}-\d{2}$/.test(String(ev.dia_ini || '')) && ev.dia_ini !== ymd(Number(c0.ini_ts)) && /\b(hoy|ahorita|al rato|ma[ñn]ana|pasado|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i.test(nuevo) && !/\b(no (puedo|alcanzo|voy|creo)|ya no|imposible)\b/i.test(nuevo)) { ev.evento = 'agenda_o_cambio'; if (ev.confianza === 'baja') ev.confianza = 'media'; ev.razon = '(nombró OTRO momento → es una propuesta: se le mueve y se le pregunta lo que falta) ' + (ev.razon || ''); }
    if (c0 && !/^\d{4}-\d{2}-\d{2}$/.test(String(ev.dia_ini || '')) && /\b(no (puedo|alcanzo|voy|creo|podr[eé]|llego)|ya no|imposible)\b/i.test(nuevo)) { const m = nuevo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/\b(hoy|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/); if (m) { const DN = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']; let d = ymd(now); if (m[1] === 'manana') d = masDias(d, 1); else if (m[1] !== 'hoy') { for (let i = 0; i < 7; i++) { const dd = masDias(ymd(now), i); if (DN[dow(at(dd, 12, 0))] === m[1]) { d = dd; break; } } } ev.dia_ini = d; ev.dia_fin = ''; } }
    // "hoy no puedo" / "mañana no alcanzo": nombra UN día y lo niega → ese día se cae (se_complico con alcance = dia), lea lo que lea la IA
    if (c0 && ['incierto', 'promete_avisar', 'confirma', 'otra_cosa'].includes(ev.evento) && /^\d{4}-\d{2}-\d{2}$/.test(String(ev.dia_ini || '')) && /\b(no (puedo|alcanzo|voy|creo|podr[eé]|llego)|ya no|imposible)\b/i.test(nuevo) && /\b(hoy|ma[ñn]ana|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i.test(nuevo) && !RE_TENTATIVO.test(nuevo)) { ev.evento = 'se_complico'; ev.alcance = ev.alcance || 'dia'; ev.razon = '(nombró un día y lo negó → ese día se cae) ' + (ev.razon || ''); }
    if (ev.evento !== evLeido) TZ_.ajustes.push('El código corrigió a la IA: leyó "' + evLeido + '" y quedó "' + ev.evento + '" — ' + String(ev.razon || '').replace(/^\(([^)]*)\).*/, '$1'));
    const notaLector = '🗓 Lector de cita · ' + ev.evento + ' (' + (ev.confianza || '?') + ') · ' + String(ev.razon || '').slice(0, 160);
    if (ev.evento === 'cortesia') { await io.sistema(notaLector); await run('UPDATE citaf SET ultimo_in_ts = ? WHERE id = ?', [now, Number(c0.id)]).catch(() => { }); const xg = slots(t, c0, now); xg.viva = true; await io.mandar(texto(t, 'gracias', xg)); return { manejado: true, seguir_cerebro: false, evento: 'cortesia', cita: Number(c0.id) }; }
    if (ev.evento === 'no_es_de_cita') return { manejado: false, evento: ev.evento, nota: notaLector };   // la nota la escribe quien llama DESPUÉS del cerebro
    await io.sistema(notaLector);
    // SIN CUÁNDO (pospuesta): solo lo que trae una realidad nueva la saca del estacionamiento; lo demás es plática normal
    if (c0 && c0.estado === 'pospuesta' && !['agenda_o_cambio', 'ya_voy', 'ya_llegue', 'ya_fue', 'cancela', 'cambia_auto'].includes(ev.evento)) TZ_.ajustes.push('La visita está SIN FECHA: este mensaje no trae un nuevo cuándo, así que se trata como plática normal');
    if (c0 && c0.estado === 'pospuesta' && !['agenda_o_cambio', 'ya_voy', 'ya_llegue', 'ya_fue', 'cancela', 'cambia_auto'].includes(ev.evento)) return { manejado: false, evento: 'no_es_de_cita', nota: notaLector + ' → sin fecha: sigue estacionada, se platica normal' };
    if (/\b(con qui[eé]n (tengo el gusto|hablo|estoy hablando)|qui[eé]n eres|c[oó]mo te llamas|cu[aá]l es tu nombre)\b/i.test(nuevo) && c0) { await io.mandar(texto(t, 'quien_soy', slots(t, c0, now))); ev.pregunta_comercial = String(ev.pregunta_comercial || '').replace(/con qui[eé]n[^?]*\??/i, '').trim(); }
    const pc = String(ev.pregunta_comercial || '').trim();
    if (pc) TZ_.comercial = { texto: pc, respondida: false };
    if (pc) { let respondida = false; if (typeof comercial === 'function') { try { respondida = !!(await comercial(pc)); } catch (e) { respondida = false; } } if (TZ_.comercial) TZ_.comercial.respondida = respondida; if (!respondida) await io.vendedor('💬 En el mismo mensaje también preguntó: "' + pc.slice(0, 160) + '". Contéstale tú.'); }
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
        if (!cambioAuto.igual) { if (c.estado !== 'pospuesta') await io.mandar(texto(t, 'cambio_auto', slots(t, c, now))); if (c.auto_id) await io.pin(Number(c.auto_id)); await io.vendedor('Cita actualizada — ' + nombreV + ' / ' + (cambioAuto.antes || 'sin auto') + ' → ' + c.auto_nombre + ' / ' + (c.estado === 'pospuesta' ? 'sin fecha' : cuandoAviso(c))); }
        await reconciliar(t, c.id, now); return R();
    }

    // ── LA EVIDENCIA REESCRIBE SOLO SU PARTE: toda reescritura del cuándo pasa por la MISMA puerta (guardar → version++ → planner → aviso) ──
    const puerta = async (v, modo) => { const r = await aplicarAgenda({ t, chat, auto, io, now, v, fuente: 'comprador', extras, nuevo, modo }); return R({ cita: r.cita, tipo: r.tipo }); };
    if (E !== 'agenda_o_cambio' && ev.dia_ini && !/\b(hoy|ahorita|al rato|ma[ñn]ana|pasado|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|d[ií]a \d|\d{1,2} de [a-z])/i.test(nuevo)) { if (ev._aj) ev._aj.push('La IA puso un día (' + ev.dia_ini + ') que el mensaje no nombra: no se toma en cuenta'); ev.dia_ini = ''; ev.dia_fin = ''; }
    const rw = c ? reescribir(t, c, ev, now) : { op: 'nada' };
    if (E === 'confirma' && rw.op === 'estrecha') return puerta(rw.v, rw.modo);          // "sí hoy" con ventana viernes-sábado = eligió el día
    if (E === 'confirma' && rw.op === 'agenda') { E = 'agenda_o_cambio'; if (ev._aj) ev._aj.push('Confirmó un día que no era el de su visita → es un cuándo nuevo'); }

    // ── CUÁNDO: nace · angosta · reprograma · reagenda ──
    if (E === 'agenda_o_cambio') {
        // INVALIDA SOLO LO QUE INVALIDÓ: nombró el MISMO día sin hablar de la hora → la hora que ya tenía sigue valiendo (salvo que el mensaje la haya dejado abierta: alcance = hora)
        if (c && ['viva', 'en_camino'].includes(c.estado) && ['hora', 'franja'].includes(c.precision) && !ev.hora_ini && !ev.franja && ev.alcance !== 'hora' && ev.dia_ini === ymd(Number(c.ini_ts)) && !(ev.dia_fin && ev.dia_fin > ev.dia_ini) && String(c.ultima_palabra) !== 'ventana_vencida') { ev.hora_ini = L(Number(c.ini_ts)).toISOString().slice(11, 16); if (c.precision === 'franja') ev.hora_fin = L(Number(c.fin_ts)).toISOString().slice(11, 16); }
        // dio el DÍA sin hora, pero antes había dicho una hora aproximada para su ventana de varios días → esa hora aplica al día que eligió
        if (c && !ev.hora_ini && !ev.franja && /^\d{4}-\d{2}-\d{2}$/.test(String(ev.dia_ini || '')) && !(ev.dia_fin && ev.dia_fin > ev.dia_ini) && extras.hora_aprox) { if (/^\d{1,2}:\d{2}$/.test(extras.hora_aprox)) ev.hora_ini = extras.hora_aprox; else ev.franja = extras.hora_aprox; }
        let v = ventanaDe(t, ev, now); let ahorita = false;
        if (v.ok && ymd(v.ini) === ymd(now) && /\b(ahorita|ahora|en un rat(o|ito)|ya mismo|ya voy saliendo)\b/i.test(nuevo) && (v.precision !== 'hora' || Math.abs(v.ini - now) < 45 * MIN)) { const ac = abreCierra(t, ymd(now)); if (ac && ac.cierra - now > 20 * MIN) { v = { ok: true, ini: now, fin: ac.cierra, precision: 'dia' }; ahorita = true; } }
        if (v.ok && v.precision === 'dias') { const ap = /^\d{1,2}:\d{2}$/.test(String(ev.hora_ini || '')) ? ev.hora_ini : (FRANJA_TXT[ev.franja] ? ev.franja : null); if (ap) extras.hora_aprox = ap; } else if (v.ok) delete extras.hora_aprox;
        if (!v.ok) {
            if (!c && ['ventana_ancha', 'muy_lejos', 'sin_dia'].includes(v.motivo)) { await bitacora(null, now, 'comprador', 'intencion', { motivo: v.motivo, nuevo }); return { manejado: false, evento: 'intencion', nota: '🗓 INTENCIÓN sin ventana concreta (' + v.motivo + '): todavía no es visita; la atiende el flujo normal' }; }
            if (c) { E = 'incierto'; ev.razon = 'dio un cuándo que no se puede agendar (' + v.motivo + ')'; if (ev._aj) ev._aj.push('Dio un cuándo que no se puede agendar (' + v.motivo + ') → no se inventa fecha: se le pregunta'); }   // no se inventa fecha: se pregunta
            else { await io.vendedor('🔴 ' + nombreV + ' propuso un momento que no pude agendar (' + v.motivo + '): "' + nuevo.slice(0, 140) + '"'); return R({ escalado: true }); }
        } else {
            if (auto && auto.vendido) { await io.mandar(texto(t, 'auto_vendido', slots(t, { nombre: chat.nombre, auto_nombre: auto.nombre, ini_ts: v.ini, fin_ts: v.fin, precision: v.precision }, now))); await io.vendedor('🔴 ' + nombreV + ' quiso agendar un auto que ya no está activo: ' + auto.nombre); return R(); }
            const igual = c && c.estado === 'viva' && !Number(c.en_duda) && String(c.ultima_palabra) !== 'ventana_vencida' && c.precision === v.precision && Math.abs(Number(c.fin_ts) - v.fin) < 5 * MIN && (Math.abs(Number(c.ini_ts) - v.ini) < 5 * MIN || (v.precision !== 'hora' && ymd(v.ini) === ymd(Number(c.ini_ts))));
        // UNA POSIBILIDAD NO REEMPLAZA UNA CITA VIGENTE: "si alcanzo…", "chance…", "a lo mejor…" → se guarda APARTE; el plan principal, su versión y su planner siguen intactos
            // (una hora aproximada para el MISMO día que ya tenía sin hora — "probablemente en la mañana" — no es una posibilidad: es PRECISAR)
            const precisaHora = c && c.precision === 'dia' && ymd(v.ini) === ymd(Number(c.ini_ts)) && ymd(v.fin) === ymd(Number(c.ini_ts)) && v.precision !== 'dia';
            if (!igual && !precisaHora && c && c.estado === 'viva' && !Number(c.en_duda) && String(c.ultima_palabra) !== 'ventana_vencida' && (ev.tentativo === true || RE_TENTATIVO.test(nuevo) || (/\?\s*$/.test(nuevo) && ev.tentativo !== false))) {
                const mismoDia = ymd(v.ini) === ymd(Number(c.ini_ts));
                const dentroV = v.ini >= Number(c.ini_ts) - 5 * MIN && v.fin <= Number(c.fin_ts) + 5 * MIN && (c.precision === 'dias' || c.precision === 'dia');
                const relacion = dentroV ? 'dentro' : (mismoDia ? (v.ini < Number(c.ini_ts) ? 'mismo_dia_antes' : 'mismo_dia_despues') : (v.ini < Number(c.ini_ts) ? 'adelanto' : 'atraso'));
                extras.alt = { ini_ts: v.ini, fin_ts: v.fin, precision: v.precision, relacion, certeza: 'tentativa', ts: now, texto: String(nuevo || '').slice(0, 120) };
                await G({}, false); await bitacora(c, now, 'comprador', 'posibilidad', { relacion, ventana: [v.ini, v.fin], nuevo });   // sin version++, sin tocar el planner
                const x = slots(t, c, now); await io.mandar(texto(t, relacion === 'dentro' ? 'posibilidad_dentro' : ((relacion === 'atraso' || relacion === 'mismo_dia_despues') ? 'posibilidad_atraso' : 'posibilidad_adelanto'), x));
                if (ymd(v.ini) <= masDias(ymd(now), 1)) await io.vendedor('💡 ' + nombreV + ' dice que chance viene ' + x.alt_corto + ' (' + (c.auto_nombre || 'sin auto') + '). Su cita ' + x.corto + ' sigue igual; si avisa que sale, te aviso.');
                if (ev._aj) ev._aj.push('Lo dijo como posibilidad: NO se movió la cita; quedó como posibilidad alterna');
                return R({ tipo: 'posibilidad', relacion });
            }
            if (ahorita) { const r = await aplicarAgenda({ t, chat, auto, io, now, v, fuente: 'comprador', extras, nuevo, modo: 'ahorita' }); return R({ cita: r.cita, tipo: 'ahorita' }); }
            if (!igual) { const r = await aplicarAgenda({ t, chat, auto, io, now, v, fuente: 'comprador', extras, nuevo }); return R({ cita: r.cita, tipo: r.tipo }); }
            E = 'confirma'; if (ev._aj) ev._aj.push('Repitió el mismo cuándo que ya tenía → no es un cambio: cuenta como confirmación');
        }
    }

    // ── EVIDENCIA FÍSICA: vale desde CUALQUIER estado (la cita nunca estorba) y manda sobre todo lo anterior ──
    const nacerAlVuelo = async (estado) => {   // sin visita viva: si terminó hace nada (hoy o ayer) REVIVE esa misma; si no, nace ligada a la anterior
        const prev = await ultimaCita(tId, chatId);
        if (prev && prev.estado === 'no_llego' && ymd(Number(prev.fin0_ts)) >= masDias(ymd(now), -1)) { c = prev; await bitacora(c, now, 'comprador', 'revive_misma', { estaba: prev.estado, nuevo }); return; }
        const ac = abreCierra(t, ymd(now)); const finV = ac ? Math.max(ac.cierra, now + H) : now + 3 * H;
        const ins = await run(`INSERT INTO citaf (tenant_id, chat_id, tel, nombre, auto_id, auto_nombre, ini_ts, fin_ts, ini0_ts, fin0_ts, precision, estado, confirmada_dia, ultimo_in_ts, ultima_palabra, version, version_ts, datos_json, previa_id, created, updated)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [tId, chatId, String(chat.telefono || ''), chat.nombre || '', auto && auto.id ? Number(auto.id) : null, auto && auto.nombre ? auto.nombre : null, now, finV, now, finV, 'dia', estado, 1, now, E, 1, now, JSON.stringify(extras), prev ? Number(prev.id) : null, now, now]);
        c = await citaPorId(Number(ins.lastInsertRowid)); await bitacora(c, now, 'comprador', 'nace_relampago', { nuevo });
    };
    if (E === 'ya_llegue' || E === 'ya_fue') {   // HECHO FÍSICO dicho por el cliente → REALIZADA (puerta A). La otra puerta es el botón Llegó del vendedor.
        if (!c) await nacerAlVuelo('en_camino');
        await G({ estado: 'realizada', ultima_palabra: E, en_duda: 0, suave: 0, razon: null, version: Number(c.version) + 1, version_ts: now }, E === 'ya_fue' ? 'dijo que ya fue' : 'ya llegó');
        await bitacora(c, now, 'comprador', E, { nuevo }); await io.mandar(texto(t, E === 'ya_fue' ? 'ya_fue' : 'realizada', slots(t, c, now)));
        await io.vendedor('✅ ' + nombreV + (E === 'ya_fue' ? ' dice que ya fue a ver ' : ' llegó para ver ') + (c.auto_nombre || 'el auto') + '.' + (E === 'ya_llegue' ? ' Sal a recibirlo.' : '') + ' Falta el resultado.'); return R();
    }
    if (E === 'ya_voy') {
        delete extras.alt;
        if (!c) await nacerAlVuelo('en_camino');
        const finHoy = (abreCierra(t, ymd(now)) || {}).cierra || now + 3 * H;
        const campos = { estado: 'en_camino', ultima_palabra: E, en_duda: 0, suave: 0, confirmada_dia: 1, razon: null, version: Number(c.version) + 1, version_ts: now };
        const soloHoy = c.estado !== 'pospuesta' && ymd(Number(c.ini_ts)) === ymd(now) && ymd(Number(c.fin_ts)) === ymd(now);
        if (!soloHoy) { campos.ini_ts = now; campos.fin_ts = Math.max(finHoy, now + H); campos.precision = 'dia'; campos.ini0_ts = now; campos.fin0_ts = campos.fin_ts; }   // viene HOY: los otros días de su ventana (o la fecha vieja) dejan de existir
        else if (Number(c.fin_ts) < now + H) campos.fin_ts = Math.max(finHoy, now + H);   // viene fuera de su ventana (antes, después, vencida o sin fecha): la realidad física manda
        await G(campos, 'ya viene en camino'); await bitacora(c, now, 'comprador', 'ya_voy', { nuevo }); await io.mandar(texto(t, 'ya_voy', slots(t, c, now)));
        if (c.auto_id && !(await query("SELECT 1 FROM citaf_eventos WHERE cita_id = ? AND evento = 'pin_enviado' LIMIT 1", [Number(c.id)]))[0]) { await io.pin(Number(c.auto_id)); await bitacora(c, now, 'sistema', 'pin_enviado', null); }
        await io.vendedor('🚗 ' + nombreV + ' va en camino para ver ' + (c.auto_nombre || 'el auto') + '.' + notaDatos(extras)); return R();
    }
    if (!c) return { manejado: false, evento: E };   // lo demás solo tiene sentido con una visita con cuándo
    const vencida = String(c.ultima_palabra) === 'ventana_vencida';
    const aSinFecha = async (razon, plantilla) => { delete extras.alt;   // SIN CUÁNDO: sale del calendario activo, mueren los recordatorios de la fecha vieja, se conserva la historia, se avisa al vendedor. NADA de rescates.
        await G({ estado: 'pospuesta', razon, en_duda: 0, suave: 0, confirmada_dia: 0, ultima_palabra: 'promete_avisar', version: Number(c.version) + 1, version_ts: now }, 'quedó sin fecha: la cita anterior ya no aplica');
        await bitacora(c, now, 'comprador', 'sin_fecha', { razon, nuevo }); if (plantilla) await io.mandar(texto(t, plantilla, slots(t, c, now)));
        await io.vendedor(nombreV + ' quedó sin fecha / pendiente de que vuelva a indicar cuándo (' + (c.auto_nombre || 'sin auto') + ').'); return R();
    };

    if (E === 'confirma') {
        if (c.estado === 'en_camino') { await G({}, false); return R(); }   // evidencia más fuerte ya registrada: un "sí" no la degrada
        if (vencida || Number(c.en_duda)) { await G({ ultima_palabra: 'incierto' }, false); await bitacora(c, now, 'comprador', 'incierto', { nuevo, nota: 'un "sí" a la aclaración no dice si fue o si viene' }); await io.mandar(texto(t, 'pide_dia', slots(t, c, now))); return R(); }
        const unDia = ymd(Number(c.ini_ts)) === ymd(Number(c.fin_ts)); const esHoy = unDia && ymd(now) >= ymd(Number(c.ini_ts));   // con varios días y sin decir cuál, NO hay 'día confirmado' (sería contradecir la ventana)
        const cd = esHoy ? 1 : Number(c.confirmada_dia) || 0; const cambia = cd !== (Number(c.confirmada_dia) || 0) || Number(c.en_duda) || ['se_retrasa', 'incierto'].includes(String(c.ultima_palabra));
        await G(Object.assign({ confirmada_dia: cd, en_duda: 0, ultima_palabra: 'confirma' }, cambia ? { version: Number(c.version) + 1, version_ts: now } : {})); await bitacora(c, now, 'comprador', esHoy ? 'confirma_dia' : 'confirma_antes', { nuevo });
        await io.mandar(texto(t, esHoy ? 'confirma_dia' : 'confirma_antes', slots(t, c, now))); return R();
    }
    if (E === 'se_retrasa' && !vencida && ymd(now) >= ymd(Number(c.ini_ts))) {
        const mins = Math.max(0, Math.min(240, Number(ev.minutos_tarde) || 0)); const finHoy = (abreCierra(t, ymd(now)) || {}).cierra || now + 3 * H; const enCamino = c.estado === 'en_camino'; const antes = cuandoAviso(c);
        if (mins) {   // dijo cuánto: la MISMA visita se recorre
            const campos = { ultima_palabra: enCamino ? c.ultima_palabra : 'confirma', confirmada_dia: 1, en_duda: 0, estado: enCamino ? 'en_camino' : 'viva', version: Number(c.version) + 1, version_ts: now };
            if (c.precision === 'hora') { campos.ini_ts = Math.max(Number(c.ini_ts), now) + mins * MIN; campos.fin_ts = campos.ini_ts; if (Number(c.ini0_ts) === Number(c.ini_ts) && Number(c.fin0_ts) === Number(c.fin_ts)) { campos.ini0_ts = campos.ini_ts; campos.fin0_ts = campos.fin_ts; } }
            else if (!enCamino && ymd(Number(c.ini_ts)) === ymd(now)) { campos.ini_ts = campos.fin_ts = Math.round((now + mins * MIN) / (5 * MIN)) * 5 * MIN; campos.precision = 'hora'; }   // "llego en media hora" = hora nueva concreta
            else campos.fin_ts = Math.max(Number(c.fin_ts), Math.min(finHoy, now + mins * MIN + H));
            await G(campos, 'avisó retraso'); await bitacora(c, now, 'comprador', 'se_retrasa', { minutos: mins, nuevo });
            await io.mandar(texto(t, 'retraso_ok', slots(t, c, now))); await io.vendedor('Cita actualizada — ' + nombreV + ' / ' + (c.auto_nombre || 'sin auto') + ' / ' + antes + ' → ' + cuandoAviso(c) + ' (avisó retraso)'); return R();
        }
        // NO dijo a qué hora: la hora anterior DEJA de ser confiable (no se cancela, no se reprograma sola) → se pregunta la nueva realidad
        const campos = { ultima_palabra: 'se_retrasa', en_duda: 0, version: Number(c.version) + 1, version_ts: now, estado: enCamino ? 'en_camino' : 'viva' };
        if (!enCamino) { campos.ini_ts = now; campos.fin_ts = Math.max(finHoy, now + 2 * H); campos.precision = 'dia'; if (ymd(Number(c.fin0_ts)) <= ymd(now)) { campos.ini0_ts = campos.ini_ts; campos.fin0_ts = campos.fin_ts; } }
        else campos.fin_ts = Math.max(Number(c.fin_ts), finHoy);
        await G(campos); await bitacora(c, now, 'comprador', 'se_retrasa', { sin_hora: true, nuevo });
        await io.mandar(texto(t, enCamino ? 'se_retrasa_camino' : 'se_retrasa_pregunta', slots(t, c, now))); await io.vendedor('Cita actualizada — ' + nombreV + ' / ' + (c.auto_nombre || 'sin auto') + ' / ' + antes + ' → se retrasa, hora por confirmar'); return R();
    }
    if (['se_complico', 'promete_avisar'].includes(E) && rw.op === 'quita_dia') return puerta(rw.v, rw.modo);   // "hoy no puedo" con viernes-sábado: el sábado sigue vivo
    if (['se_complico', 'promete_avisar'].includes(E) && rw.op === 'pregunta') {   // no se sabe QUÉ parte cayó: la ventana NO se toca; se pregunta lo mínimo
        await G({ ultima_palabra: 'incierto', razon: ev.motivo || null, version: Number(c.version) + 1, version_ts: now }, 'algo se le complicó sin decir qué día cae: se pregunta, la ventana sigue'); await bitacora(c, now, 'comprador', 'imprevisto', { nuevo });
        await io.mandar(texto(t, 'se_complico_multi', slots(t, c, now))); await io.vendedor(nombreV + ' tuvo un imprevisto' + (ev.motivo ? ' (' + ev.motivo + ')' : '') + '. Su ventana sigue viva (' + cuandoAviso(c) + '); le pregunté si le sigue quedando.'); return R({ tipo: 'pregunta' });
    }
    if (E === 'promete_avisar') {   // "yo te aviso" quita ÚNICAMENTE la dimensión que el cliente dejó abierta
        if (c.estado === 'en_camino') { await G({}, false); return R(); }
        if (rw.op === 'abre_hora') return puerta(rw.v, rw.modo);                           // el día sigue; murió la hora
        if (rw.op === 'agenda_dia' && rw.v) { const r = await puerta(rw.v); const c2 = await citaViva(tId, chatId); if (c2) await guardar(c2, { ultima_palabra: 'promete_avisar' }, now); return r; }
        if (rw.op === 'bandera') { const soloHoy = ymd(now) === ymd(Number(c.ini_ts)) && ymd(now) === ymd(Number(c.fin_ts)); await G({ ultima_palabra: 'promete_avisar', en_duda: 0, confirmada_dia: soloHoy ? 1 : Number(c.confirmada_dia) || 0, version: Number(c.version) + 1, version_ts: now }, 'él avisa la hora; el día sigue'); await bitacora(c, now, 'comprador', 'avisa_hora', { nuevo }); await io.mandar(texto(t, ymd(now) === ymd(Number(c.ini_ts)) && ymd(now) === ymd(Number(c.fin_ts)) ? 'avisa_al_salir_hoy' : 'avisa_al_salir', slots(t, c, now))); await io.vendedor('Cita actualizada — ' + nombreV + ' / ' + (c.auto_nombre || 'sin auto') + ' / sigue viniendo ' + (soloHoy ? 'HOY' : cuandoAviso(c)) + '; hora por confirmar: él avisa cuando salga.'); return R({ tipo: 'abre_hora' }); }
        return aSinFecha('dijo "yo te aviso" sin dejar ningún cuándo', 'promete_avisar');   // no quedó ni el día
    }
    if (E === 'se_complico') {
        if (vencida) {   // VENTANA VENCIDA + NO FUE + NO CANCELÓ = oportunidad sobreviviente a una cita fallida → se le pide nuevo cuándo Y se escala al vendedor
            const interes = !!ev.sigue_interesado && /(interes|lo quiero|s[ií] quiero|quiero (ir|verlo|verla)|todav[ií]a|sigo)/i.test(nuevo);
            if (ev.avisara && !interes) return aSinFecha('no fue; él avisa cuándo' + (ev.motivo ? ' (' + ev.motivo + ')' : ''), 'promete_avisar');
            await G({ en_duda: 1, suave: 0, confirmada_dia: 0, razon: ev.motivo || null, version: Number(c.version) + 1, version_ts: now }, 'no fue: la ventana anterior murió; se le pidió nuevo día');   // (sigue marcada como ventana vencida: el tiempo ya la mató)
            await bitacora(c, now, 'comprador', 'no_fue_sigue_interesado', { interes, nuevo }); await io.mandar(texto(t, 'se_complico', slots(t, c, now)));
            await io.vendedor('⚠️ ' + nombreV + ' no pudo asistir' + (interes ? ', pero confirmó que sigue interesado en ' + (c.auto_nombre || 'el auto') : ' (no canceló)') + '. Conviene recuperar la cita.' + (ev.motivo ? ' Motivo: ' + ev.motivo : '')); return R({ tipo: 'recuperar', escalado: true });
        }
        if (ev.avisara) return aSinFecha('no alcanza; él avisa cuándo' + (ev.motivo ? ' (' + ev.motivo + ')' : ''), 'promete_avisar');
        // "hoy no alcanzo": la fecha anterior deja de aplicar, pero ANTES de estacionarla se le pregunta el nuevo cuándo. Si contesta un día → viva + ese día, sin pasar por pospuesta.
        await G({ en_duda: 1, suave: 0, confirmada_dia: 0, ultima_palabra: 'se_complico', razon: ev.motivo || null, version: Number(c.version) + 1, version_ts: now }, 'dijo que no alcanza: la fecha anterior ya no aplica');
        await bitacora(c, now, 'comprador', 'se_complico', { nuevo }); await io.mandar(texto(t, 'se_complico', slots(t, c, now)));
        await io.vendedor(nombreV + ' no alcanza a venir ' + cuandoAviso(c) + (ev.motivo ? ' (' + ev.motivo + ')' : '') + '. Le pregunté qué día le queda.'); return R();
    }
    if (E === 'cancela') {   // (solo llega aquí con confianza alta)
        await G({ estado: 'cancelada', razon: ev.motivo || 'canceló el cliente', ultima_palabra: 'cancela' }); await bitacora(c, now, 'comprador', 'cancela', { motivo: ev.motivo, nuevo });
        await io.mandar(texto(t, 'cancela', slots(t, c, now))); await io.vendedor('❌ ' + nombreV + ' canceló' + (ev.motivo ? ': ' + ev.motivo : '') + ' (' + (c.auto_nombre || 'sin auto') + ').'); return R();
    }
    if (E === 'incierto' || E === 'se_retrasa') {   // (se_retrasa de una visita que no es hoy = no se sabe qué quiso decir)
        if (E === 'se_retrasa' && ev._aj) ev._aj.push('Dijo que se retrasa, pero su visita no es hoy' + (vencida ? ' (la ventana ya venció)' : '') + ': no se puede saber qué quiso decir → el código NO inventa nada: lo trata como INCIERTO y le pregunta');
        if (String(c.ultima_palabra) === 'incierto') { await G({}, false); await bitacora(c, now, 'comprador', 'incierto_otra_vez', { nuevo }); await io.vendedor('🔴 ' + nombreV + ' sigue sin dejar claro si viene: "' + nuevo.slice(0, 160) + '". Ya le pregunté una vez; contéstale tú.'); return R({ escalado: true }); }
        await G({ ultima_palabra: 'incierto', version: Number(c.version) + 1, version_ts: now }); await bitacora(c, now, 'comprador', 'incierto', { razon: ev.razon, nuevo });
        await io.mandar(texto(t, (vencida || Number(c.en_duda)) ? 'pide_dia' : 'incierto', slots(t, c, now))); return R();   // pregunta aclaratoria mínima; la realidad NO se toca
    }
    // otra_cosa → ESCALA, la línea sigue igual
    await G({}, false); await bitacora(c, now, 'comprador', 'otra_cosa', { evento_leido: E, nuevo });
    await io.vendedor('🔴 ' + nombreV + ' dijo algo de su visita que no sé resolver: "' + nuevo.slice(0, 160) + '". Contéstale tú; la visita sigue igual.');
    return R({ evento: 'otra_cosa', escalado: true });
}

// ═══ PELÍCULA (solo sandbox): FOTO del estado tras cada operación y REBOBINAR a cualquier momento. Sin tablas nuevas: la foto es un renglón 'foto' de la bitácora. ═══
const esDemoT = t => { try { return require('./demo.js').esDemo(t); } catch (e) { return false; } };
async function tomarFoto(t, chatId, ts) {
    if (!esDemoT(t)) return; try {
        const cs = await query('SELECT * FROM citaf WHERE chat_id = ?', [Number(chatId)]); const ks = await query('SELECT * FROM citaf_casillas WHERE chat_id = ?', [Number(chatId)]);
        await run('INSERT INTO citaf_eventos (cita_id, tenant_id, chat_id, ts, fuente, evento, detalle) VALUES (?,?,?,?,?,?,?)', [cs.length ? Number(cs[cs.length - 1].id) : null, Number(t.id), Number(chatId), Math.round(ts), 'sistema', 'foto', JSON.stringify({ citas: cs, casillas: ks })]);
    } catch (e) { console.error('[citaf] foto:', e.message); }
}
// Regresa ESTE cliente de prueba al momento T: la visita y sus recordatorios vuelven a como estaban, los mensajes posteriores desaparecen y su reloj queda en T.
async function rebobinar({ tenant, chat, hasta }) {
    await asegurar(); if (!esDemoT(tenant)) return { ok: false, error: 'rebobinar solo existe en el sandbox' };
    const chatId = Number(chat.id), T = Math.round(Number(hasta)); if (!T) return { ok: false, error: 'falta el momento' };
    const f = (await query("SELECT detalle FROM citaf_eventos WHERE chat_id = ? AND evento = 'foto' AND ts <= ? ORDER BY ts DESC, id DESC LIMIT 1", [chatId, T]))[0]; let foto = { citas: [], casillas: [] }; try { if (f) foto = JSON.parse(f.detalle) || foto; } catch (e) { }
    await run('DELETE FROM citaf_casillas WHERE chat_id = ?', [chatId]); await run('DELETE FROM citaf WHERE chat_id = ?', [chatId]);
    const meter = async (tabla, filas) => { for (const r of filas || []) { const k = Object.keys(r); await run('INSERT OR REPLACE INTO ' + tabla + ' (' + k.join(',') + ') VALUES (' + k.map(() => '?').join(',') + ')', k.map(x => r[x])); } };
    await meter('citaf', foto.citas); await meter('citaf_casillas', foto.casillas);
    await run('DELETE FROM citaf_eventos WHERE chat_id = ? AND ts > ?', [chatId, T]);
    const bm = await run('DELETE FROM mensajes WHERE conversacion_id = ? AND ts > ?', [chatId, T]); await run('DELETE FROM seb_turnos WHERE chat_id = ?', [chatId]).catch(() => { });
    const u = (await query('SELECT ts, direccion, texto, tipo FROM mensajes WHERE conversacion_id = ? ORDER BY ts DESC, id DESC LIMIT 1', [chatId]))[0];
    await run('UPDATE conversaciones SET ult_msg_ts = ?, ult_texto = ?, ult_dir = ? WHERE id = ?', [u ? Number(u.ts) : null, u ? String(u.tipo === 'image' ? '📷 imagen' : u.tipo === 'location' ? '📍 ubicación' : u.texto || '').slice(0, 120) : null, u ? u.direccion : null, chatId]).catch(() => { });
    await ponerOffset(chatId, T - Date.now());
    return { ok: true, mensajes_borrados: Number(bm.rowsAffected) || 0 };
}

// ═══ EVENTOS DEL VENDEDOR (botones / panel / "Agendar cita" / auto-botón). Pasan por las MISMAS puertas que lo que lee la IA. ═══
//  evento: llego | no_llego | agenda {dia_ini, dia_fin?, hora_ini?, hora_fin?, franja?} | mueve | auto_vendido | cambia_auto {auto_texto} | descartar | resultado
async function vendedor(args) { await asegurar(); const r = await conReintento(() => aplicarVendedor(args)); await tomarFoto(args.tenant, Number(args.chat.id), args.ahoraFijo ? args.ahoraFijo + 1000 : await ahora(Number(args.tenant.id), Number(args.chat.id))); return r; }
async function aplicarVendedor({ tenant, chat, evento, resultado, razon, auto, io, datos, ahoraFijo }) {
    const t = tenant, tId = Number(t.id); const now = ahoraFijo || await ahora(tId, Number(chat.id));
    let c = await citaViva(tId, Number(chat.id)); const ult = c || await ultimaCita(tId, Number(chat.id));
    if (evento === 'agenda') {
        const v = ventanaDe(t, datos || {}, now); if (!v.ok) return { ok: false, error: 'no se puede agendar: ' + v.motivo };
        if (v.fuera_horario) v.fuera_horario = false;   // el vendedor sabe a qué hora lo espera
        if (datos && /^\d{1,2}:\d{2}$/.test(String(datos.hora_ini || '')) && v.precision === 'dia') { const [h, m] = datos.hora_ini.split(':').map(Number); v.ini = v.fin = at(datos.dia_ini, h, m); v.precision = 'hora'; }
        const r = await aplicarAgenda({ t, chat, auto, io, now, v, fuente: 'vendedor', extras: c ? datosDe(c) : {}, nuevo: null }); return { ok: true, cita: r.cita, tipo: r.tipo };
    }
    if (evento === 'llego') {   // HECHO FÍSICO (puerta B de REALIZADA): válido SIEMPRE — viva, vencida, sin fecha, terminada o inexistente (nace ya realizada). Manda sobre cualquier cosa anterior.
        if (!c && ult && ['no_llego', 'cancelada'].includes(ult.estado) && now - Number(ult.updated) < 3 * DIA) c = ult;
        if (!c) { const ins = await run(`INSERT INTO citaf (tenant_id, chat_id, tel, nombre, auto_id, auto_nombre, ini_ts, fin_ts, ini0_ts, fin0_ts, precision, estado, confirmada_dia, version, version_ts, datos_json, previa_id, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [tId, Number(chat.id), String(chat.telefono || ''), chat.nombre || '', auto && auto.id ? Number(auto.id) : null, auto && auto.nombre ? auto.nombre : null, now, now, now, now, 'dia', 'realizada', 1, 1, now, '{}', ult ? Number(ult.id) : null, now, now]); c = await citaPorId(Number(ins.lastInsertRowid)); await bitacora(c, now, 'vendedor', 'llego_sin_cita', null); }
        else { await guardar(c, { estado: 'realizada', razon: null, version: Number(c.version) + 1, version_ts: now }, now); await reconciliar(t, c.id, now, 'llegó'); await bitacora(c, now, 'vendedor', 'llego', null); }
        await io.vendedor('✅ ' + nombreVis(chat) + ' llegó para ver ' + (c.auto_nombre || 'el auto') + '. Falta el resultado: compró · apartó · no compró · sigue pensando.'); return { ok: true, cita: Number(c.id), estado: 'realizada' };
    }
    if (evento === 'resultado') { if (!ult) return { ok: false, error: 'sin visita' }; await guardar(ult, { resultado: String(resultado || ''), razon: razon || ult.razon || null }, now); await bitacora(ult, now, 'vendedor', 'resultado', { resultado, razon }); return { ok: true, cita: Number(ult.id), resultado }; }
    if (!c) return { ok: false, error: 'no hay visita viva en este chat' };
    if (evento === 'cambia_auto') { const r = await aplicarAuto({ t, chat, io, now, c, auto_texto: String((datos && datos.auto_texto) || ''), fuente: 'vendedor' }); if (!r.ok) return { ok: false, error: r.n ? 'varios autos embonan' : 'no encontré ese auto en el catálogo' }; await reconciliar(t, c.id, now); return { ok: true, cita: Number(c.id), auto: r.auto.nombre }; }
    const aSinFecha = async (motivo, plantilla, campos) => {   // el vendedor deja la visita SIN CUÁNDO (estacionamiento pasivo: sin rescates)
        await guardar(c, Object.assign({ estado: 'pospuesta', razon: motivo, en_duda: 0, suave: 0, confirmada_dia: 0, version: Number(c.version) + 1, version_ts: now }, campos || {}), now); await reconciliar(t, c.id, now, motivo); await bitacora(c, now, 'vendedor', evento, { motivo });
        if (plantilla) await io.mandar(texto(t, plantilla, slots(t, c, now))); await io.vendedor(nombreVis(chat) + ' quedó sin fecha / pendiente de que vuelva a indicar cuándo (' + motivo + ').'); return { ok: true, cita: Number(c.id), estado: 'pospuesta' };
    };
    if (evento === 'no_llego' || evento === 'descartar') {   // ACCIÓN MANUAL VÁLIDA: solo la mano del vendedor puede decir "no asistió" (jamás el silencio ni el reloj)
        await guardar(c, { estado: 'no_llego', razon: razon || 'lo marcó el vendedor', version: Number(c.version) + 1, version_ts: now }, now); await reconciliar(t, c.id, now, 'el vendedor marcó que no llegó'); await bitacora(c, now, 'vendedor', 'no_llego', { razon });
        await io.sistema('⚪ NO ASISTIÓ (lo marcaste tú). Si el cliente regresa con un nuevo cuándo, nace una visita nueva ligada a esta; si aparece, "Llegó" sigue funcionando.'); return { ok: true, cita: Number(c.id), estado: 'no_llego' };
    }
    if (evento === 'mueve') return aSinFecha('la movió el vendedor', 'mueve_vendedor');
    if (evento === 'auto_vendido') return aSinFecha('el auto se vendió con la visita viva', 'auto_vendido', { auto_id: null });
    return { ok: false, error: 'evento desconocido' };
}

// ═══ EL RELOJ: el paso del tiempo también es realidad. Ejecuta las casillas vencidas; cada una REVISA A SU MAMÁ antes de salir. ═══
//  Idempotente entre procesos (cron, botones del reloj, dos pestañas): la casilla se RECLAMA (pendiente→enviando) antes de ejecutarse.
async function tick({ tenant, ioDe, hasta, chatId, curar }) {
    await asegurar(); const t = tenant, tId = Number(t.id); const now = hasta || await ahora(tId, chatId); const hechas = [];
    const soloChat = chatId ? ' AND chat_id = ' + Number(chatId) : '';
    await run("UPDATE citaf_casillas SET estado = 'pendiente' WHERE tenant_id = ? AND estado = 'enviando' AND sent_ts < ?", [tId, Date.now() - 5 * MIN]).catch(() => { });   // reclamo huérfano (proceso que murió a medias) → se reintenta
    // REVISIÓN DE SEGURIDAD (1 vez por hora en el cron; siempre en botones/pruebas): toda visita CON CUÁNDO vigente debe tener su checkpoint. Va por índice (tenant, estado) y (cita, estado).
    if (curar !== false && (curar === true || chatId || hasta || new Date().getUTCMinutes() < 10)) try { const hu = await query("SELECT id FROM citaf c WHERE tenant_id = ? AND estado IN ('viva','en_camino') AND NOT (COALESCE(ultima_palabra,'') = 'ventana_vencida' AND EXISTS (SELECT 1 FROM citaf_casillas a WHERE a.cita_id = c.id AND a.tipo = 'aclaracion' AND a.version = c.version))" + soloChat + " AND NOT EXISTS (SELECT 1 FROM citaf_casillas k WHERE k.cita_id = c.id AND k.estado IN ('pendiente','enviando'))", [tId]); for (const h of hu) { await reconciliar(t, h.id, now, 'autocuración'); await bitacora({ id: h.id, tenant_id: tId, chat_id: null }, now, 'reloj', 'autocuracion', null); } } catch (e) { }
    let choques = 0, pendFoto = null; const cerrarFoto = async () => { if (pendFoto) { const f = pendFoto; pendFoto = null; await tomarFoto(t, f.chat, f.ts); } };
    for (const ca of await query("SELECT * FROM citaf WHERE tenant_id = ? AND estado IN ('viva','en_camino') AND datos_json LIKE '%\"alt\"%'" + soloChat, [tId]).catch(() => [])) { try { if (await podarAlt(t, ca, now)) { hechas.push({ tipo: 'posibilidad_vence', para: 'sistema', due_ts: now, cuando: fechaCorta(now), salio: false, motivo: 'pasó la posibilidad sin que la eligiera; la cita sigue igual', chat_id: Number(ca.chat_id) }); await tomarFoto(t, Number(ca.chat_id), now); } } catch (e) { } }
    for (let vuelta = 0; vuelta < 60; vuelta++) {
        await cerrarFoto();
        const k = (await query("SELECT * FROM citaf_casillas WHERE tenant_id = ? AND estado = 'pendiente' AND due_ts <= ?" + soloChat + ' ORDER BY due_ts ASC, id ASC LIMIT 1', [tId, now]))[0]; if (!k) break;
        const rec = await run("UPDATE citaf_casillas SET estado = 'enviando', sent_ts = ? WHERE id = ? AND estado = 'pendiente'", [Date.now(), Number(k.id)]); if (!Number(rec.rowsAffected)) continue;   // otro proceso la ganó
        const c = await citaPorId(k.cita_id); const cuando = Number(k.due_ts);
        // EL CHAT YA NO EXISTE (lo borraron) → la visita muere con él. Nunca se manda su recordatorio a ningún otro chat.
        if (!c || !(await query('SELECT 1 x FROM conversaciones WHERE id = ? LIMIT 1', [Number(k.chat_id)]))[0]) { await run("UPDATE citaf_casillas SET estado = 'cancelada', motivo = 'el chat de esta visita ya no existe' WHERE cita_id = ? AND estado IN ('pendiente','enviando')", [Number(k.cita_id)]); if (c) await run("UPDATE citaf SET estado = 'reemplazada', razon = 'su chat fue borrado' WHERE id = ?", [Number(c.id)]); continue; }
        const io0 = await ioDe(c); const io = Object.assign({}, io0, { mandar: (tx) => io0.mandar(tx, cuando) });   // el mensaje sale fechado con la hora del recordatorio
        const saltar = async (m) => { await run("UPDATE citaf_casillas SET estado = 'saltada', motivo = ?, sent_ts = ? WHERE id = ?", [m, cuando, Number(k.id)]); await io.sistema('⏱ ' + fechaCorta(cuando) + ' · ' + k.tipo + ' NO salió: ' + m); hechas.push({ tipo: k.tipo, para: k.para, due_ts: cuando, cuando: fechaCorta(cuando), salio: false, motivo: m, chat_id: Number(k.chat_id) }); pendFoto = { chat: Number(k.chat_id), ts: cuando + 999 }; };
        const salio = async (tx) => { await run("UPDATE citaf_casillas SET estado = 'enviada', texto = ?, sent_ts = ? WHERE id = ?", [tx, cuando, Number(k.id)]); hechas.push({ tipo: k.tipo, para: k.para, due_ts: cuando, cuando: fechaCorta(cuando), salio: true, texto: tx, chat_id: Number(k.chat_id) }); pendFoto = { chat: Number(k.chat_id), ts: cuando + 999 }; };
        try {
            if (!c || Number(k.version) !== Number(c.version)) { await saltar('pertenece a una realidad anterior (la visita cambió después de programarla)'); continue; }
            const x = slots(t, c, cuando); const acD = abreCierra(t, ymd(cuando)); if (acD) x.cierre = hm(acD.cierra);
            const nombreV = nombreVis(c);
            const hablo = async (tipos) => { const p = (await query('SELECT sent_ts FROM citaf_casillas WHERE cita_id = ? AND tipo IN (' + tipos.map(() => '?').join(',') + ") AND estado = 'enviada' ORDER BY sent_ts DESC LIMIT 1", [Number(c.id)].concat(tipos)))[0]; return p && Number(c.ultimo_in_ts) > Number(p.sent_ts); };
            // ── casillas del sistema / vendedor ──
            if (k.tipo === 'vence') {   // EL TIEMPO volvió vencida la realidad temporal anterior. NO se concluye cancelación, ni plantón, ni fin de la intención.
                if (!['viva', 'en_camino'].includes(c.estado)) { await saltar('la visita ya estaba ' + c.estado); continue; }
                const ef = efectoVence(t, c, cuando);
                if (ef.reabre) {   // precisó una hora y no llegó, pero SU ventana original sigue abierta: aún no vence
                    await guardar(c, ef.campos, cuando); await reconciliar(t, c.id, cuando, 'pasó la hora que precisó; su ventana original sigue abierta');
                    await bitacora(c, cuando, 'reloj', 'reabre_ventana_original', null); await salio('reabre ventana original'); await io.sistema('⏱ ' + fechaCorta(cuando) + ' · Pasó la hora que precisó sin llegada acreditada, pero su ventana original sigue abierta hasta ' + fechaCorta(Number(c.fin0_ts)) + ': mañana un solo mensaje suave.'); continue;
                }
                await guardar(c, ef.campos, cuando); await reconciliar(t, c.id, cuando, 'la ventana venció: estos recordatorios ya no tienen sentido');
                await bitacora(c, cuando, 'reloj', 'ventana_vencida', { en_duda: !!Number(c.en_duda) }); await salio('ventana vencida');
                await io.vendedor('⚠️ Terminó la ventana de ' + nombreV + ' sin llegada acreditada (' + (c.auto_nombre || 'sin auto') + ').'); continue;
            }
            if (k.tipo === 'aclaracion') {   // a la mañana siguiente: UN mensaje para sacarnos de la duda. Si no contesta NO se infiere nada.
                if (c.estado !== 'viva' || String(c.ultima_palabra) !== 'ventana_vencida') { await saltar('la realidad ya cambió: ' + (c.estado !== 'viva' ? c.estado : String(c.ultima_palabra))); continue; }
                const tx = texto(t, plantillaDe(c, 'aclaracion'), x); await io.sistema('⏱ ' + fechaCorta(cuando) + ' · sale: aclaración de ventana vencida'); { const fin = await io.mandar(tx); await salio(typeof fin === 'string' && fin ? fin : tx); } await bitacora(c, cuando, 'reloj', 'aclaracion_enviada', null); continue;
            }
            if (k.tipo === 'marcar') {
                if (c.estado !== 'viva' || Number(c.confirmada_dia) === 1 || Number(c.en_duda) === 1) { await saltar(c.estado !== 'viva' ? 'la visita ya estaba ' + c.estado : 'ya contestó'); continue; }
                if (await hablo(['empujon', 'dia', 'dia_ultimo'])) { await saltar('el comprador sí escribió después del recordatorio'); continue; }
                await bitacora(c, cuando, 'reloj', 'silencio_2', null); await salio('márcale'); await io.vendedor('📞 Márcale a ' + nombreV + ': no ha confirmado su visita de hoy (' + cuandoCorto(c, cuando) + ' · ' + (c.auto_nombre || '') + '). Ya se le escribió dos veces.'); continue;
            }
            if (k.tipo === 'marcar_pregunta') {
                if (!['viva', 'en_camino'].includes(c.estado) || !['se_retrasa', 'incierto'].includes(String(c.ultima_palabra)) || Number(c.ultimo_in_ts) > Number(c.version_ts)) { await saltar('ya contestó la pregunta'); continue; }   // (sin respuesta NO cambia la realidad: solo se avisa al vendedor)
                await bitacora(c, cuando, 'reloj', 'silencio_a_pregunta', null); await salio('márcale'); await io.vendedor('📞 Márcale a ' + nombreV + ': ' + (String(c.ultima_palabra) === 'se_retrasa' ? 'dijo que se retrasa y no ha dicho a qué hora llega' : 'no quedó claro si sigue viniendo y no ha contestado') + ' · ' + (c.auto_nombre || '')); continue;
            }
            // ── casillas al comprador ──
            if (c.estado !== 'viva') { await saltar('la visita ya estaba ' + c.estado); continue; }
            if (Number(c.en_duda) === 1) { await saltar('dijo que no alcanza: la fecha anterior ya no aplica'); continue; }
            let tx = null;
            if (k.tipo === 'r1') { if (Number(c.ultimo_in_ts) > cuando - 6 * H) { await saltar('platicó hace menos de 6 h: no hace falta recordarle'); continue; } }
            else if (k.tipo === 'dia') { if (Number(c.confirmada_dia) === 1) { await saltar('el día ya estaba confirmado'); continue; } }
            else if (k.tipo === 'empujon') { if (Number(c.confirmada_dia) === 1 || await hablo(['dia', 'dia_ultimo'])) { await saltar('ya contestó el mensaje del día'); continue; } await bitacora(c, cuando, 'reloj', 'silencio_1', null); }
            else if (k.tipo === 'me_avisas') { if (Number(c.confirmada_dia) !== 1) { await saltar('no ha confirmado el día'); continue; } }
            { const pl = plantillaDe(c, k.tipo); if (pl) tx = texto(t, pl, x); }
            if (!tx) { await saltar('tipo desconocido'); continue; }
            await io.sistema('⏱ ' + fechaCorta(cuando) + ' · sale: ' + k.tipo); { const fin = await io.mandar(tx); await salio(typeof fin === 'string' && fin ? fin : tx); }
        } catch (e) {
            // la visita cambió justo mientras esta casilla corría (IA o vendedor ganaron): se suelta el reclamo y la siguiente vuelta la revisa contra la realidad nueva
            await run("UPDATE citaf_casillas SET estado = 'pendiente' WHERE id = ? AND estado = 'enviando'", [Number(k.id)]).catch(() => { });
            if (!(e instanceof Conflicto) || ++choques > 5) { if (!(e instanceof Conflicto)) console.error('[citaf] tick:', e.message); break; }
        }
    }
    await cerrarFoto();
    return hechas;
}

// ═══ LECTURA PARA LA UI ═══
async function estado({ tenant, chat }) {
    await asegurar(); const tId = Number(tenant.id); const off = await offsetDe(Number(chat.id)); const now = Date.now() + off;
    const c = await citaViva(tId, Number(chat.id)) || await ultimaCita(tId, Number(chat.id));
    const out = { ok: true, reloj: { offset_ms: off, ahora_ts: now, ahora: fechaCorta(now), virtual: off > 0 }, horario_hoy: horarioTexto(tenant, ymd(now)), horario: horarioDe(tenant), cita: null, casillas: [], eventos: [], historial: [] };
    const sig = (await query("SELECT MIN(due_ts) d FROM citaf_casillas WHERE chat_id = ? AND estado = 'pendiente'", [Number(chat.id)]))[0]; out.reloj.siguiente_ts = sig && sig.d ? Number(sig.d) : null;
    if (!c) return out;
    out.cita = { id: Number(c.id), estado: c.estado, viva: VIVAS.includes(c.estado), situacion: situacionDe(tenant, c, now), concrecion: CONCRECION[c.precision] || c.precision, en_duda: !!Number(c.en_duda), suave: !!Number(c.suave), confirmada_dia: !!Number(c.confirmada_dia), precision: c.precision, auto: c.auto_nombre, cuando: c.estado === 'pospuesta' ? 'sin fecha' : (String(c.ultima_palabra) === 'ventana_vencida' && c.estado === 'viva' ? 'ventana vencida' : cuandoCorto(c, now)), vencida: c.estado === 'viva' && String(c.ultima_palabra) === 'ventana_vencida', ventana: fechaCorta(c.ini_ts) + (Number(c.fin_ts) !== Number(c.ini_ts) ? ' → ' + fechaCorta(c.fin_ts) : ''), ventana_original: (Number(c.ini0_ts) !== Number(c.ini_ts) || Number(c.fin0_ts) !== Number(c.fin_ts)) ? fechaCorta(c.ini0_ts) + ' → ' + fechaCorta(c.fin0_ts) : null, ini_ts: Number(c.ini_ts), fin_ts: Number(c.fin_ts), datos: datosDe(c), resultado: c.resultado || null, razon: c.razon || null, version: Number(c.version), previa_id: c.previa_id ? Number(c.previa_id) : null };
    out.casillas = (await query('SELECT tipo, para, due_ts, estado, motivo, sent_ts, texto, version FROM citaf_casillas WHERE cita_id = ? ORDER BY due_ts ASC, id ASC', [Number(c.id)])).map(k => ({ tipo: k.tipo, para: k.para, due_ts: Number(k.due_ts), cuando: fechaCorta(k.due_ts), estado: k.estado, motivo: k.motivo || null, texto: k.texto || null, version: Number(k.version) }));
    const yaEsta = new Set(out.casillas.filter(k => k.estado === 'pendiente').map(k => k.tipo + ':' + k.due_ts));
    out.proyeccion = VIVAS.includes(c.estado) ? proyectar(tenant, c, now).filter(k => !yaEsta.has(k.tipo + ':' + k.due_ts)) : [];   // lo que vendría DESPUÉS si nadie dice nada (p. ej. la aclaración tras vencer)
    const COND = { r1: 'no sale si platicó en las últimas 6 h', dia: 'no sale si ya confirmó el día', empujon: 'solo si sigue sin contestar el mensaje del día', marcar: 'solo si sigue sin contestar', marcar_pregunta: 'solo si no contestó la pregunta', me_avisas: 'solo con el día confirmado' };
    out.casillas.forEach(k => { if (k.estado === 'pendiente') { k.previa = vistaPrevia(tenant, c, k); k.condicion = COND[k.tipo] || null; if (k.tipo === 'vence') k.efecto = efectoVence(tenant, c, k.due_ts).reabre ? 'se reabre su ventana original en modo suave' : 'la visita sigue VIVA con el dato "ventana vencida"; mueren los recordatorios de esta ventana'; } k.texto_tipo = ACCION_TXT[k.tipo] || k.tipo; }); { let cc = Object.assign({}, c); out.proyeccion.forEach(k => { k.texto_tipo = ACCION_TXT[k.tipo] || k.tipo; k.previa = vistaPrevia(tenant, cc, k); if (k.tipo === 'vence') cc = Object.assign(cc, efectoVence(tenant, cc, k.due_ts).campos); }); }
    { const a = datosDe(c).alt; out.cita.alt = a ? { ini_ts: Number(a.ini_ts), fin_ts: Number(a.fin_ts), precision: a.precision, relacion: a.relacion, cuando: altTxt(c) } : null; }
    out.cita.nace_ts = Number(c.created); out.cita.ini0_ts = Number(c.ini0_ts); out.cita.fin0_ts = Number(c.fin0_ts);
    out.eventos = (await query("SELECT ts, fuente, evento, detalle FROM citaf_eventos WHERE cita_id = ? AND evento NOT IN ('pin_enviado','autocuracion','foto') ORDER BY id ASC", [Number(c.id)])).map(e => { let d = null; try { d = JSON.parse(e.detalle || 'null'); } catch (x) { } return { ts: Number(e.ts), cuando: fechaCorta(e.ts), fuente: e.fuente, evento: e.evento, dijo: d && d.nuevo ? String(d.nuevo).slice(0, 140) : null, antes: d && d.antes ? d.antes : null }; });
    out.historial = (await query('SELECT id, estado, ini_ts, resultado FROM citaf WHERE tenant_id = ? AND chat_id = ? AND id <> ? ORDER BY id DESC LIMIT 6', [tId, Number(chat.id), Number(c.id)])).map(h => ({ id: Number(h.id), estado: h.estado, cuando: fechaCorta(h.ini_ts), resultado: h.resultado || null }));
    return out;
}
// ═══ LA LIBRETA: todas las visitas vivas del universo, cada una con su situación y su PRÓXIMA ACCIÓN. Métrica: VISITAS VIVAS SIN PRÓXIMA ACCIÓN = 0 ═══
const ACCION_TXT = { r1: 'recordatorio', vispera: 'mensaje de un día antes', dia: 'mensaje del día (pide confirmar)', dia_multi: 'mensaje del día', dia_ultimo: 'mensaje del último día', empujon: 'segundo intento', marcar: 'avisarte que le marques', marcar_pregunta: 'avisarte que le marques (no contestó la pregunta)', me_avisas: '"me avisas cuando vengas"', revision_suave: 'mensaje suave', vence: 'vence la ventana', aclaracion: 'preguntarle si fue o si todavía viene' };
async function tablero({ tenant }) {
    await asegurar(); const tId = Number(tenant.id); const off = 0; const now = Date.now();
    const cs = await query('SELECT * FROM citaf WHERE tenant_id = ? AND estado IN ' + VIVAS_SQL + ' ORDER BY ini_ts ASC', [tId]);
    const rec = await query("SELECT * FROM citaf WHERE tenant_id = ? AND estado IN ('realizada','cancelada','no_llego') AND ini_ts >= ? ORDER BY ini_ts DESC LIMIT 60", [tId, now - 21 * DIA]);   // para que el calendario también muestre cómo terminó cada día
    const ids = cs.map(c => Number(c.id)); const ph = ids.map(() => '?').join(',');
    const ks = ids.length ? await query('SELECT cita_id, tipo, para, due_ts, estado, sent_ts FROM citaf_casillas WHERE cita_id IN (' + ph + ") AND estado IN ('pendiente','enviando','enviada') ORDER BY due_ts ASC, id ASC", ids) : [];
    const es = ids.length ? await query('SELECT cita_id, ts, fuente, evento FROM citaf_eventos WHERE id IN (SELECT MAX(id) FROM citaf_eventos WHERE cita_id IN (' + ph + ") AND evento NOT IN ('pin_enviado','autocuracion','foto') GROUP BY cita_id)", ids) : [];
    const ultE = {}; for (const e of es) ultE[Number(e.cita_id)] = e;
    const dias = (c) => { const o = []; for (let d = ymd(Number(c.ini_ts)), n = 0; d <= ymd(Number(c.fin_ts)) && n < 4; d = masDias(d, 1), n++) o.push(d); return o; };
    const filas = cs.map(c => {
        const mias = ks.filter(k => Number(k.cita_id) === Number(c.id)); const prox = mias.find(k => k.estado !== 'enviada') || null; const vencida = c.estado === 'viva' && String(c.ultima_palabra) === 'ventana_vencida';
        const marcado = mias.filter(k => k.estado === 'enviada' && /^marcar/.test(k.tipo) && Number(k.sent_ts) >= Number(c.ultimo_in_ts || 0)).pop(); const u = ultE[Number(c.id)];
        let atencion = null;
        if (marcado && !vencida) atencion = 'Márcale: no contesta';
        else if (u && ['otra_cosa', 'incierto_otra_vez'].includes(u.evento)) atencion = 'Contéstale tú: dijo algo que no sé resolver';
        // SIN PRÓXIMA ACCIÓN solo es válido con una razón explícita de espera
        let espera = null;
        if (c.estado === 'pospuesta') espera = 'Sin cuándo: fuera del calendario hasta que él diga un día (o tú la agendes)';
        else if (vencida && !prox) espera = 'Ya se le preguntó si fue o si todavía viene. Sin respuesta no se concluye nada: espera su palabra o tu botón (Llegó / No llegó / mover)';
        const grupo = atencion ? 'atencion' : (c.estado === 'en_camino' ? 'en_camino' : (c.estado === 'pospuesta' ? 'sin_fecha' : (vencida ? 'vencidas' : (ymd(Number(c.ini_ts)) <= ymd(now) ? 'hoy' : 'proximas'))));
        return { cita_id: Number(c.id), chat_id: Number(c.chat_id), nombre: nombreVis(c), auto: c.auto_nombre || null, estado: c.estado, vencida, grupo, cuando: c.estado === 'pospuesta' ? 'sin fecha' : (vencida ? 'venció ' + fechaCorta(c.fin_ts) : cuandoCorto(c, now)), ini_ts: Number(c.ini_ts), fin_ts: Number(c.fin_ts), precision: c.precision, hora: c.precision === 'hora' ? hm(c.ini_ts) : (c.precision === 'franja' ? hm(c.ini_ts) + '–' + hm(c.fin_ts) : 'hora abierta'), dias: c.estado === 'pospuesta' ? [] : dias(c), concrecion: CONCRECION[c.precision] || c.precision, situacion: situacionDe(tenant, c, now), ultimo: u ? { cuando: fechaCorta(u.ts), fuente: u.fuente, evento: u.evento } : null, proxima: prox ? { tipo: prox.tipo, texto: ACCION_TXT[prox.tipo] || prox.tipo, para: prox.para, due_ts: Number(prox.due_ts), cuando: fechaCorta(prox.due_ts), vencida: Number(prox.due_ts) < now - 15 * MIN } : null, espera, atencion, datos: datosDe(c) };
    });
    const cerradas = rec.map(c => ({ cita_id: Number(c.id), chat_id: Number(c.chat_id), nombre: nombreVis(c), auto: c.auto_nombre || null, estado: c.estado, grupo: 'cerradas', cuando: fechaCorta(c.ini_ts), hora: c.precision === 'hora' ? hm(c.ini_ts) : 'hora abierta', dias: [ymd(Number(c.ini_ts))], situacion: situacionDe(tenant, c, now), resultado: c.resultado || null }));
    const sinProx = filas.filter(f => !f.proxima && !f.espera);
    return { ok: true, ahora: fechaCorta(now), hoy: ymd(now), virtual: off > 0, vivas: filas.filter(f => f.estado !== 'pospuesta').length, sin_fecha: filas.filter(f => f.estado === 'pospuesta').length, sin_proxima_accion: sinProx.length, sin_proxima: sinProx.map(f => f.cita_id), vencidas: filas.filter(f => f.vencida).length, filas, cerradas };
}
// ═══ CALENDARIO COMPLETO (vista de escritorio, mismo lienzo que el calendario del Sales Brain): la libreta + por cada visita TODAS sus casillas, la proyección y su historia.
//     Solo LEE las mismas tablas; no guarda nada propio.
async function calendario({ tenant }) {
    const tb = await tablero({ tenant }); const tId = Number(tenant.id); const now = Date.now();
    const todas = tb.filas.concat(tb.cerradas || []); const ids = todas.map(f => f.cita_id); if (!ids.length) return Object.assign(tb, { ahora_ts: now, horario: horarioDe(tenant) });
    const ph = ids.map(() => '?').join(',');
    const cs = await query('SELECT * FROM citaf WHERE id IN (' + ph + ')', ids); const porId = {}; cs.forEach(c => porId[Number(c.id)] = c);
    const ks = await query('SELECT cita_id, tipo, para, due_ts, estado, motivo, texto, version FROM citaf_casillas WHERE cita_id IN (' + ph + ') ORDER BY due_ts ASC, id ASC', ids);
    const es = await query("SELECT cita_id, ts, fuente, evento, detalle FROM citaf_eventos WHERE cita_id IN (" + ph + ") AND evento NOT IN ('pin_enviado','autocuracion','foto') ORDER BY id ASC", ids);
    for (const f of todas) {
        const c = porId[f.cita_id]; if (!c) continue;
        f.ini_ts = Number(c.ini_ts); f.fin_ts = Number(c.fin_ts); f.precision = c.precision; f.tel = c.tel; f.resultado = c.resultado || null; f.razon = c.razon || null; f.ventana = fechaCorta(c.ini_ts) + (Number(c.fin_ts) !== Number(c.ini_ts) ? ' → ' + fechaCorta(c.fin_ts) : ''); f.datos = datosDe(c);
        f.casillas = ks.filter(k => Number(k.cita_id) === f.cita_id).map(k => ({ tipo: k.tipo, texto_tipo: ACCION_TXT[k.tipo] || k.tipo, para: k.para, due_ts: Number(k.due_ts), cuando: fechaCorta(k.due_ts), estado: k.estado, motivo: k.motivo || null, texto: k.texto || null }));
        const ya = new Set(f.casillas.filter(k => k.estado === 'pendiente').map(k => k.tipo + ':' + k.due_ts));
        f.proyeccion = VIVAS.includes(c.estado) ? proyectar(tenant, c, now).filter(k => !ya.has(k.tipo + ':' + k.due_ts)).map(k => Object.assign(k, { texto_tipo: ACCION_TXT[k.tipo] || k.tipo })) : [];
        f.eventos = es.filter(e => Number(e.cita_id) === f.cita_id).map(e => { let d = null; try { d = JSON.parse(e.detalle || 'null'); } catch (x) { } return { ts: Number(e.ts), cuando: fechaCorta(e.ts), fuente: e.fuente, evento: e.evento, dijo: d && d.nuevo ? String(d.nuevo).slice(0, 160) : null, antes: d && d.antes ? d.antes : null }; });
    }
    return Object.assign(tb, { ahora_ts: now, horario: horarioDe(tenant), nombre: tenant.nombre || '' });
}
// citas vivas del universo → fila verde del inbox
async function vivasPorChat(tId) { await asegurar(); const r = await query("SELECT chat_id, ini_ts, auto_nombre, estado, confirmada_dia FROM citaf WHERE tenant_id = ? AND estado IN ('viva','en_camino')", [Number(tId)]).catch(() => []); const m = {}; for (const x of r) m[Number(x.chat_id)] = { cita_ts: Number(x.ini_ts), auto: x.auto_nombre || null, estado: 'confirmada' }; return m; }
async function reset(tId) { await asegurar(); await run('DELETE FROM citaf_reloj WHERE tenant_id IN (SELECT ' + RELOJ_BASE + ' + id FROM conversaciones WHERE tenant_id = ?)', [Number(tId)]).catch(() => { }); for (const tb of ['citaf_casillas', 'citaf_eventos', 'citaf']) await run('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [Number(tId)]).catch(() => { }); }
async function borrarDeChat(chatId) { await asegurar(); for (const tb of ['citaf_casillas', 'citaf_eventos', 'citaf']) await run('DELETE FROM ' + tb + ' WHERE chat_id = ?', [Number(chatId)]).catch(() => { }); await run('DELETE FROM citaf_reloj WHERE tenant_id = ?', [RELOJ_BASE + Number(chatId)]).catch(() => { }); }

// ═══ LA TUBERÍA (una sola, la usan el panel, el cron y las pruebas): sandbox → hilo; universo real → WhatsApp por la puerta de mensajes ═══
const SCHEMA_MAQ = { type: 'object', additionalProperties: false, required: ['burbujas'], properties: { burbujas: { type: 'array', items: { type: 'string' } } } };
const GUIA_MAQ = {
    posibilidad_adelanto: 'Abrió una POSIBILIDAD de venir antes; la cita vigente sigue. Acepta la posibilidad, pide que avise si sale, y deja claro que si no, queda lo acordado. Tres burbujas cortas.', posibilidad_dentro: 'Abrió una POSIBILIDAD de venir en un momento concreto dentro de la ventana acordada; la ventana sigue. Acepta, pide aviso si sale, y si no, sigue lo acordado.', posibilidad_atraso: 'Abrió una POSIBILIDAD de venir después; la cita vigente sigue. Por ahora se deja lo acordado; si ve que sí será después, que avise y se mueve. Dos burbujas.',
    pasa_ahorita: 'Preguntó si puede pasar AHORITA: dile que sí con gusto, hasta qué hora estamos, y que avise cuando venga en camino. Dos burbujas.',
    cambio_sin_hora: 'Cambió de día sin dar hora: acusa lo que dijo (que sí puede ese día) y pregunta la hora, como vendedor. Dos burbujas.',
    nace: 'Confirmación FORMAL (él dio día y hora). Dos burbujas: un arranque corto y natural ("Va pues!") y la confirmación con TODOS los datos del base, avisando que le mandas la ubicación. NO cierres con frases de servicio: el cierre va en otro mensaje.',
    nace_cierre: 'Cierre de servicio después de mandarle la ubicación: corto, cálido, que sepa que avise cualquier cosa y que estamos en contacto. Una burbuja.',
    me_avisas: 'Han pasado horas desde lo último: salúdalo otra vez conforme a la hora y pídele que avise cuando venga en camino. Dos burbujas cortas.',
    nace_suave: 'Solo dijo el día. NO le hables de "cita confirmada" ni de compromiso: dale el sí con naturalidad y pregúntale la hora con mano izquierda.', nace_suave_dias: 'Solo dijo un rango de días. NO le hables de "cita confirmada": dale el sí con naturalidad y pregunta si trae alguna hora en mente.',
    confirma_dia: 'Acuse corto. Si él dijo "gracias", empieza con "Gracias a ti".', confirma_antes: 'Acuse corto. Si él dijo "gracias", empieza con "Gracias a ti". Puedes cerrar con "nos hablamos" según el día.',
    se_complico: 'Dos burbujas: primero el acuse con tacto (sin drama), luego ofrecer reagendar. NO preguntes todavía día ni hora.',
    r1: 'Toque ligero a media semana, solo para seguir en contacto. Corto.', vispera_hora: 'Recordatorio de la víspera: saludo práctico y corto.', vispera_sin_hora: 'Recordatorio de la víspera: saludo práctico y corto, buscando la hora.', dia_hora: 'Mensaje del mero día, como vendedor que da por hecho que se ven (nunca como si dudaras de que venga).', dia_sin_hora: 'Mensaje del mero día, como vendedor que da por hecho que se ven; busca la hora.', dia_ultimo: 'Mensaje del mero día, como vendedor que da por hecho que se ven; busca la hora.'
};
const SIN_EMOJI = s0 => String(s0 || '').replace(/[¿¡]/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '').replace(/[ \t]{2,}/g, ' ').trim();
const planoMaq = s0 => String(s0 || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// → arreglo de burbujas. Compuertas de CÓDIGO después del modelo: mismos números, mismos días, misma cantidad de preguntas (0 o ≥1), sin temas comerciales, sin emojis, corto. Cualquier falla → plantilla.
async function maquillar({ base, clave, nombre, historial, esRespuesta, saludo }) {
    const partesBase = String(base).split('||').map(x => x.trim()).filter(Boolean);
    const dioGracias = !!esRespuesta && (historial || []).length && historial[historial.length - 1].d === 'in' && /\bgracias\b/i.test(historial[historial.length - 1].texto || '');
    try {
        const system = 'Eres Sebastián, vendedor de autos seminuevos en Monterrey, contestando TÚ MISMO por WhatsApp a un comprador. Te doy el MENSAJE BASE: es lo que NECESITAS decir ahorita (sus datos y su función no se tocan). Escríbelo como lo escribirías tú de verdad, a ESTA persona, en ESTE momento de la plática: que sienta que lo atiende alguien que quiere servirle, no una máquina.\n' +
            'ASÍ ESCRIBES (mensajes reales tuyos): "Excelente entonces déjame te confirmo la cita" · "Entonces te confirmo tu cita" · "A qué hora te viene bien Arturo" · "Okok a qué horas Hector ?" · "A qué horas te esperamos mañana ?" · "Mañana si vienes a ver el sentra correcto ?" · "Pues nos vemos el sábado Virgilio para que se arme" · "Ahí nos vemos a las 7" · "Ahí nos vemos" · "Me avisas cuando vengas Edrac" · "En cuanto vengas me avisas Juan ?" · "Vava me avisas" · "Me avisas Max cualquier cosa" · "Tú me dices, para servirte" · "Claro que sí" · "Qué tal Emiliano buen día" · "Vava gracias por avisar Emiliano, me avisas" · "Sisi" · "Cómo andas mañana ?"\n' +
            'TU RITMO: burbujas cortas (una idea por burbuja), directo, cálido sin ser empalagoso. El nombre va donde tú lo pones: al final de la pregunta o del acuse ("A qué hora te viene bien Arturo"), o en el saludo; una vez por mensaje, y no en todos. No usas "¿" ni "¡", pero TODA pregunta termina con su "?". Casi no pones punto final. Contesta a lo que él ACABA de decir: si saludó, salúdalo; si dio las gracias, "Gracias a ti"; si se disculpa o se le complicó, quítale el peso ("sin tema"); si viene animado, acompáñalo ("Excelente", "Va perfecto", "para que se arme").\n' +
            'LO QUE NO SE TOCA:\n· Los datos del base (día, hora, lugar, auto, horario): todos, tal cual, sin agregar ni cambiar ninguno ni repetir datos de la cita que el base no trae.\n· La función: si el base pregunta algo, tú preguntas LO MISMO (una sola pregunta, con su "?"); si no pregunta, no preguntas. No agregues peticiones de confirmar, llamar, marcar, reagendar ni mandar ubicación que el base no traiga. Sí puedes cerrar con "me avisas cualquier cosa" o "para servirte" cuando quede natural (no en todos).\n· Prohibido precio, crédito, enganche, garantía, descuentos, promesas.\n· CERO emojis. Nada de "estimado", "con gusto le informo", "quedo atento", "excelente día": eso es de call center.\n· Si saludas, el saludo es el de ESTA hora: "' + (saludo || 'buen día') + '".\n' +
            (dioGracias ? 'EL COMPRADOR ACABA DE DAR LAS GRACIAS: empieza con "Gracias a ti".\n' : '') +
            'BURBUJAS: 1 a 3, cada una de máximo 22 palabras. No repitas una muletilla que ya usaste en tus últimos mensajes de la conversación: varía.\nDevuelve { burbujas: [...] }.';
        const content = 'MOMENTO: ' + (GUIA_MAQ[clave] || 'Mensaje operativo de la visita: dilo natural y corto.') + '\nNOMBRE DEL COMPRADOR: ' + (nombre || '(sin nombre)') + '\nCONVERSACIÓN (lo último):\n' + (historial || []).map(m => (m.d === 'in' ? 'Comprador: ' : 'Lote: ') + String(m.texto || '').slice(0, 200).replace(/\n+/g, ' / ')).join('\n') + (dioGracias ? '\nEL COMPRADOR ACABA DE DAR LAS GRACIAS.' : '') + (esRespuesta ? '' : '\n(Este mensaje es un RECORDATORIO que sale solo, horas o días después de lo último de la conversación: no contestes a nada de lo anterior.)') + '\n\nMENSAJE BASE' + (partesBase.length > 1 ? ' (' + partesBase.length + ' burbujas)' : '') + ':\n' + partesBase.join('\n---\n');
        const r = await haiku(system, content, SCHEMA_MAQ); let B = r && Array.isArray(r.burbujas) ? r.burbujas.map(SIN_EMOJI).filter(Boolean) : null;
        const dbg = m => { if (process.env.CITAF_MAQ_DEBUG) console.log('      (maquillaje descartado: ' + m + ' → ' + JSON.stringify(B) + ')'); return partesBase; };
        if (!B || !B.length || B.length > 3) return dbg('salida inválida');
        const n1 = String(nombre || '').trim(); if (n1 && !new RegExp('\\b' + n1 + '\\b', 'i').test(partesBase.join(' '))) B = B.map(x => x.replace(new RegExp(',?\\s*\\b' + n1 + '\\b', 'gi'), '').replace(/^\s*[,.]\s*/, '').trim()).filter(Boolean);   // la IA puede quitar el nombre, no agregarlo
        B = B.map(x => (x.split(/\s+/).length <= 6 ? x.replace(/\.$/, '') : x));   // burbuja corta (saludo, acuse) sin punto final, como se escribe en WhatsApp
        const todo = B.join(' '), b0 = partesBase.join(' '); const P = planoMaq(todo), P0 = planoMaq(b0);
        const nums = x => (x.match(/\d+(?::\d+)?/g) || []); const n0 = nums(P0); if (nums(P).some(n => !n0.includes(n)) || n0.some(n => !nums(P).includes(n))) return dbg('números distintos');                       // mismos números (horas, fechas)
        for (const w of ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo', 'hoy', 'manana', 'ayer', 'mediodia', 'fin de semana']) if (new RegExp('\\b' + w + '\\b').test(P0) !== new RegExp('\\b' + w + '\\b').test(P)) return dbg('días distintos: ' + w);   // mismos días
        if (/\?/.test(b0) !== /\?/.test(todo) || (todo.match(/\?/g) || []).length > Math.max(1, (b0.match(/\?/g) || []).length)) return dbg('cambió pregunta/no pregunta');                                                        // misma función: pregunta ↔ no pregunta
        if (/\b(precio|credito|enganche|mensualidad|garantia|descuento|apart|promoci|\$)/.test(P) && !/\b(precio|credito|enganche|mensualidad|garantia|descuento|apart|promoci|\$)/.test(P0)) return dbg('tema comercial');
        for (const [w, re2] of [['buen dia', /buen(os)? dias?/], ['buenas tardes', /buenas tardes/], ['buenas noches', /buenas noches/]]) if (re2.test(P) && planoMaq(saludo || '') !== w && !re2.test(P0)) return dbg('saludo de otra hora');
        if (P0.includes('avis') && !P.includes('avis')) return dbg('se perdió la petición de avisar');
        for (const w of ['ubicaci', 'reagend', 'confirm', 'llam', 'marc']) if (P0.includes(w) !== P.includes(w)) return dbg('petición funcional distinta: ' + w);                                                                   // la petición funcional sigue ahí
        if (todo.length > b0.length * 1.7 + 60 || B.some(x => x.length > 240) || (todo.match(/!/g) || []).length > 1) return dbg('largo o con admiración de más');
        return B;
    } catch (e) { return partesBase; }
}
// POSIBILIDAD ALTERNA (datos.alt): vive junto al plan principal sin tocarlo. Vence sola cuando pasa su ventana; muere cuando el cliente ELIGE (cambio real del plan).
async function podarAlt(t, c, now) {
    const d = datosDe(c); if (!d.alt) return false;
    if (Number(d.alt.fin_ts) + 30 * MIN > now) return false;
    delete d.alt; await guardar(c, { datos_json: JSON.stringify(d) }, now); await bitacora(c, now, 'reloj', 'posibilidad_vencida', null); return true;
}
const RE_TENTATIVO = /\b(si alcanzo|si (puedo|me da|se puede|salgo|me desocupo|me dejan|acabo)|chance|a lo mejor|quiz[aá]s?|tal vez|igual y|capaz|puede que|de repente|a ver si|ojal[aá]|si acaso|si de casualidad|y si (mejor|me|paso|voy|llego)|probable|posible|no s[eé] si|ver[eé] si|checo si)\b/i;
function ioPara(tC, chC) {
    const MSJ = require('./mensajeria.js'), DEMO = require('./demo.js'), U = require('./universo.js');
    const demo = DEMO.esDemo(tC); let n = 0; const base = 'citaf:' + Number(chC.id) + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 6);
    const nota = async (txt) => { try { if (demo) await DEMO.sistema(tC, String(chC.telefono), txt); else { const ts = Date.now(); await run("INSERT OR IGNORE INTO mensajes (conversacion_id, msg_id, ts, direccion, emisor, texto, tipo, ai_generated, created_at) VALUES (?,?,?,?,?,?,?,?,?)", [Number(chC.id), 'citaf-nota:' + ts + ':' + (n++), ts, 'out', 'sistema', txt, 'text', 1, ts]); } } catch (e) { } };
    const mandar = (extra) => MSJ.enviar(Object.assign({ tenantId: Number(tC.id), chatId: Number(chC.id), origen: 'sb', clave: base + ':' + (n++), manual: false, accion: 'cita_flex' }, extra));   // (extra.ts = hora de la prueba con la que queda fechado en el sandbox)
    return {
        mandar: async (tx, ts) => {   // "||" separa burbujas. Con maquillaje encendido en el universo, la IA le pone tacto y el código verifica; si no, sale la plantilla.
            const meta = CLAVE_DE.get(tx); let B = String(tx).split('||').map(x => x.trim()).filter(Boolean);
            if (meta && cfgDe(tC).citaf_maquillaje && !process.env.CITAF_SIN_MAQUILLAJE) {
                const hist = (await query("SELECT direccion d, texto FROM mensajes WHERE conversacion_id = ? AND emisor != 'sistema' AND tipo = 'text' ORDER BY ts DESC, id DESC LIMIT 8", [Number(chC.id)]).catch(() => [])).reverse();
                B = await maquillar({ base: tx, clave: meta.clave, nombre: meta.nombre, saludo: meta.saludo, historial: hist, esRespuesta: !ts });
            }
            for (let i = 0; i < B.length; i++) await mandar({ texto: B[i], ts: ts ? ts + i * 1000 : undefined });
            return B.join('\n');
        },
        pin: async (autoInvId) => { const pe = (await query('SELECT image_b64, lat, lng, name, maps_link FROM punto_envio WHERE auto_id = ?', [Number(autoInvId)]).catch(() => []))[0]; if (!pe) return; await mandar({ imagen: pe.image_b64 || null, imagen_ref: pe.image_b64 ? 'ubic-img:' + Number(autoInvId) : null, location: (pe.lat != null && pe.lng != null) ? { lat: pe.lat, lng: pe.lng, name: pe.name || '', maps_link: pe.maps_link || undefined } : null }); },
        vendedor: async (txt) => {   // solo cambios que alteran la realidad operativa. Sandbox: renglón gris en el hilo. Universo real: además WhatsApp al número del vendedor (el mismo desde el que salen los mensajes), por la puerta de mensajes existente.
            await nota(txt);
            try { const telV = String(tC.telefono || '').replace(/\D/g, ''); if (!demo && telV.length >= 12) { const chV = await U.chatDe(Number(tC.id), telV, { crear: true, visible: false, nombre: 'Avisos de citas' }); if (chV) await MSJ.enviar({ tenantId: Number(tC.id), chatId: Number(chV.id), origen: 'sb', clave: base + ':v:' + (n++), manual: false, accion: 'cita_flex_aviso', texto: txt }); } } catch (e) { console.error('[citaf] aviso al vendedor:', e.message); }
        },
        sistema: (txt) => nota(txt),
        catalogo: async () => (await query("SELECT i.id, i.fyradrive_web_id web, i.marca, i.modelo, i.anio FROM autos_universo au JOIN inventario_autos i ON i.id = au.inv_auto_id WHERE au.tenant_id = ? AND au.activo = 1 AND i.estado = 'activo'", [Number(tC.id)]).catch(() => [])).map(a => ({ id: Number(a.id), web: a.web == null ? null : Number(a.web), nombre: [a.marca, a.modelo, a.anio].filter(Boolean).join(' ') })),
        ponerFoco: async (a) => { const ch = await U.chatDe(Number(tC.id), String(chC.telefono), { crear: false }); if (ch) await U.cambiarFoco(ch, a.web || a.id, 'fyrachat', { activado_por: 'cita_flex', auto_nombre: a.nombre, solo_si_activa: true }); }
    };
}
// reloj REAL (cron cada 10 min): todos los universos con citas_flex. Misma función tick, misma puerta.
async function tickTodos({ curar } = {}) {
    await asegurar(); const U = require('./universo.js'); const out = [];
    const ts = await query("SELECT id, telefono, nombre, config_json FROM tenants WHERE activo = 1 AND config_json LIKE '%citas_flex%'").catch(() => []);
    for (const t of ts) { if (!activo(t)) continue; try {
        // cada chat corre con SU hora (en el sandbox un cliente de prueba puede ir adelantado; en un universo real todos van a la hora real)
        const offs = {}; (await query('SELECT r.tenant_id k, r.offset_ms o FROM citaf_reloj r WHERE r.tenant_id >= ' + RELOJ_BASE).catch(() => [])).forEach(r => offs[Number(r.k) - RELOJ_BASE] = Number(r.o) || 0);
        const maxOff = Math.max(0, ...Object.values(offs)); const chats = (await query("SELECT DISTINCT chat_id FROM citaf_casillas WHERE tenant_id = ? AND estado = 'pendiente' AND due_ts <= ?", [Number(t.id), Date.now() + maxOff])).map(r => Number(r.chat_id)); let n = 0;
        for (const ch of chats) { const h = await tick({ tenant: t, chatId: ch, hasta: Date.now() + (offs[ch] || 0), curar: false, ioDe: async (c) => ioPara(t, (await U.chatPorId(Number(c.chat_id))) || { id: c.chat_id, telefono: c.tel }) }); n += h.length; }
        if (curar === true || new Date().getUTCMinutes() < 10) { const hu = await query("SELECT id, chat_id FROM citaf c WHERE tenant_id = ? AND estado IN ('viva','en_camino') AND NOT (COALESCE(ultima_palabra,'') = 'ventana_vencida' AND EXISTS (SELECT 1 FROM citaf_casillas a WHERE a.cita_id = c.id AND a.tipo = 'aclaracion' AND a.version = c.version)) AND NOT EXISTS (SELECT 1 FROM citaf_casillas k WHERE k.cita_id = c.id AND k.estado IN ('pendiente','enviando'))", [Number(t.id)]); for (const h of hu) await reconciliar(t, h.id, Date.now() + (offs[Number(h.chat_id)] || 0), 'revisión de seguridad'); }   // 1/h: a quien le falte su checkpoint se le re-planea con SU hora
        out.push({ tenant: Number(t.id), casillas: n });
    } catch (e) { out.push({ tenant: Number(t.id), error: e.message }); } }
    return out;
}

module.exports = { rebobinar, borrarDeChat, tomarFoto, RELOJ_BASE, calendario, proyectar, cuandoAviso, activo, asegurar, ahora, offsetDe, ponerOffset, entrante, vendedor, tick, tickTodos, estado, tablero, planear, reconciliar, ventanaDe, vivasPorChat, reset, citaViva, fechaCorta, horarioDe, ioPara, situacionDe, Conflicto, _t: { at, ymd, masDias, hm, fueraDeSilencio, leer, cuandoCorto, cuandoLargo, autoDeTexto, horaDeReloj } };
