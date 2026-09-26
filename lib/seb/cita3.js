'use strict';
/* CITA DE 3 PARTES · v2 (plan acordado con el owner 2026-09-25/26) — solo universos con config.tres_partes (Autos Fyradrive; LAB para simular).
 * Comprador (manda) · Vendedor Fyradrive (Mario, vota con BOTONES) · Dueño del auto (particular o lote: solo recibe horarios con 2 votos).
 * citas-flex sigue siendo el lector del CUÁNDO del comprador; esta capa es dueña de la confirmación, los recordatorios y el día D.
 *
 * RONDA (antes de la primera confirmación o tras un Nuevo horario):
 *   comprador da día+hora → fase espera_vendedor (1 voto) → Mario: Confirmo | Proponer
 *   Mario Proponer → espera_comprador (sugerencia) → comprador "sí" → 2 votos → espera_dueno
 *   espera_dueno: al dueño UN mensaje cordial. "Sí" limpio (y una sola cita abierta) = acreditada. TODO lo demás = pausa_dueno:
 *   "ahorita te contesta Mario" + voz a Mario, que cierra con botón en el chat del dueño: Dueño confirmó · Nuevo horario · Ya no disponible.
 *   Sin hora (solo ventana) NO hay ronda: se le pide la hora; si no la da, se le vuelve a pedir a las 9 am del día anterior.
 * CONFIRMADA: la máquina solo corre el script (recordatorios, "sí", herramientas). Todo lo demás de cualquiera escala a Mario, que mueve con
 *   botones: Nuevo horario (el chat donde lo aprieta dice con quién ya acordó) · Pausar/Continuar · Cancelar (con razón).
 * DÍA D: 9 am (o 2 h antes si la cita es antes de las 11) recordatorio a los 3; sin respuesta, segundo anticipado; luego "márcale" a Mario
 *   (si el que falla es Mario: aviso al owner y pausa). Con 3 palomitas, 1 h antes: ¿listos Mario y dueño? → luz verde al comprador →
 *   "ya voy" → Mario sale ya, dueño 5 min después → llegadas → Mario "Ya estamos los 3".
 * RELOJ: todo se calcula con la hora de la cita (Date.now() + desfase del chat del comprador) para que el simulador pueda adelantar el tiempo.
 * Mejor no captar que captar mal: lo que no encaja en la lista, se escala. Todo queda en bitácora (cita3_eventos). */
const { query, run } = require('./db.js');
const U = require('./universo.js');
const CITAF = require('./citas-flex.js');
const VOZ = require('./voz.js');
const MSJ = require('./mensajeria.js');
const DEMO = require('./demo.js');
const MIN = 60000, H = 3600000;
const { at, ymd, masDias } = CITAF._t;
let _ok = false;
async function asegurar() {
    if (_ok) return; _ok = true;
    await run(`CREATE TABLE IF NOT EXISTS cita3 (cita_id INTEGER PRIMARY KEY, tenant_id INTEGER, chat_id INTEGER, auto_id INTEGER, auto_nombre TEXT, dueno_tel TEXT, dueno_nombre TEXT, dueno_chat_id INTEGER, dueno_tipo TEXT,
        vendedor_id INTEGER, vendedor_nombre TEXT, vendedor_tel TEXT, gen INTEGER DEFAULT 0, por TEXT, ini_ts INTEGER, fin_ts INTEGER, precision TEXT, ok_comprador INTEGER DEFAULT 0, ok_dueno INTEGER DEFAULT 0, ok_vendedor INTEGER DEFAULT 0,
        estado TEXT DEFAULT 'ronda', pregunta_dueno TEXT, pregunta_comprador TEXT, espera_desde INTEGER, dia_json TEXT, created INTEGER, updated INTEGER)`);
    for (const [c, tp] of [['fase', 'TEXT'], ['flags_json', 'TEXT'], ['conf_ini', 'INTEGER'], ['conf_fin', 'INTEGER'], ['conf_precision', 'TEXT'], ['conf_ts', 'INTEGER'], ['razon', 'TEXT'], ['antes_pausa', 'TEXT']]) { try { await run('ALTER TABLE cita3 ADD COLUMN ' + c + ' ' + tp); } catch (e) { } }
    await run('CREATE TABLE IF NOT EXISTS cita3_eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, cita_id INTEGER, gen INTEGER, ts INTEGER, canal TEXT, texto TEXT, evento TEXT, confianza TEXT, accion TEXT)');
    await run('CREATE TABLE IF NOT EXISTS cita3_hora (cita_id INTEGER PRIMARY KEY, ts INTEGER)');
    await run('CREATE INDEX IF NOT EXISTS ix_cita3_dueno ON cita3 (tenant_id, dueno_chat_id)').catch(() => { });
    await run('CREATE INDEX IF NOT EXISTS ix_cita3_chat ON cita3 (tenant_id, chat_id)').catch(() => { });
}
const cfgDe = t => { let c = t && t.config; if (!c || typeof c !== 'object') { try { c = JSON.parse((t && t.config_json) || '{}') || {}; } catch (e) { c = {}; } } return c; };
const activo = t => Number(cfgDe(t).tres_partes) === 1;
const marcaCorta = t => String(cfgDe(t).marca || (t && t.nombre) || '').replace(/\s+IA$/i, '').trim();
const primer = s => { const p = String(s || '').trim().split(/\s+/)[0] || ''; return p && !/^\+?\d/.test(p) ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : ''; };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const ABIERTOS = "('ronda','confirmada','pausada','dia_d')";
const L = ts => new Date(Number(ts) - 6 * H);
const saludo = ts => { const h = L(ts).getUTCHours(); return h < 5 ? 'buenas noches' : (h < 12 ? 'buen día' : (h < 19 ? 'buenas tardes' : 'buenas noches')); };   // 1:38 am no es "buen día"
const hora = ts => { const d = L(ts); let h = d.getUTCHours(); const m = d.getUTCMinutes(); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return (h === 1 ? 'a la ' : 'a las ') + h + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + ap; };   // "a la 1 pm", no "a las 1 pm"
const J = s => { try { return JSON.parse(s || '{}') || {}; } catch (e) { return {}; } };
let TS_EJ = null;   // hora de EJECUCIÓN de un recordatorio (tick): el texto ("mañana", saludo) y la fecha con la que queda el mensaje salen del MISMO reloj
async function ahoraDe(c) { if (TS_EJ) return TS_EJ; return Date.now() + await CITAF.offsetDe(Number(c.chat_id)); }
async function bit(c, canal, texto, evento, confianza, accion, ts) { try { await run('INSERT INTO cita3_eventos (cita_id, gen, ts, canal, texto, evento, confianza, accion) VALUES (?,?,?,?,?,?,?,?)', [Number(c.cita_id), Number(c.gen) || 0, ts || await ahoraDe(c), canal, String(texto || '').slice(0, 300), evento, confianza || null, accion || null]); } catch (e) { } }
async function porCita(citaId) { await asegurar(); return (await query('SELECT * FROM cita3 WHERE cita_id = ?', [Number(citaId)]))[0] || null; }
async function porChat(tenantId, chatId) { await asegurar(); return (await query('SELECT * FROM cita3 WHERE tenant_id = ? AND chat_id = ? AND estado IN ' + ABIERTOS + ' ORDER BY cita_id DESC LIMIT 1', [Number(tenantId), Number(chatId)]))[0] || null; }
async function abiertasDueno(tenantId, chatId) { await asegurar(); return query('SELECT * FROM cita3 WHERE tenant_id = ? AND dueno_chat_id = ? AND estado IN ' + ABIERTOS + ' ORDER BY cita_id DESC', [Number(tenantId), Number(chatId)]); }
async function porDuenoChat(tenantId, chatId) { return (await abiertasDueno(tenantId, chatId))[0] || null; }
async function guardar(c, campos) { const k = Object.keys(campos); if (!k.length) return; await run('UPDATE cita3 SET ' + k.map(x => x + ' = ?').join(', ') + ', updated = ? WHERE cita_id = ?', [...k.map(x => campos[x]), Date.now(), Number(c.cita_id)]); Object.assign(c, campos); }
async function flag(c, k, v) { const f = J(c.flags_json); f[k] = v == null ? Date.now() : v; await guardar(c, { flags_json: JSON.stringify(f) }); }
const tiene = (c, k) => !!J(c.flags_json)[k];
async function luces(c, cambios) { const d = J(c.dia_json); Object.assign(d, cambios); await guardar(c, { dia_json: JSON.stringify(d) }); return d; }
async function cuando(c, iniTs, finTs, prec) { const now = await ahoraDe(c); return CITAF._t.cuandoCorto({ ini_ts: iniTs || c.ini_ts, fin_ts: finTs || c.fin_ts || iniTs || c.ini_ts, precision: prec || c.precision || 'hora', estado: 'viva', datos_json: '{}' }, now, true); }   // "mañana a las 11 am", "el sábado a las 5 pm"

// ── CANALES ──
const gram = s => String(s || '').replace(/\bde el\b/g, 'del').replace(/\ba el\b/g, 'al');
async function mandarA(t, chatId, texto, accion) { texto = gram(texto); return MSJ.enviar(Object.assign({ tenantId: Number(t.id), chatId: Number(chatId), origen: 'sb', clave: 'cita3:' + Number(chatId) + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 6), manual: false, accion: accion || 'cita3', texto }, TS_EJ && DEMO.esDemo(t) ? { ts: TS_EJ } : {})); }
async function nota(t, chatId, txt) { try { const ch = await U.chatPorId(Number(chatId)); if (!ch) return; if (DEMO.esDemo(t)) await DEMO.sistema(t, String(ch.telefono), txt); else await run("INSERT OR IGNORE INTO mensajes (conversacion_id, msg_id, ts, direccion, emisor, texto, tipo, ai_generated, created_at) VALUES (?,?,?,?,?,?,?,?,?)", [Number(ch.id), 'cita3:' + Number(ch.id) + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 5), Date.now(), 'out', 'sistema', txt, 'sistema', 0, Date.now()]); } catch (e) { } }
/** A Mario: nota en el chat que corresponde (FyraChat) + WhatsApp a su número (en el sandbox el WhatsApp se simula: la nota es lo que le llega). */
async function aMario(t, c, txt, enChat) { txt = gram(txt); await nota(t, enChat || c.chat_id, '🔔 ' + txt); try { if (c.vendedor_tel && !DEMO.esDemo(t)) await VOZ.avisarMiembro(t, { id: c.vendedor_id, nombre: c.vendedor_nombre, telefono: c.vendedor_tel }, txt + '\n' + VOZ.linkChat(t.id, enChat || c.chat_id)); } catch (e) { } }
async function aOwner(t, c, txt) { await nota(t, c.chat_id, '🛑 Aviso al owner: ' + txt); try { if (!DEMO.esDemo(t)) await require('./citas-vivas.js').enviarWA('5218120066355', txt, 0); } catch (e) { } }
/** El vendedor Fyradrive del chat (miembro dueño del chat; si no, el admin). */
async function vendedorDe(t, chatId) {
    const row = (await query('SELECT miembro_id FROM conversaciones WHERE id = ?', [Number(chatId)]))[0]; let m = null;
    if (row && row.miembro_id) m = (await query('SELECT id, nombre, telefono FROM vendedores_universo WHERE id = ? AND activo = 1', [Number(row.miembro_id)]))[0] || null;
    if (!m) m = (await query("SELECT id, nombre, telefono FROM vendedores_universo WHERE tenant_id = ? AND activo = 1 ORDER BY CASE WHEN rol = 'admin' THEN 0 ELSE 1 END, id LIMIT 1", [Number(t.id)]))[0] || null;
    return m ? { id: Number(m.id), nombre: m.nombre, telefono: m.telefono } : { id: null, nombre: marcaCorta(t) || 'el vendedor', telefono: null };
}
/** El dueño del auto: lote (tenant dueño del auto en autos_universo) o particular (ficha del inventario). En sandbox, siempre un dueño de prueba. */
async function duenoDe(t, autoInvId) {
    const inv = (await query('SELECT id, fyradrive_web_id, marca, modelo, anio, dueno_nombre, dueno_telefono FROM inventario_autos WHERE id = ? OR fyradrive_web_id = ? LIMIT 1', [Number(autoInvId), Number(autoInvId)]))[0]; if (!inv) return null;
    if (DEMO.esDemo(t)) { const NOMS = ['Juan', 'Carmen', 'Roberto', 'Lucía', 'Andrés', 'Paty', 'Jorge', 'Mónica']; return { tipo: 'particular', nombre: NOMS[Number(inv.id) % NOMS.length] + ' (dueño de prueba)', telefono: '52100000000' + String(50 + (Number(inv.id) % 40)), inv }; }   // MODO PRUEBA: un dueño de prueba distinto por auto (jamás el real)
    const lote = (await query("SELECT tt.id, tt.nombre, tt.telefono, tt.config_json FROM autos_universo au JOIN tenants tt ON tt.id = au.tenant_id WHERE au.inv_auto_id = ? AND au.rol = 'dueno' AND au.activo = 1 AND tt.id <> ? AND tt.activo = 1 LIMIT 1", [Number(inv.id), Number(t.id)]))[0];
    if (lote) { const cfg = J(lote.config_json); if (cfg.usuario || cfg.tipo === 'lote') { let tel = lote.telefono; if (!tel) tel = (((await query("SELECT telefono FROM vendedores_universo WHERE tenant_id = ? AND activo = 1 ORDER BY CASE WHEN rol = 'admin' THEN 0 ELSE 1 END, id LIMIT 1", [Number(lote.id)]))[0]) || {}).telefono; return { tipo: 'lote', nombre: String(cfg.marca || lote.nombre).replace(/\s+IA$/i, ''), telefono: tel || null, inv, horario: cfg.horario || null }; } }
    return { tipo: 'particular', nombre: inv.dueno_nombre || 'el dueño', telefono: inv.dueno_telefono || null, inv };
}
async function chatDueno(t, c, d) {
    let tel = String(d.telefono || '').replace(/\D/g, ''); if (tel.length === 10) tel = '521' + tel; if (DEMO.esDemo(t)) tel = DEMO.telComprador(tel || '0000000095');
    const ch = await U.chatDe(Number(t.id), tel, { crear: true, visible: true, nombre: (d.tipo === 'lote' ? '' : 'Dueño · ') + d.nombre + ' · ' + (c.auto_nombre || '') }); if (!ch) return null;
    await U.guardarEstado(Number(t.id), tel, { canal: 'dueno' }).catch(() => { });
    try { await run('UPDATE conversaciones SET miembro_id = COALESCE(miembro_id, ?), canal = ? WHERE id = ?', [c.vendedor_id, 'dueno', Number(ch.id)]); } catch (e) { }
    try { const dl = await U.delegacionActiva(ch.id); if (!dl) await U.delegar(ch.id, { auto_id: d.inv.fyradrive_web_id || d.inv.id, auto_nombre: c.auto_nombre, activado_por: 'cita3' }); } catch (e) { }
    return Object.assign(ch, { telefono: tel });
}
async function nombres(t, c) { const ch = await U.chatPorId(c.chat_id).catch(() => null); const n = primer(ch && ch.nombre); return { C: n, n: n ? ' ' + n : '', V: primer(c.vendedor_nombre) || 'el vendedor', D: primer(c.dueno_nombre) || '', auto: c.auto_nombre || 'el auto', marca: marcaCorta(t) }; }
function fueraHorarioLote(horario, iniTs) { if (!horario || typeof horario !== 'object') return null; const d = L(iniTs); const hr = horario[String(d.getUTCDay())]; const hm = h => (h % 12 || 12) + (h < 12 ? ' am' : ' pm'); if (!hr) return 'cerrado'; const h = d.getUTCHours() + d.getUTCMinutes() / 60; return (h < Number(hr[0]) - 0.01 || h > Number(hr[1]) + 0.01) ? 'de ' + hm(Number(hr[0])) + ' a ' + hm(Number(hr[1])) : null; }

// ═══ RONDA ═══
/** Crea la fila (si no existe) para la cita del motor; resuelve vendedor y dueño una sola vez. */
async function asegurarFila(t, chatId, citaId) {
    let c = await porCita(citaId); if (c) return c;
    const cf = (await query('SELECT * FROM citaf WHERE id = ?', [Number(citaId)]))[0]; if (!cf) return null;
    const v = await vendedorDe(t, chatId); const d = cf.auto_id ? await duenoDe(t, cf.auto_id) : null;
    await run('INSERT OR IGNORE INTO cita3 (cita_id, tenant_id, chat_id, auto_id, auto_nombre, dueno_tel, dueno_nombre, dueno_tipo, vendedor_id, vendedor_nombre, vendedor_tel, gen, estado, fase, dia_json, flags_json, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)',
        [Number(citaId), Number(t.id), Number(chatId), cf.auto_id, cf.auto_nombre, d ? d.telefono : null, d ? d.nombre : null, d ? d.tipo : null, v.id, v.nombre, v.telefono, 'ronda', null, '{}', '{}', Date.now(), Date.now()]);
    return porCita(citaId);
}
/** Nueva propuesta. votos = { c, v, d } (quién ya está de acuerdo con ESTE horario). El siguiente en la fila es a quien se le pregunta. */
async function proponer({ tenant: t, c, ini, fin, precision, votos, por, razon, nuevo }) {
    const now = await ahoraDe(c); const prev = { ini: c.ini_ts, fase: c.fase, gen: c.gen }; const gen = (Number(c.gen) || 0) + 1;
    await guardar(c, { gen, por, ini_ts: ini, fin_ts: fin || ini, precision: precision || 'hora', ok_comprador: votos.c ? 1 : 0, ok_vendedor: votos.v ? 1 : 0, ok_dueno: votos.d ? 1 : 0, estado: c.estado === 'confirmada' || c.estado === 'pausada' ? c.estado : 'ronda', razon: razon || null, espera_desde: now, fase: null });
    await bit(c, por, nuevo, 'propuesta', 'alta', 'gen ' + gen + ' · ' + await cuando(c) + ' · votos ' + ['c', 'v', 'd'].filter(k => votos[k]).join('+'));
    const N = await nombres(t, c); const cu = await cuando(c); const cuAnt = c.conf_ini ? await cuando(c, c.conf_ini, c.conf_fin, c.conf_precision) : null;
    if (prev.fase === 'espera_dueno' && !votos.d && c.dueno_chat_id) await mandarA(t, c.dueno_chat_id, 'Hola ' + (N.D || '') + ', hubo un cambio en el horario que te comenté; en cuanto quede te vuelvo a escribir. ¡Gracias!', 'cita3_dueno');
    if (!votos.v) { await guardar(c, { fase: 'espera_vendedor' }); await aMario(t, c, 'Cita 3 partes · ' + N.auto + ' · ' + cu + ' · la propuso ' + (por === 'comprador' ? 'el comprador' : 'el dueño') + '. Si a ti te acomoda, pícale "Confirmo" y yo le pregunto al dueño; si no, "Proponer otro horario".'); return c; }
    if (!votos.c) {
        await guardar(c, { fase: 'espera_comprador' });
        let tx;
        if (por === 'dueno') tx = (N.C ? N.C + ', ' : '') + (cuAnt ? 'quien tiene el ' + N.auto + ' no va a poder ' + cuAnt + ', pero sí puede ' + cu : 'quien tiene el ' + N.auto + ' puede ' + cu) + '. ¿Te quedaría bien? Si no, dime qué día y a qué hora te acomoda.';
        else if (cuAnt) tx = (N.C ? N.C + ', ' : '') + N.V + ' tuvo un cambio y no va a poder ' + cuAnt + '. ¿Te quedaría bien ' + cu + '? Si no, dime qué día y a qué hora te acomoda.';
        else tx = (N.C ? N.C + ', ' : '') + N.V + ' puede ' + cu + '. ¿Te quedaría bien? Si no, dime qué día y a qué hora te acomoda.';
        tx = tx.charAt(0).toUpperCase() + tx.slice(1);   // sin nombre del comprador arrancaba en minúscula ("quien tiene el Audi…")
        await mandarA(t, c.chat_id, tx, 'cita3'); return c;
    }
    if (!votos.d) return pedirDueno(t, c, cuAnt);
    return acreditar(t, c);
}
async function pedirDueno(t, c, cuAnt) {
    const N = await nombres(t, c); const cu = await cuando(c); const now = await ahoraDe(c);
    if (!c.dueno_chat_id) {
        if (!c.dueno_tel) { await guardar(c, { fase: 'pausa_dueno' }); await aMario(t, c, '⚠️ El ' + N.auto + ' no tiene teléfono del dueño: confírmalo tú con él (' + cu + ') y pícale "Dueño confirmó" o "Nuevo horario".'); return c; }
        const d = await duenoDe(t, c.auto_id); const chD = d ? await chatDueno(t, c, d) : null; if (chD) await guardar(c, { dueno_chat_id: Number(chD.id), dueno_tel: chD.telefono });
    }
    if (c.dueno_tipo === 'lote') { const d = await duenoDe(t, c.auto_id); const fh = fueraHorarioLote(d && d.horario, c.ini_ts); if (fh) { await guardar(c, { fase: 'espera_comprador', ok_comprador: 0 }); await bit(c, 'sistema', '', 'fuera_horario_lote', 'alta', fh); await mandarA(t, c.chat_id, 'Ese día ' + (c.dueno_nombre || 'el lote') + (fh === 'cerrado' ? ' no abre' : ' atiende ' + fh) + '. ¿Qué otro día u hora te acomoda?', 'cita3'); await aMario(t, c, '⚠️ ' + cu + ' cae fuera del horario de ' + c.dueno_nombre + ' (' + fh + '). Le pedí al comprador otra hora.'); return c; } }
    await guardar(c, { fase: 'espera_dueno', espera_desde: now });
    try { const chD = await U.chatPorId(c.dueno_chat_id); if (chD && VOZ.vozDe(chD) === 'humano') await VOZ.devolver({ tenant: t, chat: chD }); } catch (e) { }   // pregunta nueva al dueño = la máquina lee su respuesta
    // (agentes 2026-09-26) ya se presentó → versión corta (repetir la presentación cada vez suena a robot); con otra visita abierta del mismo dueño se dice "otro comprador";
    // "este es su número" era falso mientras el número de cada vendedor no esté vinculado: ahora "respóndeme aquí y le paso tu mensaje".
    const yaHablo = !!(await query("SELECT 1 FROM mensajes WHERE conversacion_id = ? AND direccion = 'out' AND emisor != 'sistema' LIMIT 1", [Number(c.dueno_chat_id)]).catch(() => []))[0];
    const otra = (await abiertasDueno(t.id, c.dueno_chat_id).catch(() => [])).some(x => Number(x.cita_id) !== Number(c.cita_id));
    const hola = 'Hola' + (N.D ? ' ' + N.D : '') + ', ' + saludo(now) + '. ';
    const cola = ' ¿Te quedaría bien? Con un "sí" lo dejo listo; si tienes alguna duda o prefieres otro horario, respóndeme aquí y se lo paso a ' + N.V + '. ¡Gracias!';
    const tx = cuAnt
        ? hola + (yaHablo ? '' : 'Soy Seb, el asistente de ' + N.V + ' de ' + N.marca + '. ') + 'La visita para ver tu ' + N.auto + ' que teníamos ' + cuAnt + ' se tendría que mover a ' + cu + '.' + cola
        : hola + (yaHablo ? '' : 'Soy Seb, el asistente de ' + N.V + ' de ' + N.marca + ', mucho gusto. ') + (otra ? 'Otro comprador' : 'Hay un comprador que') + (otra ? ' quiere' : ' quiere') + ' ver tu ' + N.auto + ' ' + cu + (otra ? ' (aparte de la visita que ya tenemos).' : '.') + cola;
    await mandarA(t, c.dueno_chat_id, tx, 'cita3_dueno');
    await aMario(t, c, 'Le escribí al dueño del ' + N.auto + ' para ' + cu + '. Si contesta algo distinto de "sí" o te marca, lo cierras con botón en su chat.', c.chat_id);
    return c;
}
async function acreditar(t, c) {
    const N = await nombres(t, c); const cu = await cuando(c); const movida = !!c.conf_ini; const now = await ahoraDe(c);
    await guardar(c, { estado: 'confirmada', fase: null, conf_ini: c.ini_ts, conf_fin: c.fin_ts, conf_precision: c.precision, conf_ts: now, dia_json: '{}', flags_json: '{}', antes_pausa: null });
    await bit(c, 'sistema', '', movida ? 'movida' : 'acreditada', 'alta', cu);
    try { const iso = new Date(Number(c.ini_ts) - 6 * H).toISOString(); await CITAF.vendedor({ tenant: t, chat: await U.chatPorId(c.chat_id), evento: 'agenda', datos: { dia_ini: iso.slice(0, 10), dia_fin: iso.slice(0, 10), hora_ini: c.precision === 'hora' ? iso.slice(11, 16) : '' }, auto: { id: c.auto_id, nombre: c.auto_nombre }, io: ioMudo() }); } catch (e) { }
    await mandarA(t, c.chat_id, movida ? '¡Listo' + N.n + '! Tu cita quedó movida a ' + cu + ' para ver el ' + N.auto + '. Te recibe ' + N.V + '. Te comparto la ubicación.' : '¡Listo' + N.n + '! Tu cita quedó confirmada: ' + cu + ' para ver el ' + N.auto + '. Te recibe ' + N.V + ' y ahí estará el dueño. Te comparto la ubicación.', 'cita3');
    await ubicacion(t, c);
    if (c.dueno_chat_id) await mandarA(t, c.dueno_chat_id, '¡Confirmado' + (N.D ? ' ' + N.D : '') + '! ' + cu.charAt(0).toUpperCase() + cu.slice(1) + ', ' + N.V + ' llega con el comprador a ver tu ' + N.auto + '. El día de la visita te aviso cuando vayan en camino. ¡Gracias!', 'cita3_dueno');
    await aMario(t, c, '✅ Cita ' + (movida ? 'movida y ' : '') + 'confirmada por las 3 partes · ' + N.auto + ' · ' + cu + '. El día de la cita no salgas hasta que el comprador diga que ya va; yo te aviso.');
    return c;
}
async function ubicacion(t, c) {
    let pe = (await query('SELECT image_b64, lat, lng, name, maps_link FROM punto_envio WHERE auto_id = ?', [Number(c.auto_id)]).catch(() => []))[0] || null;
    if (!pe && c.dueno_tipo === 'lote') { const tl = (await query("SELECT tt.config_json FROM autos_universo au JOIN tenants tt ON tt.id = au.tenant_id WHERE au.inv_auto_id = ? AND au.rol = 'dueno' AND au.activo = 1 AND tt.id <> ? LIMIT 1", [Number(c.auto_id), Number(t.id)]).catch(() => []))[0]; const cl = tl ? J(tl.config_json) : {}; if (cl.direccion || cl.zona) pe = { name: c.dueno_nombre + ' · ' + (cl.direccion || cl.zona) }; }
    if (!pe) { await aMario(t, c, '⚠️ El ' + (c.auto_nombre || 'auto') + ' no tiene ubicación en su ficha: mándasela tú al comprador.'); return; }
    try { await MSJ.enviar({ tenantId: Number(t.id), chatId: Number(c.chat_id), origen: 'sb', clave: 'cita3:pin:' + c.cita_id + ':' + c.gen + ':' + Date.now(), manual: false, accion: 'cita3', imagen: pe.image_b64 || null, imagen_ref: pe.image_b64 ? 'ubic-img' : null, location: pe.lat && pe.lng ? { lat: pe.lat, lng: pe.lng, name: pe.name, maps_link: pe.maps_link } : null, texto: pe.image_b64 || (pe.lat && pe.lng) ? undefined : (pe.name + (pe.maps_link ? ' ' + pe.maps_link : '')) }); } catch (e) { }
}
function ioMudo() { return { mandar: async () => '', pin: async () => { }, vendedor: async () => { }, sistema: async () => { }, catalogo: async () => [], ponerFoco: async () => { } }; }

/** El motor de citas aplicó un cuándo del COMPRADOR (antes de la primera confirmación). Solo arranca la ronda con hora concreta. */
async function propuestaComprador({ tenant: t, chat, citaId, nuevo }) {
    await asegurar(); const cf = (await query('SELECT * FROM citaf WHERE id = ?', [Number(citaId)]))[0]; if (!cf) return null;
    const c = await asegurarFila(t, chat.id, citaId); if (!c) return null;
    if (['confirmada', 'pausada', 'dia_d'].includes(c.estado)) return c;   // después de confirmada no se mueve sola: eso lo decide el interceptor (escala)
    const franjaCorta = cf.precision === 'franja' && Number(cf.fin_ts) - Number(cf.ini_ts) <= 2 * H;   // "a medio día" = las 12: es una hora, no un rango
    if (cf.precision !== 'hora' && !franjaCorta) {
        await bit(c, 'comprador', nuevo, 'ventana_sin_hora', 'alta', 'no arranca la ronda; se pide la hora');
        if (cf.precision === 'franja' && !/a qu[eé] hora/i.test(String(((await query("SELECT texto FROM mensajes WHERE conversacion_id = ? AND direccion = 'out' AND emisor != 'sistema' ORDER BY id DESC LIMIT 1", [Number(chat.id)]))[0] || {}).texto || ''))) { const N = await nombres(t, c); await mandarA(t, chat.id, '¿A qué hora exactamente te acomoda' + N.n + '? Así lo confirmo.', 'cita3'); }
        await aMario(t, c, 'El comprador quiere ver el ' + (c.auto_nombre || 'auto') + ' ' + await cuando(c, cf.ini_ts, cf.fin_ts, cf.precision) + ', sin hora exacta todavía. Ya le pedí la hora; te aviso cuando la dé.'); return c;
    }
    return proponer({ tenant: t, c, ini: Number(cf.ini_ts), fin: Number(cf.ini_ts), precision: 'hora', votos: { c: 1 }, por: 'comprador', nuevo });
}
// ── LECTURA DETERMINISTA DE LOS "SÍ" (texto normalizado: \b de JS no entiende acentos) ──
const RE_SI = /^\W*(si|claro|va|vale|de acuerdo|perfecto|confirmo|confirmado|ok(ey)?|dale|sale|listo|esta bien|ahi (los )?(espero|estare|estamos)|sin problema|por supuesto|orale|simon|correcto|asi es|en pie|sigue en pie|todo bien|con gusto)\b/;
const RE_NEG = /\b(no|pero|aunque|mejor|cambio|otra hora|otro dia|a las|como a|tarde|temprano|manana|hoy no|imposible|complic|ya no)\b/;
const esSiLimpio = tx => { const n = norm(tx); return n.length <= 60 && RE_SI.test(n) && !RE_NEG.test(n.replace(/^\W*si\b/, '')); };
// "SÍ" DE PERSONA REAL (agentes 2026-09-26: "Hola Seb, sí, el jueves a las 5 me queda bien 👍" pausaba y le pasaba el chat a Mario):
// saludo, emojis y repetir el cuándo NO lo ensucian; basta que TODO lo que mencione de día/hora coincida con lo propuesto y que no traiga un "no/pero/mejor/otra".
const RE_SI2 = /\b(si|sip|sii+|claro|va|vale|de acuerdo|perfecto|confirmo|confirmado|ok|okey|okay|dale|sale|listo|lista|esta bien|me queda bien|me queda perfecto|me acomoda|me parece bien|me late|ahi (los )?(espero|estare|nos vemos)|los espero|te espero|por supuesto|orale|simon|correcto|asi es|en pie|con gusto|adelante|excelente|de lujo|jalo|sinproblema)\b/;
const RE_NEG2 = /\b(no|pero|aunque|mejor|cambi\w*|otra|otro|imposible|complic\w*|ya no|mas tarde|mas temprano|en vez|solo puedo|nomas puedo|despues de las|antes de las|a ver si|creo)\b/;
const DN3 = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
function esSi(tx, c, now) {
    let n = norm(tx).replace(/[^\p{L}\p{N}:\s]/gu, ' ').replace(/\s+/g, ' ').trim(); if (!n || n.length > 160) return false;
    n = n.replace(/\b(no hay (problema|bronca|tema|pedo|falla|lio)|sin (problema|bronca|tema|falla))\b/g, ' sinproblema ');
    if (RE_NEG2.test(n) || !RE_SI2.test(n)) return false;
    if (c && c.ini_ts) {
        const d = new Date(Number(c.ini_ts) - 6 * 3600000); const h = d.getUTCHours(), mi = d.getUTCMinutes();
        for (const m of n.matchAll(/\b(?:a las|alas|las|a la)\s*(\d{1,2})(?::(\d{2}))?/g)) { if (!(Number(m[1]) % 12 === h % 12 && Number(m[2] || 0) === mi)) return false; }
        for (const w of (n.match(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/g) || [])) if (w !== DN3[d.getUTCDay()]) return false;
        if (now) { const y = ts => new Date(Number(ts) - 6 * 3600000).toISOString().slice(0, 10); const dC = y(c.ini_ts), hoy = y(now), man = y(Number(now) + 86400000);
            if (/\bhoy\b/.test(n) && dC !== hoy) return false; if (/\bmanana\b/.test(n.replace(/\b(de|en|por) la manana\b/g, '')) && dC !== man) return false; }
    }
    return true;
}

const RE_LISTO = /\b(ya estoy|aqui estoy|ya llegue|llegue|ya voy|voy saliendo|en camino|voy para alla|ahi estare|los espero|aqui los espero|listo|lista)\b/;
const RE_HUMANO = /\b(hablar con|comunicame|que me (marque|llame|hable)|pasame|quiero hablar)\b/;

/** Mensaje del DUEÑO (su canal). Solo el "sí" limpio se toma solo; todo lo demás: pausa + Mario. */
async function entranteDueno({ tenant: t, chat, texto }) {
    const abiertas = await abiertasDueno(t.id, chat.id); const c = abiertas[0]; if (!c) return { manejado: false };
    const tx = String(texto || ''); const n = norm(tx); const N = await nombres(t, c); const d = J(c.dia_json);
    const pausa = async (motivo) => {
        await bit(c, 'dueno', tx, 'no_script', null, 'pausa · ' + motivo);
        if (c.fase === 'espera_dueno') await guardar(c, { fase: 'pausa_dueno' });
        await mandarA(t, chat.id, 'Gracias' + (N.D ? ' ' + N.D : '') + ', ahorita te contesta ' + N.V + ' personalmente.', 'cita3_dueno');
        try { await VOZ.entregar({ tenant: t, chat, motivo: 'dueño: "' + tx.slice(0, 80) + '"', avisar: false }); } catch (e) { }
        await aMario(t, c, '👤 El dueño del ' + N.auto + ' escribió: "' + tx.slice(0, 140) + '". Contéstale tú (puedes hacerlo desde tu WhatsApp) y ciérralo con botón en su chat: Dueño confirmó · Nuevo horario · Ya no disponible' + (abiertas.length > 1 ? '. OJO: tiene ' + abiertas.length + ' citas abiertas, elige cuál.' : '.'), chat.id);
        return { manejado: true, evento: 'pausa', motivo };
    };
    if (abiertas.length > 1) return pausa('varias citas abiertas');
    if (RE_HUMANO.test(n)) return pausa('pide hablar con el vendedor');
    if ((c.fase === 'espera_dueno' || c.fase === 'pausa_dueno') && esSi(tx, c, await ahoraDe(c))) { /* pausa_dueno: si Mario ya le devolvió el chat a Seb, el "sí" limpio del dueño vale */ await bit(c, 'dueno', tx, 'confirma', 'alta', 'ok_dueno'); await guardar(c, { ok_dueno: 1 }); return (c.ok_comprador && c.ok_vendedor) ? (await acreditar(t, c), { manejado: true, evento: 'acreditada' }) : { manejado: true, evento: 'confirma_dueno' }; }
    if (['confirmada', 'dia_d'].includes(c.estado)) {
        if (c.pregunta_dueno === 'dia' && !d.ok_d && esSi(tx, c, await ahoraDe(c))) { await luces(c, { ok_d: await ahoraDe(c) }); await bit(c, 'dueno', tx, 'palomita', 'alta', 'dueño confirmó el día'); await mandarA(t, chat.id, '¡Gracias' + (N.D ? ' ' + N.D : '') + '! Te aviso cuando vayan en camino.', 'cita3_dueno'); await revisarListos(t, c); return { manejado: true, evento: 'palomita' }; }
        if (c.pregunta_dueno === 'listo' && !d.listo_d && (esSi(tx, c, await ahoraDe(c)) || RE_LISTO.test(n))) { await luces(c, { listo_d: await ahoraDe(c) }); await bit(c, 'dueno', tx, 'listo', 'alta', 'dueño listo'); await mandarA(t, chat.id, '¡Perfecto! En cuanto el comprador salga te aviso para que salgas tú también.', 'cita3_dueno'); await revisarLuzVerde(t, c); return { manejado: true, evento: 'listo' }; }
        if (d.sal_d && !d.llego_d && /\b(ya estoy|aqui estoy|ya llegue|llegue|aqui ando)\b/.test(n)) { await luzLlegada(t, c, 'd', tx); return { manejado: true, evento: 'llego' }; }
        if (c.pregunta_dueno === 'vispera' && esSi(tx, c, await ahoraDe(c))) { await bit(c, 'dueno', tx, 'vispera_ok', 'alta', null); await guardar(c, { pregunta_dueno: null }); return { manejado: true, evento: 'vispera_ok' }; }
    }
    return pausa('fuera del guion');
}
/** El COMPRADOR contesta a una sugerencia (antes o después de confirmada). Solo el "sí" limpio; otro cuándo lo lee el motor; lo demás, normal. */
async function entranteComprador({ tenant: t, chat, texto }) {
    const c = await porChat(t.id, chat.id); if (!c || c.fase !== 'espera_comprador') return { manejado: false };
    if (!esSi(texto, c, await ahoraDe(c))) {
        // (orden owner 2026-09-26, "pues tú dime qué horario" → le contestaron el horario del lote): con una propuesta esperando su respuesta,
        // solo 2 cosas NO escalan: un cuándo concreto (lo lee el motor → nueva ronda) o una duda comercial clara del auto (la contesta el cerebro).
        // Todo lo demás (dudar, "tú dime", "mm", "no", "no sé") es de Mario: se le entrega la voz y la propuesta sigue esperando.
        const n = norm(texto);
        const dia = /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo|hoy|manana|pasado manana|fin de semana)\b/.test(n), hora = /\b(a las|alas|a la una|medio ?dia|\d{1,2}\s*(am|pm)|\d{1,2}:\d{2}|en la (manana|tarde|noche)|temprano)\b/.test(n);
        if ((dia || hora) && !/\b(tu dime|dime tu|cuando (tu|ustedes) (digas|quieran|puedan)|la que (tu|ustedes)|cualquier)\b/.test(n)) return { manejado: false };
        if (/\?/.test(texto) && /\b(precio|cuanto (cuesta|esta|piden|sale)|credito|financ|enganche|mensualidad|km|kilometr|fotos?|ubicacion|donde (esta|queda)|factura|duenos|servicios|motor|transmision|garantia)\b/.test(n)) return { manejado: false };
        const relleno = /^\W*(m+h*|h?m+|e+h*|a+h*|jm+|mmm+|uhm+|pues|este)\W*$/.test(n);
        const N = await nombres(t, c);
        if (relleno) { await bit(c, 'comprador', texto, 'relleno_propuesta', null, 'aviso a ' + N.V); await aMario(t, c, 'El comprador contestó "' + String(texto).slice(0, 20) + '" a la propuesta de ' + await cuando(c) + '. Si no dice más, escríbele o márcale.'); return { manejado: true, evento: 'relleno' }; }
        await bit(c, 'comprador', texto, 'duda_propuesta', null, 'escala a ' + N.V);
        await mandarA(t, chat.id, 'Va' + N.n + ', ahorita te escribe ' + N.V + ' para cuadrar el horario.', 'cita3');
        try { await VOZ.entregar({ tenant: t, chat, motivo: 'comprador ante la propuesta: "' + String(texto).slice(0, 80) + '"', avisar: false }); } catch (e) { }
        await aMario(t, c, '👤 Le propuse al comprador ' + await cuando(c) + ' y contestó: "' + String(texto).slice(0, 140) + '". Contéstale tú; si quedan en otro horario pícale "Nuevo horario", o si dice que sí, "Devolver a Seb" y yo lo cierro.');
        return { manejado: true, evento: 'escala_propuesta' };
    }
    await bit(c, 'comprador', texto, 'acepta', 'alta', 'ok_comprador'); await guardar(c, { ok_comprador: 1 });
    if (c.ok_dueno) { await acreditar(t, c); return { manejado: true, evento: 'acreditada' }; }
    await pedirDueno(t, c, c.conf_ini ? await cuando(c, c.conf_ini, c.conf_fin, c.conf_precision) : null);
    const N = await nombres(t, c); await mandarA(t, chat.id, '¡Perfecto' + N.n + '! Lo confirmo con quien tiene el auto y te aviso por aquí.', 'cita3');
    return { manejado: true, evento: 'acepta' };
}
/** DESPUÉS DE CONFIRMADA (comprador): el lector del motor ya clasificó el mensaje; aquí solo el script, lo demás escala. null = que siga el cerebro. */
async function interceptar({ tenant: t, chat, ev, nuevo }) {
    const c = await porChat(t.id, chat.id); if (!c || !['confirmada', 'pausada', 'dia_d'].includes(c.estado)) return null;
    if (c.fase === 'espera_comprador') return null;
    const N = await nombres(t, c); const E = ev && ev.evento;
    if (E === 'no_es_de_cita') return null;   // herramientas y dudas básicas: las atiende el cerebro con su doctrina
    if (E === 'cortesia') return { manejado: true, silencio: true };
    if (c.estado !== 'pausada' && E === 'confirma' && esSi(nuevo, c, await ahoraDe(c))) {
        const d = J(c.dia_json); const now = await ahoraDe(c); const hoy = ymd(now) === ymd(c.ini_ts);
        if (hoy && !d.ok_c) { await luces(c, { ok_c: now }); await bit(c, 'comprador', nuevo, 'palomita', 'alta', 'comprador confirmó el día'); await mandarA(t, chat.id, '¡Gracias' + N.n + '! Recuerda esperar mi aviso para salir; te escribo en cuanto el dueño y ' + N.V + ' estén listos.', 'cita3'); await revisarListos(t, c); return { manejado: true, evento: 'palomita' }; }
        await bit(c, 'comprador', nuevo, 'confirma', 'alta', null); await mandarA(t, chat.id, '¡Perfecto' + N.n + ', gracias!', 'cita3'); return { manejado: true, evento: 'confirma' };
    }
    if (c.estado !== 'pausada' && E === 'ya_voy') { await luzComprador(t, c, nuevo); return { manejado: true, evento: 'ya_voy' }; }
    if (c.estado !== 'pausada' && E === 'ya_llegue') { await luzLlegada(t, c, 'c', nuevo); return { manejado: true, evento: 'ya_llegue' }; }
    return escalarComprador(t, c, chat, nuevo, E);
}
async function escalarComprador(t, c, chat, nuevo, E) {
    const N = await nombres(t, c);
    await bit(c, 'comprador', nuevo, 'no_script', null, 'escala · ' + (E || '?'));
    try { await VOZ.entregar({ tenant: t, chat, motivo: 'cita: "' + String(nuevo || '').slice(0, 80) + '"', avisar: false }); } catch (e) { }
    await aMario(t, c, '👤 ' + (N.C || 'El comprador') + ' escribió sobre la cita de ' + await cuando(c) + ': "' + String(nuevo || '').slice(0, 140) + '". Si es duda, contéstale y dale Devolver a Seb. Si mueve la cita: Nuevo horario · Pausar · Cancelar.');
    return { manejado: true, escalado: true, evento: 'escala' };
}

// ═══ BOTONES DE MARIO ═══
async function vendedor({ tenant: t, chat, evento, datos }) {
    datos = datos || {}; const desdeDueno = String(chat.canal || '') === 'dueno';
    let c = null;
    if (desdeDueno) { const ab = await abiertasDueno(t.id, chat.id); c = datos.cita_id ? ab.find(x => Number(x.cita_id) === Number(datos.cita_id)) : (ab.length === 1 ? ab[0] : null); if (!c && ab.length > 1) return { ok: false, error: 'Este dueño tiene ' + ab.length + ' citas abiertas: indica cuál (cita_id).', citas: ab.map(x => ({ cita_id: x.cita_id, auto: x.auto_nombre })) }; }
    else c = await porChat(t.id, chat.id);
    if (!c) return { ok: false, error: 'este chat no tiene cita de 3 partes abierta' };
    const now = await ahoraDe(c); const N = await nombres(t, c); const d = J(c.dia_json);
    const devolverVoz = async () => { try { const ch = await U.chatPorId(chat.id); if (ch && VOZ.vozDe(ch) === 'humano') await VOZ.devolver({ tenant: t, chat: ch }); } catch (e) { } };
    const ventana = () => { const v = CITAF.ventanaDe(t, { dia_ini: datos.dia_ini, dia_fin: datos.dia_ini, hora_ini: datos.hora_ini || '' }, now); if (!v.ok) return v; if (/^\d{1,2}:\d{2}$/.test(String(datos.hora_ini || ''))) { const [h, m] = datos.hora_ini.split(':').map(Number); v.ini = v.fin = at(datos.dia_ini, h, m); v.precision = 'hora'; } return v.precision === 'hora' ? v : { ok: false, motivo: 'falta la hora' }; };
    await bit(c, 'vendedor', 'botón', 'boton:' + evento, 'alta', desdeDueno ? 'desde chat del dueño' : 'desde chat del comprador');
    if (evento === 'confirmo') { if (c.fase !== 'espera_vendedor') return { ok: false, error: 'no hay un horario esperando tu confirmación' }; await guardar(c, { ok_vendedor: 1 }); await pedirDueno(t, c, c.conf_ini ? await cuando(c, c.conf_ini, c.conf_fin, c.conf_precision) : null); return { ok: true }; }
    if (evento === 'nuevo_horario' || evento === 'proponer') {
        const v = ventana(); if (!v.ok) return { ok: false, error: 'Pon día y hora válidos (' + v.motivo + ').' };
        const post = !!c.conf_ini; const razon = String(datos.razon || '');
        const votos = desdeDueno ? { v: 1, d: 1 } : ((!post || razon === 'vendedor') ? { v: 1 } : { v: 1, c: 1 });
        if (c.estado === 'pausada') await guardar(c, { estado: c.antes_pausa || 'confirmada', antes_pausa: null });
        await proponer({ tenant: t, c, ini: v.ini, fin: v.fin, precision: 'hora', votos, por: desdeDueno ? 'dueno' : 'vendedor', razon, nuevo: 'botón Nuevo horario' });
        await devolverVoz(); return { ok: true, gen: c.gen };
    }
    if (evento === 'comprador_acepto') {   // Mario lo cuadró él con el comprador (chat o llamada) y éste aceptó lo propuesto: mismo efecto que el "sí" del comprador
        if (c.fase !== 'espera_comprador') return { ok: false, error: 'no hay una propuesta esperando al comprador' };
        await guardar(c, { ok_comprador: 1 });
        if (c.ok_dueno) await acreditar(t, c); else await pedirDueno(t, c, c.conf_ini ? await cuando(c, c.conf_ini, c.conf_fin, c.conf_precision) : null);
        await devolverVoz(); return { ok: true, acreditada: c.estado === 'confirmada' };
    }
    if (evento === 'dueno_confirmo') { if (!['espera_dueno', 'pausa_dueno'].includes(c.fase)) return { ok: false, error: 'no hay un horario esperando al dueño' }; await guardar(c, { ok_dueno: 1 }); if (c.ok_comprador && c.ok_vendedor) await acreditar(t, c); else if (!c.ok_comprador) { await guardar(c, { fase: 'espera_comprador' }); } await devolverVoz(); return { ok: true, acreditada: c.estado === 'confirmada' && c.fase == null }; }
    if (evento === 'pausar') { if (c.estado === 'pausada') return { ok: false, error: 'ya está en pausa' }; await guardar(c, { antes_pausa: c.estado, estado: 'pausada' }); return { ok: true }; }
    if (evento === 'continuar') { if (c.estado !== 'pausada') return { ok: false, error: 'no está en pausa' }; if (!c.conf_ini || Number(c.conf_ini) <= now) return { ok: false, error: 'el horario confirmado ya pasó: usa Nuevo horario o Cancelar' }; await guardar(c, { estado: c.antes_pausa || 'confirmada', antes_pausa: null, ini_ts: c.conf_ini, fin_ts: c.conf_fin, precision: c.conf_precision, fase: null, ok_comprador: 1, ok_vendedor: 1, ok_dueno: 1 }); await devolverVoz(); return { ok: true }; }
    if (evento === 'cancelar' || evento === 'ya_no_disponible') {
        const razon = evento === 'ya_no_disponible' ? 'ya no disponible' : String(datos.razon || 'sin razón');
        const cuAnt = await cuando(c, c.conf_ini || c.ini_ts); await guardar(c, { estado: 'cancelada', fase: null, razon });
        try { await CITAF.vendedor({ tenant: t, chat: await U.chatPorId(c.chat_id), evento: 'descartar', razon, io: ioMudo() }); } catch (e) { }
        await mandarA(t, c.chat_id, evento === 'ya_no_disponible' ? (N.C ? N.C + ', ' : '') + 'lamentablemente el ' + N.auto + ' ya no está disponible. ' + N.V + ' te busca para mostrarte otras opciones.' : (N.C ? N.C + ', ' : '') + 'la visita ' + cuAnt + ' para ver el ' + N.auto + ' ya no se va a poder realizar. ' + N.V + ' se pone en contacto contigo.', 'cita3');
        if (c.dueno_chat_id && evento !== 'ya_no_disponible') await mandarA(t, c.dueno_chat_id, (N.D ? N.D + ', ' : '') + 'la visita ' + cuAnt + ' para ver tu ' + N.auto + ' se canceló. ¡Gracias por tu tiempo!', 'cita3_dueno');
        await devolverVoz(); return { ok: true };
    }
    // ── DÍA D (Mario también puede marcar por los otros cuando habló con ellos por teléfono) ──
    if (evento === 'palomear') { const q = datos.quien || 'vendedor'; const k = { comprador: 'ok_c', dueno: 'ok_d', vendedor: 'ok_v' }[q]; if (!k) return { ok: false, error: 'quien inválido' }; await luces(c, { [k]: now }); await revisarListos(t, c); return { ok: true }; }
    if (evento === 'listo') { const q = datos.quien || 'vendedor'; await luces(c, { [q === 'dueno' ? 'listo_d' : 'listo_v']: now }); await revisarLuzVerde(t, c); return { ok: true }; }
    if (evento === 'ya_va') { await luzComprador(t, c, 'Mario lo marcó', true); return { ok: true }; }
    if (evento === 'voy') { await luces(c, { sal_v: now }); if (d.voy_c) await mandarA(t, c.chat_id, N.V + ' ya va en camino para recibirte.', 'cita3'); return { ok: true }; }
    if (evento === 'llegue') { await luzLlegada(t, c, datos.quien === 'dueno' ? 'd' : (datos.quien === 'comprador' ? 'c' : 'v'), 'botón'); return { ok: true }; }
    if (evento === 'los_tres') { await luces(c, { los3: now }); await guardar(c, { estado: 'realizada', fase: null }); await bit(c, 'vendedor', '', 'los_tres', 'alta', 'realizada'); try { await CITAF.vendedor({ tenant: t, chat: await U.chatPorId(c.chat_id), evento: 'llego', io: ioMudo() }); } catch (e) { } await aMario(t, c, '✅ Ya están los 3 en la cita. De aquí en adelante la llevas tú.'); return { ok: true, estado: 'realizada' }; }
    if (evento === 'no_se_hizo') { await guardar(c, { estado: 'no_se_hizo', fase: null, razon: String(datos.razon || '') }); try { await CITAF.vendedor({ tenant: t, chat: await U.chatPorId(c.chat_id), evento: 'no_llego', razon: String(datos.razon || ''), io: ioMudo() }); } catch (e) { } return { ok: true }; }
    return { ok: false, error: 'evento desconocido' };
}

// ═══ DÍA D ═══
function tiemposDia(ini) { const dia = ymd(ini); const t1 = ini >= at(dia, 11, 0) ? at(dia, 9, 0) : ini - 2 * H; return { t1, t2: t1 + Math.max(30 * MIN, (ini - t1) / 4), t3: t1 + (ini - t1) / 2, tL: ini - 60 * MIN, vispera: at(masDias(dia, -1), 18, 0), vence: ini + 90 * MIN }; }
async function revisarListos(t, c) { const d = J(c.dia_json); if (!(d.ok_c && d.ok_d && d.ok_v)) return; if (!d.tres_ok) { await luces(c, { tres_ok: await ahoraDe(c) }); await aMario(t, c, '✅ Los 3 confirmaron la cita de hoy ' + hora(c.ini_ts) + '. Una hora antes coordino la salida.'); } if ((await ahoraDe(c)) >= tiemposDia(Number(c.ini_ts)).tL) await preguntarListos(t, c); }
async function preguntarListos(t, c) {
    if (tiene(c, 'listos')) return; await flag(c, 'listos'); const N = await nombres(t, c); await guardar(c, { estado: 'dia_d' });
    if (c.dueno_chat_id) { await guardar(c, { pregunta_dueno: 'listo' }); await mandarA(t, c.dueno_chat_id, (N.D ? N.D + ', ' : '') + 'el comprador está por salir. ¿Estás listo para recibirlo ' + hora(c.ini_ts) + ' en cuanto él me avise que va en camino? Con un "sí" me basta.', 'cita3_dueno'); }
    else await luces(c, { listo_d: await ahoraDe(c) });
    await aMario(t, c, 'Una hora para la cita: ¿listo para salir en cuanto ' + (N.C || 'el comprador') + ' avise que va? Pícale "Listo".');
}
async function revisarLuzVerde(t, c) { const d = J(c.dia_json); if (!(d.listo_v && d.listo_d) || d.verde) return; await luces(c, { verde: await ahoraDe(c) }); const N = await nombres(t, c); await bit(c, 'sistema', '', 'luz_verde', 'alta', null); await mandarA(t, c.chat_id, (N.C ? N.C + ', ' : '') + N.V + ' y el dueño ya están listos. En cuanto salgas, escríbeme "ya voy" y ellos salen también. ¡Te esperamos!', 'cita3'); await aMario(t, c, '🟢 Luz verde al comprador. En cuanto diga "ya voy", sales.'); }
async function luzComprador(t, c, texto, porMario) {
    const d = J(c.dia_json); const N = await nombres(t, c); const now = await ahoraDe(c);
    if (!d.verde && !porMario) { await bit(c, 'comprador', texto, 'ya_voy_antes', 'alta', 'contención'); await mandarA(t, c.chat_id, 'Espérame tantito' + N.n + ', en cuanto el dueño y ' + N.V + ' me confirmen que están listos te aviso para que salgas. Así llegan al mismo tiempo.', 'cita3'); await aMario(t, c, '⚠️ ' + (N.C || 'El comprador') + ' dice que ya va y todavía no hay luz verde (falta ' + [!d.ok_d || !d.listo_d ? 'el dueño' : null, !d.listo_v ? 'tu "Listo"' : null].filter(Boolean).join(' y ') + '). Decide tú: márcale al dueño o pídele que espere.'); return; }
    if (d.voy_c) return;
    await luces(c, { voy_c: now }); await bit(c, 'comprador', texto, 'ya_voy', 'alta', 'luz 1');
    if (!porMario) await mandarA(t, c.chat_id, '¡Perfecto' + N.n + '! Ya le aviso a ' + N.V + ' y al dueño. Buen camino.', 'cita3');
    await aMario(t, c, '🚗 ' + (N.C || 'El comprador') + ' ya salió. Sal ahora y pícale "Voy".');
}
async function luzLlegada(t, c, quien, texto) {
    const k = { c: 'llego_c', v: 'llego_v', d: 'llego_d' }[quien]; const d = J(c.dia_json); if (d[k]) return; await luces(c, { [k]: await ahoraDe(c) }); const N = await nombres(t, c);
    await bit(c, { c: 'comprador', v: 'vendedor', d: 'dueno' }[quien], texto, 'llego', 'alta', k);
    if (quien === 'c') { await aMario(t, c, '📍 ' + (N.C || 'El comprador') + ' ya llegó.'); if (c.dueno_chat_id) await mandarA(t, c.dueno_chat_id, 'El comprador ya llegó.', 'cita3_dueno'); }
    if (quien === 'v') { await mandarA(t, c.chat_id, N.V + ' ya está en el lugar.', 'cita3'); if (c.dueno_chat_id) await mandarA(t, c.dueno_chat_id, N.V + ' ya llegó.', 'cita3_dueno'); }
    if (quien === 'd') { await mandarA(t, c.chat_id, 'El dueño ya está en el lugar.', 'cita3'); await aMario(t, c, '📍 El dueño ya llegó.'); }
}

// ═══ EL RELOJ: función pura (cita, ahora) → lo que toca; tick lo ejecuta en orden, cada cosa con SU hora ═══
function pendientes(c) {
    const P = []; const add = (k, due) => { if (due && !J(c.flags_json)[k]) P.push({ k, due: Math.round(due) }); };
    const ini = Number(c.ini_ts), e = Number(c.espera_desde) || 0, g = c.gen; const d = J(c.dia_json);
    if (c.estado === 'ronda' || (['confirmada', 'dia_d'].includes(c.estado) && c.fase)) {
        if (c.fase === 'espera_vendedor') { add('rv30:' + g, e + 30 * MIN); add('rv2h:' + g, e + 2 * H); }
        if (c.fase === 'espera_dueno') { add('rd30:' + g, e + 30 * MIN); add('rd:' + g, limiteEspera(e)); }
        if (c.fase === 'espera_comprador') add('rc:' + g, siguiente930(e));
    }
    if (['confirmada', 'dia_d'].includes(c.estado) && !c.fase) {
        const T = tiemposDia(ini);
        if ((Number(c.conf_ts) || 0) < T.vispera - 30 * MIN) add('vispera', T.vispera);
        add('d1', T.t1); add('d2', T.t2); add('d3', T.t3); add('dL', T.tL);
        if (d.voy_c && !d.sal_d) add('dsal', Number(d.voy_c) + 5 * MIN);
        if (!d.los3) add('vence', T.vence);
    }
    return P.sort((a, b) => a.due - b.due);
}
function limiteEspera(desde) { const h = L(desde).getUTCHours(); if (h >= 20) return at(masDias(ymd(desde), 1), 9, 0); if (h < 8) return at(ymd(desde), 9, 0); return Number(desde) + 2 * H; }
function siguiente930(desde) { const hoy = at(ymd(desde), 9, 30); return desde < hoy - 3 * H ? hoy : at(masDias(ymd(desde), 1), 9, 30); }
async function ejecutar(t, c, k, nowEj) { TS_EJ = nowEj || null; try { return await ejecutar0(t, c, k); } finally { TS_EJ = null; } }
async function ejecutar0(t, c, k) {
    await flag(c, k); const N = await nombres(t, c); const d = J(c.dia_json); const [tipo] = k.split(':');
    const cu = await cuando(c);
    if (tipo === 'rv30') { await aMario(t, c, '⏳ Te falta confirmar la cita ' + cu + ' (' + N.auto + '). Confirma o propón otro horario.'); if (!tiene(c, 'sigo:' + c.gen)) { await flag(c, 'sigo:' + c.gen); await mandarA(t, c.chat_id, 'Sigo confirmándolo' + N.n + '; en cuanto quede te aviso por aquí.', 'cita3'); } return; }
    if (tipo === 'rv2h') { await aOwner(t, c, N.V + ' lleva 2 horas sin confirmar la cita ' + cu + ' (' + N.auto + ').'); return; }
    if (tipo === 'rd30') { if (!tiene(c, 'sigo:' + c.gen)) { await flag(c, 'sigo:' + c.gen); await mandarA(t, c.chat_id, 'Sigo confirmándolo con quien tiene el auto' + N.n + '; en cuanto quede te aviso.', 'cita3'); } return; }
    if (tipo === 'rd') { await guardar(c, { fase: 'pausa_dueno' }); await aMario(t, c, '⏰ El dueño del ' + N.auto + ' no ha contestado sobre ' + cu + '. Márcale y ciérralo con botón en su chat.', c.dueno_chat_id || c.chat_id); return; }
    if (tipo === 'rc') { await mandarA(t, c.chat_id, (N.C ? N.C + ', ' : '') + '¿te quedaría bien ' + cu + ' para ver el ' + N.auto + '? Si no, dime qué día y hora te acomoda.', 'cita3'); await aMario(t, c, 'Le recordé al comprador la propuesta ' + cu + '.'); return; }
    if (tipo === 'vispera' && ymd(await ahoraDe(c)) >= ymd(c.ini_ts)) return;   // ya es el día de la cita (se brincó la víspera): lo cubre el primer recordatorio del día, jamás "mañana" el mismo día
    if (tipo === 'vispera') { await mandarA(t, c.chat_id, 'Qué tal' + N.n + ', ' + saludo(await ahoraDe(c)) + '. Te recuerdo que mañana nos vemos ' + hora(c.ini_ts) + ' para ver el ' + N.auto + '. ¡Cualquier cosa aquí estoy!', 'cita3'); if (c.dueno_chat_id) { await guardar(c, { pregunta_dueno: 'vispera' }); await mandarA(t, c.dueno_chat_id, 'Hola ' + (N.D || '') + ', ' + saludo(await ahoraDe(c)) + '. Te recuerdo que mañana ' + hora(c.ini_ts) + ' van a ver tu ' + N.auto + '; te aviso cuando salgan. ¡Gracias!', 'cita3_dueno'); } await aMario(t, c, 'Mañana ' + hora(c.ini_ts) + ': ' + (N.C || 'comprador') + ' ve el ' + N.auto + '.'); return; }
    if (tipo === 'd1') {
        await guardar(c, { estado: 'dia_d' });
        if (!d.ok_c) await mandarA(t, c.chat_id, '¡Buen día' + N.n + '! Hoy nos vemos ' + hora(c.ini_ts) + ' para ver el ' + N.auto + ', ¿sigue en pie? Un detalle importante: antes de salir espera mi aviso; te escribo en cuanto el dueño y ' + N.V + ' estén listos para que lleguen al mismo tiempo.', 'cita3');
        if (c.dueno_chat_id && !d.ok_d) { await guardar(c, { pregunta_dueno: 'dia' }); await mandarA(t, c.dueno_chat_id, '¡Buen día' + (N.D ? ' ' + N.D : '') + '! Hoy ' + hora(c.ini_ts) + ' van a ver tu ' + N.auto + ', ¿sigue en pie? Con un "sí" me basta.', 'cita3_dueno'); } else if (!c.dueno_chat_id) await luces(c, { ok_d: await ahoraDe(c) });
        if (!d.ok_v) await aMario(t, c, 'Hoy ' + hora(c.ini_ts) + ': ' + (N.C || 'comprador') + ' ve el ' + N.auto + '. ¿Sigue en pie? Palomea tu confirmación.');
        return;
    }
    if (tipo === 'd2') { if (!d.ok_c) await mandarA(t, c.chat_id, '¿Seguimos en pie para hoy ' + hora(c.ini_ts) + N.n + '?', 'cita3'); if (c.dueno_chat_id && !d.ok_d) await mandarA(t, c.dueno_chat_id, '¿Seguimos en pie para hoy ' + hora(c.ini_ts) + (N.D ? ', ' + N.D : '') + '?', 'cita3_dueno'); if (!d.ok_v) await aMario(t, c, '¿Sigue en pie la cita de hoy ' + hora(c.ini_ts) + '? Palomea tu confirmación.'); return; }
    if (tipo === 'd3') {
        const faltan = []; if (!d.ok_c) faltan.push(N.C || 'el comprador'); if (!d.ok_d) faltan.push('el dueño');
        if (faltan.length) await aMario(t, c, '📞 ' + faltan.join(' y ') + ' no ha' + (faltan.length > 1 ? 'n' : '') + ' confirmado la cita de hoy (' + hora(c.ini_ts) + ') tras dos recordatorios. Márcale' + (faltan.length > 1 ? 's' : '') + '; si confirma, palomea "Confirmó".');
        if (!d.ok_v) { await aOwner(t, c, N.V + ' no ha confirmado la cita de hoy ' + hora(c.ini_ts) + ' (' + N.auto + '). Se pausa la operación.'); await guardar(c, { antes_pausa: c.estado, estado: 'pausada' }); }
        return;
    }
    if (tipo === 'dL') { if (d.ok_c && d.ok_d && d.ok_v) await preguntarListos(t, c); else await aMario(t, c, '⚠️ Falta una hora y no están las 3 confirmaciones (' + [!d.ok_c ? 'comprador' : null, !d.ok_d ? 'dueño' : null, !d.ok_v ? 'tú' : null].filter(Boolean).join(', ') + '). Nadie sale todavía: resuélvelo o mueve la cita.'); return; }
    if (tipo === 'dsal') { await luces(c, { sal_d: await ahoraDe(c) }); if (c.dueno_chat_id) await mandarA(t, c.dueno_chat_id, (N.D ? N.D + ', ' : '') + 'el comprador ya va en camino a ver tu ' + N.auto + '. ¡Ya puedes salir! Avísame cuando estés en el lugar.', 'cita3_dueno'); return; }
    if (tipo === 'vence') { await aMario(t, c, '⌛ Pasó la hora de la cita y no están los 3. Márcala como "No se hizo" o pon Nuevo horario.'); return; }
}
/** Ejecuta lo vencido. Con chatId solo esa cita (simulador); sin chatId, todas las abiertas de universos 3 partes (cron). hasta = hora destino. */
async function tick({ chatId, hasta } = {}) {
    await asegurar(); const out = [];
    const rows = chatId ? await query('SELECT * FROM cita3 WHERE chat_id = ? AND estado IN ' + ABIERTOS, [Number(chatId)]) : await query('SELECT * FROM cita3 WHERE estado IN ' + ABIERTOS);
    for (const c0 of rows) {
        const t = (await query('SELECT id, nombre, telefono, config_json FROM tenants WHERE id = ?', [c0.tenant_id]))[0]; if (!t) continue; t.config = J(t.config_json); if (!activo(t)) continue; t.demo = DEMO.esDemo(t);
        for (let i = 0; i < 12; i++) {
            const c = await porCita(c0.cita_id); if (!c || !['ronda', 'confirmada', 'dia_d'].includes(c.estado)) break;
            const now = hasta || await ahoraDe(c); const sig = pendientes(c).find(p => p.due <= now); if (!sig) break;
            await ejecutar(t, c, sig.k, hasta ? now : null); out.push({ cita: c.cita_id, k: sig.k, due: sig.due });
        }
    }
    await tickHora({ chatId, hasta, out });
    return out;
}
/** Visitas con solo ventana (sin hora): a las 9 am del día anterior se le vuelve a pedir la hora, una vez. */
async function tickHora({ chatId, hasta, out }) {
    const rows = await query("SELECT f.* FROM citaf f LEFT JOIN cita3_hora h ON h.cita_id = f.id WHERE h.cita_id IS NULL AND f.estado IN ('viva') AND f.precision IN ('dia','dias')" + (chatId ? ' AND f.chat_id = ?' : ''), chatId ? [Number(chatId)] : []).catch(() => []);
    for (const f of rows) {
        const t = (await query('SELECT id, nombre, telefono, config_json FROM tenants WHERE id = ?', [f.tenant_id]))[0]; if (!t) continue; t.config = J(t.config_json); if (!activo(t)) continue;
        const now = hasta || Date.now() + await CITAF.offsetDe(Number(f.chat_id)); const due = at(masDias(ymd(Number(f.ini_ts)), -1), 9, 0);
        if (now < due) continue;
        await run('INSERT OR IGNORE INTO cita3_hora (cita_id, ts) VALUES (?,?)', [Number(f.id), now]);
        const ch = await U.chatPorId(f.chat_id); const n = primer(ch && ch.nombre);
        await mandarA(t, f.chat_id, '¡Hola' + (n ? ' ' + n : '') + '! Para dejar lista tu visita a ver el ' + (f.auto_nombre || 'auto') + ' ' + CITAF._t.cuandoCorto(f, now) + ', ¿a qué hora te acomoda?', 'cita3');
        if (out) out.push({ cita: f.id, k: 'pide_hora', due });
    }
}
/** Lo próximo que va a pasar (para el botón "siguiente evento" del simulador). */
async function proximo(chatId) {
    const c = (await query('SELECT * FROM cita3 WHERE chat_id = ? AND estado IN ' + ABIERTOS + ' ORDER BY cita_id DESC LIMIT 1', [Number(chatId)]))[0];
    const now = Date.now() + await CITAF.offsetDe(Number(chatId)); const P = c && ['ronda', 'confirmada', 'dia_d'].includes(c.estado) ? pendientes(c).filter(p => p.due > now - 1000) : [];
    const f = (await query("SELECT f.* FROM citaf f LEFT JOIN cita3_hora h ON h.cita_id = f.id WHERE h.cita_id IS NULL AND f.estado = 'viva' AND f.precision IN ('dia','dias') AND f.chat_id = ?", [Number(chatId)]).catch(() => []))[0];
    if (f) P.push({ k: 'pide_hora', due: at(masDias(ymd(Number(f.ini_ts)), -1), 9, 0) });
    return P.sort((a, b) => a.due - b.due);
}
const K_TXT = { rv30: 'Recordatorio a Mario (y "sigo confirmando" al comprador)', rv2h: 'Aviso al owner: Mario no confirma', rd30: '"Sigo confirmando" al comprador', rd: 'Dueño sin respuesta: Mario le marca', rc: 'Recordatorio al comprador de la propuesta', vispera: 'Recordatorio de víspera (comprador y dueño)', d1: 'Día D: primer recordatorio a los 3', d2: 'Día D: segundo recordatorio', d3: 'Día D: Mario marca a quien falte', dL: 'Día D: ¿listos Mario y el dueño?', dsal: 'Día D: el dueño sale (5 min después)', vence: 'Pasó la hora: Mario decide', pide_hora: 'Pedirle la hora al comprador (día anterior 9 am)' };
async function estado(citaId) {
    const c = await porCita(citaId); if (!c) return null;
    const ev = await query('SELECT gen, ts, canal, texto, evento, accion FROM cita3_eventos WHERE cita_id = ? ORDER BY id', [Number(citaId)]);
    const d = J(c.dia_json); const now = await ahoraDe(c);
    const P = ['ronda', 'confirmada', 'dia_d'].includes(c.estado) ? pendientes(c).map(p => ({ k: p.k, que: K_TXT[p.k.split(':')[0]] || p.k, due: p.due, cuando: CITAF.fechaCorta(p.due) })) : [];
    const m = (a, b) => d[a] && d[b] ? Math.round((d[b] - d[a]) / MIN) : null;
    return { cita_id: c.cita_id, gen: c.gen, por: c.por, estado: c.estado, fase: c.fase, cuando: c.ini_ts ? await cuando(c) : null, ini_ts: c.ini_ts, confirmada: c.conf_ini ? await cuando(c, c.conf_ini, c.conf_fin, c.conf_precision) : null,
        ok: { comprador: !!c.ok_comprador, dueno: !!c.ok_dueno, vendedor: !!c.ok_vendedor }, dueno: { tipo: c.dueno_tipo, nombre: c.dueno_nombre, tel: c.dueno_tel, chat_id: c.dueno_chat_id, pregunta: c.pregunta_dueno }, vendedor: { id: c.vendedor_id, nombre: c.vendedor_nombre }, razon: c.razon,
        dia: d, ahora_ts: now, pendientes: P, eventos: ev,
        medicion: { confirmo_comprador_min: d.ok_c ? Math.round((d.ok_c - tiemposDia(Number(c.ini_ts)).t1) / MIN) : null, luz_verde_a_voy_min: m('verde', 'voy_c'), voy_a_llegada_comprador_min: m('voy_c', 'llego_c'), espera_dueno_en_sitio_min: m('llego_d', 'llego_c'), espera_mario_en_sitio_min: m('llego_v', 'llego_c'), rondas: c.gen } };
}
async function borrarDeCita(citaId) { await asegurar(); await run('DELETE FROM cita3_eventos WHERE cita_id = ?', [Number(citaId)]); await run('DELETE FROM cita3 WHERE cita_id = ?', [Number(citaId)]); await run('DELETE FROM cita3_hora WHERE cita_id = ?', [Number(citaId)]); }
module.exports = { activo, asegurar, propuestaComprador, entranteDueno, entranteComprador, interceptar, vendedor, tick, proximo, estado, porCita, porChat, porDuenoChat, abiertasDueno, borrarDeCita, duenoDe, esSiLimpio, esSi, K_TXT };
