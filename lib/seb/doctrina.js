// lib/seb/doctrina.js
// LA PRUEBA DE FUEGO — doctrina dictada por el owner (2026-07-09, calibración en vivo):
//
//   «El bot NO es vendedor. El bot es: catálogo + calculadora + agenda + recepcionista.
//    TODO lo que sea VENDER — explicar procesos, políticas, tranquilizar, persuadir,
//    manejar dinero, capitalizar señales — ESCALA al owner.»
//
// La pregunta única por mensaje:
//   ¿La respuesta es solo LEER un dato, MANDAR un archivo, CALCULAR una tarjeta o
//   ANOTAR una cita?  → bot.
//   ¿La respuesta influye en la DECISIÓN del comprador? → ESCALA (eso ya es vender).
//
// LISTA BLANCA (lo obvio obvio obvio):
//   📖 LEER ficha     — precio, km, año, color, transmisión, dueños, factura(dato),
//                       adeudos/choques(ficha), ubicación/punto/ciudad, horario.
//   📤 MANDAR archivo — fotos, pin, lista de requisitos, link del catálogo.
//   🧮 CALCULAR       — la tarjeta del cotizador tal cual (sin comentario de venta).
//   📅 ANOTAR         — coordinación de cita (día/hora/confirmar ✅), frenos simples
//                       («te aviso» → acuse+silencio), cortesías (silencio).
// TODO LO DEMÁS → ESCALA con puente fijo + aviso al owner (🔴/🔥/🔔).
//
// Momentos de gol (SIEMPRE del owner):
//   🔴 VENTA EN RIESGO — juicio negativo de costo («está caro/alta la mensualidad»).
//   🔥 COMPRADOR CALIENTE — compromiso material declarado («ya iría con papelería y
//      el enganche», «me lo llevo», «¿dónde firmo?», crédito propio aprobado).
//   🔴 HUMANO — salud/familia/crisis. Acuse cálido fijo, JAMÁS un banco, jamás vender.

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ── 🔴 HUMANO — dimensión personal: enfermedad, muerte, accidente, crisis ──
const RE_HUMANO = /(enferm[oa]?\b|enfermedad|hospital|internad|operaci[oó]n|me operan|lo operan|cirugia|falleci|muri[oó]|fallecimiento|luto|velorio|funeral|(tuve|sufri|sufrio) un (accidente|choque)|embarazad|dio a luz|\bparto\b|delicad[oa] de salud|esta grave|urgencia (medica|familiar)|emergencia (medica|familiar)?|cuidando a (mi|la|el|un)|la estamos cuidando|lo estamos cuidando|mi (mama|papa|madre|padre|hermana|hermano|esposa|esposo|hij[oa]|abuel[oa]|suegr[oa])[^?]{0,40}(enferm|hospital|grave|delicad|mal[ao]?\b|cuidando))/;

// ── 🔴 VENTA EN RIESGO — juicio NEGATIVO de costo (pregunta de costo NO entra aquí) ──
const RE_RIESGO = /(est[aá] (muy |algo |un poco |medio )?(car[oa]|alt[oa]|elevad[oa]|pesad[oa])|l[oa] veo (muy |algo |un poco |medio )?(alt[oa]|car[oa]|elevad[oa])|muy car[oa]|carisim|no me alcanza|no me sale|no me ajusta|no completo\b|se me hace (caro|mucho|pesado|alto)|(mensualidad|pago mensual|enganche|precio)[^?]{0,24}(alt[oa]|pesad[oa]|fuerte|elevad)|fuera de mi (presupuesto|alcance)|no puedo pagar(lo)?|esta pesado)/;

// ── 🔥 COMPRADOR CALIENTE — compromiso material declarado ──
// OJO: "lo quiero VER/manejar" es cita (recepcionista), no compra — se excluye.
const RE_CALIENTE = /((ya |si |asi )?(ir[ií]a|voy|llego|caigo|vengo)[^?]{0,30}con (la |el |los |mi )?(papeleria|papeles|documentos|enganche|dinero|efectivo)|me l[oa] llevo|l[oa] quiero(?! ver| manejar| probar| checar| conocer| revisar| checarl)|donde firmo|apartamel[oa]|(lo|la) aparto\b|como (lo |la )?aparto|te lo separo|separamel[oa]|(lo|la) voy a (agarrar|comprar|llevar)|tengo (ya )?(el )?(enganche|dinero) (listo|junto|juntado|completo)|(pago|pagaria|lo pago|la pago) de contado|de contado l[oa] (pago|agarro|compro)|llevo el efectivo|vamos a (agarrarl[oa]|comprarl[oa])|ya (lo|la) decidi|estoy decidid|ya tengo (el )?credito (aprobado|listo)|mi banco (ya )?me (presta|aprobo|autorizo))/;

// ── Proceso de PAGO/CIERRE — "¿cuándo doy el enganche?" etc. (zona de cierre → owner) ──
const RE_PROCESO_PAGO = /((daria|doy|dar|entrego|entregar|pago|pagar) el enganche[^?]{0,30}(entrega|recibir|momento|cuando|antes|despues)|enganche[^?]{0,20}(en la entrega|al recibir|al momento de)|(cuando|donde|como|en que momento) (se )?(da|doy|dan|paga|pago|entrega|entrego) (el )?(enganche|dinero|anticipo)|(hay que|tengo que|debo) (dar|pagar|depositar|soltar) (algo|dinero|anticipo|el enganche) (antes|primero|ya)|se paga (algo )?(antes|por adelantado)|piden (anticipo|deposito) antes)/;

// ── ¿Es freno simple? (para elegir el puente que no enfría al caliente) ──
const RE_FRENO = /(te aviso|les aviso|me comunico|te confirmo|lo pienso|lo platico|lo consulto|deja(me)? (chec|ver|veo|progr|cuadrar|acomodar|organizar)|me programo|dame (chance|tiempo|oportunidad)|aguantame|esperame|(ando|estoy|he andado) (muy |bien+ |re )?(atareado|atariado|ocupado|saturado)|tengo (varios )?compromisos)/;

// ══════════════════════════════════════════════════════════════════════
// PUERTA DE ENTRADA — corre ANTES del motor: los momentos de gol ni se procesan.
// Devuelve null (pasa al motor) o { escalar, motivo, puente }.
// ══════════════════════════════════════════════════════════════════════
function puertaEntrada(texto) {
    const t = norm(texto);
    if (RE_HUMANO.test(t)) return {
        escalar: true, doctrina: 'humano',
        motivo: '🔴 HUMANO — mencionó salud/familia/crisis. Dale seguimiento PERSONAL (el bot solo acusó con calidez y se apartó)',
        puente: 'Ntp, eso es lo primero — tómate tu tiempo, aquí ando pendiente'
    };
    if (RE_RIESGO.test(t)) return {
        escalar: true, doctrina: 'riesgo',
        motivo: '🔴 VENTA EN RIESGO — ve caro/alto el costo. El póker es tuyo',
        puente: 'Va, sin tema; déjame checo si hay forma de acomodarte mejor los números y aquí te digo'
    };
    if (RE_CALIENTE.test(t)) return {
        escalar: true, doctrina: 'caliente',
        motivo: '🔥 COMPRADOR CALIENTE — compromiso material declarado (papelería/enganche/contado/apartar/firma). TUYO',
        puente: RE_FRENO.test(t)
            ? 'Va, sin tema, aquí ando pendiente'
            : 'Perfecto, déjame dejo todo listo y aquí mismo te confirmo'
    };
    if (RE_PROCESO_PAGO.test(t)) return {
        escalar: true, doctrina: 'proceso_pago',
        motivo: '💰 pregunta el PROCESO DEL PAGO/ENGANCHE (zona de cierre — explícalo tú)',
        puente: 'Déjame te explico bien cómo va lo del pago y en un momento te digo'
    };
    return null;
}

// ══════════════════════════════════════════════════════════════════════
// PUERTA DE SALIDA — corre DESPUÉS del motor: universos que ya NO contesta el bot
// (políticas/procesos/persuasión). El motor los detecta; la doctrina los escala.
// ══════════════════════════════════════════════════════════════════════
const DESTINOS = {
    seguro:          { motivo: 'pregunta del SEGURO (política de crédito)', puente: 'Déjame te confirmo bien lo del seguro y aquí te digo' },
    duda_cotizacion: { motivo: 'duda fina de la cotización (comisión/CAT/qué incluye)', puente: 'Déjame te lo confirmo exacto y aquí te digo' },
    abono_capital:   { motivo: 'pregunta ABONOS A CAPITAL (política de crédito)', puente: 'Déjame te confirmo bien cómo aplica en tu crédito y aquí te digo' },
    negociacion:     { motivo: 'quiere NEGOCIAR el precio (sin número)', puente: 'Va, déjame lo checo y aquí mismo te digo' },
    trade_in:        { motivo: 'ofrece su auto A CUENTA (valuación — tuya)', puente: 'Claro, déjame checo cómo lo tomamos a cuenta y te digo' },
    negocio:         { motivo: 'pregunta CÓMO FUNCIONA el negocio (pitch de confianza — tuyo)', puente: 'Claro, déjame te explico bien cómo trabajamos y en un momento te escribo' },
    lugar_seguro:    { motivo: 'pregunta si el punto es SEGURO (confianza — tuya)', puente: 'Te entiendo perfecto; dame un momento y te explico bien cómo te protegemos' },
    llevar_mecanico: { motivo: 'quiere llevar MECÁNICO a la cita (política — confírmala tú)', puente: 'Dame un momento y te confirmo lo del mecánico' },
    foraneo:         { motivo: 'comprador FORÁNEO (jugada de distancia: cita anticipada vs envío — tuya)', puente: 'No hay bronca por la distancia; déjame veo cómo te lo acomodamos mejor y aquí te digo' },
    terceros:        { motivo: 'crédito a NOMBRE DE OTRA persona (política — tuya)', puente: 'Claro, déjame confirmo cómo quedaría a su nombre y te digo' },
    banco_propio:    { motivo: '🔥 trae CRÉDITO PROPIO aprobado (caliente — tuyo)', puente: 'Perfecto, con tu crédito sin problema; déjame coordino todo y te confirmo' },
    que_sigue:       { motivo: 'pregunta QUÉ SIGUE (zona de cierre — dirígelo tú)', puente: 'Ahorita te escribo bien el siguiente paso, dame un momento' },
    multi:           { motivo: '💰 proceso del enganche + cita en el mismo mensaje (zona de cierre)', puente: 'Déjame te explico bien cómo va lo del pago y en un momento te digo' }
};

function puertaSalida(r) {
    if (!r || r.escalar || r.silencio || !r.universo) return r;
    const d = DESTINOS[r.universo];
    if (!d) return r;                       // lista blanca → pasa
    return { escalar: true, doctrina: 'universo', motivo: d.motivo, puente: d.puente };
}

// ══ CANDADO STANDBY (🚩fyrachat#8, caso Gustavo 2026-07-12) ══════════════════
// Frases del OWNER (mensaje MANUAL, ai_generated=0) que significan "yo quedo de
// confirmar": el bot se CONGELA en ese chat — ni propone horas ni cierra citas —
// hasta que el owner vuelva a escribir a mano algo que no sea otro "espera".
const RE_STANDBY = /(mejor te confirmo|dejame (lo |te )?(confirmo|confirmar|checar|checo|ver|veo|revisar|reviso|preguntar|pregunto)|dame (chanza|chance|oportunidad|un momento|unos minutos|[0-9]+ min)|ahorita te (confirmo|aviso|digo)|yo te (digo|aviso|confirmo)|esperame|te confirmo (ahorita|al rato|mas tarde|en un rato|manana)|en cuanto (sepa|me confirme|me confirmen|me conteste|me contesten)|(todavia|aun) no me (contesta|contestan|confirma|confirman))/;
// Si el mensaje ADEMÁS trae una confirmación real, NO es standby ("te confirmo que sí está").
const RE_NO_STANDBY = /(confirmad[oa]|ya quedo|queda entonces|si esta disponible|esta apartad)/;
function esStandby(texto) {
    const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return RE_STANDBY.test(t) && !RE_NO_STANDBY.test(t);
}
const ACUSE_STANDBY = 'Va, en cuanto tenga la confirmación te aviso';

// ══ POSESIÓN DEL OWNER → MODO HERRAMIENTA (orden 2026-07-13, casos Gustavo 7:44pm
// y David Castillo): con el owner al volante el bot NO conversa — solo sirve
// HERRAMIENTA pura: cotizar / fotos / ubicación+horarios / ficha. Tal cual,
// sin maquillaje y sin UN solo gancho. Todo lo demás: silencio total.
const UNIV_HERRAMIENTA = ['cotizacion', 'fotos', 'ubicacion', 'info_auto'];
const RE_GANCHO_HERR = /(te agendo|te late|c[oó]mo la ves|te queda bien|lo coordino|con que me digas|en firme|te espero|nos vemos|te cotizo|agendarte|te aparto|lo apartamos|prueba de manejo)/i;
function herramientaPura(r) {
    if (!r || r.escalar || r.silencio || !Array.isArray(r.segmentos) || !r.segmentos.length) return null;
    if (UNIV_HERRAMIENTA.indexOf(String(r.universo || '')) === -1) return null;
    const esGancho = s => {
        const t = String(s || '').trim();
        if (!t) return true;
        if (t.indexOf('\n') !== -1) return false;               // tarjetas multilinea JAMÁS se tocan
        if (/enganche/i.test(t) && /\?\s*$/.test(t)) return false; // el cotizador puede pedir su input
        return /\?\s*$/.test(t) || RE_GANCHO_HERR.test(t);
    };
    const segs = r.segmentos.filter(s => !esGancho(s));
    if (!segs.length) return null;
    return Object.assign({}, r, { segmentos: segs, escalar: false, puente: null, cita_confirmada: false, cita_datos: null, cita_resume: false });
}

// ══ CONTROL vs RESCATE (human in the loop, orden owner 2026-07-13) ═══════════
// posesionOwner(mensajes) recorre el hilo y decide si el owner tiene el CONTROL:
// - CONTROL: manual con INICIATIVA (pregunta al comprador o promesa/propuesta RE_CONTROL),
//   o manual con sustancia SIN escalada pendiente (nada que rescatar = iniciativa),
//   o 2º manual tras respuesta del comprador a un rescate (ping-pong = ya es su hilo).
// - RESCATE: manual de puro dato con escalada pendiente (entrante sin out) → NO toma.
// - Transparente: acuse de ≤2 palabras sin iniciativa ("Okok","Correcto") → no juega.
// - Vigencia: 12h; estando en control, CUALQUIER manual suyo renueva el reloj.
const RE_CONTROL = /(te (confirmo|aviso|llevo|acerco|marco|hablo|espero|mando|aparto)|deja(me)? (ver|checar|checo|confirmar|pregunt)|yo te|te la (llevo|acerco|aparto|enseno)|nos vemos|ahi (te|nos|estare)|dame (chanza|chance|oportunidad)|mejor te|al rato te|en un rato te|te parece si)/;
// OPCIÓN A (owner 2026-07-13): tras una escalada de CRITERIO (doctrina: riesgo/caliente/
// pago/foráneo/humano...), el PRIMER manual del owner — del tamaño que sea, hasta un
// "okey" — toma posesión. Las escaladas de BUG/HUECO (fallbacks del bot) NO: ahí el
// parche del owner deja al bot seguir (reglas normales de rescate/transparencia).
const RE_ESCALA_BUG = /(fuera de (la )?lista blanca|fuera de banco|no descifrado|juez ia|🧠|no sabe qué no vio|no tiene punto de venta configurado)/i;
function posesionOwner(mensajes, escalas) {
    escalas = escalas || [];
    let ctrl = 0, rescateTs = 0, rescateRespondido = false, prevOutTs = 0;
    // POSESIÓN SOLO EN ETAPA 3 (spec owner 2026-07-13): un manual solo puede tomar
    // control si su ráfaga es la #3+ (opener y continuación NO activan posesión —
    // antes, un manual del turno 1-2 dejaba la posesión pre-armada).
    let rafagas = 0, prevDir = null;
    for (let i = 0; i < (mensajes || []).length; i++) {
        const m = mensajes[i];
        if (m.direccion === 'out') { if (prevDir !== 'out') rafagas++; prevDir = 'out'; } else prevDir = 'in';
        if (m.direccion === 'in') { if (rescateTs) rescateRespondido = true; continue; }
        if (m.ai) { prevOutTs = Number(m.ts); continue; }
        if (rafagas < 3) { prevOutTs = Number(m.ts); continue; }   // etapa 1-2: no juega
        // renovación SOLO si el control sigue vivo (<12h entre manual y manual);
        // un control viejo no revive con un rescate de hoy — se re-evalúa desde cero.
        if (ctrl && (Number(m.ts) - ctrl) < 12 * 3600000) { ctrl = Number(m.ts); prevOutTs = Number(m.ts); continue; }
        ctrl = 0;
        // OPCIÓN A: ¿este manual llega tras una escalada de CRITERIO pendiente?
        const escCriterio = escalas.some(e => Number(e.ts) > prevOutTs && Number(e.ts) <= Number(m.ts) && !RE_ESCALA_BUG.test(String(e.motivo || '')));
        if (escCriterio) { ctrl = Number(m.ts); prevOutTs = Number(m.ts); continue; }
        const txt = String(m.mensaje || '');
        const tN = txt.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const conIniciativa = txt.indexOf('?') !== -1 || RE_CONTROL.test(tN);
        const palabras = tN.trim().split(/\s+/).filter(Boolean);
        if (!conIniciativa && palabras.length <= 2) { prevOutTs = Number(m.ts); continue; }
        let pendiente = false;
        for (let j = i - 1; j >= 0; j--) {
            if (mensajes[j].direccion === 'in') { pendiente = true; break; }
            if (mensajes[j].direccion === 'out') break;
        }
        if (conIniciativa || !pendiente || (rescateTs && rescateRespondido)) ctrl = Number(m.ts);
        else { rescateTs = Number(m.ts); rescateRespondido = false; }
        prevOutTs = Number(m.ts);
    }
    return (ctrl && (Date.now() - ctrl) < 12 * 3600000) ? ctrl : 0;
}

module.exports = { puertaEntrada, puertaSalida, DESTINOS, RE_HUMANO, RE_RIESGO, RE_CALIENTE, RE_FRENO, esStandby, ACUSE_STANDBY, herramientaPura, UNIV_HERRAMIENTA, posesionOwner, RE_CONTROL };
