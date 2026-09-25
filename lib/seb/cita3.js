'use strict';
/* CITA DE 3 PARTES (orden owner 2026-09-24) — solo universos con config.tres_partes (Autos Fyradrive; LAB para pruebas).
 * Comprador · Dueño del auto (particular o lote) · Vendedor Fyradrive (Mario). El motor de citas (citas-flex) sigue siendo el dueño
 * del CUÁNDO y de los recordatorios al comprador; esta capa es la dueña de la CONFIRMACIÓN:
 *   · UNA sola propuesta viva por generación (gen). Quien propone lo dice el CANAL por donde llegó, nunca la IA.
 *   · Tres casillas por generación: ok_comprador · ok_dueno · ok_vendedor. Propuesta nueva ⇒ gen+1 y las otras dos casillas a cero.
 *   · Cada parte se lee SOLO en su canal y SOLO contra la pregunta que tiene pendiente. Lo que no encaja no se interpreta: se escala al vendedor.
 *   · El vendedor confirma con BOTONES (FyraChat), no con texto libre.
 *   · Cita acreditada = las tres casillas en 1. Antes de eso al comprador solo se le dice "lo confirmo con quien tiene el auto".
 *   · DÍA D = semáforo de tres luces: comprador_voy → se pregunta al dueño y al vendedor; dueno_listo → se le dice al comprador;
 *     vendedor_voy; llegadas; "ya estamos los 3" (botón) cierra. El vendedor NO sale hasta el "voy" acreditado del comprador.
 *   · Mejor no captar una señal que captarla mal: sin claridad → escala. Todo queda en bitácora (canal, texto crudo, evento, acción). */
const { query, run } = require('./db.js');
const U = require('./universo.js');
const CITAF = require('./citas-flex.js');
const VOZ = require('./voz.js');
const MSJ = require('./mensajeria.js');
const DEMO = require('./demo.js');
const H = 3600000, MIN = 60000;
let _ok = false;
async function asegurar() {
    if (_ok) return; _ok = true;
    await run(`CREATE TABLE IF NOT EXISTS cita3 (cita_id INTEGER PRIMARY KEY, tenant_id INTEGER, chat_id INTEGER, auto_id INTEGER, auto_nombre TEXT, dueno_tel TEXT, dueno_nombre TEXT, dueno_chat_id INTEGER, dueno_tipo TEXT,
        vendedor_id INTEGER, vendedor_nombre TEXT, vendedor_tel TEXT, gen INTEGER DEFAULT 0, por TEXT, ini_ts INTEGER, fin_ts INTEGER, precision TEXT, ok_comprador INTEGER DEFAULT 0, ok_dueno INTEGER DEFAULT 0, ok_vendedor INTEGER DEFAULT 0,
        estado TEXT DEFAULT 'ronda', pregunta_dueno TEXT, pregunta_comprador TEXT, espera_desde INTEGER, dia_json TEXT, created INTEGER, updated INTEGER)`);
    await run('CREATE TABLE IF NOT EXISTS cita3_eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, cita_id INTEGER, gen INTEGER, ts INTEGER, canal TEXT, texto TEXT, evento TEXT, confianza TEXT, accion TEXT)');
    await run('CREATE INDEX IF NOT EXISTS ix_cita3_dueno ON cita3 (tenant_id, dueno_chat_id)').catch(() => { });
}
const activo = t => { let c = t && t.config; if (!c) { try { c = JSON.parse((t && t.config_json) || '{}'); } catch (e) { c = {}; } } return Number(c.tres_partes) === 1; };
const marcaCorta = t => String((t.config && t.config.marca) || t.nombre || '').replace(/\s+IA$/i, '').trim();
const primer = s => String(s || '').trim().split(/\s+/)[0] || '';
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
async function bit(c, canal, texto, evento, confianza, accion) { try { await run('INSERT INTO cita3_eventos (cita_id, gen, ts, canal, texto, evento, confianza, accion) VALUES (?,?,?,?,?,?,?,?)', [Number(c.cita_id), Number(c.gen) || 0, Date.now(), canal, String(texto || '').slice(0, 300), evento, confianza || null, accion || null]); } catch (e) { } }
async function porCita(citaId) { await asegurar(); return (await query('SELECT * FROM cita3 WHERE cita_id = ?', [Number(citaId)]))[0] || null; }
async function porDuenoChat(tenantId, chatId) { await asegurar(); return (await query("SELECT * FROM cita3 WHERE tenant_id = ? AND dueno_chat_id = ? AND estado IN ('ronda','confirmada','dia_d') ORDER BY cita_id DESC LIMIT 1", [Number(tenantId), Number(chatId)]))[0] || null; }
async function porChat(tenantId, chatId) { await asegurar(); return (await query("SELECT * FROM cita3 WHERE tenant_id = ? AND chat_id = ? AND estado IN ('ronda','confirmada','dia_d') ORDER BY cita_id DESC LIMIT 1", [Number(tenantId), Number(chatId)]))[0] || null; }
async function guardar(c, campos) { const k = Object.keys(campos); if (!k.length) return; await run('UPDATE cita3 SET ' + k.map(x => x + ' = ?').join(', ') + ', updated = ? WHERE cita_id = ?', [...k.map(x => campos[x]), Date.now(), Number(c.cita_id)]); Object.assign(c, campos); }
const cuando = c => CITAF.cuandoAviso({ ini_ts: c.ini_ts, fin_ts: c.fin_ts, precision: c.precision, estado: 'viva', datos_json: '{}' }, Date.now());

// ── CANALES ──
async function mandarA(t, chatId, texto, accion) { return MSJ.enviar({ tenantId: Number(t.id), chatId: Number(chatId), origen: 'sb', clave: 'cita3:' + Number(chatId) + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 6), manual: false, accion: accion || 'cita3', texto }); }
async function nota(t, chat, txt) { try { if (DEMO.esDemo(t)) await DEMO.sistema(t, String(chat.telefono), txt); else await run("INSERT OR IGNORE INTO mensajes (conversacion_id, msg_id, ts, direccion, emisor, texto, tipo, ai_generated, created_at) VALUES (?,?,?,?,?,?,?,?,?)", [Number(chat.id), 'cita3:' + Number(chat.id) + ':' + Date.now(), Date.now(), 'out', 'sistema', txt, 'sistema', 0, Date.now()]); } catch (e) { } }
/** El vendedor Fyradrive del chat (miembro dueño del chat; si no, el admin). */
async function vendedorDe(t, chat) {
    const row = (await query('SELECT miembro_id FROM conversaciones WHERE id = ?', [Number(chat.id)]))[0]; let m = null;
    if (row && row.miembro_id) m = (await query('SELECT id, nombre, telefono FROM vendedores_universo WHERE id = ? AND activo = 1', [Number(row.miembro_id)]))[0] || null;
    if (!m) m = (await query("SELECT id, nombre, telefono FROM vendedores_universo WHERE tenant_id = ? AND activo = 1 ORDER BY CASE WHEN rol = 'admin' THEN 0 ELSE 1 END, id LIMIT 1", [Number(t.id)]))[0] || null;
    return m ? { id: Number(m.id), nombre: m.nombre, telefono: m.telefono } : { id: null, nombre: marcaCorta(t) || 'el vendedor', telefono: t.telefono || null };
}
/** Aviso al vendedor: nota en el chat del comprador (FyraChat) + WhatsApp a su número (best effort). */
async function avisarVendedor(t, c, chat, txt) { await nota(t, chat, txt); try { if (c.vendedor_tel) await VOZ.avisarMiembro(t, { id: c.vendedor_id, nombre: c.vendedor_nombre, telefono: c.vendedor_tel }, txt); } catch (e) { } }
/** El dueño del auto: particular (dueno_telefono del inventario) o lote (tenant dueño del auto). */
async function duenoDe(t, autoInvId) {
    const inv = (await query('SELECT id, fyradrive_web_id, marca, modelo, anio, dueno_nombre, dueno_telefono FROM inventario_autos WHERE id = ? OR fyradrive_web_id = ? LIMIT 1', [Number(autoInvId), Number(autoInvId)]))[0]; if (!inv) return null;
    if (DEMO.esDemo(t)) return { tipo: 'particular', nombre: 'Dueño de prueba', telefono: '5210000000095', inv };   // MODO PRUEBA: jamás el dueño real; un dueño del carril de pruebas
    const lote = (await query("SELECT tt.id, tt.nombre, tt.telefono, tt.config_json FROM autos_universo au JOIN tenants tt ON tt.id = au.tenant_id WHERE au.inv_auto_id = ? AND au.rol = 'dueno' AND au.activo = 1 AND tt.id <> ? AND tt.activo = 1 LIMIT 1", [Number(inv.id), Number(t.id)]))[0];
    if (lote) { let cfg = {}; try { cfg = JSON.parse(lote.config_json || '{}'); } catch (e) { } if (cfg.usuario || cfg.tipo === 'lote') { let tel = lote.telefono; if (!tel) tel = (((await query("SELECT telefono FROM vendedores_universo WHERE tenant_id = ? AND activo = 1 ORDER BY CASE WHEN rol = 'admin' THEN 0 ELSE 1 END, id LIMIT 1", [Number(lote.id)]))[0]) || {}).telefono; return { tipo: 'lote', nombre: String(cfg.marca || lote.nombre).replace(/\s+IA$/i, ''), telefono: tel || null, inv, horario: cfg.horario || null, tenant_id: Number(lote.id) }; } }
    return { tipo: 'particular', nombre: inv.dueno_nombre || 'el dueño', telefono: inv.dueno_telefono || null, inv };
}
/** Chat del dueño dentro del universo (canal 'dueno', a nombre del vendedor, con delegación para que la puerta de mensajes lo deje salir). */
async function chatDueno(t, c, d) {
    let tel = String(d.telefono || '').replace(/\D/g, ''); if (tel.length === 10) tel = '521' + tel; if (DEMO.esDemo(t)) tel = DEMO.telComprador(tel || '0000000000');
    const ch = await U.chatDe(Number(t.id), tel, { crear: true, visible: true, nombre: (d.tipo === 'lote' ? '' : 'Dueño · ') + d.nombre + ' · ' + c.auto_nombre }); if (!ch) return null;
    await U.guardarEstado(Number(t.id), tel, { canal: 'dueno' }).catch(() => { });
    try { await run('UPDATE conversaciones SET miembro_id = COALESCE(miembro_id, ?) WHERE id = ?', [c.vendedor_id, Number(ch.id)]); } catch (e) { }
    try { const dl = await U.delegacionActiva(ch.id); if (!dl) await U.delegar(ch.id, { auto_id: d.inv.fyradrive_web_id || d.inv.id, auto_nombre: c.auto_nombre, activado_por: 'cita3' }); } catch (e) { }
    return Object.assign(ch, { telefono: tel });
}

/** HORARIO DEL LOTE DUEÑO (orden owner 2026-09-25: al lote solo se le verifica disponibilidad y hora cuadrada; sus datos vienen predeterminados).
 *  Devuelve null si la ventana cabe en su horario; si no, el texto del horario de ese día ('cerrado' o 'de 9 am a 7 pm'). */
function fueraHorarioLote(horario, ini_ts, fin_ts) {
    if (!horario || typeof horario !== 'object') return null;
    const d = L(ini_ts); const dow = String(d.getUTCDay()); const hr = horario[dow]; const hm = h => (h % 12 || 12) + (h < 12 ? ' am' : ' pm');
    if (!hr) return 'cerrado';
    const hIni = d.getUTCHours() + d.getUTCMinutes() / 60; const f = L(fin_ts); const hFin = f.getUTCHours() + f.getUTCMinutes() / 60 + (f.getUTCDate() !== d.getUTCDate() ? 24 : 0);
    if (hIni < Number(hr[0]) - 0.01 || hIni > Number(hr[1]) + 0.01) return 'de ' + hm(Number(hr[0])) + ' a ' + hm(Number(hr[1]));
    return null;
}
async function horarioLoteDe(c) { if (c.dueno_tipo !== 'lote' || !c.auto_id) return null; try { const tl = (await query("SELECT tt.config_json FROM autos_universo au JOIN tenants tt ON tt.id = au.tenant_id WHERE au.inv_auto_id = ? AND au.rol = 'dueno' AND au.activo = 1 AND tt.id <> ? LIMIT 1", [Number(c.auto_id), Number(c.tenant_id)]))[0]; const cl = tl ? JSON.parse(tl.config_json || '{}') : {}; return cl.horario || null; } catch (e) { return null; } }
// ── RONDA DE CONFIRMACIÓN ──
/** Nueva propuesta (por: comprador | dueno | vendedor). Sube la generación, deja en 1 la casilla de quien propone y pregunta a las otras dos. */
async function propuesta({ tenant: t, chat, citaId, por, ventana, nuevo }) {
    await asegurar(); const cf = (await query('SELECT * FROM citaf WHERE id = ?', [Number(citaId)]))[0]; if (!cf) return null;
    let c = await porCita(citaId);
    if (!c) {
        const v = await vendedorDe(t, chat); const d = cf.auto_id ? await duenoDe(t, cf.auto_id) : null;
        await run('INSERT OR IGNORE INTO cita3 (cita_id, tenant_id, chat_id, auto_id, auto_nombre, dueno_tel, dueno_nombre, dueno_tipo, vendedor_id, vendedor_nombre, vendedor_tel, gen, estado, dia_json, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)',
            [Number(citaId), Number(t.id), Number(chat.id), cf.auto_id, cf.auto_nombre, d ? d.telefono : null, d ? d.nombre : null, d ? d.tipo : null, v.id, v.nombre, v.telefono, 'ronda', '{}', Date.now(), Date.now()]);
        c = await porCita(citaId);
        if (d && d.telefono) { const chD = await chatDueno(t, c, d); if (chD) await guardar(c, { dueno_chat_id: Number(chD.id), dueno_tel: chD.telefono }); }
        else if (d) await bit(c, 'sistema', '', 'dueno_sin_telefono', null, 'escala');
    }
    const w = ventana || { ini: Number(cf.ini_ts), fin: Number(cf.fin_ts), precision: cf.precision };
    const gen = (Number(c.gen) || 0) + 1;
    await guardar(c, { gen, por, ini_ts: w.ini, fin_ts: w.fin, precision: w.precision, ok_comprador: por === 'comprador' ? 1 : 0, ok_dueno: por === 'dueno' ? 1 : 0, ok_vendedor: por === 'vendedor' ? 1 : 0, estado: 'ronda', pregunta_dueno: null, pregunta_comprador: null, espera_desde: Date.now() });
    await bit(c, por, nuevo, 'propuesta', 'alta', 'gen ' + gen + ' · ' + cuando(c));
    const V = primer(c.vendedor_nombre), auto = c.auto_nombre || 'el auto', cu = cuando(c);
    if (por !== 'dueno' && c.dueno_tipo === 'lote') {
        const fh = fueraHorarioLote(await horarioLoteDe(c), w.ini, w.fin);
        if (fh) {
            await bit(c, 'sistema', '', 'fuera_horario_lote', 'alta', fh);
            if (por === 'comprador') await mandarA(t, c.chat_id, 'Ese día ' + (c.dueno_nombre || 'el lote') + (fh === 'cerrado' ? ' no abre' : ' atiende ' + fh) + '. ¿Qué otro día u hora te acomoda?', 'cita3');
            await avisarVendedor(t, c, chat, '⚠️ La propuesta ' + cu + ' cae fuera del horario de ' + (c.dueno_nombre || 'el lote') + ' (' + fh + '). ' + (por === 'comprador' ? 'Le pedí al comprador otra hora.' : 'Propón otra hora.'));
            await guardar(c, { estado: 'ronda', pregunta_dueno: null, ok_comprador: 0 });
            return c;
        }
    }
    if (por !== 'dueno') await preguntarDueno(t, c, 'confirmar', 'Hola, soy Seb, asistente virtual de ' + V + ' (' + marcaCorta(t) + '). Un comprador quiere ver tu ' + auto + ' ' + cu + '. ¿Confirmas que puedes a esa hora? Si no, dime qué día y hora te queda.');
    if (por !== 'comprador') { await guardar(c, { pregunta_comprador: 'aceptar' }); await mandarA(t, c.chat_id, (por === 'dueno' ? 'Quien tiene el ' + auto : V) + ' puede ' + cu + '. ¿Te queda bien? Si no, dime qué día y hora te acomoda.', 'cita3'); }
    if (por !== 'vendedor') await avisarVendedor(t, c, chat, '🗓 Cita de 3 partes · ' + auto + ' · ' + cu + ' · propuso el ' + (por === 'comprador' ? 'comprador' : 'dueño') + '. Confirma en FyraChat › Cita (Confirmo / No puedo / Proponer otra).' + (c.dueno_tel ? '' : ' ⚠️ El auto no tiene teléfono del dueño: coordínalo tú.'));
    if (!c.dueno_tel) await guardar(c, { ok_dueno: 1 });   // sin dueño localizable: el vendedor responde por él (ya se le avisó)
    return c;
}
async function preguntarDueno(t, c, pregunta, texto) { if (!c.dueno_chat_id) return; await guardar(c, { pregunta_dueno: pregunta, espera_desde: Date.now() }); await mandarA(t, c.dueno_chat_id, texto, 'cita3_dueno'); }
/** Una casilla se confirma. Si las tres están en 1 → cita acreditada: se avisa a las tres partes y sale la ubicación. */
async function confirmar({ tenant: t, c, quien, texto }) {
    const campos = {}; campos['ok_' + quien] = 1; if (quien === 'dueno') campos.pregunta_dueno = null; if (quien === 'comprador') campos.pregunta_comprador = null;
    await guardar(c, campos); await bit(c, quien, texto, 'confirma', 'alta', 'ok_' + quien);
    if (!(c.ok_comprador && c.ok_dueno && c.ok_vendedor)) {
        const falta = ['comprador', 'dueno', 'vendedor'].filter(k => !c['ok_' + k]);
        if (quien !== 'comprador') { /* el comprador sigue esperando; no se le repite nada */ }
        return { acreditada: false, falta };
    }
    await guardar(c, { estado: 'confirmada' });
    const V = primer(c.vendedor_nombre), auto = c.auto_nombre || 'el auto', cu = cuando(c);
    const chat = { id: c.chat_id };
    try { await CITAF.vendedor({ tenant: t, chat: await U.chatPorId(c.chat_id), evento: 'agenda', datos: { dia_ini: ymdL(c.ini_ts), dia_fin: ymdL(c.fin_ts), hora_ini: c.precision === 'hora' ? hhmm(c.ini_ts) : '' }, auto: { id: c.auto_id, nombre: c.auto_nombre }, io: silencioIo(t, c) }); } catch (e) { }   // el motor de citas queda en la ventana acreditada (recordatorios) sin volver a hablarle al comprador
    await mandarA(t, c.chat_id, 'Listo, cita confirmada: ' + cu + ' para ver ' + auto + '. Te recibe ' + V + ' y ahí estará quien tiene el auto. Te mando la ubicación.', 'cita3');
    let pe = null; try { pe = (await query('SELECT image_b64, lat, lng, name, maps_link FROM punto_envio WHERE auto_id = ?', [Number(c.auto_id)]).catch(() => []))[0] || null; } catch (e) { }
    if (!pe && c.dueno_tipo === 'lote') { try { const tl = (await query("SELECT tt.config_json FROM autos_universo au JOIN tenants tt ON tt.id = au.tenant_id WHERE au.inv_auto_id = ? AND au.rol = 'dueno' AND au.activo = 1 AND tt.id <> ? LIMIT 1", [Number(c.auto_id), Number(t.id)]))[0]; const cl = tl ? JSON.parse(tl.config_json || '{}') : {}; if (cl.direccion || cl.zona) pe = { name: c.dueno_nombre + ' · ' + (cl.direccion || cl.zona), maps_link: cl.maps_link || null }; } catch (e) { } }   // lote: su dirección predeterminada
    if (!pe) await avisarVendedor(t, c, chat, '⚠️ El ' + auto + ' no tiene ubicación en su ficha: mándasela tú al comprador.');
    try { if (pe) await MSJ.enviar({ tenantId: Number(t.id), chatId: Number(c.chat_id), origen: 'sb', clave: 'cita3:pin:' + c.cita_id + ':' + c.gen, manual: false, accion: 'cita3', imagen: pe.image_b64 || null, imagen_ref: pe.image_b64 ? 'ubic-img' : null, location: pe.lat && pe.lng ? { lat: pe.lat, lng: pe.lng, name: pe.name, maps_link: pe.maps_link } : null, texto: pe.image_b64 || (pe.lat && pe.lng) ? undefined : (pe.name + (pe.maps_link ? ' ' + pe.maps_link : '')) }); } catch (e) { }
    if (c.dueno_chat_id) await mandarA(t, c.dueno_chat_id, 'Confirmado: ' + cu + ', ' + V + ' llega con el comprador a ver el ' + auto + '. Te aviso cuando vayan en camino.', 'cita3_dueno');
    await avisarVendedor(t, c, chat, '✅ Cita acreditada por las 3 partes · ' + auto + ' · ' + cu + '. El día de la cita no salgas hasta que el comprador diga que ya va; yo te aviso.');
    return { acreditada: true };
}
function silencioIo(t, c) { return { mandar: async () => '', pin: async () => { }, vendedor: async () => { }, sistema: async () => { }, catalogo: async () => [], ponerFoco: async () => { } }; }
const L = ts => new Date(Number(ts) - 6 * H); const ymdL = ts => L(ts).toISOString().slice(0, 10); const hhmm = ts => L(ts).toISOString().slice(11, 16);

// ── LECTURA DEL DUEÑO (solo contra su pregunta pendiente) ──
const RE_SI = /^\W*(s[ií]|claro|va|vale|de acuerdo|perfecto|confirmo|confirmado|ok(ey)?|dale|sale|listo|est[aá] bien|ah[ií] (los )?(espero|estar[eé])|sin problema|por supuesto|órale|orale|simon|simón)\b/i;
const RE_NO = /\b(no puedo|no se puede|no voy a poder|imposible|no me queda|no alcanzo|no estar[eé]|ese d[ií]a no|a esa hora no|no,? mejor)\b/i;
const RE_TIEMPO = /\b(hoy|ma[ñn]ana|pasado|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|a las? \d|\d ?(am|pm)|en la (ma[ñn]ana|tarde|noche)|medio ?d[ií]a|m[aá]s tarde|m[aá]s temprano|otro d[ií]a|otra hora)\b/i;
const RE_LISTO = /\b(ya estoy|aqu[ií] estoy|ya llegu[eé]|ya voy|voy saliendo|en camino|voy para all[aá]|ah[ií] estar[eé]|los espero|aqu[ií] los espero)\b/i;
const RE_HUMANO = /\b(hablar con|comunicame|comun[ií]came|que me (marque|llame|hable)|p[aá]same|quiero hablar)\b/i;
async function entranteDueno({ tenant: t, chat, texto }) {
    const c = await porDuenoChat(t.id, chat.id); if (!c) return { manejado: false };
    const tx = String(texto || ''); const tn = norm(tx); const V = primer(c.vendedor_nombre); const chatC = await U.chatPorId(c.chat_id);
    const escala = async (motivo) => { await bit(c, 'dueno', tx, 'no_claro', 'baja', 'escala:' + motivo); await mandarA(t, chat.id, 'Le paso tu mensaje a ' + V + ' para que te conteste directo.', 'cita3_dueno'); try { await VOZ.entregar({ tenant: t, chat, motivo: 'cita 3 partes · el dueño: "' + tx.slice(0, 80) + '"' }); } catch (e) { } await avisarVendedor(t, c, chatC, '👤 El dueño del ' + c.auto_nombre + ' escribió y no quedó claro: "' + tx.slice(0, 120) + '". Contéstale tú (puedes hacerlo en tu WhatsApp; al terminar, Devolver a Seb).'); return { manejado: true, evento: 'escala' }; };
    if (RE_HUMANO.test(tn)) return escala('pide humano');
    if (c.pregunta_dueno === 'confirmar') {
        if (RE_NO.test(tn) && !RE_TIEMPO.test(tn)) { await bit(c, 'dueno', tx, 'no_puede', 'alta', 'pregunta nueva fecha'); await guardar(c, { ok_dueno: 0 }); await mandarA(t, chat.id, 'Va. ¿Qué día y a qué hora sí te queda para que vean el ' + c.auto_nombre + '?', 'cita3_dueno'); await guardar(c, { pregunta_dueno: 'fecha', espera_desde: Date.now() }); await avisarVendedor(t, c, chatC, '⏳ El dueño del ' + c.auto_nombre + ' NO puede ' + cuando(c) + '. Le pregunté qué día sí.'); return { manejado: true, evento: 'no_puede' }; }
        if (RE_SI.test(tn) && !RE_TIEMPO.test(tn) && !RE_NO.test(tn)) { const r = await confirmar({ tenant: t, c, quien: 'dueno', texto: tx }); if (!r.acreditada) { await mandarA(t, chat.id, 'Perfecto, gracias. En cuanto ' + (r.falta.includes('vendedor') ? V + ' confirme' : 'el comprador confirme') + ' te aviso.', 'cita3_dueno'); await avisarVendedor(t, c, chatC, '✅ El dueño del ' + c.auto_nombre + ' confirmó ' + cuando(c) + '. Falta: ' + r.falta.join(' y ') + '.'); } return { manejado: true, evento: 'confirma' }; }
    }
    if ((c.pregunta_dueno === 'confirmar' || c.pregunta_dueno === 'fecha') && RE_TIEMPO.test(tn)) {
        // contrapropuesta: la ventana la extrae el lector del motor de citas (día/hora); si no sale una ventana clara → escala
        let ev = null; try { ev = await CITAF._t.leer({ t, c: null, now: Date.now(), historial: [], nuevo: tx, auto: { nombre: c.auto_nombre } }); } catch (e) { }
        const v = ev && ev.dia_ini ? CITAF.ventanaDe(t, ev, Date.now()) : { ok: false };
        if (!v.ok) return escala('contrapropuesta sin ventana clara');
        await bit(c, 'dueno', tx, 'contrapropone', ev.confianza || 'media', 'gen nueva');
        await propuesta({ tenant: t, chat: chatC, citaId: c.cita_id, por: 'dueno', ventana: { ini: v.ini, fin: v.fin, precision: v.precision }, nuevo: tx });
        await mandarA(t, chat.id, 'Va, le propongo ' + cuando(await porCita(c.cita_id)) + ' al comprador y a ' + V + ' y te confirmo.', 'cita3_dueno');
        return { manejado: true, evento: 'contrapropone' };
    }
    if (c.pregunta_dueno === 'dia_d') {
        if (RE_LISTO.test(tn) || (RE_SI.test(tn) && !RE_NO.test(tn))) { await luz({ tenant: t, c, luz: 'dueno_listo', texto: tx }); await mandarA(t, chat.id, 'Perfecto, le aviso al comprador que ya lo esperas.', 'cita3_dueno'); return { manejado: true, evento: 'dueno_listo' }; }
        return escala('día D: respuesta del dueño no clara');
    }
    return escala('sin pregunta pendiente');
}
// ── EL COMPRADOR, cuando la ronda espera SU respuesta (contrapropuesta del dueño o del vendedor) ──
async function entranteComprador({ tenant: t, chat, texto }) {
    const c = await porChat(t.id, chat.id); if (!c || c.estado !== 'ronda' || c.pregunta_comprador !== 'aceptar') return { manejado: false };
    const tx = String(texto || ''); const tn = norm(tx); const V = primer(c.vendedor_nombre);
    if (RE_SI.test(tn) && !RE_TIEMPO.test(tn) && !RE_NO.test(tn)) { const r = await confirmar({ tenant: t, c, quien: 'comprador', texto: tx }); if (!r.acreditada) await mandarA(t, chat.id, 'Va, en cuanto ' + (r.falta.includes('vendedor') ? V : 'quien tiene el auto') + ' me confirme te aviso.', 'cita3'); return { manejado: true, evento: 'confirma' }; }
    if (RE_TIEMPO.test(tn)) return { manejado: false };   // propone otra cosa: el motor de citas la lee y vuelve a entrar como propuesta del comprador (gen nueva)
    if (RE_NO.test(tn)) { await bit(c, 'comprador', tx, 'no_puede', 'alta', 'pregunta nueva fecha'); await mandarA(t, chat.id, 'Va, ¿qué día y a qué hora te acomoda?', 'cita3'); return { manejado: true, evento: 'no_puede' }; }
    return { manejado: false };
}
// ── VENDEDOR (botones de FyraChat) ──
async function vendedor({ tenant: t, chat, evento, datos, texto }) {
    const c = await porChat(t.id, chat.id); if (!c) return { ok: false, error: 'este chat no tiene cita de 3 partes' };
    if (evento === 'confirmo') { const r = await confirmar({ tenant: t, c, quien: 'vendedor', texto: 'botón' }); return { ok: true, acreditada: r.acreditada, falta: r.falta || [] }; }
    if (evento === 'no_puedo' || evento === 'propongo') {
        if (evento === 'no_puedo' && !(datos && datos.dia_ini)) { await guardar(c, { ok_vendedor: 0 }); await bit(c, 'vendedor', '', 'no_puede', 'alta', 'espera propuesta del vendedor'); return { ok: true, espera: 'propuesta' }; }
        const v = CITAF.ventanaDe(t, datos || {}, Date.now()); if (!v.ok) return { ok: false, error: 'no se puede agendar: ' + v.motivo };
        if (datos && /^\d{1,2}:\d{2}$/.test(String(datos.hora_ini || '')) && v.precision === 'dia') { const [h, m] = datos.hora_ini.split(':').map(Number); v.ini = v.fin = CITAF._t.at(datos.dia_ini, h, m); v.precision = 'hora'; }
        await propuesta({ tenant: t, chat, citaId: c.cita_id, por: 'vendedor', ventana: { ini: v.ini, fin: v.fin, precision: v.precision }, nuevo: 'botón proponer' }); return { ok: true, gen: (await porCita(c.cita_id)).gen };
    }
    if (evento === 'voy') { await luz({ tenant: t, c, luz: 'vendedor_voy', texto: 'botón' }); return { ok: true }; }
    if (evento === 'llegue') { await luz({ tenant: t, c, luz: 'vendedor_llego', texto: 'botón' }); return { ok: true }; }
    if (evento === 'los_tres') { await luz({ tenant: t, c, luz: 'los_tres', texto: 'botón' }); try { await CITAF.vendedor({ tenant: t, chat, evento: 'llego', io: silencioIo(t, c) }); } catch (e) { } return { ok: true, estado: 'realizada' }; }
    return { ok: false, error: 'evento desconocido' };
}
// ── DÍA D: tres luces ──
async function luz({ tenant: t, c, luz: k, texto }) {
    const d = JSON.parse(c.dia_json || '{}'); d[k] = Date.now(); await guardar(c, { dia_json: JSON.stringify(d), estado: k === 'los_tres' ? 'realizada' : 'dia_d' }); await bit(c, k.startsWith('dueno') ? 'dueno' : (k.startsWith('vendedor') || k === 'los_tres' ? 'vendedor' : 'comprador'), texto, k, 'alta', 'luz');
    const V = primer(c.vendedor_nombre), auto = c.auto_nombre || 'el auto'; const chatC = await U.chatPorId(c.chat_id);
    if (k === 'comprador_voy') {
        if (c.dueno_chat_id) await preguntarDueno(t, c, 'dia_d', 'El comprador ya va en camino a ver el ' + auto + '. ¿Ya estás ahí o vas para allá? Contéstame "ya estoy" o "voy saliendo".');
        await avisarVendedor(t, c, chatC, '🚗 El comprador YA VA en camino (' + auto + '). ' + (c.dueno_chat_id ? 'Le pregunté al dueño si ya está; en cuanto diga te aviso. ' : '') + 'Cuando salgas, pícale "Voy" en FyraChat › Cita.');
    }
    if (k === 'dueno_listo') { await mandarA(t, c.chat_id, 'Quien tiene el ' + auto + ' ya te espera' + (d.vendedor_voy ? ' y ' + V + ' ya va en camino' : '') + '.', 'cita3'); await avisarVendedor(t, c, chatC, '🟢 El dueño del ' + auto + ' ya está listo/en camino. ' + (d.vendedor_voy ? '' : 'Puedes salir: pícale "Voy".')); }
    if (k === 'vendedor_voy') { await mandarA(t, c.chat_id, V + ' ya va en camino para recibirte' + (d.dueno_listo ? '' : '; en cuanto quien tiene el auto me diga que está ahí te aviso') + '.', 'cita3'); if (c.dueno_chat_id) await mandarA(t, c.dueno_chat_id, V + ' ya va en camino con el comprador.', 'cita3_dueno'); }
    if (k === 'comprador_llego') { await avisarVendedor(t, c, chatC, '📍 El comprador ya llegó (' + auto + ').'); if (c.dueno_chat_id) await mandarA(t, c.dueno_chat_id, 'El comprador ya llegó al ' + auto + '.', 'cita3_dueno'); }
    if (k === 'los_tres') { await avisarVendedor(t, c, chatC, '✅ Ya están los 3 en la cita. De aquí en adelante la llevas tú.'); }
}
// ── EL RELOJ: tiempo de espera del dueño (2 h de día; si es de noche, a la mañana siguiente) → escala al vendedor ──
function limiteEspera(desde) { const h = L(desde).getUTCHours(); if (h >= 20 || h < 8) { const d = L(desde); const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (h >= 20 ? 1 : 0), 9 + 6, 30)); return m.getTime(); } return Number(desde) + 2 * H; }
async function tick({ now } = {}) {
    await asegurar(); const t0 = now || Date.now(); const out = [];
    const rows = await query("SELECT * FROM cita3 WHERE estado = 'ronda' AND pregunta_dueno IN ('confirmar','fecha') AND espera_desde IS NOT NULL");
    for (const c of rows) {
        if (t0 < limiteEspera(c.espera_desde)) continue;
        const t = (await query('SELECT id, nombre, telefono, config_json FROM tenants WHERE id = ?', [c.tenant_id]))[0]; if (!t) continue; try { t.config = JSON.parse(t.config_json || '{}'); } catch (e) { t.config = {}; }
        const chatC = await U.chatPorId(c.chat_id); await guardar(c, { pregunta_dueno: null, espera_desde: null });
        await bit(c, 'sistema', '', 'dueno_sin_respuesta', null, 'escala al vendedor');
        await avisarVendedor(t, c, chatC, '⏰ El dueño del ' + c.auto_nombre + ' no ha contestado sobre la cita ' + cuando(c) + '. Háblale tú' + (c.dueno_tel ? ' (+' + c.dueno_tel + ')' : '') + ' y confirma en FyraChat › Cita, o propón otro horario.');
        if (c.dueno_chat_id) { try { const chD = await U.chatPorId(c.dueno_chat_id); if (chD) await VOZ.entregar({ tenant: t, chat: chD, motivo: 'dueño sin respuesta ' + cuando(c), avisar: false }); } catch (e) { } }
        out.push({ cita: c.cita_id, accion: 'escalada_dueno_sin_respuesta' });
    }
    return out;
}
async function estado(citaId) { const c = await porCita(citaId); if (!c) return null; const ev = await query('SELECT gen, ts, canal, texto, evento, accion FROM cita3_eventos WHERE cita_id = ? ORDER BY id', [Number(citaId)]); return { gen: c.gen, por: c.por, estado: c.estado, cuando: c.ini_ts ? cuando(c) : null, ok: { comprador: !!c.ok_comprador, dueno: !!c.ok_dueno, vendedor: !!c.ok_vendedor }, dueno: { tipo: c.dueno_tipo, nombre: c.dueno_nombre, tel: c.dueno_tel, chat_id: c.dueno_chat_id, pregunta: c.pregunta_dueno }, vendedor: { id: c.vendedor_id, nombre: c.vendedor_nombre }, espera_comprador: c.pregunta_comprador, dia: JSON.parse(c.dia_json || '{}'), eventos: ev }; }
async function borrarDeCita(citaId) { await asegurar(); await run('DELETE FROM cita3_eventos WHERE cita_id = ?', [Number(citaId)]); await run('DELETE FROM cita3 WHERE cita_id = ?', [Number(citaId)]); }
module.exports = { activo, asegurar, propuesta, confirmar, entranteDueno, entranteComprador, vendedor, luz, tick, estado, porCita, porChat, porDuenoChat, borrarDeCita, duenoDe };
