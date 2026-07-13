// lib/seb/citas-vivas.js
// EL CICLO DE VIDA DE LA CITA — UN SOLO CEREBRO para el sandbox y para WhatsApp REAL
// (orden owner 2026-07-10: "que sea idéntico todo, siempre a la par").
//
// Piezas PURAS (compartidas — el sandbox las importa, producción también):
//   resolverCitaTs · planRecordatorios (con los TEXTOS de los recordatorios) ·
//   clasificarVendedor · clasificarCancelacion · MSJ (todos los textos del ciclo)
//
// Piezas de PRODUCCIÓN (WhatsApp real, tabla citas_match, bridge del VPS):
//   registrarSolicitud · manejarMensajeDueno · manejarMensajeComprador ·
//   senalManual · tickRecordatorios (cron) · enviarWA
//
// Flujo real:  cita-extractor solicita al dueño → registrarSolicitud
//   dueño contesta por WA → manejarMensajeDueno (IA: afirma|negativo|propone|no_puede)
//   afirma → MATCH: confianza al comprador + plan de recordatorios
//   cron (VPS, cada 10 min) → tickRecordatorios manda los que ya tocan
//   comprador en match → manejarMensajeComprador (cancela / ya voy en camino)
//   owner escribe "cita confirmada" al dueño (le confirmaron por teléfono) → senalManual

const { query, run } = require('./db.js');

const MTY_OFF = 6 * 3600000;                       // Monterrey = UTC-6
const sh = ts => new Date(ts - MTY_OFF);
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const DIAS_SEM = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };

function parseHora(hora) {
    const m = String(hora || '').toLowerCase().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (!m) return null;
    let h = Number(m[1]); const min = Number(m[2] || 0); const suf = m[3];
    if (suf === 'pm' && h < 12) h += 12;
    else if (suf === 'am' && h === 12) h = 0;
    else if (!suf && h >= 1 && h <= 6) h += 12;    // "a las 4" = 4pm (heurística de Seb)
    return { h, min };
}
function resolverCitaTs(fecha, hora) {
    const hm = parseHora(hora); if (!hm) return null;
    const f = norm(fecha);
    const now = sh(Date.now());
    let y = now.getUTCFullYear(), mo = now.getUTCMonth(), d = now.getUTCDate();
    if (/pasado ?manana/.test(f)) d += 2;
    else if (/manana/.test(f)) d += 1;
    else if (/hoy|ahorita/.test(f)) { /* hoy */ }
    else if (DIAS_SEM[f.replace(/^el /, '')] != null) {
        const target = DIAS_SEM[f.replace(/^el /, '')];
        let delta = (target - now.getUTCDay() + 7) % 7; if (delta === 0) delta = 7;
        d += delta;
    } else {
        const mn = f.match(/el (\d{1,2})/);
        if (mn) { const dd = Number(mn[1]); if (dd >= now.getUTCDate()) d = dd; else { mo += 1; d = dd; } }
        else return null;
    }
    return Date.UTC(y, mo, d, hm.h, hm.min) + MTY_OFF;
}
function mismaHora(a, b) {
    const pa = parseHora(a), pb = parseHora(b);
    return !!(pa && pb && pa.h === pb.h && pa.min === pb.min);
}
function mismaFecha(a, b) {
    const n = s => norm(s).replace(/^el /, '').trim();
    return n(a) === n(b) && n(a) !== '';
}
const art = f => /^(hoy|manana|mañana|pasado)/i.test(String(f)) ? '' : 'el ';

// ══════════ TODOS LOS TEXTOS DEL CICLO (fuente única — sandbox y real) ══════════
const MSJ = {
    confianza: c => `Listo ${c.nombre}, el dueño particular ya confirmó ✅ Ahí nos vemos ${art(c.fecha)}${c.fecha} a las ${c.hora} — te atendemos nosotros junto con el dueño 👍`,
    graciasAfirma: c => [`Perfecto, muchas gracias ${c.dueno} 👍`, 'Quedamos en firme, ahí estaremos con el comprador'],
    pideHorario: () => ['Entendido, sin tema', 'Qué día y horario te acomoda mejor? Y yo lo amarro con el comprador'],
    faltaHora: f => [`Va, ${f} entonces`, 'A qué hora te acomoda? Y así lo amarro en firme con el comprador'],
    proponeVendedor: () => ['Va, déjame lo checo con el comprador y aquí te confirmo 👍'],
    proponeComprador: (c, nf, nh) => [
        `Oye ${c.nombre}, me comenta el dueño que se le acomoda mejor ${art(nf)}${nf} a las ${nh}`,
        `Te agendo en firme: ${String(nf).charAt(0).toUpperCase()}${String(nf).slice(1)} a las ${nh}, va?`
    ],
    negativoVendedor: () => ['Entendido, gracias por avisarme 👍'],
    negativoComprador: c => [
        `Oye ${c.nombre}, una disculpa — me avisa el dueño que se complicó para ${art(c.fecha)}${c.fecha} a las ${c.hora}`,
        'Te acomodo otro día u horario? Tú dime y lo dejamos en firme'
    ],
    matchDirectoVendedor: c => `Listo ${c.dueno}, el comprador confirmó — quedamos ${art(c.fecha)}${c.fecha} a las ${c.hora} ✅`,
    acuseEnCamino: () => 'Va, aquí te esperamos 👍',
    acreditacionVendedor: c => `${c.dueno}, listo — el comprador ya va en camino 👍 Puedes ir preparando el ${c.auto}`,
    canceladaComprador: () => ['Va, sin tema — cita cancelada ❌', 'Cualquier cosa aquí ando para reagendarte cuando gustes 👍'],
    canceladaVendedor: c => `Qué tal ${c.dueno}, una disculpa — el comprador canceló la cita de ${art(c.fecha)}${c.fecha} a las ${c.hora}. Yo te aviso si se reagenda 👍`,
    canceladaPorVendedorComprador: c => [
        `Oye ${c.nombre}, una disculpa — surgió un imprevisto con el auto para ${art(c.fecha)}${c.fecha} a las ${c.hora}`,
        'Te acomodo otro día u horario? Tú dime y lo dejamos en firme'
    ]
};

// ══════════ EL PLAN DE RECORDATORIOS (proporcional; solo comprador + espera del dueño) ══════════
function planRecordatorios(match_ts, cita_ts, ctx) {
    const R = [];
    const add = (k, ts, para, texto) => { if (ts > match_ts + 60000 && ts < cita_ts + 1) R.push({ k, ts, para, texto, enviado: 0 }); };
    const c = sh(cita_ts), m = sh(match_ts);
    const mismoDia = c.getUTCFullYear() === m.getUTCFullYear() && c.getUTCMonth() === m.getUTCMonth() && c.getUTCDate() === m.getUTCDate();
    const gap = cita_ts - match_ts;
    if (!mismoDia) {
        add('vispera', Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate() - 1, 20, 0) + MTY_OFF, 'comprador',
            `Qué tal ${ctx.nombre}, buenas noches. Te recuerdo tu cita de mañana a las ${ctx.hora} para el ${ctx.auto}. Seguimos en pie?`);
        const diaD = Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate(), 9, 30) + MTY_OFF;
        if (diaD < cita_ts - 75 * 60000) {
            add('dia_comprador', diaD, 'comprador', `Buen día ${ctx.nombre}. Hoy nos vemos a las ${ctx.hora} para el ${ctx.auto}. Aquí ando pendiente 👍`);
            add('dia_vendedor_espera', diaD + 120000, 'vendedor', `Qué tal ${ctx.dueno}, hoy es la cita de tu ${ctx.auto} a las ${ctx.hora}. De favor no hagas movimiento todavía — yo te aviso en cuanto el comprador me acredite que ya va en camino 👍`);
        }
        add('1h_antes', cita_ts - 3600000, 'comprador', `${ctx.nombre}, te esperamos en una hora para ver el ${ctx.auto}. De favor, me avisas en cuanto vayas en camino? Así ya te estamos esperando listos 👍`);
        add('en_camino', cita_ts - 1800000, 'comprador', `${ctx.nombre}, ya casi es la hora — vienes en camino? Aquí te esperamos 👍`);
    } else {
        if (gap > 2.5 * 3600000) {
            add('confirmacion_hoy', match_ts + Math.round(gap / 2), 'comprador', `Todo listo para hoy a las ${ctx.hora}, ${ctx.nombre}. Aquí ando pendiente 👍`);
            add('dia_vendedor_espera', match_ts + Math.round(gap / 2) + 120000, 'vendedor', `Qué tal ${ctx.dueno}, hoy es la cita de tu ${ctx.auto} a las ${ctx.hora}. De favor no hagas movimiento todavía — yo te aviso en cuanto el comprador me acredite que ya va en camino 👍`);
        }
        if (gap > 75 * 60000) {
            add('1h_antes', cita_ts - 3600000, 'comprador', `${ctx.nombre}, te esperamos en una hora para ver el ${ctx.auto}. De favor, me avisas en cuanto vayas en camino? Así ya te estamos esperando listos 👍`);
            add('en_camino', cita_ts - 1800000, 'comprador', `${ctx.nombre}, ya casi es la hora — vienes en camino? Aquí te esperamos 👍`);
        }
        else if (gap > 40 * 60000) add('ya_casi', match_ts + Math.round(gap / 2), 'comprador', `${ctx.nombre}, ya casi nos vemos — a las ${ctx.hora} para el ${ctx.auto}. Aquí ando pendiente 👍`);
    }
    return R.sort((a, b) => a.ts - b.ts);
}

// ══════════ IA: interpretar al VENDEDOR (afirma | negativo | propone_hora | no_puede_hora) ══════════
async function clasificarVendedor(texto, cita) {
    const fb = (() => {
        const t = norm(texto);
        const mh = t.match(/a las (\d{1,2}(:\d{2})?\s?(am|pm)?)/);
        const mf = t.match(/\b(hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
        if (/(ya se vendio|se vendio|no disponible|ya no (esta|lo tengo)|no lo tengo|lo aparte|cancel|ya no quiero)/.test(t)) return { accion: 'negativo', fecha: null, hora: null };
        if (/(mejor|otro dia|otra hora|puedo (a las|el)|que sea (a las|el)|cambia|se puede (a las|el)|hasta las|despues de)/.test(t) && (mh || mf)) {
            return { accion: 'propone_hora', fecha: mf ? mf[1] : null, hora: mh ? mh[1] : null };
        }
        if (/(no (puedo|voy|va|estoy|estare|alcanzo|me queda|se va a poder)|imposible|complicado|dificil)/.test(t)) {
            return (mh || mf) ? { accion: 'propone_hora', fecha: mf ? mf[1] : null, hora: mh ? mh[1] : null } : { accion: 'no_puede_hora', fecha: null, hora: null };
        }
        if (mh || mf) return { accion: 'propone_hora', fecha: mf ? mf[1] : null, hora: mh ? mh[1] : null };
        return { accion: 'afirma', fecha: null, hora: null };
    })();
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return fb;
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
                model: 'claude-haiku-4-5', max_tokens: 150,
                system: `Interpretas la respuesta de un VENDEDOR de auto a esta solicitud de cita: "${cita.fecha} a las ${cita.hora}". Clasifica en:
- "afirma": está disponible / de acuerdo con esa cita.
- "negativo": el AUTO ya no está disponible (se vendió, lo apartó, cancela todo).
- "propone_hora": puede pero en OTRO momento y da la alternativa CONCRETA (extrae fecha y/u hora, ej. "mejor a las 6" → hora "6pm").
- "no_puede_hora": NO puede a esa hora/día pero NO dice cuál sí le queda (ej. "a esa hora no puedo").
Responde SOLO el JSON.`,
                messages: [{ role: 'user', content: `VENDEDOR: "${texto}"` }],
                output_config: { format: { type: 'json_schema', schema: {
                    type: 'object',
                    properties: {
                        accion: { type: 'string', description: 'afirma | negativo | propone_hora | no_puede_hora' },
                        fecha: { type: ['string', 'null'], description: 'fecha propuesta (hoy/mañana/sábado/el 15) o null' },
                        hora: { type: ['string', 'null'], description: 'hora propuesta (ej 6pm, 17:00) o null' }
                    }, required: ['accion', 'fecha', 'hora'], additionalProperties: false } } }
            })
        });
        if (!r.ok) return fb;
        const data = await r.json();
        const tb = (data.content || []).find(b => b.type === 'text');
        const out = JSON.parse(tb.text);
        if (!['afirma', 'negativo', 'propone_hora', 'no_puede_hora'].includes(out.accion)) return fb;
        return out;
    } catch (e) { return fb; }
}

// ══════════ IA: ¿el COMPRADOR cancela / avisa que no asiste? ══════════
async function clasificarCancelacion(texto, cita) {
    const t = norm(texto);
    const proponeOtra = /(mejor (a las|el)|puedo (a las|el)|que sea (a las|el)|cambiamos? a|a las \d{1,2}\b)/.test(t);
    const fb = !proponeOtra && /(no (voy a |vamos a )?(poder|podre|podremos)|no (llego|logro llegar|alcanzo|alcanzare)|no (voy|ire|asistire|vamos)\b|cancel(a|o|ar|amos|emos|ada)|ya no (voy|quiero|puedo|podre|me interesa)|se me complico|me surgio (algo|un|una)|no me va a dar tiempo|imposible (llegar|ir)|no va a poderse|no se va a poder)/.test(t);
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return { cancela: fb };
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
                model: 'claude-haiku-4-5', max_tokens: 60,
                system: `El COMPRADOR tiene una cita CONFIRMADA (${cita.fecha} a las ${cita.hora}) para ver un auto. Interpreta su mensaje: cancela=true SOLO si está cancelando o avisando que NO asistirá (sin proponer una nueva hora concreta). Si propone otra hora/día concreto, o es cualquier otra cosa (pregunta, confirmación, "ya voy"), cancela=false. Responde SOLO el JSON.`,
                messages: [{ role: 'user', content: `COMPRADOR: "${texto}"` }],
                output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { cancela: { type: 'boolean' } }, required: ['cancela'], additionalProperties: false } } }
            })
        });
        if (!r.ok) return { cancela: fb };
        const data = await r.json();
        const tb = (data.content || []).find(b => b.type === 'text');
        return { cancela: JSON.parse(tb.text).cancela === true };
    } catch (e) { return { cancela: fb }; }
}

// ═══════════════════════ PRODUCCIÓN (WhatsApp REAL) ═══════════════════════
const tel10 = t => String(t || '').replace(/\D/g, '').slice(-10);
const esTelPrueba = t => /^52100000000\d?$/.test(String(t || '').replace(/\D/g, ''));

async function ensureCitasMatch() {
    await run(`CREATE TABLE IF NOT EXISTS citas_match (
        id INTEGER PRIMARY KEY AUTOINCREMENT, comprador_tel TEXT, comprador_nombre TEXT,
        dueno_tel TEXT, dueno TEXT, auto_id INTEGER, auto_nombre TEXT,
        fecha TEXT, hora TEXT, cita_ts INTEGER, match_ts INTEGER, estado TEXT,
        recordatorios TEXT, prop_fecha TEXT, prop_hora TEXT, updated INTEGER)`);
    await run("CREATE INDEX IF NOT EXISTS idx_cm_dueno ON citas_match(dueno_tel, estado)").catch(() => {});
    await run("CREATE INDEX IF NOT EXISTS idx_cm_comp ON citas_match(comprador_tel, estado)").catch(() => {});
}

// Enviar WhatsApp via el bridge del VPS. Números de prueba (52100000000x) JAMÁS salen.
async function enviarWA(tel, texto) {
    if (esTelPrueba(tel)) return { ok: true, simulado: true };
    const url = process.env.BRIDGE_SEND_URL || 'http://137.184.199.19:3000/api/send';
    const key = process.env.BRIDGE_API_KEY || 'fyra-bridge-v2-2026';
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': key },
            body: JSON.stringify({ phone: String(tel), text: texto })
        });
        const d = await r.json().catch(() => ({}));
        return { ok: r.ok && d.ok !== false, error: d.error || null };
    } catch (e) { return { ok: false, error: e.message }; }
}

// El cita-extractor (o quien solicite al dueño) registra aquí la SOLICITUD viva.
async function registrarSolicitud({ comprador_tel, comprador_nombre, dueno_tel, dueno, auto_id, auto_nombre, fecha, hora, cita_ts }) {
    await ensureCitasMatch();
    const ts = cita_ts || resolverCitaTs(fecha, hora);
    // una solicitud viva por comprador: la nueva pisa a la anterior
    await run("UPDATE citas_match SET estado='reemplazada', updated=? WHERE comprador_tel=? AND estado IN ('solicitud','contrapropuesta','esperando_horario')", [Date.now(), String(comprador_tel)]);
    await run(`INSERT INTO citas_match (comprador_tel, comprador_nombre, dueno_tel, dueno, auto_id, auto_nombre, fecha, hora, cita_ts, estado, updated)
               VALUES (?,?,?,?,?,?,?,?,?,'solicitud',?)`,
        [String(comprador_tel), comprador_nombre || null, String(dueno_tel), dueno || 'Vendedor', auto_id || null, auto_nombre || null, fecha || '', hora || '', ts, Date.now()]);
    return true;
}

async function filaActivaDueno(dueno_tel) {
    await ensureCitasMatch();
    const rows = await query("SELECT * FROM citas_match WHERE estado IN ('solicitud','contrapropuesta','esperando_horario') ORDER BY updated DESC");
    return rows.find(r => tel10(r.dueno_tel) === tel10(dueno_tel)) || null;
}
async function filaMatchComprador(comprador_tel) {
    await ensureCitasMatch();
    const rows = await query("SELECT * FROM citas_match WHERE estado='match' ORDER BY updated DESC");
    return rows.find(r => tel10(r.comprador_tel) === tel10(comprador_tel)) || null;
}
async function filaContraComprador(comprador_tel) {
    await ensureCitasMatch();
    const rows = await query("SELECT * FROM citas_match WHERE estado='contrapropuesta' ORDER BY updated DESC");
    return rows.find(r => tel10(r.comprador_tel) === tel10(comprador_tel)) || null;
}

// Ejecutar el MATCH (afirma del dueño o señal manual): confianza + plan de recordatorios.
async function ejecutarMatch(M, { notificarVendedor = false } = {}) {
    const matchTs = Date.now();
    const ctx = { nombre: (M.comprador_nombre || '').split(/\s+/)[0] || 'amigo', dueno: (M.dueno || 'amigo').split(/\s+/)[0], auto: M.auto_nombre || 'auto', hora: M.hora, fecha: M.fecha };
    const recs = planRecordatorios(matchTs, Number(M.cita_ts), ctx);
    await run("UPDATE citas_match SET estado='match', match_ts=?, recordatorios=?, updated=? WHERE id=?", [matchTs, JSON.stringify(recs), Date.now(), M.id]);
    await enviarWA(M.comprador_tel, MSJ.confianza(ctx));
    if (notificarVendedor) await enviarWA(M.dueno_tel, MSJ.matchDirectoVendedor(ctx));
    return { recs, ctx };
}

// ── El DUEÑO contesta por WhatsApp → estado machine (idéntica al sandbox) ──
// Devuelve los segmentos PARA EL DUEÑO (el caller los regresa por el mismo canal);
// los mensajes al comprador se mandan aquí (cross-send).
async function manejarMensajeDueno(dueno_tel, texto) {
    if (process.env.CITAS_VIVAS === '0') return null;
    const M = await filaActivaDueno(dueno_tel);
    if (!M || !M.cita_ts) return null;
    let cls = await clasificarVendedor(texto, { fecha: M.fecha, hora: M.hora });
    if (M.estado === 'esperando_horario' && cls.accion !== 'negativo') {
        const tN = norm(texto);
        const mh = tN.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
        const mf = tN.match(/\b(hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|el \d{1,2})\b/);
        const horaX = (mh && Number(mh[1]) <= 23) ? (mh[1] + (mh[2] ? ':' + mh[2] : '') + (mh[3] || '')) : null;
        cls = { accion: (horaX || mf || cls.fecha || cls.hora) ? 'propone_hora' : 'no_puede_hora', fecha: cls.fecha || (mf ? mf[1] : null), hora: cls.hora || horaX };
    }
    const ctx = { nombre: (M.comprador_nombre || '').split(/\s+/)[0] || 'amigo', dueno: (M.dueno || '').split(/\s+/)[0], auto: M.auto_nombre || 'auto', fecha: M.fecha, hora: M.hora };

    if (cls.accion === 'afirma') {
        await ejecutarMatch(M);
        return MSJ.graciasAfirma(ctx);
    }
    if (cls.accion === 'negativo') {
        await run("UPDATE citas_match SET estado='rechazo', updated=? WHERE id=?", [Date.now(), M.id]);
        for (const s of MSJ.negativoComprador(ctx)) await enviarWA(M.comprador_tel, s);
        return MSJ.negativoVendedor();
    }
    if (cls.accion === 'no_puede_hora' || (!cls.fecha && !cls.hora)) {
        await run("UPDATE citas_match SET estado='esperando_horario', updated=? WHERE id=?", [Date.now(), M.id]);
        return MSJ.pideHorario();
    }
    if (cls.fecha && !cls.hora) {
        await run("UPDATE citas_match SET estado='esperando_horario', prop_fecha=?, prop_hora=NULL, updated=? WHERE id=?", [cls.fecha, Date.now(), M.id]);
        return MSJ.faltaHora(cls.fecha);
    }
    const nf = cls.fecha || M.prop_fecha || M.fecha, nh = cls.hora;
    await run("UPDATE citas_match SET estado='contrapropuesta', prop_fecha=?, prop_hora=?, updated=? WHERE id=?", [nf, nh, Date.now(), M.id]);
    for (const s of MSJ.proponeComprador(ctx, nf, nh)) await enviarWA(M.comprador_tel, s);
    return MSJ.proponeVendedor();
}

// ── El COMPRADOR (con match o contrapropuesta viva) manda mensaje ──
// Devuelve segmentos para el comprador o null (el flujo normal sigue).
async function manejarMensajeComprador(comprador_tel, texto) {
    if (process.env.CITAS_VIVAS === '0') return null;
    // MATCH DIRECTO: aceptó lo que el dueño propuso ("va" tras la contrapropuesta) —
    // lo detecta el cerrador normal (cita_confirmada); aquí solo cancel/en-camino.
    const M = await filaMatchComprador(comprador_tel);
    if (!M) return null;
    const tEC = norm(texto);
    if (/(ya voy|voy en camino|en camino|ya salgo|saliendo|voy para alla|alla voy|ya merito llego|ya casi llego)/.test(tEC) && !/(no |cancel)/.test(tEC)) {
        const ctx = { dueno: (M.dueno || '').split(/\s+/)[0], auto: M.auto_nombre || 'auto' };
        await enviarWA(M.dueno_tel, MSJ.acreditacionVendedor(ctx));
        return [MSJ.acuseEnCamino()];
    }
    const cc = await clasificarCancelacion(texto, { fecha: M.fecha, hora: M.hora });
    if (cc.cancela) {
        await run("UPDATE citas_match SET estado='cancelada', updated=? WHERE id=?", [Date.now(), M.id]);
        const ctx = { dueno: (M.dueno || '').split(/\s+/)[0], fecha: M.fecha, hora: M.hora };
        await enviarWA(M.dueno_tel, MSJ.canceladaVendedor(ctx));
        return MSJ.canceladaComprador();
    }
    return null;
}

// MATCH DIRECTO real: el comprador confirmó EXACTO lo que el dueño propuso.
// Llamar cuando el cerrador confirme una cita (cita_confirmada) — si empata con la
// contrapropuesta viva, match sin re-preguntar al dueño (y se le avisa).
async function intentarMatchDirecto(comprador_tel, fecha, hora) {
    if (process.env.CITAS_VIVAS === '0') return false;
    const M = await filaContraComprador(comprador_tel);
    if (!M) return false;
    if (!(mismaHora(M.prop_hora || M.hora, hora) && mismaFecha(M.prop_fecha || M.fecha, fecha))) return false;
    const citaTs = resolverCitaTs(fecha, hora);
    await run("UPDATE citas_match SET fecha=?, hora=?, cita_ts=?, updated=? WHERE id=?", [fecha || '', hora || '', citaTs, Date.now(), M.id]);
    const M2 = { ...M, fecha, hora, cita_ts: citaTs };
    await ejecutarMatch(M2, { notificarVendedor: true });
    return true;
}

// SEÑAL MANUAL del owner (human-in-the-loop): escribió "cita confirmada"/"cita cancelada"
// en el chat del DUEÑO (le confirmaron por teléfono). Ejecuta la acción real.
async function senalManual(dueno_tel, texto) {
    if (process.env.CITAS_VIVAS === '0') return null;
    const tS = norm(texto);
    const esConf = /confirmad/.test(tS) && !/no |cancel/.test(tS);
    const esCanc = /cancelad/.test(tS);
    if (!esConf && !esCanc) return null;
    await ensureCitasMatch();
    const rows = await query("SELECT * FROM citas_match WHERE estado IN ('solicitud','contrapropuesta','esperando_horario','match') ORDER BY updated DESC");
    const M = rows.find(r => tel10(r.dueno_tel) === tel10(dueno_tel));
    if (!M) return null;
    if (esConf && M.estado !== 'match' && M.cita_ts) {
        await ejecutarMatch(M);
        return { senal: 'confirmada' };
    }
    if (esCanc) {
        await run("UPDATE citas_match SET estado='cancelada', updated=? WHERE id=?", [Date.now(), M.id]);
        const ctx = { nombre: (M.comprador_nombre || '').split(/\s+/)[0] || 'amigo', fecha: M.fecha, hora: M.hora };
        for (const s of MSJ.canceladaPorVendedorComprador(ctx)) await enviarWA(M.comprador_tel, s);
        return { senal: 'cancelada' };
    }
    return null;
}

// ══ CIERRE DEL OWNER (human in the loop, 2026-07-13): en POSESIÓN el owner cierra
// la cita ÉL con "cita confirmada" + día/hora/auto/precio EN CUALQUIER ORDEN y forma
// (número o letra: "mañana viernes", "a la una y media"). Aquí se extraen fecha y
// hora 100% DETERMINISTAS — importa la verdad, no el formato. Cero IA.
const HORA_LETRA = { una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 };
function parseCierreOwner(texto) {
    const t = norm(texto);
    if (t.indexOf('cita confirmada') === -1) return null;
    let fecha = null, m;
    m = t.match(/\b(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/);
    if (m) fecha = m[0];
    if (!fecha) { m = t.match(/\bel (\d{1,2})\b/); if (m) fecha = m[0]; }
    if (!fecha) { m = t.match(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/); if (m) fecha = m[1]; }
    if (!fecha && /\bpasado ?manana\b/.test(t)) fecha = 'pasado mañana';
    if (!fecha && /\bmanana\b/.test(t)) fecha = 'mañana';
    if (!fecha && /\b(hoy|ahorita)\b/.test(t)) fecha = 'hoy';
    if (!fecha) return null;
    let hora = null;
    m = t.match(/\ba las? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    if (!m) { const x = t.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/); if (x) m = [x[0], x[1], x[2], x[3]]; }
    if (!m) { const x = t.match(/\b(\d{1,2})\s*(am|pm)\b/); if (x) m = [x[0], x[1], null, x[2]]; }
    if (m && Number(m[1]) >= 0 && Number(m[1]) <= 23) hora = m[1] + (m[2] ? ':' + m[2] : '') + (m[3] || '');
    if (!hora) {
        m = t.match(/\ba las? (una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)(?:\s+y\s+(media|cuarto))?(?:\s+de la\s+(tarde|noche|manana))?\b/);
        if (m) hora = HORA_LETRA[m[1]] + (m[2] === 'media' ? ':30' : m[2] === 'cuarto' ? ':15' : '') + (m[3] === 'manana' ? 'am' : m[3] ? 'pm' : '');
    }
    if (!hora) return null;
    const ts = resolverCitaTs(fecha, hora);
    if (!ts || ts < Date.now() - 3600000) return null;
    return { fecha, hora, cita_ts: ts };
}

// ══ CIERRE DEL OWNER — EJECUTOR (cron cada 10 min): busca "cita confirmada" MANUAL
// (ai=0) en chats de compradores en los últimos 30 min, lo interpreta determinista y
// EJECUTA la máquina: canónica + SALES-BRAIN (cita + calendar + solicitud al dueño).
// Idempotente vía cita_canonica (una canónica posterior al mensaje = ya ejecutado).
const SALES_BRAIN_URL = process.env.SALES_BRAIN_URL || 'https://sales-brain-theta.vercel.app';
const OWNER_TEL = '5218120066355';
async function cierresOwner() {
    const rows = await query(
        "SELECT m.id, m.texto, m.ts, c.telefono FROM mensajes m JOIN conversaciones c ON c.id = m.conversacion_id WHERE m.direccion='out' AND COALESCE(m.ai_generated,0)=0 AND m.ts > ? AND lower(m.texto) LIKE '%cita confirmada%' ORDER BY m.ts ASC",
        [Date.now() - 30 * 60000]);
    let ejecutados = 0;
    for (const r of rows) {
        try {
            const tel = String(r.telefono || '').replace(/\D/g, '');
            if (!tel || /^52100000000\d?$/.test(tel)) continue;           // carril de pruebas JAMÁS
            const cierre = parseCierreOwner(r.texto);
            if (!cierre) continue;
            await ensureCanonica();
            const ya = await query("SELECT id FROM cita_canonica WHERE telefono LIKE ? AND created > ?", ['%' + tel.slice(-10), Number(r.ts)]);
            if (ya.length) continue;                                       // ya ejecutado
            await registrarCitaCanonica({ telefono: tel, fecha: cierre.fecha, hora: cierre.hora });
            let autoId = null;
            try { const wc = await query("SELECT auto_id_activo FROM wa_conversations WHERE telefono=?", [tel]); if (wc[0] && wc[0].auto_id_activo) autoId = Number(wc[0].auto_id_activo); } catch (e) { }
            let sb = null;
            try {
                const resp = await fetch(SALES_BRAIN_URL + '/api/upload', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'registrar_cita_owner', phone: tel, texto: r.texto, auto_id: autoId })
                });
                sb = await resp.json().catch(() => null);
            } catch (e) { console.error('[cierresOwner] SB:', e.message); }
            const iso = tsAIsoHora(cierre.cita_ts);
            await enviarWA(OWNER_TEL, '🤝 Ejecuté tu cierre: cita ' + cierre.fecha + ' a las ' + iso.hora_hhmm + ' (' + iso.fecha_iso + ')' + ((sb && sb.ok) ? ' — registrada en CRM/Calendar y solicitud al dueño en camino ✓' : ' — fecha canónica lista; OJO: Sales Brain no confirmó el registro, revísalo'));
            ejecutados++;
        } catch (e) { console.error('[cierresOwner]', e.message); }
    }
    return ejecutados;
}

// ── SEÑAL DESDE EL TELÉFONO (caso Yaris/Cantisani 2026-07-12): el owner confirma
// citas escribiendo "confirmado" DESDE SU CELULAR en el chat del dueño — eso NO pasa
// por FyraChat (manual_directo), así que el CRON la recoge: si el último mensaje
// MANUAL del owner (ai_generated=0) en el chat del dueño es posterior al último
// movimiento de la fila y dice confirmado/cancelada → misma máquina que senalManual.
async function senalesTelefono() {
    const rows = await query("SELECT * FROM citas_match WHERE estado IN ('solicitud','contrapropuesta','esperando_horario')");
    let ejecutadas = 0;
    for (const M of rows) {
        try {
            const dt = tel10(M.dueno_tel);
            if (!dt) continue;
            const cv = await query("SELECT id FROM conversaciones WHERE channel_thread_id LIKE ? OR telefono LIKE ? LIMIT 1", ['%' + dt, '%' + dt]);
            if (!cv.length) continue;
            const ms = await query("SELECT texto FROM mensajes WHERE conversacion_id=? AND direccion='out' AND COALESCE(ai_generated,0)=0 AND ts > ? ORDER BY ts DESC LIMIT 1", [cv[0].id, Number(M.updated) || 0]);
            if (!ms.length) continue;
            const r = await senalManual(M.dueno_tel, ms[0].texto);
            if (r) ejecutadas++;
        } catch (e) { console.error('[senalesTelefono]', e.message); }
    }
    return ejecutadas;
}

// EL CRON REAL (VPS crontab → /api/seb-cron cada 10 min): manda los recordatorios que tocan.
async function tickRecordatorios() {
    if (process.env.CITAS_VIVAS === '0') return { ok: true, off: true };
    await ensureCitasMatch();
    let senales = 0;
    try { senales = await senalesTelefono(); } catch (e) { console.error('[cron señales]', e.message); }
    let cierres = 0;
    try { cierres = await cierresOwner(); } catch (e) { console.error('[cron cierres]', e.message); }
    const now = Date.now();
    const rows = await query("SELECT * FROM citas_match WHERE estado='match'");
    let enviados = 0;
    for (const M of rows) {
        let recs; try { recs = JSON.parse(M.recordatorios || '[]'); } catch (e) { continue; }
        let dirty = false;
        for (const r of recs) {
            if (!r.enviado && r.ts <= now) {
                const tel = r.para === 'vendedor' ? M.dueno_tel : M.comprador_tel;
                const res = await enviarWA(tel, r.texto);
                if (res.ok) { r.enviado = 1; dirty = true; enviados++; }
            }
        }
        if (dirty) await run("UPDATE citas_match SET recordatorios=?, updated=? WHERE id=?", [JSON.stringify(recs), Date.now(), M.id]);
        // cita ya pasó hace 3h+ → cerrar el ciclo
        if (Number(M.cita_ts) && now > Number(M.cita_ts) + 3 * 3600000) {
            await run("UPDATE citas_match SET estado='vencida', updated=? WHERE id=?", [Date.now(), M.id]);
        }
    }
    return { ok: true, matches: rows.length, enviados, senales, cierres };
}

// ══════════ LA FECHA CANÓNICA (🚩fyrachat#7 — orden owner: "única, inamovible, SIN IA") ══════════
// Cuando el CERRADOR confirma una cita, aquí queda la fecha/hora EXACTAS que el
// comprador aceptó. El cita-extractor las usa TAL CUAL (jamás re-adivina con IA).
async function ensureCanonica() {
    await run(`CREATE TABLE IF NOT EXISTS cita_canonica (
        id INTEGER PRIMARY KEY AUTOINCREMENT, telefono TEXT, fecha_texto TEXT, hora_texto TEXT,
        cita_ts INTEGER, fecha_iso TEXT, hora_hhmm TEXT, lugar TEXT, auto_id INTEGER, created INTEGER)`);
    await run("CREATE INDEX IF NOT EXISTS idx_canonica_tel ON cita_canonica(telefono, created)").catch(() => {});
}
function tsAIsoHora(ts) {
    const d = sh(Number(ts));
    const iso = d.toISOString().slice(0, 10);
    const hh = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    return { fecha_iso: iso, hora_hhmm: hh };
}
async function registrarCitaCanonica({ telefono, fecha, hora, lugar, auto_id }) {
    const ts = resolverCitaTs(fecha, hora);
    if (!ts) return null;
    await ensureCanonica();
    const { fecha_iso, hora_hhmm } = tsAIsoHora(ts);
    await run("INSERT INTO cita_canonica (telefono, fecha_texto, hora_texto, cita_ts, fecha_iso, hora_hhmm, lugar, auto_id, created) VALUES (?,?,?,?,?,?,?,?,?)",
        [String(telefono), String(fecha || ''), String(hora || ''), ts, fecha_iso, hora_hhmm, lugar || null, auto_id || null, Date.now()]);
    return { cita_ts: ts, fecha_iso, hora_hhmm };
}

module.exports = {
    // puras (compartidas con el sandbox)
    parseHora, resolverCitaTs, mismaHora, mismaFecha, planRecordatorios,
    clasificarVendedor, clasificarCancelacion, MSJ,
    // producción
    ensureCitasMatch, enviarWA, registrarSolicitud, registrarCitaCanonica, tsAIsoHora,
    manejarMensajeDueno, manejarMensajeComprador, intentarMatchDirecto, senalManual, tickRecordatorios, parseCierreOwner, cierresOwner, ejecutarMatch };
