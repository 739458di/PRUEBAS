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
const U = require('./universo.js');   // ETAPA 2

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
    await ensureDireccionCitas();
}

// ══════════ DIRECCIÓN COMPLETA DE LA CITA (orden owner 2026-09-08: universo → chat → delegación) ══════════
// citas / citas_match / cita_vendedores ganan la dirección; las búsquedas por teléfono (LIKE '%tel10',
// que recorren la tabla completa) se reemplazan por (tenant_id, chat_id, estado) con índice.
// dueno_chat_id = el chat del DUEÑO en el universo 0 (el bot Fyradrive le habla a él).
// cita_casillas = LA VERDAD de los recordatorios (una fila por envío; estado idempotente).
let _ensDir = null;
function ensureDireccionCitas() {
    if (_ensDir) return _ensDir;
    _ensDir = (async () => {
        for (const c of ['tenant_id INTEGER', 'chat_id INTEGER', 'delegacion_id INTEGER', 'dueno_chat_id INTEGER'])
            await run('ALTER TABLE citas_match ADD COLUMN ' + c).catch(() => { });
        await run('CREATE INDEX IF NOT EXISTS idx_cm_dir ON citas_match(tenant_id, chat_id, estado)').catch(() => { });
        await run('CREATE INDEX IF NOT EXISTS idx_cm_dueno_chat ON citas_match(dueno_chat_id, estado)').catch(() => { });
        await run('CREATE INDEX IF NOT EXISTS idx_cm_estado_cita ON citas_match(estado, cita_ts)').catch(() => { });
        for (const c of ['tenant_id INTEGER', 'chat_id INTEGER', 'delegacion_id INTEGER'])
            await run('ALTER TABLE citas ADD COLUMN ' + c).catch(() => { });
        await run('CREATE INDEX IF NOT EXISTS idx_citas_dir ON citas(tenant_id, chat_id, estado)').catch(() => { });
        await run(`CREATE TABLE IF NOT EXISTS cita_casillas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cita_match_id INTEGER, staff_id INTEGER, cita_id INTEGER,
            tenant_id INTEGER NOT NULL DEFAULT 0, chat_id INTEGER,
            tipo TEXT NOT NULL, para TEXT NOT NULL,
            tel TEXT, due_ts INTEGER NOT NULL, texto TEXT NOT NULL,
            estado TEXT NOT NULL DEFAULT 'pendiente',
            intentos INTEGER NOT NULL DEFAULT 0, enviado_ts INTEGER, error TEXT,
            created INTEGER NOT NULL, updated INTEGER)`);
        await run('CREATE INDEX IF NOT EXISTS idx_casillas_estado_due ON cita_casillas(estado, due_ts)');
        await run('CREATE INDEX IF NOT EXISTS idx_casillas_match ON cita_casillas(cita_match_id, estado)');
        await run('CREATE INDEX IF NOT EXISTS idx_casillas_staff ON cita_casillas(staff_id, estado)');
        return true;
    })().catch(e => { _ensDir = null; throw e; });
    return _ensDir;
}

// direccionDe(tenantId, tel, { crear }) → { tenant_id, chat_id, delegacion_id } (2 lecturas de 1 fila por índice).
// Sin chat → chat_id null (se reporta; jamás se inventa un chat para un número sin forma MX).
async function direccionDe(tenantId, tel, opts) {
    const t = Number(tenantId) || 0;
    const out = { tenant_id: t, chat_id: null, delegacion_id: null };
    try {
        const chat = await U.chatDe(t, tel, { crear: !!(opts && opts.crear) });
        if (!chat) return out;
        out.chat_id = Number(chat.id);
        const d = await U.delegacionActiva(chat.id);
        if (d) out.delegacion_id = Number(d.id);
    } catch (e) { console.error('[direccionDe]', e.message); }
    return out;
}
// chat del dueño en el universo 0 (1 lectura)
async function chatIdDueno(dueno_tel) {
    try { const c = await U.chatDe(0, dueno_tel); return c ? Number(c.id) : null; } catch (e) { return null; }
}
const ESTADOS_VIVOS = ['solicitud', 'contrapropuesta', 'esperando_horario', 'match', 'pausada', 'pausada_staff', 'escalada_manual'];
const ESTADOS_PREVIOS = ['solicitud', 'contrapropuesta', 'esperando_horario'];
// filaViva(tenantId, chatId, estados) → la fila más reciente de ESE chat en esos estados (índice idx_cm_dir)
async function filaViva(tenantId, chatId, estados) {
    await ensureCitasMatch();
    if (chatId == null) return null;
    const est = estados && estados.length ? estados : ESTADOS_VIVOS;
    const rows = await query(`SELECT * FROM citas_match WHERE tenant_id=? AND chat_id=? AND estado IN (${est.map(() => '?').join(',')}) ORDER BY updated DESC LIMIT 1`,
        [Number(tenantId) || 0, Number(chatId)].concat(est));
    return rows[0] || null;
}
// filaVivaDueno(duenoChatId, estados) → la fila viva donde este chat es el DUEÑO (índice idx_cm_dueno_chat)
async function filaVivaDueno(duenoChatId, estados) {
    await ensureCitasMatch();
    if (duenoChatId == null) return null;
    const est = estados && estados.length ? estados : ESTADOS_PREVIOS;
    const rows = await query(`SELECT * FROM citas_match WHERE dueno_chat_id=? AND estado IN (${est.map(() => '?').join(',')}) ORDER BY updated DESC LIMIT 1`,
        [Number(duenoChatId)].concat(est));
    return rows[0] || null;
}

const { tocar: tocarTimbre } = require('./timbre.js');
const ACC = require('./acciones.js');   // acciones por chat (Etapa 2c)
const T = (entidad, id, accion) => tocarTimbre({ entidad, id: id == null ? null : Number(id), accion });   // timbre de cambios
// Enviar WhatsApp via el bridge del VPS. Números de prueba (52100000000x) JAMÁS salen.
async function enviarWA(tel, texto, tenantId) {
    if (esTelPrueba(tel)) return { ok: true, simulado: true };
    const tId = Number(tenantId) || 0;                      // 0 = número de Fyradrive; N = universo del vendedor
    const url = process.env.BRIDGE_SEND_URL || 'http://137.184.199.19:3000/api/send';
    const key = process.env.K_PUENTE || process.env.BRIDGE_API_KEY;   // llave SALIENTE al puente (transición: BRIDGE_API_KEY); sin literal
    if (!key) return { ok: false, error: 'K_PUENTE no configurada' };
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
// La solicitud nace CON dirección: (tenant_id, chat_id, delegacion_id) del comprador + chat del dueño (t0).
async function registrarSolicitud({ comprador_tel, comprador_nombre, dueno_tel, dueno, auto_id, auto_nombre, fecha, hora, cita_ts, tenant_id }) {
    await ensureCitasMatch();
    const ts = cita_ts || resolverCitaTs(fecha, hora);
    const tId = Number(tenant_id) || 0;
    const dir = await direccionDe(tId, comprador_tel, { crear: true });
    const duenoChat = await chatIdDueno(dueno_tel);
    // una solicitud viva por comprador (por dirección): la nueva pisa a la anterior
    if (dir.chat_id != null) await _reemplazarVivas(tId, dir.chat_id, ESTADOS_PREVIOS);
    const ins = await run(`INSERT INTO citas_match (comprador_tel, comprador_nombre, dueno_tel, dueno, auto_id, auto_nombre, fecha, hora, cita_ts, estado, updated, tenant_id, chat_id, delegacion_id, dueno_chat_id)
               VALUES (?,?,?,?,?,?,?,?,?,'solicitud',?,?,?,?,?)`,
        [String(comprador_tel), comprador_nombre || null, String(dueno_tel), dueno || 'Vendedor', auto_id || null, auto_nombre || null, fecha || '', hora || '', ts, Date.now(), tId, dir.chat_id, dir.delegacion_id, duenoChat]);
    const id = Number(ins.lastInsertRowid);
    await T('cita', id, 'solicitud');
    await ACC.registrar({ tenant_id: tId, chat_id: dir.chat_id, delegacion_id: dir.delegacion_id, tipo: 'cita_solicitud', ref_id: id, meta: { fecha, hora, auto: auto_nombre || null, dueno: dueno || null }, actor: 'bot' });
    return { ok: true, id, chat_id: dir.chat_id };
}
// marca 'reemplazada' las filas vivas de un chat y CANCELA sus casillas pendientes (2 UPDATE por índice, sin lecturas)
async function _reemplazarVivas(tenantId, chatId, estados) {
    const est = estados && estados.length ? estados : ESTADOS_VIVOS;
    const ph = est.map(() => '?').join(',');
    const now = Date.now();
    await run(`UPDATE cita_casillas SET estado='cancelada', updated=? WHERE estado IN ('pendiente','pausada') AND cita_match_id IN (SELECT id FROM citas_match WHERE tenant_id=? AND chat_id=? AND estado IN (${ph}))`,
        [now, Number(tenantId) || 0, Number(chatId)].concat(est));
    const u = await run(`UPDATE citas_match SET estado='reemplazada', updated=? WHERE tenant_id=? AND chat_id=? AND estado IN (${ph})`,
        [now, Number(tenantId) || 0, Number(chatId)].concat(est));
    return Number(u.rowsAffected) || 0;
}

// Las tres búsquedas del cerebro, ahora por DIRECCIÓN (1 fila por índice). Las variantes por
// teléfono quedan como puerta de compatibilidad para el tenant 0 (resuelven el chat primero).
async function filaActivaDueno(dueno_tel) { return filaVivaDueno(await chatIdDueno(dueno_tel), ESTADOS_PREVIOS); }
async function filaMatchComprador(comprador_tel, tenantId) { const d = await direccionDe(tenantId || 0, comprador_tel); return filaViva(d.tenant_id, d.chat_id, ['match']); }
async function filaContraComprador(comprador_tel, tenantId) { const d = await direccionDe(tenantId || 0, comprador_tel); return filaViva(d.tenant_id, d.chat_id, ['contrapropuesta']); }

// ══════════ LAS CASILLAS (la verdad de los recordatorios — Ley del Timbre) ══════════
// crearCasillas(M, recs, opts): una fila por envío del plan (MISMOS textos que planRecordatorios).
//   El JSON `recordatorios` de citas_match se sigue escribiendo como FOTO del plan (dual-write de
//   compatibilidad: historial y sandbox); el "enviado" real vive AQUÍ. Apagar el dual-write = quitar
//   `recordatorios=?` del UPDATE en ejecutarMatch.
async function crearCasillas(M, recs, opts) {
    opts = opts || {};
    const now = Date.now();
    const tId = Number(M.tenant_id) || 0;
    const filas = [];
    for (const r of recs) {
        if (r.enviado) continue;
        const para = r.para || 'comprador';
        const tel = para === 'vendedor' ? M.dueno_tel : M.comprador_tel;
        if (!String(tel || '').replace(/\D/g, '')) continue;   // auto sin dueño → no nacen casillas de vendedor
        filas.push({ sql: `INSERT INTO cita_casillas (cita_match_id, cita_id, tenant_id, chat_id, tipo, para, tel, due_ts, texto, estado, created, updated) VALUES (?,?,?,?,?,?,?,?,?,'pendiente',?,?)`,
            args: [Number(M.id), M.cita_id == null ? null : Number(M.cita_id), tId, M.chat_id == null ? null : Number(M.chat_id), String(r.k), para, String(tel), Number(r.ts), String(r.texto), now, now] });
    }
    let ids = [];
    for (const f of filas) { const ins = await run(f.sql, f.args); ids.push({ id: Number(ins.lastInsertRowid), due_ts: f.args[7], tel: f.args[6] }); }
    if (ids.length) {
        await T('casilla', M.id, 'creadas');
        if (!opts.sin_programar) await programarEnPuente(ids);
    }
    return ids;
}
// cancelarCasillas({ cita_match_id | staff_id }, estadoNuevo='cancelada') → n (1 UPDATE por índice; idempotente)
async function cancelarCasillas(sel, estadoNuevo) {
    await ensureDireccionCitas();
    const nuevo = estadoNuevo || 'cancelada';
    let u;
    if (sel.staff_id != null) u = await run("UPDATE cita_casillas SET estado=?, updated=? WHERE staff_id=? AND estado IN ('pendiente','pausada')", [nuevo, Date.now(), Number(sel.staff_id)]);
    else u = await run("UPDATE cita_casillas SET estado=?, updated=? WHERE cita_match_id=? AND estado IN ('pendiente','pausada')", [nuevo, Date.now(), Number(sel.cita_match_id)]);
    const n = Number(u.rowsAffected) || 0;
    if (n) await T('casilla', sel.cita_match_id || sel.staff_id, nuevo);
    return n;
}
// reanudarCasillas({ cita_match_id }) → las pausadas vuelven a 'pendiente'; las que vencieron durante la pausa → 'saltada'
async function reanudarCasillas(sel) {
    await ensureDireccionCitas();
    const now = Date.now();
    await run("UPDATE cita_casillas SET estado='saltada', updated=? WHERE cita_match_id=? AND estado='pausada' AND due_ts<=?", [now, Number(sel.cita_match_id), now]);
    const u = await run("UPDATE cita_casillas SET estado='pendiente', updated=? WHERE cita_match_id=? AND estado='pausada'", [now, Number(sel.cita_match_id)]);
    const n = Number(u.rowsAffected) || 0;
    if (n) {
        const pend = await query("SELECT id, due_ts, tel FROM cita_casillas WHERE cita_match_id=? AND estado='pendiente'", [Number(sel.cita_match_id)]);
        await programarEnPuente(pend);
        await T('casilla', sel.cita_match_id, 'reanudadas');
    }
    return n;
}
// EL TIMBRE PROGRAMADO: el puente pone un temporizador por casilla (evento, no sondeo). Best-effort:
// si el puente no contesta, el cron (barredor) la recoge por la MISMA puerta. Tels de prueba: no se programan.
async function programarEnPuente(casillas) {
    const lista = (casillas || []).filter(c => c && c.id && !esTelPrueba(c.tel)).map(c => ({ casilla_id: Number(c.id), due_ts: Number(c.due_ts) }));
    if (!lista.length) return { ok: true, n: 0 };
    const url = (process.env.BRIDGE_SEND_URL || 'http://137.184.199.19:3000/api/send').replace(/\/api\/send$/, '/api/programar');
    const key = process.env.K_PUENTE || process.env.BRIDGE_API_KEY;
    if (!key) return { ok: false, n: lista.length, error: 'K_PUENTE no configurada' };
    try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ casillas: lista }), signal: ctl.signal });
        clearTimeout(t);
        return { ok: r.ok, n: lista.length };
    } catch (e) { return { ok: false, n: lista.length, error: e.message }; }
}

// ── LA PUERTA ÚNICA DE EJECUCIÓN: el temporizador del puente y el barredor del cron entran AQUÍ ──
// casillaEjecutar(idOrRow) → lee la casilla (1 fila), checklist, manda por enviarWA(tel, texto, tenant),
// marca 'enviada'. Idempotente: el claim es UPDATE … WHERE estado='pendiente' (si dos llegan a la vez, uno gana).
//   checklist: estado pendiente · ya toca (due_ts ≤ ahora+2 min) · la cita sigue en match (o staff confirmado)
//   · la cita no pasó hace 3h+ · universo conectado (tenant≠0: 1 fila de wa_sessions).
const CASILLA_ADELANTO_MS = 2 * 60000;
async function casillaEjecutar(idOrRow, opts) {
    opts = opts || {};
    await ensureDireccionCitas();
    const C = (idOrRow && typeof idOrRow === 'object') ? idOrRow : (await query('SELECT * FROM cita_casillas WHERE id=?', [Number(idOrRow)]))[0];
    if (!C) return { ok: false, motivo: 'no_existe' };
    const now = Date.now();
    if (C.estado === 'enviando' && Number(C.updated || 0) > now - 5 * 60000) return { ok: true, ya: true, motivo: 'en_vuelo' };
    if (!['pendiente', 'enviando'].includes(String(C.estado))) return { ok: true, ya: true, estado: C.estado };
    if (Number(C.due_ts) > now + CASILLA_ADELANTO_MS && !opts.forzar) return { ok: false, motivo: 'aun_no_toca', due_ts: Number(C.due_ts) };
    // ── checklist contra la máquina (1 fila) ──
    let tenantId = Number(C.tenant_id) || 0, salto = null;
    if (C.staff_id != null) {
        const V = (await query('SELECT estado, cita_ts FROM cita_vendedores WHERE id=?', [Number(C.staff_id)]))[0];
        if (!V || V.estado !== 'confirmado') salto = 'staff_' + (V ? V.estado : 'inexistente');
        else if (Number(V.cita_ts) && now > Number(V.cita_ts) + 3 * 3600000) salto = 'cita_pasada';
        tenantId = 0;   // al staff le habla el bot Fyradrive
    } else if (C.cita_match_id != null) {
        const M = (await query('SELECT estado, cita_ts, tenant_id FROM citas_match WHERE id=?', [Number(C.cita_match_id)]))[0];
        if (!M || M.estado !== 'match') salto = 'match_' + (M ? M.estado : 'inexistente');
        else if (Number(M.cita_ts) && now > Number(M.cita_ts) + 3 * 3600000) salto = 'cita_pasada';
        if (C.para === 'vendedor') tenantId = 0;          // al dueño/vendedor le habla el bot Fyradrive
        else if (M) tenantId = Number(M.tenant_id) || 0;  // al comprador, por el universo de la cita
    }
    if (salto) {
        await run("UPDATE cita_casillas SET estado='saltada', error=?, updated=? WHERE id=? AND estado IN ('pendiente','enviando')", [salto, now, C.id]);
        await T('casilla', C.id, 'saltada');
        return { ok: true, saltada: salto };
    }
    if (tenantId && !esTelPrueba(C.tel)) {   // carril de pruebas: se simula sin exigir universo conectado
        const s = (await query('SELECT estado FROM wa_sessions WHERE tenant_id=?', [tenantId]))[0];
        if (!s || s.estado !== 'vinculado') {
            await run("UPDATE cita_casillas SET intentos=intentos+1, error=?, updated=? WHERE id=?", ['universo ' + tenantId + ' no conectado (' + (s ? s.estado : 'sin sesión') + ')', now, C.id]);
            return { ok: false, motivo: 'universo_no_conectado', tenant_id: tenantId };
        }
    }
    // ── claim idempotente ──
    const claim = await run("UPDATE cita_casillas SET estado='enviando', intentos=intentos+1, updated=? WHERE id=? AND estado IN ('pendiente','enviando') AND (estado='pendiente' OR updated<=?)", [now, C.id, now - 5 * 60000]);
    if (!(Number(claim.rowsAffected) > 0)) return { ok: true, ya: true, motivo: 'claim_perdido' };
    const res = await enviarWA(C.tel, C.texto, tenantId);
    if (res.ok) {
        await run("UPDATE cita_casillas SET estado='enviada', enviado_ts=?, error=?, updated=? WHERE id=? AND estado='enviando'", [Date.now(), res.simulado ? 'simulado' : null, Date.now(), C.id]);
        await T('casilla', C.id, 'enviada');
        await ACC.registrar({ tenant_id: Number(C.tenant_id) || 0, chat_id: C.chat_id, tipo: 'recordatorio', ref_id: C.id, meta: { k: C.tipo, para: C.para, simulado: !!res.simulado }, actor: 'bot' });
        return { ok: true, enviada: true, simulado: !!res.simulado };
    }
    await run("UPDATE cita_casillas SET estado='pendiente', error=?, updated=? WHERE id=? AND estado='enviando'", [String(res.error || 'sin detalle').slice(0, 250), Date.now(), C.id]);
    return { ok: false, motivo: 'envio_fallo', error: res.error || null };
}
// EL BARREDOR (cron cada 10 min): SOLO lo vencido, por índice (estado, due_ts), máx. 50 por vuelta.
async function barrerCasillas(limite) {
    await ensureDireccionCitas();
    const now = Date.now();
    const rows = await query("SELECT * FROM cita_casillas WHERE estado IN ('pendiente','enviando') AND due_ts <= ? ORDER BY due_ts ASC LIMIT ?", [now, Number(limite) || 50]);
    let enviadas = 0, saltadas = 0, fallidas = 0;
    for (const C of rows) {
        try {
            const r = await casillaEjecutar(C);
            if (r.enviada) enviadas++; else if (r.saltada) saltadas++; else if (!r.ok) fallidas++;
        } catch (e) { fallidas++; console.error('[barrerCasillas]', C.id, e.message); }
    }
    return { vencidas: rows.length, enviadas, saltadas, fallidas };
}

// Ejecutar el MATCH (afirma del dueño o señal manual): confianza + plan de recordatorios.
// avisarComprador=false solo lo usa la puerta del Calendar (el comprador ya recibió
// el machote firmado del popup) — el plan de recordatorios es EL MISMO siempre.
// Las casillas NACEN aquí (mismos textos que planRecordatorios) y el puente las programa.
async function ejecutarMatch(M, { notificarVendedor = false, avisarComprador = true } = {}) {
    const matchTs = Date.now();
    const ctx = { nombre: (M.comprador_nombre || '').split(/\s+/)[0] || 'amigo', dueno: (M.dueno || 'amigo').split(/\s+/)[0], auto: M.auto_nombre || 'auto', hora: M.hora, fecha: M.fecha };
    const recs = planRecordatorios(matchTs, Number(M.cita_ts), ctx);
    // dirección tardía (fila vieja sin chat): se completa aquí para que las casillas nazcan con dirección
    if (M.chat_id == null) {
        const d = await direccionDe(M.tenant_id || 0, M.comprador_tel, { crear: true });
        if (d.chat_id != null) { M.chat_id = d.chat_id; M.delegacion_id = d.delegacion_id; await run('UPDATE citas_match SET tenant_id=?, chat_id=?, delegacion_id=? WHERE id=?', [d.tenant_id, d.chat_id, d.delegacion_id, M.id]); }
    }
    await run("UPDATE citas_match SET estado='match', match_ts=?, recordatorios=?, updated=? WHERE id=?", [matchTs, JSON.stringify(recs), Date.now(), M.id]);
    await cancelarCasillas({ cita_match_id: M.id });   // re-match de la misma fila: las casillas previas mueren
    const casillas = await crearCasillas(Object.assign({}, M, { match_ts: matchTs }), recs);
    await T('cita', M.id, 'match');
    await ACC.registrar({ tenant_id: Number(M.tenant_id) || 0, chat_id: M.chat_id, delegacion_id: M.delegacion_id, tipo: 'cita_match', ref_id: M.id, meta: { fecha: M.fecha, hora: M.hora, casillas: casillas.length }, actor: 'bot' });
    if (avisarComprador) await enviarWA(M.comprador_tel, MSJ.confianza(ctx), M.tenant_id);
    if (notificarVendedor) await enviarWA(M.dueno_tel, MSJ.matchDirectoVendedor(ctx));
    return { recs, ctx, casillas };
}

// ── MATCH DIRECTO DESDE EL CALENDAR (orden owner 2026-08-24): agendar en el
// Calendar = el owner YA habló con el dueño y la confirmación viene acreditada.
// MISMA máquina de siempre: nace la fila del match y ejecutarMatch arma el MISMO
// plan de recordatorios (víspera, día D, 1h antes, en camino). Lo único distinto:
// no se le repite la confianza al comprador (ya recibió el machote del popup).
// avisar=true (re-confirmación con hora nueva): SÍ se les avisa a ambas partes con
// los machotes del match de siempre (confianza al comprador, confirmación al dueño).
// reemplazar=true (mover/re-confirmar desde el Calendar): las máquinas vivas de ESE chat (match, pausada,
// escalada…) pasan a 'reemplazada' y sus casillas se cancelan ANTES de nacer las nuevas (casillas viejas
// canceladas + casillas nuevas = "mover la cita").
async function matchDirectoCalendar({ comprador_tel, comprador_nombre, dueno_tel, dueno, auto_id, auto_nombre, fecha, hora, cita_ts, avisar, tenant_id, cita_id, reemplazar }) {
    await ensureCitasMatch();
    const telC = String(comprador_tel || '').replace(/\D/g, '');
    if (!telC || !cita_ts) return { ok: false, error: 'faltan comprador_tel o cita_ts' };
    const tId = Number(tenant_id) || 0;
    const dir = await direccionDe(tId, telC, { crear: true });
    if (dir.chat_id == null) return { ok: false, error: 'sin chat para ' + telC + ' en el universo ' + tId };
    // idempotente: mismo chat + misma cita ya en match → no duplicar (1 fila por índice)
    const ya = await filaViva(tId, dir.chat_id, ['match']);
    if (ya && Number(ya.cita_ts) === Number(cita_ts)) return { ok: true, match_id: ya.id, ya_existia: true, chat_id: dir.chat_id };
    const reemplazadas = await _reemplazarVivas(tId, dir.chat_id, reemplazar ? ESTADOS_VIVOS : ESTADOS_PREVIOS);
    const duenoChat = await chatIdDueno(dueno_tel);
    const ins = await run(`INSERT INTO citas_match (comprador_tel, comprador_nombre, dueno_tel, dueno, auto_id, auto_nombre, fecha, hora, cita_ts, estado, updated, tenant_id, chat_id, delegacion_id, dueno_chat_id)
               VALUES (?,?,?,?,?,?,?,?,?,'solicitud',?,?,?,?,?)`,
        [telC, comprador_nombre || null, String(dueno_tel || ''), dueno || 'Vendedor', auto_id || null, auto_nombre || null, fecha || '', hora || '', Number(cita_ts), Date.now(), tId, dir.chat_id, dir.delegacion_id, duenoChat]);
    const M = (await query("SELECT * FROM citas_match WHERE id=?", [Number(ins.lastInsertRowid)]))[0];
    if (cita_id) M.cita_id = Number(cita_id);
    await T('cita', M.id, reemplazadas ? 'movida' : 'match_directo');
    if (reemplazadas) await ACC.registrar({ tenant_id: tId, chat_id: dir.chat_id, delegacion_id: dir.delegacion_id, tipo: 'cita_movida', ref_id: M.id, meta: { fecha, hora, reemplazadas }, actor: 'owner' });
    const { recs, casillas } = await ejecutarMatch(M, { avisarComprador: !!avisar, notificarVendedor: !!avisar && !!String(dueno_tel || '').replace(/\D/g, '') });
    // auto sin teléfono de dueño → la FOTO del plan también se poda (crearCasillas ya no las creó)
    if (!String(dueno_tel || '').replace(/\D/g, '')) {
        const soloComp = recs.filter(x => x.para !== 'vendedor');
        await run("UPDATE citas_match SET recordatorios=?, updated=? WHERE id=?", [JSON.stringify(soloComp), Date.now(), M.id]);
    }
    return { ok: true, match_id: M.id, chat_id: dir.chat_id, recordatorios: recs.length, casillas: casillas.length, reemplazadas };
}

// ── El DUEÑO contesta por WhatsApp → estado machine (idéntica al sandbox) ──
// Devuelve los segmentos PARA EL DUEÑO (el caller los regresa por el mismo canal);
// los mensajes al comprador se mandan aquí (cross-send).
// chatId opcional: si el caller ya tiene el chat del dueño (opener_auto), se ahorra la lectura del chat.
async function manejarMensajeDueno(dueno_tel, texto, chatId) {
    if (process.env.CITAS_VIVAS === '0') return null;
    const M = chatId != null ? await filaVivaDueno(chatId, ESTADOS_PREVIOS) : await filaActivaDueno(dueno_tel);
    return _dueno(M, texto);
}
async function _dueno(M, texto) {
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
        await cancelarCasillas({ cita_match_id: M.id });
        await T('cita', M.id, 'rechazo');
        await ACC.registrar({ tenant_id: Number(M.tenant_id) || 0, chat_id: M.chat_id, delegacion_id: M.delegacion_id, tipo: 'cita_cancelada', ref_id: M.id, meta: { por: 'dueno', texto: String(texto).slice(0, 120) }, actor: 'vendedor' });
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
// chatId opcional: con la dirección ya resuelta es 1 lectura (idx_cm_dir); sin ella, direccionDe (+2).
async function manejarMensajeComprador(comprador_tel, texto, tenantId, chatId) {
    if (process.env.CITAS_VIVAS === '0') return null;
    // MATCH DIRECTO: aceptó lo que el dueño propuso ("va" tras la contrapropuesta) —
    // lo detecta el cerrador normal (cita_confirmada); aquí solo cancel/en-camino.
    const M = chatId != null ? await filaViva(tenantId || 0, chatId, ['match']) : await filaMatchComprador(comprador_tel, tenantId);
    return _comprador(M, texto);
}
// staff confirmado de una cita, por DIRECCIÓN del comprador (índice comprador_chat_id, estado)
async function staffDeCita(M) {
    try {
        await ensureCitaVendedores();
        if (M.chat_id != null) return await query("SELECT id, nombre, tel FROM cita_vendedores WHERE comprador_chat_id=? AND estado='confirmado'", [Number(M.chat_id)]);
    } catch (e) { }
    return [];
}
async function _comprador(M, texto) {
    if (!M) return null;
    const tEC = norm(texto);
    const dirM = { tenant_id: Number(M.tenant_id) || 0, chat_id: M.chat_id, delegacion_id: M.delegacion_id };
    if (/(ya voy|voy en camino|en camino|ya salgo|saliendo|voy para alla|alla voy|ya merito llego|ya casi llego)/.test(tEC) && !/(no |cancel)/.test(tEC)) {
        const ctx = { dueno: (M.dueno || '').split(/\s+/)[0], auto: M.auto_nombre || 'auto' };
        await ACC.registrar(Object.assign({}, dirM, { tipo: 'en_camino', ref_id: M.id, meta: { texto: String(texto).slice(0, 120) }, actor: 'comprador' }));
        // el aviso al DUEÑO es una CASILLA inmediata (misma puerta, reintento si el envío falla)
        const now = Date.now();
        if (String(M.dueno_tel || '').replace(/\D/g, '')) {
            const ins = await run(`INSERT INTO cita_casillas (cita_match_id, cita_id, tenant_id, chat_id, tipo, para, tel, due_ts, texto, estado, created, updated) VALUES (?,?,?,?,?,?,?,?,?,'pendiente',?,?)`,
                [Number(M.id), M.cita_id == null ? null : Number(M.cita_id), dirM.tenant_id, M.chat_id == null ? null : Number(M.chat_id), 'en_camino_aviso', 'vendedor', String(M.dueno_tel), now, MSJ.acreditacionVendedor(ctx), now, now]);
            await casillaEjecutar(Number(ins.lastInsertRowid));
        }
        // el VENDEDOR asignado (staff) también se entera del movimiento — casilla por silla
        for (const V of await staffDeCita(M)) {
            const ins = await run(`INSERT INTO cita_casillas (cita_match_id, staff_id, tenant_id, chat_id, tipo, para, tel, due_ts, texto, estado, created, updated) VALUES (?,?,?,?,?,?,?,?,?,'pendiente',?,?)`,
                [Number(M.id), Number(V.id), dirM.tenant_id, M.chat_id == null ? null : Number(M.chat_id), 'en_camino_staff', 'staff', String(V.tel), now, `${(V.nombre || '').split(/\s+/)[0] || 'Oye'}, el comprador ya va en camino 👍`, now, now]);
            await casillaEjecutar(Number(ins.lastInsertRowid));
        }
        return [MSJ.acuseEnCamino()];
    }
    // ══ POST-CITA (caso Virgilio 2026-07-18): la cita YA PASÓ → "me amarré con otro"
    // NO es cancelación (¡la cita se hizo!). No se toca el estado: se le avisa al
    // owner para que ÉL la marque REALIZADA + resultado en Calendar. El bot calla.
    if (Number(M.cita_ts) && Date.now() > Number(M.cita_ts)) {
        await ACC.registrar(Object.assign({}, dirM, { tipo: 'post_cita', ref_id: M.id, meta: { texto: String(texto).slice(0, 120) }, actor: 'comprador' }));
        await enviarWA(OWNER_TEL, `💬 POST-CITA de ${M.comprador_nombre || M.comprador_tel} (${M.auto_nombre || 'auto'}, ${M.fecha} ${M.hora} — ya pasó): «${String(texto).slice(0, 140)}» — NO la cancelo. Márcala en Calendar: 🤝 CITA REALIZADA + resultado.`).catch(() => { });
        return null;
    }
    const cc = await clasificarCancelacion(texto, { fecha: M.fecha, hora: M.hora });
    if (cc.cancela) {
        await ejecutarCancelacion(M, { por: 'comprador', texto });
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

// ══════════ UNA SOLA ENTRADA POR UNIVERSO (orden owner 2026-09-08) ══════════
// procesarEntrante({ tenantId, chatId, tel, texto, vendedor_ultimo_ts, enviar }) → { handled, rol, segmentos }
//   Se llama SOLO con la dirección del chat. Lecturas: 1 fila (comprador con cita viva, idx_cm_dir)
//   + 1 fila (¿es dueño con solicitud viva?, idx_cm_dueno_chat) + 1 fila (¿es staff invitado/confirmado?,
//   idx_cv_chat). Sin cita viva → no lee nada más y regresa handled=false.
//   Ley 5 (universos ≠0): si el VENDEDOR escribió a mano en ese chat en los últimos N min (config
//   tenants.config_json.pausa_min / env CITA_PAUSA_MANUAL_MIN, default 15) el bot NO le contesta al
//   comprador: solo registra la acción. El puente manda `vendedor_ultimo_ts` (memoria) → cero lecturas;
//   si no viene, 1 fila de mensajes por índice (conversacion_id, ts).
//   enviar=true: los segmentos al comprador salen aquí por enviarWA(tel, s, tenant) (universos ≠0 —
//   el camino único del puente no manda segmentos); tenant 0 los regresa (el puente/opener_auto los manda).
async function procesarEntrante({ tenantId, chatId, tel, texto, vendedor_ultimo_ts, enviar, pausaMin }) {
    const t = Number(tenantId) || 0;
    const out = { handled: false, rol: null, segmentos: null, tenant_id: t, chat_id: chatId == null ? null : Number(chatId) };
    if (process.env.CITAS_VIVAS === '0' || chatId == null || !String(texto || '').trim()) return out;
    await ensureCitasMatch();
    // ① comprador con match vivo (o contrapropuesta: la resuelve el cerrador; aquí solo match)
    const Mc = await filaViva(t, chatId, ['match']);
    if (Mc) {
        out.rol = 'comprador';
        // Ley 5 — pausa por manual del vendedor (solo universos ≠0)
        if (t) {
            const N = Number(pausaMin) || Number(process.env.CITA_PAUSA_MANUAL_MIN) || 15;
            let ult = Number(vendedor_ultimo_ts) || 0;
            if (!ult) {
                try { const r = await query("SELECT ts FROM mensajes WHERE conversacion_id=? AND direccion='out' AND COALESCE(ai_generated,0)=0 ORDER BY ts DESC LIMIT 1", [Number(chatId)]); ult = r.length ? Number(r[0].ts) : 0; } catch (e) { }
            }
            if (ult && Date.now() - ult < N * 60000) {
                await ACC.registrar({ tenant_id: t, chat_id: chatId, delegacion_id: Mc.delegacion_id, tipo: 'entrada', ref_id: Mc.id, meta: { texto: String(texto).slice(0, 120), ley5: 'vendedor activo hace <' + N + ' min — bot callado' }, actor: 'comprador' });
                return Object.assign(out, { handled: true, callado: 'ley5' });
            }
        }
        const segs = await _comprador(Mc, texto);
        out.handled = true; out.segmentos = segs;
        if (segs && segs.length && enviar) { for (const s of segs) await enviarWA(tel || Mc.comprador_tel, s, t); out.enviados = segs.length; }
        return out;
    }
    // ② dueño con solicitud viva (el dueño vive en el universo 0)
    const Md = t ? null : await filaVivaDueno(chatId, ESTADOS_PREVIOS);
    if (Md) {
        out.rol = 'dueno';
        const segs = await _dueno(Md, texto);
        out.handled = true; out.segmentos = segs;
        if (segs && segs.length && enviar) { for (const s of segs) await enviarWA(tel || Md.dueno_tel, s, 0); out.enviados = segs.length; }
        return out;
    }
    // ③ staff (silla viva) — también universo 0
    if (!t) {
        const segsSt = await manejarMensajeStaff(tel, texto, chatId);
        if (segsSt !== null) {
            out.rol = 'staff'; out.handled = true; out.segmentos = segsSt;
            if (segsSt && segsSt.length && enviar) { for (const s of segsSt) await enviarWA(tel, s, 0); out.enviados = segsSt.length; }
            return out;
        }
    }
    return out;
}

// ══ PAUSA POR DESVÍO (orden owner 2026-08-25): algo se sale del guion acordado
// (mover hora/día, o cualquier cosa que requiera al staff) → LA MÁQUINA SE PAUSA
// (los recordatorios mueren hasta re-confirmar) y se le avisa al VENDEDOR asignado
// para que cuadre a AMBAS partes; sin staff asignado, al owner como siempre.
// Re-armar = botón "Confirmar cita" del Calendar o "cita confirmada ✅".
async function pausarPorDesvio(M, quien, texto) {
    await run("UPDATE citas_match SET estado='pausada_staff', updated=? WHERE id=?", [Date.now(), M.id]);
    await cancelarCasillas({ cita_match_id: M.id });   // los recordatorios MUEREN; re-confirmar crea casillas nuevas
    await T('cita', M.id, 'pausa');
    await ACC.registrar({ tenant_id: Number(M.tenant_id) || 0, chat_id: M.chat_id, delegacion_id: M.delegacion_id, tipo: 'cita_pausada', ref_id: M.id, meta: { por: quien, texto: String(texto).slice(0, 120) }, actor: quien === 'dueno' ? 'vendedor' : 'comprador' });
    const aviso = `⚠️ ${quien === 'dueno' ? 'El dueño' + (M.dueno ? ' ' + M.dueno : '') : (M.comprador_nombre || 'El comprador')} quiere mover algo de la cita del ${M.auto_nombre || 'auto'} (${M.fecha} ${M.hora}): «${String(texto).slice(0, 120)}»\nLa máquina se PAUSÓ 🛑 — cuadra con las dos partes y ya cuadrado se re-confirma en el Calendar (o "cita confirmada ✅" + día + hora + auto).`;
    let alStaff = 0;
    try {
        for (const V of await staffDeCita(M)) { const r = await enviarWA(V.tel, aviso); if (r.ok) alStaff++; }
    } catch (e) { }
    await enviarWA(OWNER_TEL, aviso + (alStaff ? '\n(avisado también al vendedor asignado ✓)' : '')).catch(() => { });
    return true;
}

// ══ CANCELACIÓN — UNA MÁQUINA para todo trigger (orden owner 2026-07-18, dibujo
// "mismo funcionamiento"): el WhatsApp del comprador Y el botón manual del Calendar
// entran AQUÍ. Marca la fila del match y avisa al DUEÑO con EL MISMO texto de
// siempre — misma naturaleza, distinto timbre.
async function ejecutarCancelacion(M, opts) {
    opts = opts || {};
    const u = await run("UPDATE citas_match SET estado='cancelada', updated=? WHERE id=? AND estado NOT IN ('cancelada','realizada')", [Date.now(), M.id]);
    const casillas = await cancelarCasillas({ cita_match_id: M.id });
    await T('cita', M.id, 'cancelada');
    await ACC.registrar({ tenant_id: Number(M.tenant_id) || 0, chat_id: M.chat_id, delegacion_id: M.delegacion_id, tipo: 'cita_cancelada', ref_id: M.id, meta: { por: opts.por || 'comprador', texto: opts.texto ? String(opts.texto).slice(0, 120) : undefined, casillas }, actor: opts.actor || (opts.por === 'owner' ? 'owner' : 'comprador') });
    if (!(Number(u.rowsAffected) > 0)) return true;   // ya estaba cancelada/realizada: sin segundo aviso al dueño
    const ctx = { dueno: (M.dueno || '').split(/\s+/)[0], fecha: M.fecha, hora: M.hora };
    if (String(M.dueno_tel || '').replace(/\D/g, '')) await enviarWA(M.dueno_tel, MSJ.canceladaVendedor(ctx));
    return true;
}

// MATCH DIRECTO real: el comprador confirmó EXACTO lo que el dueño propuso.
// Llamar cuando el cerrador confirme una cita (cita_confirmada) — si empata con la
// contrapropuesta viva, match sin re-preguntar al dueño (y se le avisa).
async function intentarMatchDirecto(comprador_tel, fecha, hora, tenantId) {
    if (process.env.CITAS_VIVAS === '0') return false;
    const M = await filaContraComprador(comprador_tel, tenantId);
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
    // por DIRECCIÓN: el chat del dueño en el universo 0 (1 fila por índice idx_cm_dueno_chat)
    const M = await filaVivaDueno(await chatIdDueno(dueno_tel), ['solicitud', 'contrapropuesta', 'esperando_horario', 'match']);
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
                    try {
                        // la cita (hecho) por DIRECCIÓN (idx_citas_dir); sin dirección aún → por teléfono exacto (idx no aplica: fila vieja)
                        const cr = M.chat_id != null
                            ? await query("SELECT id FROM citas WHERE tenant_id=? AND chat_id=? AND estado='agendada' ORDER BY id DESC LIMIT 1", [Number(M.tenant_id) || 0, Number(M.chat_id)])
                            : await query("SELECT id FROM citas WHERE comprador_telefono=? AND estado='agendada' ORDER BY id DESC LIMIT 1", [String(M.comprador_tel)]);
                        if (cr.length) {
                            await run("UPDATE citas SET fecha=?, hora=?, fecha_hora=?, updated_at=? WHERE id=?", [iso.fecha_iso, iso.hora_hhmm, iso.fecha_iso + ' ' + iso.hora_hhmm + ':00', Date.now(), cr[0].id]);
                            await T('cita', cr[0].id, 'movida');
                            await ACC.registrar({ tenant_id: Number(M.tenant_id) || 0, chat_id: M.chat_id, delegacion_id: M.delegacion_id, tipo: 'cita_movida', ref_id: cr[0].id, meta: { fecha: nf, hora: nh, por: 'senal_owner' }, actor: 'owner' });
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
        await cancelarCasillas({ cita_match_id: M.id });
        await T('cita', M.id, 'cancelada');
        await ACC.registrar({ tenant_id: Number(M.tenant_id) || 0, chat_id: M.chat_id, delegacion_id: M.delegacion_id, tipo: 'cita_cancelada', ref_id: M.id, meta: { por: 'dueno_senal_owner' }, actor: 'owner' });
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
            const aidW = await U.autoActivoDe(0, tel);
            if (aidW) { const a = autosAct.find(x => x.id === aidW); if (a) r = { auto: a, candidatos: [a] }; }
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
            // K_PANEL por header (el SB la verifica); transición: body.key = KEY_VIEJA mientras el SB no se actualice. Sin literales.
            if (!process.env.K_PANEL) throw new Error('K_PANEL no configurada');
            const resp = await fetch(SALES_BRAIN_URL + '/api/upload', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.K_PANEL },
                body: JSON.stringify({
                    action: 'registrar_cita_canonica', key: process.env.KEY_VIEJA || undefined,
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
    // ══ EL BARREDOR DE CASILLAS (Ley del Timbre): SOLO lo vencido, por índice (estado, due_ts).
    // Antes: SELECT * de TODOS los matches + parse del JSON cada 10 min. Ahora el temporizador del
    // puente ejecuta cada casilla al minuto; esto recoge lo que se le haya escapado por la MISMA puerta.
    let casillas = { vencidas: 0, enviadas: 0, saltadas: 0, fallidas: 0 };
    try { casillas = await barrerCasillas(50); } catch (e) { console.error('[barrerCasillas]', e.message); }
    // cita ya pasó hace 3h+ → cerrar el ciclo (UPDATE por índice (estado, cita_ts); cero lecturas)
    let vencidas = 0, staff_vencidos = 0;
    try {
        const now = Date.now();
        const u = await run("UPDATE citas_match SET estado='vencida', updated=? WHERE estado='match' AND cita_ts IS NOT NULL AND cita_ts < ?", [now, now - 3 * 3600000]);
        vencidas = Number(u.rowsAffected) || 0;
        if (vencidas) await T('cita', null, 'vencida');
        staff_vencidos = await tickStaff();
    } catch (e) { console.error('[vencidas]', e.message); }
    return { ok: true, casillas, vencidas, staff_vencidos, senales, cierres, cita_jobs: jobs, cargas };
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
    await ensureDireccionCitas();   // citas.tenant_id/chat_id y cita_casillas existen antes de sentar staff
    await run(`CREATE TABLE IF NOT EXISTS cita_vendedores (
        id INTEGER PRIMARY KEY AUTOINCREMENT, cita_id INTEGER, comprador_tel TEXT,
        nombre TEXT, tel TEXT, auto_nombre TEXT, fecha TEXT, hora TEXT, cita_ts INTEGER,
        estado TEXT, recordatorios TEXT, created INTEGER, updated INTEGER)`);
    await run("CREATE INDEX IF NOT EXISTS idx_cv_tel ON cita_vendedores(tel, estado)").catch(() => { });
    // DIRECCIÓN (2026-09-08): chat del staff (universo 0) + chat del comprador de la cita (su universo)
    for (const c of ['tenant_id INTEGER', 'chat_id INTEGER', 'comprador_chat_id INTEGER'])
        await run('ALTER TABLE cita_vendedores ADD COLUMN ' + c).catch(() => { });
    await run("CREATE INDEX IF NOT EXISTS idx_cv_chat ON cita_vendedores(chat_id, estado)").catch(() => { });
    await run("CREATE INDEX IF NOT EXISTS idx_cv_comp_chat ON cita_vendedores(comprador_chat_id, estado)").catch(() => { });
    await run("CREATE INDEX IF NOT EXISTS idx_cv_estado_cita ON cita_vendedores(estado, cita_ts)").catch(() => { });
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
    // DIRECCIÓN: el staff vive en el universo 0; el comprador en el universo de la cita
    const tenantC = Number(cita.tenant_id) || 0;
    const chatStaff = await chatIdDueno(tel12);
    let compChat = cita.chat_id == null ? null : Number(cita.chat_id);
    if (compChat == null) { const dC = await direccionDe(tenantC, cita.comprador_telefono); compChat = dC.chat_id; }
    if (ya.length) vid = ya[0].id;
    else {
        const ins = await run(`INSERT INTO cita_vendedores (cita_id, comprador_tel, nombre, tel, auto_nombre, fecha, hora, cita_ts, estado, created, updated, tenant_id, chat_id, comprador_chat_id)
                   VALUES (?,?,?,?,?,?,?,?,'invitado',?,?,?,?,?)`,
            [Number(cita_id), String(cita.comprador_telefono || ''), nombre || null, tel12, cita.auto_nombre || null, diaNom, horaHum, citaTs, Date.now(), Date.now(), tenantC, chatStaff, compChat]);
        vid = Number(ins.lastInsertRowid);
        await T('staff', vid, 'invitado');
        await ACC.registrar({ tenant_id: tenantC, chat_id: compChat, tipo: 'staff_invitado', ref_id: vid, meta: { nombre: nombre || null, cita_id: Number(cita_id) }, actor: 'owner' });
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
        const plan = staffPlan(V);
        await run("UPDATE cita_vendedores SET estado='confirmado', recordatorios=?, updated=? WHERE id=?",
            [JSON.stringify(plan), Date.now(), V.id]);
        // las CASILLAS del staff (víspera 8pm + día 9:30) nacen aquí; el bot Fyradrive le habla (tenant 0)
        const now = Date.now(); const ids = [];
        for (const r of plan) {
            const ins = await run(`INSERT INTO cita_casillas (staff_id, cita_id, tenant_id, chat_id, tipo, para, tel, due_ts, texto, estado, created, updated) VALUES (?,?,?,?,?,?,?,?,?,'pendiente',?,?)`,
                [Number(V.id), V.cita_id == null ? null : Number(V.cita_id), Number(V.tenant_id) || 0, V.comprador_chat_id == null ? null : Number(V.comprador_chat_id), String(r.k), 'staff', String(V.tel), Number(r.ts), String(r.texto), now, now]);
            ids.push({ id: Number(ins.lastInsertRowid), due_ts: Number(r.ts), tel: String(V.tel) });
        }
        if (ids.length) await programarEnPuente(ids);
        await T('staff', V && V.id, 'confirmado');
        await ACC.registrar({ tenant_id: Number(V.tenant_id) || 0, chat_id: V.comprador_chat_id, tipo: 'staff_confirmado', ref_id: V.id, meta: { nombre: V.nombre || null, casillas: ids.length }, actor: 'vendedor' });
    }
    return { ok: true, id: V.id, nombre: V.nombre };
}

// El VENDEDOR asignado contesta por WhatsApp: sí → confirma; no → escala; resto → escala.
// Por DIRECCIÓN: su chat (universo 0) → índice (chat_id, estado). chatId opcional (si el caller ya lo tiene).
async function manejarMensajeStaff(tel, texto, chatId) {
    await ensureCitaVendedores();
    const cid = chatId != null ? Number(chatId) : await chatIdDueno(tel);
    if (cid == null) return null;
    const filas = await query("SELECT * FROM cita_vendedores WHERE chat_id=? AND estado IN ('invitado','confirmado') ORDER BY updated DESC LIMIT 1", [cid]);
    const V = filas[0];
    if (!V) return null;
    const t10 = String(tel || V.tel || '').replace(/\D/g, '').slice(-10);
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
            await cancelarCasillas({ staff_id: V.id });
            await T('staff', V.id, 'rechazo');
            await ACC.registrar({ tenant_id: Number(V.tenant_id) || 0, chat_id: V.comprador_chat_id, tipo: 'staff_rechazo', ref_id: V.id, meta: { texto: String(texto).slice(0, 100) }, actor: 'vendedor' });
            await enviarWA('5218120066355', `⚠️ ${V.nombre || 'El vendedor'} (${t10}) NO puede con la cita de las ${V.hora}: "${String(texto).slice(0, 100)}" — asigna a alguien más o ve tú.`).catch(() => { });
            return ['Entendido, gracias por avisarme 👍'];
        }
    }
    // cualquier otra cosa del staff → se escala al owner y el bot CALLA (regresa []
    // = "es staff, no sigas al flujo de comprador"; null = "no es staff")
    await enviarWA('5218120066355', `💬 ${V.nombre || 'Vendedor'} (cita ${V.hora}${V.auto_nombre ? ', ' + V.auto_nombre : ''}): «${String(texto).slice(0, 140)}»`).catch(() => { });
    return [];
}

// Cierre de sillas vencidas (lo llama tickRecordatorios). Los recordatorios del staff ya son
// CASILLAS (barrerCasillas / temporizador del puente). Aquí solo: UPDATE por índice, cero lecturas.
async function tickStaff() {
    await ensureCitaVendedores();
    const now = Date.now();
    const u = await run("UPDATE cita_vendedores SET estado='vencida', updated=? WHERE estado IN ('confirmado','invitado') AND cita_ts IS NOT NULL AND cita_ts < ?", [now, now - 3 * 3600000]);
    const n = Number(u.rowsAffected) || 0;
    if (n) await T('staff', null, 'vencida');
    return n;
}

// ══════════ BACKFILL DE DIRECCIÓN (idempotente; lo dispara el owner o el script de pruebas) ══════════
// Liga las filas VIVAS del sistema de citas a su dirección (tenant → chat → delegación) por teléfono
// normalizado. Solo filas sin dirección (chat_id IS NULL), por índice de estado. Reporta lo que no se
// pudo ligar (sin chat) para que el owner decida. También crea las casillas de los matches vivos que
// aún viven solo en el JSON (migración del cron viejo). opts.telefonos limita a esos (pruebas).
async function backfillDireccionCitas(opts) {
    opts = opts || {};
    await ensureCitasMatch(); await ensureCitaVendedores();
    const filtro = Array.isArray(opts.telefonos) && opts.telefonos.length ? new Set(opts.telefonos.map(U.tel12)) : null;
    const rep = { dry: !!opts.dry, match_vistas: 0, match_ligadas: 0, match_sin_chat: [], dueno_ligados: 0, citas_vistas: 0, citas_ligadas: 0, citas_sin_chat: [], staff_vistos: 0, staff_ligados: 0, staff_sin_chat: [], casillas_creadas: 0 };
    const ph = ESTADOS_VIVOS.map(() => '?').join(',');
    // ① citas_match vivas sin dirección
    let ms = await query(`SELECT * FROM citas_match WHERE estado IN (${ph}) AND (chat_id IS NULL OR dueno_chat_id IS NULL)`, ESTADOS_VIVOS);
    if (filtro) ms = ms.filter(m => filtro.has(U.tel12(m.comprador_tel)));
    for (const M of ms) {
        rep.match_vistas++;
        const t = Number(M.tenant_id) || 0;
        let chat_id = M.chat_id, delegacion_id = M.delegacion_id, dueno_chat_id = M.dueno_chat_id;
        if (chat_id == null) { const d = await direccionDe(t, M.comprador_tel); chat_id = d.chat_id; delegacion_id = d.delegacion_id; }
        if (dueno_chat_id == null && String(M.dueno_tel || '').replace(/\D/g, '')) dueno_chat_id = await chatIdDueno(M.dueno_tel);
        if (chat_id == null) rep.match_sin_chat.push({ id: M.id, tel: String(M.comprador_tel || '').slice(-4), estado: M.estado });
        if (chat_id != null && M.chat_id == null) rep.match_ligadas++;
        if (dueno_chat_id != null && M.dueno_chat_id == null) rep.dueno_ligados++;
        if (!opts.dry && (chat_id != null || dueno_chat_id != null))
            await run('UPDATE citas_match SET tenant_id=?, chat_id=COALESCE(chat_id,?), delegacion_id=COALESCE(delegacion_id,?), dueno_chat_id=COALESCE(dueno_chat_id,?) WHERE id=?', [t, chat_id, delegacion_id, dueno_chat_id, M.id]);
    }
    // ② matches en 'match' sin casillas → casillas desde el JSON (solo las no enviadas y futuras)
    let vivos = await query("SELECT * FROM citas_match WHERE estado='match'");
    if (filtro) vivos = vivos.filter(m => filtro.has(U.tel12(m.comprador_tel)));
    for (const M of vivos) {
        const ya = await query("SELECT 1 FROM cita_casillas WHERE cita_match_id=? LIMIT 1", [M.id]);
        if (ya.length) continue;
        let recs = []; try { recs = JSON.parse(M.recordatorios || '[]'); } catch (e) { }
        const pend = recs.filter(r => !r.enviado);
        if (!pend.length) continue;
        if (!opts.dry) { const ids = await crearCasillas(M, pend); rep.casillas_creadas += ids.length; }
        else rep.casillas_creadas += pend.length;
    }
    // ③ citas (hecho) futuras/agendadas sin dirección — tenant por vendedor_telefono ∈ tenants (≠0) o 0
    let cs = await query("SELECT id, comprador_telefono, vendedor_telefono, estado, fecha FROM citas WHERE estado IN ('agendada','pausada') AND fecha >= date('now') AND chat_id IS NULL");
    if (filtro) cs = cs.filter(c => filtro.has(U.tel12(c.comprador_telefono)));
    let tenantsPorTel = null;
    for (const C of cs) {
        rep.citas_vistas++;
        if (!tenantsPorTel) { tenantsPorTel = new Map(); try { for (const r of await query('SELECT id, telefono FROM tenants WHERE activo=1 AND id<>0')) tenantsPorTel.set(U.tel12(r.telefono), Number(r.id)); } catch (e) { } }
        const t = tenantsPorTel.get(U.tel12(C.vendedor_telefono)) || 0;
        const d = await direccionDe(t, C.comprador_telefono);
        if (d.chat_id == null) { rep.citas_sin_chat.push({ id: C.id, tel: String(C.comprador_telefono || '').slice(-4) }); continue; }
        rep.citas_ligadas++;
        if (!opts.dry) await run('UPDATE citas SET tenant_id=?, chat_id=?, delegacion_id=? WHERE id=? AND chat_id IS NULL', [t, d.chat_id, d.delegacion_id, C.id]);
    }
    // ④ staff vivo sin dirección
    let vs = await query("SELECT * FROM cita_vendedores WHERE estado IN ('invitado','confirmado') AND (chat_id IS NULL OR comprador_chat_id IS NULL)");
    if (filtro) vs = vs.filter(v => filtro.has(U.tel12(v.tel)) || filtro.has(U.tel12(v.comprador_tel)));
    for (const V of vs) {
        rep.staff_vistos++;
        const chat_id = V.chat_id != null ? V.chat_id : await chatIdDueno(V.tel);
        const t = Number(V.tenant_id) || 0;
        const comp = V.comprador_chat_id != null ? V.comprador_chat_id : (await direccionDe(t, V.comprador_tel)).chat_id;
        if (chat_id == null && comp == null) { rep.staff_sin_chat.push({ id: V.id, tel: String(V.tel || '').slice(-4) }); continue; }
        rep.staff_ligados++;
        if (!opts.dry) await run('UPDATE cita_vendedores SET tenant_id=?, chat_id=COALESCE(chat_id,?), comprador_chat_id=COALESCE(comprador_chat_id,?) WHERE id=?', [t, chat_id, comp, V.id]);
    }
    return rep;
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
    staffInvitar, staffConfirmar, staffLista, manejarMensajeStaff, tickStaff,
    // DIRECCIÓN + CASILLAS + ENTRADA ÚNICA (orden owner 2026-09-08)
    ensureDireccionCitas, direccionDe, filaViva, filaVivaDueno, ESTADOS_VIVOS,
    crearCasillas, cancelarCasillas, reanudarCasillas, casillaEjecutar, barrerCasillas, programarEnPuente,
    procesarEntrante, backfillDireccionCitas };
