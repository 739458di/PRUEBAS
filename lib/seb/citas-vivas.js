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
    } else if (/(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/.test(f)) {
        // 🚩fyrachat#9 (caso Eduardo Castillo): fecha de CALENDARIO explícita
        // ("19 de julio") — el parser la sacaba pero aquí no había rama y el cierre
        // del owner moría en silencio. Día explícito manda (ley de fecha canónica).
        const mx = f.match(/(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/);
        const MES_NUM = { enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11 };
        const dd = Number(mx[1]);
        if (dd < 1 || dd > 31) return null;
        mo = MES_NUM[mx[2]]; d = dd;
        // ya pasó este año → es del año que entra
        if (Date.UTC(y, mo, dd) < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) y += 1;
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
    // LEY DEL NOMBRE (owner 2026-08-06, caso Rene/"undefined"): el nombre es el
    // SUYO o NO SE DICE NADA — jamás interpolar undefined/null/basura en un texto
    // que sale a WhatsApp. Igual para dueño y auto: si faltan, la frase se arma sin ellos.
    const sano = v => {
        const t = String(v == null ? '' : v).trim();
        if (!t || /^(undefined|null|nan|comprador|vendedor|sin nombre)$/i.test(t)) return null;
        if (!/[a-zA-Z\u00c1\u00c9\u00cd\u00d3\u00da\u00e1\u00e9\u00ed\u00f3\u00fa\u00d1\u00f1]{2}/.test(t)) return null;
        return t;
    };
    const nom = sano(ctx && ctx.nombre), due = sano(ctx && ctx.dueno), autoN = sano(ctx && ctx.auto);
    const N = nom ? ' ' + nom : '';                      // "Qué tal${N},"
    const D = due ? ' ' + due : '';                      // "Qué tal${D},"
    const A = autoN ? ' para el ' + autoN : '';          // "cita ... ${A}."
    const Atu = autoN ? 'tu ' + autoN : 'tu auto';       // "la cita de ${Atu}"
    const Aver = autoN ? 'ver el ' + autoN : 'ver el auto';
    const R = [];
    const add = (k, ts, para, texto) => { if (ts > match_ts + 60000 && ts < cita_ts + 1) R.push({ k, ts, para, texto, enviado: 0 }); };
    const c = sh(cita_ts), m = sh(match_ts);
    const mismoDia = c.getUTCFullYear() === m.getUTCFullYear() && c.getUTCMonth() === m.getUTCMonth() && c.getUTCDate() === m.getUTCDate();
    const gap = cita_ts - match_ts;
    if (!mismoDia) {
        // ══ SELLO DE CONFIANZA (orden owner 2026-07-16): recordatorio TEMPRANO y
        // proporcional que trabaja la CONFIANZA antes de la cita — sin datos de ficha
        // (orden owner): puro sello de verificación. Regla técnica: anticipación ≥72h
        // → 48h antes a las 12pm MTY; 48–72h → punto medio match↔víspera; <48h → no
        // aplica (víspera/día/1h ya cubren). Jamás cae el mismo día que la víspera.
        const DIA_NOM = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
        const visperaTs = Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate() - 1, 20, 0) + MTY_OFF;
        let selloTs = null;
        if (gap >= 72 * 3600000) selloTs = Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate() - 2, 12, 0) + MTY_OFF;
        else if (gap >= 48 * 3600000) selloTs = match_ts + Math.round((visperaTs - match_ts) / 2);
        if (selloTs && selloTs > match_ts + 3 * 3600000) {
            const s = sh(selloTs), v = sh(visperaTs);
            const esDiaVispera = s.getUTCFullYear() === v.getUTCFullYear() && s.getUTCMonth() === v.getUTCMonth() && s.getUTCDate() === v.getUTCDate();
            if (!esDiaVispera) add('sello', selloTs, 'comprador',
                `🤖 Este mensaje es enviado por SEB, agente de IA de Fyradrive\n\n¿Sabías que el ${autoN || 'auto'} que vas a ver el ${DIA_NOM[c.getUTCDay()]} a las ${ctx.hora} ya fue verificado por Fyradrive? ✅\n\nSello de confianza: inspección mecánica y legal aprobada — para que compres calidad.\n\nCualquier duda aquí ando 👍`);
        }
        add('vispera', Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate() - 1, 20, 0) + MTY_OFF, 'comprador',
            `Qué tal${N}, buenas noches. Te recuerdo tu cita de mañana a las ${ctx.hora}${A}. Seguimos en pie?`);
        // ══ VÍSPERA DEL DUEÑO (orden owner 2026-07-16): la noche anterior el dueño
        // también se entera — auto listo y disponible, y de paso el candado anti
        // venta-por-fuera trabaja desde la víspera, no hasta el día D.
        add('vispera_vendedor', Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate() - 1, 20, 0) + MTY_OFF + 120000, 'vendedor',
            `Qué tal${D}, buenas noches. Te recuerdo que mañana a las ${ctx.hora} es la cita de ${Atu} 👍 De favor tenlo listo y disponible — yo te aviso en cuanto el comprador vaya en camino.`);
        let diaD = Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate(), 9, 30) + MTY_OFF;
        // ══ CITAS TEMPRANAS (orden owner 2026-07-16, caso Mazda/Audi 9am): si las 9:30
        // caen encima o después de la cita, el aviso del día se RECORRE a 90 min antes
        // — nunca antes de las 7:00am (madrugada jamás). Antes simplemente se omitía y
        // el día D quedaba sin recordatorio para citas de 9-10:45am.
        if (diaD >= cita_ts - 75 * 60000) {
            const alt = cita_ts - 90 * 60000;
            const piso7am = Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate(), 7, 0) + MTY_OFF;
            diaD = alt >= piso7am ? alt : null;
        }
        if (diaD) {
            add('dia_comprador', diaD, 'comprador', `Buen día${N}. Hoy nos vemos a las ${ctx.hora}${A}. Aquí ando pendiente 👍`);
            add('dia_vendedor_espera', diaD + 120000, 'vendedor', `Qué tal${D}, hoy es la cita de ${Atu} a las ${ctx.hora}. De favor no hagas movimiento todavía — yo te aviso en cuanto el comprador me acredite que ya va en camino 👍`);
        }
        add('1h_antes', cita_ts - 3600000, 'comprador', (nom ? nom + ', te' : 'Te') + ` esperamos en una hora para ${Aver}. De favor, me avisas en cuanto vayas en camino? Así ya te estamos esperando listos 👍`);
        add('en_camino', cita_ts - 1800000, 'comprador', (nom ? nom + ', ya' : 'Ya') + ` casi es la hora — vienes en camino? Aquí te esperamos 👍`);
    } else {
        if (gap > 2.5 * 3600000) {
            add('confirmacion_hoy', match_ts + Math.round(gap / 2), 'comprador', `Todo listo para hoy a las ${ctx.hora}${nom ? ', ' + nom : ''}. Aquí ando pendiente 👍`);
            add('dia_vendedor_espera', match_ts + Math.round(gap / 2) + 120000, 'vendedor', `Qué tal${D}, hoy es la cita de ${Atu} a las ${ctx.hora}. De favor no hagas movimiento todavía — yo te aviso en cuanto el comprador me acredite que ya va en camino 👍`);
        }
        if (gap > 75 * 60000) {
            add('1h_antes', cita_ts - 3600000, 'comprador', (nom ? nom + ', te' : 'Te') + ` esperamos en una hora para ${Aver}. De favor, me avisas en cuanto vayas en camino? Así ya te estamos esperando listos 👍`);
            add('en_camino', cita_ts - 1800000, 'comprador', (nom ? nom + ', ya' : 'Ya') + ` casi es la hora — vienes en camino? Aquí te esperamos 👍`);
        }
        else if (gap > 40 * 60000) add('ya_casi', match_ts + Math.round(gap / 2), 'comprador', (nom ? nom + ', ya' : 'Ya') + ` casi nos vemos — a las ${ctx.hora}${A}. Aquí ando pendiente 👍`);
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
const esTelPrueba = t => /^52100000000/.test(String(t || '').replace(/\D/g, ''));

// CUOTA TURSO (2026-09-08): los ensure* corren UNA vez por instancia (antes: 4 DDL por
// cada mensaje entrante). Las tablas/índices ya existen; el flag solo evita el viaje.
let _ensCM = false, _ensCan = false, _ensCJ = false, _ensCV = false;
async function ensureCitasMatch() {
    if (_ensCM) return;
    _ensCM = true;
    await run(`CREATE TABLE IF NOT EXISTS citas_match (
        id INTEGER PRIMARY KEY AUTOINCREMENT, comprador_tel TEXT, comprador_nombre TEXT,
        dueno_tel TEXT, dueno TEXT, auto_id INTEGER, auto_nombre TEXT,
        fecha TEXT, hora TEXT, cita_ts INTEGER, match_ts INTEGER, estado TEXT,
        recordatorios TEXT, prop_fecha TEXT, prop_hora TEXT, updated INTEGER)`);
    await run("CREATE INDEX IF NOT EXISTS idx_cm_dueno ON citas_match(dueno_tel, estado)").catch(() => {});
    // TENANT (2026-09-08): la cita nace en el universo del vendedor → lo que va AL COMPRADOR sale por SU número;
    // lo que va al dueño/vendedor sale por el número de Fyradrive (el bot Fyradrive le habla a él).
    await run("ALTER TABLE citas_match ADD COLUMN tenant_id INTEGER").catch(() => {});
    await run("CREATE INDEX IF NOT EXISTS idx_cm_comp ON citas_match(comprador_tel, estado)").catch(() => {});
}

// Enviar WhatsApp via el bridge del VPS. Números de prueba (52100000000x) JAMÁS salen.
async function enviarWA(tel, texto, tenantId) {
    if (esTelPrueba(tel)) return { ok: true, simulado: true };
    const tId = Number(tenantId) || 0;                      // 0 = número de Fyradrive; N = universo del vendedor
    const url = process.env.BRIDGE_SEND_URL || 'http://137.184.199.19:3000/api/send';
    const key = process.env.BRIDGE_API_KEY || 'fyra-bridge-v2-2026';
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': key },
            body: JSON.stringify(Object.assign({ phone: String(tel), text: texto }, tId ? { tenant_id: tId } : {}))
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

// CUOTA TURSO (2026-09-08): el teléfono se filtra EN SQL (LIKE '%'||últimos 10 dígitos, sobre
// el índice citas_match(estado)) en vez de traer todas las filas activas y filtrar en JS.
// El find en JS se conserva como verificación exacta (mismo criterio tel10 de siempre).
async function filaActivaDueno(dueno_tel) {
    await ensureCitasMatch();
    const t10 = tel10(dueno_tel);
    if (!t10) return null;
    const rows = await query("SELECT * FROM citas_match WHERE estado IN ('solicitud','contrapropuesta','esperando_horario') AND dueno_tel LIKE ? ORDER BY updated DESC", ['%' + t10]);
    return rows.find(r => tel10(r.dueno_tel) === t10) || null;
}
async function filaMatchComprador(comprador_tel) {
    await ensureCitasMatch();
    const t10 = tel10(comprador_tel);
    if (!t10) return null;
    const rows = await query("SELECT * FROM citas_match WHERE estado='match' AND comprador_tel LIKE ? ORDER BY updated DESC", ['%' + t10]);
    return rows.find(r => tel10(r.comprador_tel) === t10) || null;
}
async function filaContraComprador(comprador_tel) {
    await ensureCitasMatch();
    const t10 = tel10(comprador_tel);
    if (!t10) return null;
    const rows = await query("SELECT * FROM citas_match WHERE estado='contrapropuesta' AND comprador_tel LIKE ? ORDER BY updated DESC", ['%' + t10]);
    return rows.find(r => tel10(r.comprador_tel) === t10) || null;
}

// Ejecutar el MATCH (afirma del dueño o señal manual): confianza + plan de recordatorios.
// avisarComprador=false solo lo usa la puerta del Calendar (el comprador ya recibió
// el machote firmado del popup) — el plan de recordatorios es EL MISMO siempre.
async function ejecutarMatch(M, { notificarVendedor = false, avisarComprador = true } = {}) {
    const matchTs = Date.now();
    const ctx = { nombre: (M.comprador_nombre || '').split(/\s+/)[0] || 'amigo', dueno: (M.dueno || 'amigo').split(/\s+/)[0], auto: M.auto_nombre || 'auto', hora: M.hora, fecha: M.fecha };
    const recs = planRecordatorios(matchTs, Number(M.cita_ts), ctx);
    await run("UPDATE citas_match SET estado='match', match_ts=?, recordatorios=?, updated=? WHERE id=?", [matchTs, JSON.stringify(recs), Date.now(), M.id]);
    if (avisarComprador) await enviarWA(M.comprador_tel, MSJ.confianza(ctx), M.tenant_id);
    if (notificarVendedor) await enviarWA(M.dueno_tel, MSJ.matchDirectoVendedor(ctx));
    return { recs, ctx };
}

// ── MATCH DIRECTO DESDE EL CALENDAR (orden owner 2026-08-24): agendar en el
// Calendar = el owner YA habló con el dueño y la confirmación viene acreditada.
// MISMA máquina de siempre: nace la fila del match y ejecutarMatch arma el MISMO
// plan de recordatorios (víspera, día D, 1h antes, en camino). Lo único distinto:
// no se le repite la confianza al comprador (ya recibió el machote del popup).
// avisar=true (re-confirmación con hora nueva): SÍ se les avisa a ambas partes con
// los machotes del match de siempre (confianza al comprador, confirmación al dueño).
async function matchDirectoCalendar({ comprador_tel, comprador_nombre, dueno_tel, dueno, auto_id, auto_nombre, fecha, hora, cita_ts, avisar, tenant_id }) {
    await ensureCitasMatch();
    const telC = String(comprador_tel || '').replace(/\D/g, '');
    if (!telC || !cita_ts) return { ok: false, error: 'faltan comprador_tel o cita_ts' };
    // idempotente: mismo comprador + misma cita ya en match → no duplicar
    const vivos = await query("SELECT * FROM citas_match WHERE estado='match' AND comprador_tel LIKE ?", ['%' + tel10(telC)]);
    const ya = vivos.find(r => tel10(r.comprador_tel) === tel10(telC) && Number(r.cita_ts) === Number(cita_ts));
    if (ya) return { ok: true, match_id: ya.id, ya_existia: true };
    await run("UPDATE citas_match SET estado='reemplazada', updated=? WHERE comprador_tel LIKE ? AND estado IN ('solicitud','contrapropuesta','esperando_horario')", [Date.now(), '%' + tel10(telC)]);
    const ins = await run(`INSERT INTO citas_match (comprador_tel, comprador_nombre, dueno_tel, dueno, auto_id, auto_nombre, fecha, hora, cita_ts, estado, updated, tenant_id)
               VALUES (?,?,?,?,?,?,?,?,?,'solicitud',?,?)`,
        [telC, comprador_nombre || null, String(dueno_tel || ''), dueno || 'Vendedor', auto_id || null, auto_nombre || null, fecha || '', hora || '', Number(cita_ts), Date.now(), Number(tenant_id) || 0]);
    const M = (await query("SELECT * FROM citas_match WHERE id=?", [Number(ins.lastInsertRowid)]))[0];
    const { recs } = await ejecutarMatch(M, { avisarComprador: !!avisar, notificarVendedor: !!avisar && !!String(dueno_tel || '').replace(/\D/g, '') });
    // auto sin teléfono de dueño → se podan los recordatorios de vendedor (si no,
    // el barredor reintentaría por siempre contra un teléfono vacío)
    if (!String(dueno_tel || '').replace(/\D/g, '')) {
        const soloComp = recs.filter(x => x.para !== 'vendedor');
        await run("UPDATE citas_match SET recordatorios=?, updated=? WHERE id=?", [JSON.stringify(soloComp), Date.now(), M.id]);
    }
    return { ok: true, match_id: M.id, recordatorios: recs.length };
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
        for (const s of MSJ.negativoComprador(ctx)) await enviarWA(M.comprador_tel, s, M.tenant_id);
        return MSJ.negativoVendedor();
    }
    // ══ FRENO DE CONTRAPROPUESTA (orden owner 2026-08-25, caso Julio Torres): si el
    // dueño mueve la hora, no puede, o pide otro horario, la máquina SE DETIENE —
    // ni una palabra al dueño ni al comprador. Se le escala al owner: él cuadra la
    // nueva hora a mano y re-confirma ("cita confirmada ✅" o el Calendar), y eso
    // arranca un flujo fresco con la hora buena.
    await run("UPDATE citas_match SET prop_fecha=?, prop_hora=?, updated=? WHERE id=?",
        [cls.fecha || null, cls.hora || null, Date.now(), M.id]);
    await pausarPorDesvio(M, 'dueno', texto);
    return null;
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
        // el VENDEDOR asignado (staff) también se entera del movimiento
        try {
            const t10s = String(comprador_tel || '').replace(/\D/g, '').slice(-10);
            const staff = await query("SELECT nombre, tel FROM cita_vendedores WHERE estado='confirmado' AND comprador_tel LIKE ?", ['%' + t10s]);
            for (const V of staff) await enviarWA(V.tel, `${(V.nombre || '').split(/\s+/)[0] || 'Oye'}, el comprador ya va en camino 👍`);
        } catch (e) { }
        return [MSJ.acuseEnCamino()];
    }
    // ══ POST-CITA (caso Virgilio 2026-07-18): la cita YA PASÓ → "me amarré con otro"
    // NO es cancelación (¡la cita se hizo!). No se toca el estado: se le avisa al
    // owner para que ÉL la marque REALIZADA + resultado en Calendar. El bot calla.
    if (Number(M.cita_ts) && Date.now() > Number(M.cita_ts)) {
        await enviarWA('5218120066355', `💬 POST-CITA de ${M.comprador_nombre || comprador_tel} (${M.auto_nombre || 'auto'}, ${M.fecha} ${M.hora} — ya pasó): «${String(texto).slice(0, 140)}» — NO la cancelo. Márcala en Calendar: 🤝 CITA REALIZADA + resultado.`).catch(() => { });
        return null;
    }
    const cc = await clasificarCancelacion(texto, { fecha: M.fecha, hora: M.hora });
    if (cc.cancela) {
        await ejecutarCancelacion(M);
        return MSJ.canceladaComprador();
    }
    // ══ DESVÍO DEL GUION (orden owner 2026-08-25): el comprador quiere mover la
    // hora/el día → la máquina SE PAUSA y el staff cuadra. El bot no negocia.
    if (/(otra hora|otro dia|cambiar la (cita|hora)|mover la (cita|hora)|reagendar|se me complico|no (voy a |vamos a )?alcanz|mas tarde|mas temprano|puedo (ir|llegar) (a las|hasta)|mejor (a las|el )|se puede (a las|el |mas ))/.test(tEC)) {
        await pausarPorDesvio(M, 'comprador', texto);
        return null;
    }
    return null;
}

// ══ PAUSA POR DESVÍO (orden owner 2026-08-25): algo se sale del guion acordado
// (mover hora/día, o cualquier cosa que requiera al staff) → LA MÁQUINA SE PAUSA
// (los recordatorios mueren hasta re-confirmar) y se le avisa al VENDEDOR asignado
// para que cuadre a AMBAS partes; sin staff asignado, al owner como siempre.
// Re-armar = botón "Confirmar cita" del Calendar o "cita confirmada ✅".
async function pausarPorDesvio(M, quien, texto) {
    await run("UPDATE citas_match SET estado='pausada_staff', updated=? WHERE id=?", [Date.now(), M.id]);
    const aviso = `⚠️ ${quien === 'dueno' ? 'El dueño' + (M.dueno ? ' ' + M.dueno : '') : (M.comprador_nombre || 'El comprador')} quiere mover algo de la cita del ${M.auto_nombre || 'auto'} (${M.fecha} ${M.hora}): «${String(texto).slice(0, 120)}»\nLa máquina se PAUSÓ 🛑 — cuadra con las dos partes y ya cuadrado se re-confirma en el Calendar (o "cita confirmada ✅" + día + hora + auto).`;
    let alStaff = 0;
    try {
        await ensureCitaVendedores();
        const t10p = String(M.comprador_tel || '').replace(/\D/g, '').slice(-10);
        const staff = await query("SELECT nombre, tel FROM cita_vendedores WHERE estado='confirmado' AND comprador_tel LIKE ?", ['%' + t10p]);
        for (const V of staff) { const r = await enviarWA(V.tel, aviso); if (r.ok) alStaff++; }
    } catch (e) { }
    await enviarWA('5218120066355', aviso + (alStaff ? '\n(avisado también al vendedor asignado ✓)' : '')).catch(() => { });
    return true;
}

// ══ CANCELACIÓN — UNA MÁQUINA para todo trigger (orden owner 2026-07-18, dibujo
// "mismo funcionamiento"): el WhatsApp del comprador Y el botón manual del Calendar
// entran AQUÍ. Marca la fila del match y avisa al DUEÑO con EL MISMO texto de
// siempre — misma naturaleza, distinto timbre.
async function ejecutarCancelacion(M) {
    await run("UPDATE citas_match SET estado='cancelada', updated=? WHERE id=?", [Date.now(), M.id]);
    const ctx = { dueno: (M.dueno || '').split(/\s+/)[0], fecha: M.fecha, hora: M.hora };
    await enviarWA(M.dueno_tel, MSJ.canceladaVendedor(ctx));
    return true;
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
    const t10d = tel10(dueno_tel);
    if (!t10d) return null;
    const rows = await query("SELECT * FROM citas_match WHERE estado IN ('solicitud','contrapropuesta','esperando_horario','match') AND dueno_tel LIKE ? ORDER BY updated DESC", ['%' + t10d]);
    const M = rows.find(r => tel10(r.dueno_tel) === t10d);
    if (!M) return null;
    if (esConf && M.estado !== 'match' && M.cita_ts) {
        // ══ LA SEÑAL TRAE LA VERDAD (owner 2026-07-13): si tu "cita confirmada" menciona
        // OTRA fecha/hora (tú ya coordinaste), ESA gana — se actualiza máquina, canónica,
        // CRM y Calendar ANTES del match; la confianza al comprador sale con la nueva.
        try {
            const fh = parseFechaHoraTexto(texto);
            if (fh && (fh.fecha || fh.hora)) {
                const nf = fh.fecha || M.fecha, nh = fh.hora || M.hora;
                const nts = resolverCitaTs(nf, nh);
                if (nts && Math.abs(nts - Number(M.cita_ts)) > 60000) {
                    M.fecha = nf; M.hora = nh; M.cita_ts = nts;
                    await run("UPDATE citas_match SET fecha=?, hora=?, cita_ts=?, updated=? WHERE id=?", [nf, nh, nts, Date.now(), M.id]);
                    await registrarCitaCanonica({ telefono: M.comprador_tel, fecha: nf, hora: nh });
                    const iso = tsAIsoHora(nts);
                    const t10 = tel10(M.comprador_tel);
                    try {
                        const cr = await query("SELECT id FROM citas WHERE comprador_telefono LIKE ? AND estado='agendada' ORDER BY id DESC LIMIT 1", ['%' + t10]);
                        if (cr.length) {
                            await run("UPDATE citas SET fecha=?, hora=?, fecha_hora=?, updated_at=? WHERE id=?", [iso.fecha_iso, iso.hora_hhmm, iso.fecha_iso + ' ' + iso.hora_hhmm + ':00', Date.now(), cr[0].id]);
                            await fetch((process.env.SALES_BRAIN_URL || 'https://sales-brain-theta.vercel.app') + '/api/upload?_gaction=sync_one&cita_id=' + cr[0].id).catch(() => { });
                        }
                    } catch (e) { }
                }
            }
        } catch (e) { console.error('[senal hora]', e.message); }
        await ejecutarMatch(M);
        return { senal: 'confirmada' };
    }
    if (esCanc) {
        await run("UPDATE citas_match SET estado='cancelada', updated=? WHERE id=?", [Date.now(), M.id]);
        const ctx = { nombre: (M.comprador_nombre || '').split(/\s+/)[0] || 'amigo', fecha: M.fecha, hora: M.hora };
        for (const s of MSJ.canceladaPorVendedorComprador(ctx)) await enviarWA(M.comprador_tel, s, M.tenant_id);
        return { senal: 'cancelada' };
    }
    return null;
}

// ══ CIERRE DEL OWNER (human in the loop, 2026-07-13): en POSESIÓN el owner cierra
// la cita ÉL con "cita confirmada" + día/hora/auto/precio EN CUALQUIER ORDEN y forma
// (número o letra: "mañana viernes", "a la una y media"). Aquí se extraen fecha y
// hora 100% DETERMINISTAS — importa la verdad, no el formato. Cero IA.
const HORA_LETRA = { una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 };
function parseFechaHoraTexto(texto) {
    const t = norm(texto);
    let fecha = null, m;
    m = t.match(/\b(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/);
    if (m) fecha = m[0];
    if (!fecha) { m = t.match(/\bel (\d{1,2})\b/); if (m) fecha = m[0]; }
    if (!fecha) { m = t.match(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/); if (m) fecha = m[1]; }
    if (!fecha && /\bpasado ?manana\b/.test(t)) fecha = 'pasado mañana';
    if (!fecha && /\bmanana\b/.test(t)) fecha = 'mañana';
    if (!fecha && /\b(hoy|ahorita)\b/.test(t)) fecha = 'hoy';
    let hora = null;
    m = t.match(/\ba las? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    if (!m) { const x = t.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/); if (x) m = [x[0], x[1], x[2], x[3]]; }
    if (!m) { const x = t.match(/\b(\d{1,2})\s*(am|pm)\b/); if (x) m = [x[0], x[1], null, x[2]]; }
    if (m && Number(m[1]) >= 0 && Number(m[1]) <= 23) hora = m[1] + (m[2] ? ':' + m[2] : '') + (m[3] || '');
    if (!hora) {
        m = t.match(/\ba las? (una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)(?:\s+y\s+(media|cuarto))?(?:\s+de la\s+(tarde|noche|manana))?\b/);
        if (m) hora = HORA_LETRA[m[1]] + (m[2] === 'media' ? ':30' : m[2] === 'cuarto' ? ':15' : '') + (m[3] === 'manana' ? 'am' : m[3] ? 'pm' : '');
    }
    return { fecha, hora };
}
function parseCierreOwner(texto) {
    const t = norm(texto);
    if (t.indexOf('cita confirmada') === -1) return null;
    const fh = parseFechaHoraTexto(texto);
    if (!fh.fecha || !fh.hora) return null;
    const ts = resolverCitaTs(fh.fecha, fh.hora);
    if (!ts || ts < Date.now() - 3600000) return null;
    return { fecha: fh.fecha, hora: fh.hora, cita_ts: ts };
}

// ══════════ LA MÁQUINA DEL CIERRE — LÓGICA DEL TIMBRE (orden owner 2026-07-16) ══════════
// "cita confirmada ✅" → PUERTA ÚNICA ejecutarCierre (el TIMBRE del puente y el
// BARREDOR del cron entran por aquí — idempotente, jamás duplica) → PAQUETE completo
// con CÓDIGO (fecha/hora del parse determinista + AUTO por cascada; la IA no está en
// el camino crítico) → verificación → cita_jobs con CASILLAS (cita CRM + Calendar +
// solicitud al dueño) que se REINTENTAN hasta palomear → acuse honesto (ejecutada
// completa / falta el auto / atorada con motivo — jamás silencio).
// Nació del caso Alejandra/Mazda 3: el extractor viejo re-leía la fecha con Sonnet
// en texto libre, sin reintento, y un null/529 mataba todo sin ejecutar nada.
const SALES_BRAIN_URL = process.env.SALES_BRAIN_URL || 'https://sales-brain-theta.vercel.app';
const OWNER_TEL = '5218120066355';

async function ensureCitaJobs() {
    if (_ensCJ) return;
    _ensCJ = true;
    await run(`CREATE TABLE IF NOT EXISTS cita_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, telefono TEXT, nombre TEXT,
        fecha_iso TEXT, hora_hhmm TEXT, cita_ts INTEGER,
        auto_inv_id INTEGER, auto_nombre TEXT, opciones TEXT,
        estado TEXT, intentos INTEGER DEFAULT 0, ultimo_error TEXT,
        sb_cita_id INTEGER, gcal_ok INTEGER DEFAULT 0, solicitud_ok INTEGER DEFAULT 0,
        aviso_atorado INTEGER DEFAULT 0, created INTEGER, updated INTEGER)`);
}

// Resolver el auto de un CIERRE contra el inventario, con el AÑO como desempate
// (el resolver general solo veta por año; aquí "mazda 3 2018" con dos Mazda 3
// activos SÍ se resuelve — el del 2018). Único o nada; empate → candidatos para
// preguntarle al owner con lista numerada.
function resolverAutoCierre(texto, autos) {
    const t = norm(texto);
    const anioM = t.match(/\b(19|20)\d{2}\b/);
    const anio = anioM ? Number(anioM[0]) : null;
    const cands = [];
    for (const a of autos) {
        const toks = norm(a.nombre).split(/\s+/).filter(w => (w.length >= 3 || /[a-z]\d|\d[a-z]/.test(w)) && !/^\d+$/.test(w));
        const hits = toks.filter(tok => t.includes(tok)).length;
        if (!hits) continue;
        if (anio && a.anio && Number(a.anio) !== anio) continue;
        cands.push({ a, hits });
    }
    if (!cands.length) return { auto: null, candidatos: [] };
    const top = Math.max(...cands.map(c => c.hits));
    const tops = cands.filter(c => c.hits === top).map(c => c.a);
    return tops.length === 1 ? { auto: tops[0], candidatos: tops } : { auto: null, candidatos: tops };
}

// ── LA PUERTA ÚNICA: arma el paquete, verifica y dispara las casillas ──
async function ejecutarCierre({ tel, texto, ts, origen }) {
    tel = String(tel || '').replace(/\D/g, '');
    if (!tel || esTelPrueba(tel)) return { ok: false, motivo: 'tel_prueba' };
    const cierre = parseCierreOwner(texto);
    if (!cierre) return { ok: false, motivo: 'no_es_cierre' };
    // ══ CHAT DE DUEÑO (auditoría D2, caso cita #125 Cantisani): "cita confirmada"
    // en el chat de un DUEÑO es SEÑAL del match (senalManual la ejecuta), NO un
    // cierre de comprador — jamás crear una cita con el dueño como comprador.
    try {
        const esD = await query("SELECT 1 FROM inventario_autos WHERE replace(replace(COALESCE(dueno_telefono,''),'+',''),' ','') LIKE ? LIMIT 1", ['%' + tel.slice(-10)]);
        if (esD.length) return { ok: false, motivo: 'chat de dueño — es señal del match, no cierre de comprador' };
    } catch (e) { }
    await ensureCanonica(); await ensureCitaJobs();
    // CANDADO IDEMPOTENTE: una canónica posterior al mensaje = este cierre ya entró
    // (así el timbre y el barredor pueden disparar los dos sin duplicar nada).
    const msgTs = Number(ts || Date.now());
    const ya = await query("SELECT id FROM cita_canonica WHERE telefono LIKE ? AND created > ?", ['%' + tel.slice(-10), msgTs]);
    if (ya.length) return { ok: false, motivo: 'ya_ejecutado' };
    await registrarCitaCanonica({ telefono: tel, fecha: cierre.fecha, hora: cierre.hora });
    const iso = tsAIsoHora(cierre.cita_ts);
    let nombre = null;
    try { const c = await query("SELECT nombre FROM conversaciones WHERE channel_thread_id=? LIMIT 1", ['whatsapp:' + tel]); nombre = c.length ? c[0].nombre : null; } catch (e) { }

    // ══ EL AUTO — cascada de CÓDIGO: ① el cierre lo nombra ② memoria del bot
    // ③ la última ficha/mención en los mensajes del chat. Duda → pregunta, no adivina.
    const autosAct = (await query("SELECT id, marca, modelo, version, anio, precio, dueno_nombre, dueno_telefono FROM inventario_autos WHERE estado='activo'"))
        .map(a => ({ ...a, nombre: [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' ') }));
    let r = resolverAutoCierre(texto, autosAct);
    if (!r.auto) {
        try {
            const wc = await query("SELECT auto_id_activo FROM wa_conversations WHERE telefono=?", [tel]);
            if (wc[0] && wc[0].auto_id_activo) { const a = autosAct.find(x => x.id === Number(wc[0].auto_id_activo)); if (a) r = { auto: a, candidatos: [a] }; }
        } catch (e) { }
    }
    if (!r.auto) {
        try {
            const cv = await query("SELECT id FROM conversaciones WHERE channel_thread_id=? LIMIT 1", ['whatsapp:' + tel]);
            if (cv.length) {
                const outs = await query("SELECT texto FROM mensajes WHERE conversacion_id=? AND direccion='out' ORDER BY ts DESC LIMIT 30", [cv[0].id]);
                for (const m of outs) { const rm = resolverAutoCierre(String(m.texto || ''), autosAct); if (rm.auto) { r = rm; break; } }
            }
        } catch (e) { }
    }

    const now = Date.now();
    if (!r.auto) {
        // SIN AUTO → job en espera + pregunta al owner (contesta "cita auto 1" o "cita auto <nombre año>")
        const ops = (r.candidatos || []).slice(0, 5).map(a => ({ id: a.id, nombre: a.nombre }));
        await run(`INSERT INTO cita_jobs (telefono, nombre, fecha_iso, hora_hhmm, cita_ts, auto_inv_id, auto_nombre, opciones, estado, created, updated)
                   VALUES (?,?,?,?,?,NULL,NULL,?,'sin_auto',?,?)`,
            [tel, nombre, iso.fecha_iso, iso.hora_hhmm, cierre.cita_ts, ops.length ? JSON.stringify(ops) : null, now, now]);
        const lista = ops.length ? ('\n' + ops.map((o, i) => (i + 1) + ') ' + o.nombre).join('\n') + '\nContesta: cita auto 1 (o el número)') : '\nContesta: cita auto <marca modelo año>';
        await enviarWA(OWNER_TEL, '🤝 Recibí tu cierre (' + (nombre || tel.slice(-10)) + ', ' + cierre.fecha + ' ' + iso.hora_hhmm + ') pero no pude amarrar el AUTO.' + lista);
        return { ok: true, estado: 'sin_auto' };
    }

    const ins = await run(`INSERT INTO cita_jobs (telefono, nombre, fecha_iso, hora_hhmm, cita_ts, auto_inv_id, auto_nombre, estado, created, updated)
               VALUES (?,?,?,?,?,?,?,'pendiente',?,?)`,
        [tel, nombre, iso.fecha_iso, iso.hora_hhmm, cierre.cita_ts, r.auto.id, r.auto.nombre, now, now]);
    const jobId = Number(ins.lastInsertRowid);
    // primer intento AL INSTANTE (el timbre da la velocidad); si algo falla, el
    // barredor lo reintenta cada 10 min (la garantía).
    const done = await ejecutarCitaJobs(jobId);
    if (!done) await enviarWA(OWNER_TEL, '🤝 Recibí tu cierre: ' + r.auto.nombre + ' — ' + cierre.fecha + ' ' + iso.hora_hhmm + ' (' + (nombre || tel.slice(-10)) + '). Casillas pendientes; reintento cada 10 min hasta completar.');
    return { ok: true, estado: done ? 'hecho' : 'pendiente', job: jobId };
}

// ── LAS CASILLAS: ejecuta lo pendiente contra Sales Brain (brazo que solo escribe)
// y reintenta hasta palomear. Acuse final SOLO cuando TODO quedó. ──
async function ejecutarCitaJobs(soloJobId) {
    await ensureCitaJobs();
    const rows = soloJobId
        ? await query("SELECT * FROM cita_jobs WHERE id=? AND estado='pendiente'", [soloJobId])
        : await query("SELECT * FROM cita_jobs WHERE estado='pendiente'");
    let completos = 0;
    for (const J of rows) {
        try {
            const resp = await fetch(SALES_BRAIN_URL + '/api/upload', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'registrar_cita_canonica', key: process.env.SELLER_BRIDGE_KEY || 'fyra-bridge-v2-2026',
                    phone: J.telefono, nombre: J.nombre, fecha_iso: J.fecha_iso, hora: J.hora_hhmm,
                    inv_auto_id: J.auto_inv_id, auto_nombre: J.auto_nombre
                })
            });
            const d = await resp.json().catch(() => null);
            if (resp.ok && d && d.ok && d.cita_id && d.gcal_ok && (d.solicitud_ok || d.solicitud_na)) {
                await run("UPDATE cita_jobs SET estado='hecho', sb_cita_id=?, gcal_ok=1, solicitud_ok=?, updated=? WHERE id=?", [d.cita_id, d.solicitud_ok ? 1 : 0, Date.now(), J.id]);
                await enviarWA(OWNER_TEL, '✅ Cita ejecutada COMPLETA: ' + (J.auto_nombre || 'auto') + ' — ' + J.fecha_iso + ' ' + J.hora_hhmm + ' con ' + (J.nombre || J.telefono.slice(-10)) + ' — CRM ✓ Calendar ✓ ' + (d.solicitud_na ? '(⚠️ el auto no tiene teléfono de dueño registrado: solicitud no aplicó)' : 'solicitud al dueño ✓'));
                completos++;
            } else {
                const err = (d && (d.error || d.reason || ('parcial: cita=' + (d.cita_id || 'no') + ' gcal=' + (d.gcal_ok ? 'sí' : 'no') + ' solicitud=' + (d.solicitud_ok ? 'sí' : 'no')))) || ('http ' + resp.status);
                await run("UPDATE cita_jobs SET sb_cita_id=COALESCE(?, sb_cita_id), gcal_ok=MAX(gcal_ok, ?), solicitud_ok=MAX(solicitud_ok, ?), intentos=intentos+1, ultimo_error=?, updated=? WHERE id=?",
                    [(d && d.cita_id) || null, (d && d.gcal_ok) ? 1 : 0, (d && d.solicitud_ok) ? 1 : 0, String(err).slice(0, 250), Date.now(), J.id]);
            }
        } catch (e) {
            await run("UPDATE cita_jobs SET intentos=intentos+1, ultimo_error=?, updated=? WHERE id=?", [String(e.message).slice(0, 250), Date.now(), J.id]);
        }
        // atorada tras 4 intentos → aviso UNA vez (y se sigue reintentando por siempre)
        try {
            const jj = (await query("SELECT * FROM cita_jobs WHERE id=?", [J.id]))[0];
            if (jj && jj.estado === 'pendiente' && Number(jj.intentos) >= 4 && !Number(jj.aviso_atorado)) {
                await run("UPDATE cita_jobs SET aviso_atorado=1, updated=? WHERE id=?", [Date.now(), J.id]);
                await enviarWA(OWNER_TEL, '⚠️ Cita ATORADA (' + (jj.auto_nombre || 'auto') + ' ' + jj.fecha_iso + ' ' + jj.hora_hhmm + '): ' + (jj.ultimo_error || 'sin detalle') + ' — sigo reintentando cada 10 min');
            }
        } catch (e) { }
    }
    return completos;
}

// ── RESPUESTA DEL OWNER a "no pude amarrar el auto": "cita auto 1" / "cita auto mazda 3 2018" ──
async function respuestasCierre() {
    await ensureCitaJobs();
    const jobs = await query("SELECT * FROM cita_jobs WHERE estado='sin_auto' ORDER BY id DESC LIMIT 5");
    if (!jobs.length) return 0;
    const cv = await query("SELECT id FROM conversaciones WHERE channel_thread_id=? LIMIT 1", ['whatsapp:' + OWNER_TEL]);
    if (!cv.length) return 0;
    let resueltos = 0;
    for (const J of jobs) {
        const ms = await query("SELECT texto FROM mensajes WHERE conversacion_id=? AND direccion='in' AND ts > ? ORDER BY ts ASC", [cv[0].id, Number(J.updated)]);
        for (const m of ms) {
            const mm = String(m.texto || '').match(/^\s*cita auto\s*[:=]?\s*(.+)/i);
            if (!mm) continue;
            let auto = null;
            const resto = mm[1].trim();
            let ops = []; try { ops = JSON.parse(J.opciones || '[]'); } catch (e) { }
            if (/^\d+$/.test(resto) && ops[Number(resto) - 1]) auto = ops[Number(resto) - 1];
            else {
                const autosAct = (await query("SELECT id, marca, modelo, version, anio FROM inventario_autos WHERE estado='activo'"))
                    .map(a => ({ ...a, nombre: [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' ') }));
                const rr = resolverAutoCierre(resto, autosAct);
                if (rr.auto) auto = rr.auto;
            }
            if (auto) {
                await run("UPDATE cita_jobs SET auto_inv_id=?, auto_nombre=?, estado='pendiente', updated=? WHERE id=?", [auto.id, auto.nombre, Date.now(), J.id]);
                await ejecutarCitaJobs(J.id);
                resueltos++;
                break;
            }
        }
    }
    return resueltos;
}

// ── EL BARREDOR (red de seguridad del timbre): mensajes "cita confirmada" manuales
// recientes → la MISMA puerta (el candado idempotente evita duplicados). ──
async function cierresOwner() {
    const rows = await query(
        "SELECT m.id, m.texto, m.ts, c.telefono FROM mensajes m JOIN conversaciones c ON c.id = m.conversacion_id WHERE m.direccion='out' AND COALESCE(m.ai_generated,0)=0 AND m.ts > ? AND lower(m.texto) LIKE '%cita confirmada%' AND m.msg_id NOT LIKE 'sbx_%' ORDER BY m.ts ASC",
        [Date.now() - 30 * 60000]);
    let ejecutados = 0;
    for (const r of rows) {
        try {
            const res = await ejecutarCierre({ tel: r.telefono, texto: r.texto, ts: r.ts, origen: 'barredor' });
            if (res.ok) ejecutados++;
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
            // CUOTA TURSO: búsqueda EXACTA por hilo (UNIQUE) y por teléfono (índice) en las 3 formas
            // (521/52/10 dígitos) — antes LIKE '%…' recorría la tabla conversaciones completa por cada fila viva, cada 10 min.
            const cv = await query("SELECT id FROM conversaciones WHERE channel_thread_id IN (?,?,?) OR telefono IN (?,?,?) LIMIT 1",
                ['whatsapp:521' + dt, 'whatsapp:52' + dt, 'whatsapp:' + dt, '521' + dt, '52' + dt, dt]);
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
    // LÓGICA DEL TIMBRE: el barredor reintenta las casillas pendientes y recoge
    // las respuestas "cita auto N" del owner — hasta palomear todo.
    let jobs = 0;
    try { jobs = await ejecutarCitaJobs(); } catch (e) { console.error('[cron cita_jobs]', e.message); }
    try { await respuestasCierre(); } catch (e) { console.error('[cron respuestas cierre]', e.message); }
    let cargas = 0;
    try { cargas = await require('./carga-lote.js').barrerCargas(); } catch (e) { console.error('[cron cargas]', e.message); }
    const now = Date.now();
    const rows = await query("SELECT * FROM citas_match WHERE estado='match'");
    let enviados = 0;
    for (const M of rows) {
        let recs; try { recs = JSON.parse(M.recordatorios || '[]'); } catch (e) { continue; }
        let dirty = false;
        for (const r of recs) {
            if (!r.enviado && r.ts <= now) {
                const tel = r.para === 'vendedor' ? M.dueno_tel : M.comprador_tel;
                const res = await enviarWA(tel, r.texto, r.para === 'vendedor' ? 0 : M.tenant_id);
                if (res.ok) { r.enviado = 1; dirty = true; enviados++; }
            }
        }
        if (dirty) await run("UPDATE citas_match SET recordatorios=?, updated=? WHERE id=?", [JSON.stringify(recs), Date.now(), M.id]);
        // cita ya pasó hace 3h+ → cerrar el ciclo
        if (Number(M.cita_ts) && now > Number(M.cita_ts) + 3 * 3600000) {
            await run("UPDATE citas_match SET estado='vencida', updated=? WHERE id=?", [Date.now(), M.id]);
        }
    }
    // recordatorios del VENDEDOR asignado (staff) — misma barrida
    let staff_enviados = 0;
    try { staff_enviados = await tickStaff(); } catch (e) { console.error('[tickStaff]', e.message); }
    return { ok: true, matches: rows.length, enviados, staff_enviados, senales, cierres, cita_jobs: jobs, cargas };
}

// ══════════ LA FECHA CANÓNICA (🚩fyrachat#7 — orden owner: "única, inamovible, SIN IA") ══════════
// Cuando el CERRADOR confirma una cita, aquí queda la fecha/hora EXACTAS que el
// comprador aceptó. El cita-extractor las usa TAL CUAL (jamás re-adivina con IA).
async function ensureCanonica() {
    if (_ensCan) return;
    _ensCan = true;
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

// ══════════ VENDEDOR ASIGNADO A LA CITA (orden owner 2026-08-25, caso Mario Cruz) ══════════
// El owner puede AGREGAR un vendedor (su staff) a una cita ya confirmada. Se maneja
// igual que el dueño pero en su papel: invitación "¿me confirmas?", confirma él por
// WhatsApp o el owner desde el Calendar, y ya confirmado recibe víspera, día D y
// "el comprador va en camino". Mismo rodaje del match, otra silla.
async function ensureCitaVendedores() {
    if (_ensCV) return;
    _ensCV = true;
    await run(`CREATE TABLE IF NOT EXISTS cita_vendedores (
        id INTEGER PRIMARY KEY AUTOINCREMENT, cita_id INTEGER, comprador_tel TEXT,
        nombre TEXT, tel TEXT, auto_nombre TEXT, fecha TEXT, hora TEXT, cita_ts INTEGER,
        estado TEXT, recordatorios TEXT, created INTEGER, updated INTEGER)`);
    await run("CREATE INDEX IF NOT EXISTS idx_cv_tel ON cita_vendedores(tel, estado)").catch(() => { });
}

const DIAS_STAFF = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function staffCtx(V) {
    return { nombre: (V.nombre || '').split(/\s+/)[0], auto: V.auto_nombre ? ' del ' + V.auto_nombre : '', hora: V.hora, fecha: V.fecha };
}
function staffPlan(V) {
    const c = sh(Number(V.cita_ts)), ahora = Date.now();
    const x = staffCtx(V);
    const R = [];
    const add = (k, ts, texto) => { if (ts > ahora + 60000 && ts < Number(V.cita_ts) + 1) R.push({ k, ts, para: 'staff', texto, enviado: 0 }); };
    add('vispera', Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate() - 1, 20, 0) + MTY_OFF,
        `Qué tal ${x.nombre}, buenas noches. Te recuerdo que mañana a las ${x.hora} tienes la cita${x.auto}. Yo te aviso por aquí los movimientos 👍`);
    add('dia', Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate(), 9, 30) + MTY_OFF,
        `Buen día ${x.nombre}. Hoy a las ${x.hora} es la cita${x.auto}. Te aviso en cuanto el comprador vaya en camino 👍`);
    return R.sort((a, b) => a.ts - b.ts);
}

// Invitar (desde el Calendar): guarda la silla y manda el "¿me confirmas?"
async function staffInvitar({ cita_id, nombre, tel }) {
    await ensureCitaVendedores();
    const telV = String(tel || '').replace(/\D/g, '');
    const tel12 = telV.length === 10 ? '521' + telV : telV;
    if (!tel12) return { ok: false, error: 'teléfono inválido' };
    const cRows = await query('SELECT * FROM citas WHERE id = ? LIMIT 1', [Number(cita_id)]);
    if (!cRows.length) return { ok: false, error: 'cita no encontrada' };
    const cita = cRows[0];
    const [yy, mm, dd] = String(cita.fecha).split('-').map(Number);
    const hm2 = String(cita.hora || '').match(/(\d{1,2}):(\d{2})/);
    const citaTs = (yy && hm2) ? (Date.UTC(yy, mm - 1, dd, Number(hm2[1]), Number(hm2[2])) + 6 * 3600000) : null;
    const hh = Number(hm2 ? hm2[1] : 0), mi = Number(hm2 ? hm2[2] : 0);
    const horaHum = (hh % 12 === 0 ? 12 : hh % 12) + (mi ? ':' + String(mi).padStart(2, '0') : '') + (hh < 12 ? 'am' : 'pm');
    const diaNom = citaTs ? DIAS_STAFF[sh(citaTs).getUTCDay()] : '';
    // silla única por cita+tel (idempotente)
    const ya = await query('SELECT id, estado FROM cita_vendedores WHERE cita_id=? AND tel=?', [Number(cita_id), tel12]);
    let vid;
    if (ya.length) vid = ya[0].id;
    else {
        const ins = await run(`INSERT INTO cita_vendedores (cita_id, comprador_tel, nombre, tel, auto_nombre, fecha, hora, cita_ts, estado, created, updated)
                   VALUES (?,?,?,?,?,?,?,?,'invitado',?,?)`,
            [Number(cita_id), String(cita.comprador_telefono || ''), nombre || null, tel12, cita.auto_nombre || null, diaNom, horaHum, citaTs, Date.now(), Date.now()]);
        vid = Number(ins.lastInsertRowid);
    }
    const nom = (nombre || '').split(/\s+/)[0];
    const txt = `Hola${nom ? ' ' + nom : ''}, tienes cita confirmada${diaNom ? ' el ' + diaNom : ''} a las ${horaHum}${cita.auto_nombre ? ' para el ' + cita.auto_nombre : ''}${cita.punto_nombre ? ' ahí en ' + cita.punto_nombre : ''}. ¿Me confirmas de favor? Por aquí te aviso los movimientos 👍`;
    const env = await enviarWA(tel12, txt);
    return { ok: true, id: vid, enviado: env.ok, texto: txt };
}

// Confirmar la silla (el vendedor por WhatsApp, o el owner desde el Calendar)
async function staffConfirmar(vid) {
    await ensureCitaVendedores();
    const V = (await query('SELECT * FROM cita_vendedores WHERE id=?', [Number(vid)]))[0];
    if (!V) return { ok: false, error: 'no existe' };
    if (V.estado !== 'confirmado') {
        await run("UPDATE cita_vendedores SET estado='confirmado', recordatorios=?, updated=? WHERE id=?",
            [JSON.stringify(staffPlan(V)), Date.now(), V.id]);
    }
    return { ok: true, id: V.id, nombre: V.nombre };
}

// El VENDEDOR asignado contesta por WhatsApp: sí → confirma; no → escala; resto → escala.
async function manejarMensajeStaff(tel, texto) {
    await ensureCitaVendedores();
    const t10 = String(tel || '').replace(/\D/g, '').slice(-10);
    if (!t10) return null;
    // CUOTA TURSO: filtro por teléfono en SQL (corre en CADA mensaje entrante); el find exacto se conserva
    const filas = await query("SELECT * FROM cita_vendedores WHERE estado IN ('invitado','confirmado') AND updated > ? AND tel LIKE ? ORDER BY updated DESC", [Date.now() - 30 * 86400000, '%' + t10]);
    const V = filas.find(v => String(v.tel || '').replace(/\D/g, '').slice(-10) === t10);
    if (!V) return null;
    const tN = norm(texto);
    if (V.estado === 'invitado') {
        if (/(^|\s)(si|sí|claro|va|dale|ok|okey|confirmo|confirmado|listo|de acuerdo|ahi estare|ahi estoy|perfecto|sale)(\s|$|!|\.)/. test(' ' + tN + ' ')) {
            await staffConfirmar(V.id);
            const nom = (V.nombre || '').split(/\s+/)[0];
            await enviarWA('5218120066355', `✅ ${V.nombre || 'El vendedor'} confirmó la cita de las ${V.hora}${V.auto_nombre ? ' (' + V.auto_nombre + ')' : ''}.`).catch(() => { });
            return [`Perfecto${nom ? ' ' + nom : ''}, quedamos 👍 Por aquí te aviso los movimientos.`];
        }
        if (/(no (puedo|voy|podre|alcanzo)|imposible|no me queda|cancel)/.test(tN)) {
            await run("UPDATE cita_vendedores SET estado='rechazo', updated=? WHERE id=?", [Date.now(), V.id]);
            await enviarWA('5218120066355', `⚠️ ${V.nombre || 'El vendedor'} (${t10}) NO puede con la cita de las ${V.hora}: "${String(texto).slice(0, 100)}" — asigna a alguien más o ve tú.`).catch(() => { });
            return ['Entendido, gracias por avisarme 👍'];
        }
    }
    // cualquier otra cosa del staff → se escala al owner y el bot CALLA (regresa []
    // = "es staff, no sigas al flujo de comprador"; null = "no es staff")
    await enviarWA('5218120066355', `💬 ${V.nombre || 'Vendedor'} (cita ${V.hora}${V.auto_nombre ? ', ' + V.auto_nombre : ''}): «${String(texto).slice(0, 140)}»`).catch(() => { });
    return [];
}

// Barrido de recordatorios del staff (lo llama tickRecordatorios)
async function tickStaff() {
    await ensureCitaVendedores();
    const now = Date.now();
    const rows = await query("SELECT * FROM cita_vendedores WHERE estado='confirmado'");
    let enviados = 0;
    for (const V of rows) {
        let recs; try { recs = JSON.parse(V.recordatorios || '[]'); } catch (e) { continue; }
        let dirty = false;
        for (const r of recs) {
            if (!r.enviado && r.ts <= now) {
                const res = await enviarWA(V.tel, r.texto);
                if (res.ok) { r.enviado = 1; dirty = true; enviados++; }
            }
        }
        if (dirty) await run("UPDATE cita_vendedores SET recordatorios=?, updated=? WHERE id=?", [JSON.stringify(recs), Date.now(), V.id]);
        if (Number(V.cita_ts) && now > Number(V.cita_ts) + 3 * 3600000) {
            await run("UPDATE cita_vendedores SET estado='vencida', updated=? WHERE id=?", [Date.now(), V.id]);
        }
    }
    return enviados;
}

async function staffLista(cita_id) {
    await ensureCitaVendedores();
    return query("SELECT id, nombre, tel, estado FROM cita_vendedores WHERE cita_id=? ORDER BY id", [Number(cita_id)]);
}

module.exports = {
    // puras (compartidas con el sandbox)
    parseHora, resolverCitaTs, mismaHora, mismaFecha, planRecordatorios,
    clasificarVendedor, clasificarCancelacion, MSJ,
    // producción
    ensureCitasMatch, enviarWA, registrarSolicitud, registrarCitaCanonica, tsAIsoHora,
    manejarMensajeDueno, manejarMensajeComprador, intentarMatchDirecto, senalManual, tickRecordatorios, parseCierreOwner, cierresOwner, ejecutarMatch, parseFechaHoraTexto,
    // máquina del cierre (lógica del timbre)
    ejecutarCierre, ejecutarCitaJobs, respuestasCierre, resolverAutoCierre, ejecutarCancelacion,
    // puerta del Calendar (dueño ya confirmado por el owner)
    matchDirectoCalendar,
    // vendedor asignado a la cita (staff)
    staffInvitar, staffConfirmar, staffLista, manejarMensajeStaff, tickStaff };
