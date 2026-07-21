// lib/seb/ghosting.js
// ETAPA 3 — TRIGGER DE GHOSTING (el toque de las 3 HORAS). Único auto-envío de etapa 3.
//
// El comprador dejó de contestar tras algo que LE MANDAMOS → a las ~3h se manda UNA
// burbuja sobria (vestido etapa 3: sin saludo; nombre solo si es nombre humano común)
// preguntando por LO QUE QUEDÓ COLGADO (cotización, fotos, pin, requisitos, pregunta).
// En paralelo se arma la LISTA para el personal del owner (nombres + teléfonos) para
// que él les marque.
//
// CANDADOS (todos medidos en la autopsia de sus conversaciones, jun-2026):
//  - NO dispara si lo último del comprador fue promesa/espera/despedida/rechazo.
//  - Máx 1 por episodio de silencio y 1 por día por conversación. NUNCA se repite.
//  - Horario 9am-8pm MTY; silencios nocturnos se barren en la mañana (gap ≤ 16h).
//  - Solo ETAPA 3 (ya hubo ≥2 ráfagas nuestras: opener + continuación pasaron).
//  - Nunca a dueños. Solo silencios frescos (no retro-dispara al estrenar).

const { query, run } = require('./db.js');
const { nombreReal } = require('./opener.js');

const H = 3600 * 1000;
const GAP_MIN = 3 * H;          // el toque: 3 horas de silencio
const GAP_MAX_FRESCO = 5 * H;   // ventana normal (con scan cada ~15 min sobra)
const GAP_MAX_MANANA = 16 * H;  // barrido de la mañana: silencios que cayeron de noche

// ── Banco de frases (voz del owner, sobrio; {n} = ", Nombre" opcional · {auto} = nombre del auto)
const BANCO = {
    cotizacion: ['Cómo viste los números{n}?', 'Qué te pareció la cotización{n}?', 'Cómo ves{n}, se te acomoda alguna opción?'],
    requisitos: ['Cómo ves los requisitos{n}?', 'Los juntas sin tema{n}, o te ayudo con algo?'],
    fotos:      ['Qué te pareció el auto{n}?', 'Qué te parecieron las fotos{n}?', 'Cómo lo ves{n}? Está impecable'],
    ubicacion:  ['Te queda bien la ubicación{n}?', 'Cómo ves{n}, te queda cerca?'],
    cita:       ['Entonces qué día te acomodo{n}?', 'Cómo quedamos{n}, qué hora te queda bien?'],
    preg_enganche: ['Entonces con cuánto de enganche le hacemos los números{n}?'],
    pregunta:   ['Te interesa que le demos{n}?', 'Cómo ves{n}, le damos?'],
    info:       ['Te quedó alguna otra duda del {auto}{n}?', 'Qué más te gustaría saber del {auto}{n}?']
};
const rot = a => a[Math.floor(Math.random() * a.length)];

// Lo último del COMPRADOR fue promesa/espera/despedida/rechazo → NO tocar (presión que quema).
const RE_NO_TOCAR = /(te aviso|les aviso|le aviso|lo aviso|yo aviso|me comunico|te confirmo|les confirmo|te marco|te hablo|lo platico|platicarlo|lo consulto|lo checo|deja( ?me)? chec|deja ver|dejame ver|d[eé]jame ver|voy a ver|lo voy a (ver|pensar|checar|platicar)|lo pienso|d[ée]jame pensarlo|dame (chance|oportunidad|un dia|tiempo)|aguantame|esperame|al rato (te|paso|voy)|m[aá]s tarde|luego te|despu[eé]s te|en la semana|fin de mes|la quincena|quincena|el (lunes|martes|miercoles|mi[eé]rcoles|jueves|viernes|sabado|s[aá]bado|domingo) te|no puedo (hoy|ahorita|este)|hoy no puedo|ya compr[eé]|ya lo vi|ya vi otro|no gracias|no por el momento|muchas gracias|mil gracias|gracias por (todo|la atencion|la atenci[oó]n|tu atencion|tu atenci[oó]n)|estamos en contacto|seguimos en contacto|hay prioridades|buen fin|feliz|^\s*(si )?gracias\s*$|^\s*(ok|va|sale|vale|de acuerdo|perfecto|listo)( gracias)?\s*$|^\s*gracias\b|de nada|muy amable|va pues|okey gracias)/;

// Detecta el ESCENARIO por lo último que MANDAMOS (la ráfaga saliente final).
// Devuelve la clave del BANCO o null (sin escenario → silencio, mejor nada que relleno).
function detectarEscenario(rafagaOut, ultimoInTexto) {
    const t = rafagaOut.map(m => String(m.texto || '')).join('\n');
    const tn = t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const tipos = rafagaOut.map(m => String(m.tipo || ''));
    if (/sujeto a aprobacion bancaria|monto a financiar|planes de financiamiento/.test(tn)) return 'cotizacion';
    if (/identificacion oficial|comprobante de domicilio|3 meses de nominas/.test(tn)) return 'requisitos';
    if (tipos.includes('image') || /dejame te las mando|te las mando|ahi las tienes/.test(tn)) return 'fotos';
    if (tipos.includes('location') || /maps\.google|maps\.app\.goo|punto de venta|te mando la ubicacion/.test(tn)) return 'ubicacion';
    if (/(que|qué) (dia|día|hora)|a que hora te|hora te (queda|coordino|esperamos)|dia te queda|te agendo|agendarte|agendamos|te coordino|que dia y hora|prueba de manejo|venir a verl|como andas manana/.test(tn) && /\?/.test(t)) return 'cita';
    if (/enganche[^?]{0,30}\?|con cuanto (de enganche|te cotizo|cuentas)/.test(tn)) return 'preg_enganche';
    if (/\?\s*$/.test(t.trim())) return 'pregunta';
    // ESTRICTO: NO hay escenario 'info'. Antes, si el último del comprador traía "?",
    // se mandaba un "qué más te gustaría saber?" aunque NO hubiéramos hecho un movimiento
    // concreto (cotización/fotos/pin/CTA). Eso disparaba ghosts sobre preguntas sin
    // responder (caso Jose). Sin movimiento nuestro claro → NO se manda nada.
    return null;
}

// ── Le DEBEMOS algo al comprador (promesa nuestra sin cumplir) → jamás ghost. ──
// "ahorita te mando la cotización" y nunca llegó = la bola está en NUESTRA cancha.
const RE_PROMESA_NUESTRA = /(ahorita|al rato|en un momento|enseguida|orita|ahora) te (mando|paso|env[ií]o|la mando|las mando|comparto)|te (la|lo|las|los) (mando|paso|env[ií]o) (en un momento|ahorita|al rato|enseguida)|dejame te (armo|mando|paso|preparo|saco)|permiteme (tantito|un momento)|dame (chance|un momento) (y|para) te|ya casi te (mando|paso)/;
const REGX_DELIVERABLE = /sujeto a aprobacion bancaria|monto a financiar|planes de financiamiento|identificacion oficial|comprobante de domicilio|maps\.(google|app)/;
// Escanea los mensajes (asc) buscando una promesa NUESTRA que no fue seguida por su entrega.
function deudaPendiente(asc) {
    for (let k = asc.length - 1; k >= 0 && k >= asc.length - 8; k--) {
        const m = asc[k];
        if (m.direccion !== 'out') continue;
        const tn = String(m.texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (RE_PROMESA_NUESTRA.test(tn)) {
            // ¿llegó la entrega DESPUÉS de la promesa? (cotización/requisitos/pin, o una imagen)
            const entregado = asc.slice(k + 1).some(x => x.direccion === 'out' &&
                (String(x.tipo || '') === 'image' || String(x.tipo || '') === 'location' ||
                 REGX_DELIVERABLE.test(String(x.texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))));
            if (!entregado) return true;   // prometimos y no cumplimos → le debemos
        }
    }
    return false;
}

async function nombreAuto(telefono) {
    try {
        const r = await query("SELECT auto_id_activo FROM wa_conversations WHERE telefono=?", [telefono]);
        if (!r.length || !r[0].auto_id_activo) return null;
        const a = await query("SELECT marca, modelo, anio FROM inventario_autos WHERE id=?", [Number(r[0].auto_id_activo)]);
        if (!a.length) return null;
        return [a[0].marca, a[0].modelo, a[0].anio].filter(Boolean).join(' ');
    } catch (e) { return null; }
}

function fraseDe(escenario, nombre, auto) {
    const nm = nombre ? ', ' + nombre : '';
    let f = rot(BANCO[escenario]).replace('{n}', nm).replace('{auto}', auto || 'auto');
    return f.replace(/\s+/g, ' ').trim();
}

// ── SCAN: encuentra los ghosteados de etapa 3 que tocan AHORA y arma los envíos.
// Devuelve { enviar: [{telefono, texto, nombre, escenario}], reporte: string|null }.
async function ghostScan({ duenos = new Set(), dry = false } = {}) {
    await run(`CREATE TABLE IF NOT EXISTS seguimientos_ghost (
        id INTEGER PRIMARY KEY AUTOINCREMENT, telefono TEXT, conv_id INTEGER,
        episodio_in_ts INTEGER, escenario TEXT, frase TEXT, sent_dia TEXT, created_at INTEGER)`).catch(() => {});

    // Hora Monterrey (UTC-6): solo 9am-8pm. En la franja 9:00-10:30 se barren también
    // los silencios nocturnos (gap hasta 16h); fuera de ella, solo silencios frescos.
    const ahora = Date.now();
    const hMty = new Date(ahora - 6 * H).getUTCHours();
    if (hMty < 9 || hMty >= 20) return { enviar: [], reporte: null, motivo: 'fuera_de_horario' };
    const esBarridoManana = hMty === 9 || (hMty === 10 && new Date(ahora - 6 * H).getUTCMinutes() <= 30);
    const gapMax = esBarridoManana ? GAP_MAX_MANANA : GAP_MAX_FRESCO;

    // Candidatos baratos: el último mensaje es NUESTRO y el silencio está en ventana.
    const cands = await query(
        "SELECT id, channel_thread_id, telefono, nombre, ult_msg_ts FROM conversaciones WHERE ult_dir='out' AND ult_msg_ts <= ? AND ult_msg_ts >= ?",
        [ahora - GAP_MIN, ahora - gapMax]);

    const enviar = [];
    for (const c of cands) {
        const tel = String(c.telefono || '').replace(/\D/g, '');
        if (!tel || duenos.has(tel.slice(-10))) continue;
        if (tel.startsWith('521000000000')) continue;   // 🧪 sandbox (…000 owner, …001 pruebas) — jamás tocarlos

        const ms = await query(
            "SELECT direccion, texto, tipo, ts FROM mensajes WHERE conversacion_id=? ORDER BY ts DESC, id DESC LIMIT 40", [c.id]);
        if (!ms.length) continue;
        const asc = ms.slice().reverse();

        // ETAPA 3: ≥2 ráfagas salientes nuestras (opener + continuación ya pasaron) y hubo comprador.
        let bursts = 0, prev = null, hayIn = false;
        for (const m of asc) {
            if (m.direccion === 'out') { if (prev !== 'out') bursts++; } else hayIn = true;
            prev = m.direccion;
        }
        if (bursts < 2 || !hayIn) continue;

        // ESTRICTO — CANDADO 1: el comprador tuvo la ÚLTIMA palabra → la bola está en
        // NUESTRA cancha, jamás ghost. (ult_dir de la conversación puede venir stale;
        // esto se verifica contra los mensajes reales — caso Jose.)
        if (asc[asc.length - 1].direccion !== 'out') continue;

        // ESTRICTO — CANDADO 2: le DEBEMOS una entrega prometida ("ahorita te mando la
        // cotización" y nunca llegó) → no se le presiona, se le debe (caso Diana).
        if (deudaPendiente(asc)) continue;

        // Última ráfaga saliente (del final hacia atrás) + último IN del comprador.
        const rafagaOut = [];
        let i = asc.length - 1;
        for (; i >= 0 && asc[i].direccion === 'out'; i--) rafagaOut.unshift(asc[i]);
        // ESTRICTO — CANDADO 3: sin ráfaga saliente real, no hay de qué recordar.
        if (!rafagaOut.length) continue;
        let ultimoIn = null, ultimoInTs = null;
        for (; i >= 0; i--) if (asc[i].direccion === 'in') { ultimoIn = String(asc[i].texto || ''); ultimoInTs = Number(asc[i].ts); break; }
        if (!ultimoIn) continue;

        // Candado: promesa/espera/despedida/rechazo/CORTESÍA del comprador → no tocar.
        const inNorm = ultimoIn.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (RE_NO_TOCAR.test(inNorm)) continue;

        // ESTRICTO — CANDADO 4: si el comprador dejó una PREGUNTA colgada y nuestra última
        // ráfaga NO fue un movimiento concreto (cotización/fotos/pin/CTA), le debemos la
        // respuesta, no un ghost. (detectarEscenario abajo ya exige movimiento concreto;
        // esto es el cinturón extra sobre la duda sin responder.)
        const rafOutTn = rafagaOut.map(m => String(m.texto || '')).join('\n').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const hicimosMovimiento = /sujeto a aprobacion bancaria|monto a financiar|planes de financiamiento|identificacion oficial|comprobante de domicilio|maps\.(google|app)|\?\s*$/.test(rafOutTn) || rafagaOut.some(m => ['image', 'location'].includes(String(m.tipo || '')));
        if (/\?/.test(inNorm) && !hicimosMovimiento) continue;

        // Candado: 1 por episodio de silencio y 1 por día.
        const dia = new Date(ahora - 6 * H).toISOString().slice(0, 10);
        const ya = await query(
            "SELECT id FROM seguimientos_ghost WHERE telefono=? AND (episodio_in_ts=? OR sent_dia=?) LIMIT 1",
            [tel, ultimoInTs || 0, dia]);
        if (ya.length) continue;

        // Candado: si nuestra última ráfaga fue el propio recordatorio, no encadenar.
        const yaEsRecordatorio = await query(
            "SELECT id FROM seguimientos_ghost WHERE telefono=? ORDER BY id DESC LIMIT 1", [tel]);
        if (yaEsRecordatorio.length) {
            const ult = await query("SELECT frase FROM seguimientos_ghost WHERE id=?", [yaEsRecordatorio[0].id]);
            if (ult.length && rafagaOut.some(m => String(m.texto || '').trim() === String(ult[0].frase || '').trim())) continue;
        }

        const escenario = detectarEscenario(rafagaOut, ultimoIn);
        if (!escenario) continue;

        const nombre = nombreReal(c.nombre);
        const auto = (escenario === 'info') ? await nombreAuto(tel) : null;
        const texto = fraseDe(escenario, nombre, auto);

        if (!dry) await run(
            "INSERT INTO seguimientos_ghost (telefono, conv_id, episodio_in_ts, escenario, frase, sent_dia, created_at) VALUES (?,?,?,?,?,?,?)",
            [tel, c.id, ultimoInTs || 0, escenario, texto, dia, ahora]);
        enviar.push({ telefono: tel, texto, nombre: nombre || (c.nombre || 'Sin nombre'), escenario });
    }

    // La LISTA para el personal del owner (los marca por teléfono).
    let reporte = null;
    if (enviar.length) {
        const lineas = enviar.map(e => `• ${e.nombre} — ${e.telefono.replace(/^521/, '')} — ${e.escenario.replace('_', ' ')}`);
        reporte = 'Ghosting 3h — se les mandó recordatorio, para marcarles:\n' + lineas.join('\n');
    }
    return { enviar, reporte };
}

module.exports = { ghostScan, detectarEscenario, BANCO, RE_NO_TOCAR };
