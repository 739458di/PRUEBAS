// lib/seb/etapa3.js
// ETAPA 3 — EL JUEGO LIBRE (turno 3+). SOLO COPILOTO: esto corre cuando el owner pica
// "sugerir"; JAMÁS auto-envía. Es el MISMO motor que sería el automático (misma mecánica),
// solo que el gatillo es su click. Las acciones (fotos/pin) viajan en meta y se ejecutan
// AL APROBAR, igual que en el autopilot (manual_directo consume_qid).
//
// Arquitectura (4 capas):
//   1. INTERPRETAR — Haiku ya clasificó (llega intencion + datos: enganche/plazo/fecha/hora).
//   2. FUENTE — banco del owner (~80%) → herramienta con dato real → null (cae al cerebro
//      Sonnet con su voz) → o ESCALA dura (dinero/una llamada/sin política).
//   3. VESTIR — ritual etapa 3: SIN saludo, SIN presentación, SIN nombre, afirmación
//      fundida ("Sisi, trae quemacocos"), 1-3 burbujas estratégicas.
//   4. DIRIGIR — CTA por ESTADO (brújula de avance mínimo): nunca el mismo CTA dos veces,
//      cita pedida 2 veces sin éxito → silencio; entrega pendiente ES el mensaje.
//
// Reglas de la autopsia (180 convs): el CTA de cita mató al 28% cuando sustituyó una
// entrega o se repitió; resolver la duda dominante hace que el comprador pida la cita solo.

const { query } = require('./db.js');
const { cotizar, planes, fotosDeAuto, enganche_minimo, bancoDeAuto } = require('./herramientas.js');
const { subInfo, infoAccion } = require('./info_auto.js');
const { datosPunto, ciudadCercana } = require('./continuacion.js');
const { gobernar, esGancho } = require('./gobernador.js');
const { puertaEntrada, puertaSalida } = require('./doctrina.js');
const { juzgar } = require('./juez.js');
const { maquillar } = require('./conector.js');

// ── EL VESTIDOR (orden owner 2026-07-09): acción concreta PERO maquillada ACORDE al
// input (conector con sintonía, palabras específicas) — nunca robótica-seca.
// Devuelve el conector ('' si la IA falla) y sintonía (false → la respuesta no embona → escala).
async function vestir(texto, accion, pool) {
    const r = await maquillar({ texto, accion, pool: pool || ['Claro', 'Mira', 'Va'] });
    return { c: r.conector || '', sintonia: r.sintonia !== false };
}
// Funde conector + acción en UNA burbuja natural: "Claro, son $345,000".
const fusion = (c, accion) => c ? `${c}, ${accion.charAt(0).toLowerCase()}${accion.slice(1)}` : accion;

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const rot = a => a[Math.floor(Math.random() * a.length)];

// ── CIERRE DE CITA (la "zona killer") — extractores de día/hora del texto crudo ──
// Respaldan a Haiku (d.fecha/d.hora); si Haiku no las sacó, las leemos aquí.
const DIAS = 'lunes|martes|miercoles|jueves|viernes|sabado|domingo';
function sacaFecha(t) {
    if (/\bhoy\b/.test(t)) return 'hoy';
    if (/pasado ?manana/.test(t)) return 'pasado mañana';
    if (/\bmanana\b/.test(t)) return 'mañana';
    const md = t.match(new RegExp('\\b(' + DIAS + ')\\b'));
    if (md) return md[1] === 'miercoles' ? 'miércoles' : md[1] === 'sabado' ? 'sábado' : md[1];
    const mn = t.match(/\bel (\d{1,2})(?![\d.,:%])/);
    if (mn) return 'el ' + mn[1];
    return null;
}
function sacaHora(t) {
    // "antes/después de las N" es una FRANJA (límite), NO una hora exacta → lo maneja sacaFranja.
    if (/\b(antes|despues|luego) de (la|las)\b/.test(t)) return null;
    let m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (m) return m[1] + (m[2] ? ':' + m[2] : '') + m[3];
    m = t.match(/\ba ?las? (\d{1,2})(?::(\d{2}))?\b/);   // tolera "alas 5" y "a la 1"
    if (m) { const h = Number(m[1]); const suf = h >= 1 && h <= 6 ? 'pm' : (h >= 7 && h <= 11 ? 'am' : ''); return m[1] + (m[2] ? ':' + m[2] : '') + suf; }
    m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(de la (manana|tarde|noche)|hrs?|horas)\b/);
    if (m) { const q = m[3] || ''; const suf = /manana/.test(q) ? 'am' : /tarde|noche/.test(q) ? 'pm' : ''; return m[1] + (m[2] ? ':' + m[2] : '') + suf; }
    return null;
}
// FRANJA = ventana vaga que da el comprador ("antes de las 4", "por la tarde", "temprano").
// Seb la reconoce y PROPONE horas concretas dentro de ella para cerrar en firme.
function sacaFranja(t) {
    let m = t.match(/antes de (la|las) (\d{1,2})/);
    if (m) return { tipo: 'antes', n: Number(m[2]) };
    m = t.match(/(despues|luego) de (la|las) (\d{1,2})/);
    if (m) return { tipo: 'despues', n: Number(m[3]) };
    if (/(por|en) la manana|tempran/.test(t)) return { tipo: 'texto', txt: 'por la mañana' };
    if (/(por|en) la tarde|saliendo de(l| mi) trabaj/.test(t)) return { tipo: 'texto', txt: 'por la tarde' };
    if (/(por|en) la noche|ya en la noche/.test(t)) return { tipo: 'texto', txt: 'por la noche' };
    if (/(al medio ?dia|medio dia)/.test(t)) return { tipo: 'texto', txt: 'al mediodía' };
    return null;
}
const hpm = h => h >= 1 && h <= 6 ? h + 'pm' : (h >= 7 && h <= 11 ? h + 'am' : h + '');
// El mensaje de cierre que dispara al dueño: lleva "cita confirmada ✅" LITERAL
// (ese texto saliente es el trigger que ya existe en cita-extractor). Copiloto en real
// (sale al aprobar), automático en el sandbox (se simula la tarjeta al dueño).
function citaConfirmadaSeg(fecha, hora, lugar) {
    const cuando = [cap(fecha), hora ? 'a las ' + hora : ''].filter(Boolean).join(' ');
    const donde = lugar ? ' en ' + lugar : '';
    return {
        universo: 'cita_confirmada',
        cita_confirmada: true,
        cita_datos: { fecha, hora, lugar: lugar || null },
        segmentos: [
            rot(['Listo', 'Va que va', 'Perfecto']) + ', entonces ' + cuando + donde,
            'Cita confirmada ✅',
            'Cualquier cambio aquí me avisas'
        ]
    };
}

// Motivo de escala CLARO cuando cotizar/planes no puede (que el owner sepa qué hacer).
const MOTIVO_COTIZA = e => e === 'auto_financiera_pendiente'
    ? 'el auto es <2018: HEY no lo financia, va por FINANCIERA (fórmula pendiente) — arma tú la cotización'
    : e === 'sin_precio' ? 'el auto no tiene precio cargado en inventario'
    : 'no se pudo cotizar (' + (e || 'error') + ')';

// ══════════════════════════════════════════════════════════════════════
// ESTADO — se calcula de los MENSAJES cada vez (fuente de verdad, nunca rancio)
// ══════════════════════════════════════════════════════════════════════
async function estadoConv(conv_id) {
    const ms = await query("SELECT direccion, texto, tipo FROM mensajes WHERE conversacion_id=? ORDER BY ts ASC, id ASC", [conv_id]);
    const outs = ms.filter(m => m.direccion === 'out');
    const ins = ms.filter(m => m.direccion === 'in');
    const t = m => norm(m.texto);
    const ya_cotizado = outs.some(m => /sujeto a aprobacion bancaria|monto a financiar|planes de financiamiento/.test(t(m)));
    // ¿el CRÉDITO ya salió en la conversación? (lo trajo el COMPRADOR, o ya cotizamos).
    // Sin esto, el gancho ofrecía "te cotizo" a un comprador que quizá va de CONTADO.
    const credito_tocado = ya_cotizado || ins.some(m => /(credit|financ|enganche|mensualidad|a meses|\d+ ?meses|a plazos?|\bplazo\b|\bbur[oó]\b|preaprob|nomina|comprobante de ingres)/.test(t(m)));
    const fotos_enviadas = outs.some(m => String(m.tipo || '') === 'image');
    const pin_enviado = outs.some(m => String(m.tipo || '') === 'location' || /maps\.(google|app)/.test(t(m)));
    let citas_pedidas = 0;
    outs.forEach(m => {
        if (/\?/.test(String(m.texto || '')) &&
            /(te agendo|agendarte|venir a verl|te coordino|que dia te|hora te queda|te esperamos|prueba de manejo|cuando te interesa venir)/.test(t(m))) citas_pedidas++;
    });
    const ultima_pregunta = outs.slice().reverse().map(m => String(m.texto || '').trim()).find(x => /\?\s*$/.test(x)) || null;
    // ¿ya soltamos un proactivo de estado? (para no repetir "impecable" a cada rato).
    const proactivo_usado = outs.some(m => /(impecable|excelentes condiciones|como nuev|buenisim|de lujo|una belleza)/.test(t(m)));
    // ── MEMORIA DEL GOBERNADOR (el termostato del gancho, análisis #591) ──
    const outsTx = outs.map(m => String(m.texto || '').trim()).filter(Boolean);
    // Últimas 10 líneas enviadas, normalizadas (para el dedup: jamás repetirse textual).
    const ultimos_out = outsTx.slice(-10).map(x => norm(x).replace(/\s+/g, ' ').trim());
    // ¿Nuestro último mensaje fue un GANCHO? (si el comprador no lo contesta, se enfría).
    const gancho_abierto = outsTx.length ? esGancho(outsTx[outsTx.length - 1]) : false;
    // ¿Ya hay cita confirmada ✅? (tras el sí se deja de vender — candado).
    const cita_confirmada = outsTx.some(x => /cita confirmada/i.test(x));
    return { ya_cotizado, fotos_enviadas, pin_enviado, citas_pedidas, ultima_pregunta, credito_tocado, proactivo_usado, ultimos_out, gancho_abierto, cita_confirmada };
}

// ══════════════════════════════════════════════════════════════════════
// PROACTIVIDAD DE VENTA — comentario que tranquiliza+empuja cuando la duda lo amerita.
// Tipos (de la data real del owner): 'estado' (impecable+manejar), 'negocio' (modelo de
// confianza), 'emocional' (anímate). CONTROL POR AUTO: inventario_autos.proactividad=0
// apaga los proactivos de ESTADO de ese auto (excepción: tiene un detalle, no mentimos).
// Candados: 1 por conversación (proactivo_usado), voz sobria (sin ! ni emojis).
// ══════════════════════════════════════════════════════════════════════
async function proactivo(auto_id, tipo, est) {
    if (tipo === 'estado' || tipo === 'emocional') {
        if (est && est.proactivo_usado) return '';                 // no saturar: 1 por conversación
        const r = await query("SELECT proactividad FROM inventario_autos WHERE id=?", [Number(auto_id)]).catch(() => []);
        const on = !r.length || r[0].proactividad == null || Number(r[0].proactividad) === 1;
        if (!on) return '';                                        // auto EXCEPCIÓN → no decir "impecable"
    }
    if (tipo === 'estado') return rot([
        'Está impecable, ven a manejarlo para que lo sientas',
        'En excelentes condiciones, ven a verlo y manejarlo',
        'La verdad está impecable, ven a checarlo con calma',
        'Está como nuevo, ven a manejarlo y lo compruebas'
    ]);
    if (tipo === 'negocio') return rot([   // el VALOR del modelo aplica siempre (no depende del auto)
        'Todos nuestros autos son de dueños particulares con uso cotidiano, filtrados y con la seguridad de agencia',
        'Son autos de particulares seleccionados, con papeles en regla y el respaldo de un intermediario'
    ]);
    if (tipo === 'emocional') return rot(['Ojalá te animes, está buenísimo', 'Anímate, no te vas a arrepentir, está impecable']);
    return '';
}
// Sub-áreas de info del auto que SÍ ameritan proactivo de estado (cargan una duda oculta).
const SUB_PROACTIVABLE = new Set(['duenos', 'choques', 'adeudos', 'servicios', 'papeleria', 'detalles', 'km']);

// ══════════════════════════════════════════════════════════════════════
// CTA por ESTADO — la brújula. Devuelve la pregunta final de la ráfaga o '' (silencio).
// ══════════════════════════════════════════════════════════════════════
function ctaEstado(est, carril) {
    let c = '';
    if (carril === 'credito') {
        c = !est.ya_cotizado ? 'Te cotizo? Con cuánto de enganche le hacemos los números?'
            : 'Cómo ves los números?';
    } else if (carril === 'producto') {
        // El carril PRODUCTO nunca empuja cotización (eso es off-topic en una duda de
        // info/negocio); su norte es la CITA. Si ya se pidió cita, calla (no rogar).
        c = (est.citas_pedidas === 0) ? 'Te late venir a verlo y manejarlo?' : '';
    } else if (carril === 'logistica') {
        c = (est.citas_pedidas < 2) ? 'Qué día te queda bien?' : '';
    } else if (carril === 'proseguir') {
        // "Le damos?" ELIMINADO (feedback #591: empuja el cierre cuando el comprador aún
        // calcula — fuera del instinto de venta). Se pregunta por su lectura, no por el sí.
        c = est.ya_cotizado ? 'Cómo ves los números?' : 'Te cotizo?';
    }
    // Frenos: cita pedida 2+ veces sin éxito → silencio; nunca repetir la última pregunta.
    if (est.citas_pedidas >= 2 && /(venir a verl|te agendo|dia te queda|te late venir)/.test(norm(c))) c = '';
    if (c && est.ultima_pregunta && norm(c) === norm(est.ultima_pregunta)) c = '';
    return c;
}

// ══════════════════════════════════════════════════════════════════════
// ESCALA DURA de etapa 3 — esto NO lo contesta ni el banco ni Sonnet: lo ve el owner.
// ══════════════════════════════════════════════════════════════════════
// Devuelve null (no escala) o { motivo, puente } — REGLA DE ORO: el bot JAMÁS se calla,
// SIEMPRE manda un puente al comprador y en paralelo escala al humano para lo que sigue.
function escala3(t) {
    const E = (motivo, puente) => ({ motivo, puente });
    // Petición de ENVIAR algo que no está en el banco (video/carnet/factura/papeles) → puente a la medida.
    if (/(video|graba|andando en video)/.test(t) && /(mandas|manda|pasas|envias|env[ií]as|compartes|tienes|hay|puedes|mande)/.test(t))
        return E('pide VIDEO (grabarlo/pedirlo al dueño)', 'Claro que sí, dame un momento y te mando el video');
    if (/(carnet|bitacora|historial de servicio)/.test(t) && /(mandas|manda|pasas|envias|env[ií]as|compartes|puedes|mande|ver)/.test(t))
        return E('pide el CARNET de mantenimientos (mandárselo)', 'Claro, dame un momento y te paso el carnet de mantenimientos');
    if (/(factura|papeles|documento|tarjeta de circulacion|verificacion)[^?]{0,20}(mandas|manda|pasas|envias|env[ií]as|compartes|foto de|una foto)/.test(t))
        return E('pide documento/factura (mandárselo)', 'Claro que sí, dame un momento y te lo mando');
    // Dudas de cita que el owner mandó ESCALAR: transporte, cuánto dinero llevar, estacionamiento.
    if (/((llego|llegar|voy|puedo ir)[^?]{0,18}(en|sin) (uber|didi|taxi|camion|autobus|transporte|carro|coche|auto))|sin (carro|auto|coche)[^?]{0,12}como (llego|voy|le hago)|hay (como llegar en )?transporte|me pueden (recoger|pasar)/.test(t)) return E('pregunta TRANSPORTE al punto', 'Déjame te confirmo lo del transporte y en un momento te digo');
    if (/((tengo que|debo|necesito|hay que|voy a) llevar (dinero|efectivo|el enganche|algo de dinero))|(llevo|llevar) (dinero|efectivo|el enganche) (a la cita)?|con cuanto (dinero )?(voy|llego|me presento) a la cita|que (dinero|monto) llevo/.test(t)) return E('¿cuánto dinero llevar a la cita? (confirmar con owner)', 'Déjame te confirmo bien ese punto y en un momento te digo');
    if (/(hay|tienen|cuentan con) estacionamiento|donde (me estaciono|puedo estacionar|dejo el carro)|puedo estacionar/.test(t)) return E('pregunta ESTACIONAMIENTO (dato del punto)', 'Déjame lo confirmo y en un momento te digo');
    if (/garant/.test(t)) return E('garantía (sin política fija)', 'Déjame te confirmo bien ese punto y aquí mismo te digo');
    if (/(me (puedes |podrias |puedes )?(marcar|llamar)|marcame|llamame|hablame|una llamada|por telefono mejor)/.test(t)) return E('pide LLAMADA (caliente — márcale)', 'Va, déjame te marco en un momento');
    if (/(entregan?|me lo (llevo|entregan)|salgo manejando)[^?]{0,20}(mismo dia|hoy mismo|al momento)/.test(t)) return E('entrega mismo día (sin política)', 'Déjame lo confirmo con el dueño y aquí te digo');
    if (/iva (completo|total)|facturar (todo|completa) con iva|refactur/.test(t)) return E('factura con IVA completo (confirmar con dueño)', 'Déjame lo confirmo y aquí mismo te digo');
    if (/(baja\w*[^?]{0,12}tasa|tasa[^?]{0,14}(alta|cara|elevada))/.test(t)) return E('objeción de tasa', 'Déjame checo si hay forma de mejorarla y te confirmo');
    if (/(dejamelo en|te (doy|ofrezco|deposito) \$?\d|lo dejas en \$?\d|\d[\d,]{4,}[^?]{0,12}(cerrado|y trato)|ultimo precio.*\d)/.test(t)) return E('oferta con NÚMERO (negociación de dinero)', 'Va, déjame lo checo con el dueño ahorita mismo y aquí te digo');
    // TRABAJO POR MI CUENTA / independiente → escala (caso a caso con el banco).
    if (/(por mi (propia )?cuenta|independiente|negocio propio|soy mi (propio )?jefe|no tengo nomina|sin nomina|informal|trabajo libre|freelance|honorarios)/.test(t)) return E('comprador SIN nómina / independiente (revisar caso con el banco)', 'Déjame reviso tu caso y te confirmo qué te piden, dame un momento');
    // MIEDO / OBJECIÓN HUMANA (fraude, desconfianza, "no me alcanza") → escala con calidez.
    if (/(fraude|estafa|es confiable|puedo confiar|como se que no|no me vayan a|me da miedo|desconfianza|es seguro (comprar|esto)|no es (falso|trampa)|me van a robar)/.test(t)) return E('MIEDO/desconfianza (trato humano)', 'Es la duda más válida que hay, dame un momento y te explico bien cómo te protegemos');
    if (/(no se si (me alcance|pueda|calific)|no me alcanza|esta (muy )?caro para mi|no creo (poder|calificar)|no tengo tanto)/.test(t)) return E('MIEDO al alcance/precio (trato humano)', 'Tranquilo, déjame vemos números que se te acomoden y te confirmo, dame un momento');
    return null;
}

// ══════════════════════════════════════════════════════════════════════
// BANCOS DEL UNIVERSO DE NEGOCIO (palabras del owner, aprobadas; vestido etapa 3)
// ══════════════════════════════════════════════════════════════════════
async function nombreAuto(auto_id) {
    if (!auto_id) return null;
    const r = await query("SELECT marca, modelo, anio FROM inventario_autos WHERE id=?", [Number(auto_id)]);
    return r.length ? [r[0].marca, r[0].modelo, r[0].anio].filter(Boolean).join(' ') : null;
}

// FORÁNEO COMO OBJECIÓN: el comprador está/vive en otra ciudad y eso es la traba
// (no una simple pregunta de "¿dónde están?"). Ciudades foráneas comunes + framing de lejanía.
const CIUDADES_FORANEAS = /(saltillo|torreon|torreón|reynosa|matamoros|nuevo laredo|\blaredo\b|tampico|victoria|cd victoria|ciudad victoria|durango|zacatecas|san luis|slp|aguascalientes|guadalajara|\bgdl\b|cdmx|ciudad de mexico|mexico city|df\b|monclova|piedras negras|sabinas|linares|montemorelos|chihuahua|culiacan|mazatlan|veracruz|puebla|queretaro|leon|guanajuato|tijuana|hermosillo|merida|cancun|oaxaca|morelia|toluca)/;
function esForaneoObjecion(t) {
    if (/\bdonde\b (estan|se ubican|queda)/.test(t) && !CIUDADES_FORANEAS.test(t)) return false;  // solo quiere el punto
    const dice_foraneo = /(estoy|ando|vivo|radico|soy|me encuentro) (aqui )?(en|de|por) /.test(t) && CIUDADES_FORANEAS.test(t);
    const lejania = /(me queda (lejos|retirado)|esta (muy )?lejos|hasta (aca|alla|aya)|otro estado|soy foraneo|somos foraneos|no soy de (aqui|mty|monterrey)|estoy fuera de (mty|monterrey)|desde (otra ciudad|fuera)|no estoy en (mty|monterrey))/.test(t);
    const solo_ciudad = CIUDADES_FORANEAS.test(t) && /(pense que|crei que|estan en|estan aca|estan por)/.test(t);
    return dice_foraneo || lejania || solo_ciudad;
}

// FORÁNEO — la jugada depende de QUÉ tan lejos (🚩 sandbox 2026-07-09):
// ciudad CERCANA (Saltillo, Ramos, etc. — de ahí SÍ vienen manejando) → CITA CON
// ANTICIPACIÓN primero ("para que no hagas el viaje en balde") y el envío como opción.
// Lejana/desconocida → envío primero, pero SIEMPRE con la cita anticipada como opción.
function respForaneo(t, est) {
    const ciudad = ciudadCercana(t);
    const sinGancho = est && est.citas_pedidas >= 2;
    if (ciudad) {
        return { universo: 'foraneo', segmentos: [
            'No hay bronca por la distancia',
            `Somos de Monterrey; te agendo tu cita con anticipación para que no hagas el viaje en balde desde ${cap(ciudad)}`,
            'Y si lo prefieres también manejamos envío: un mecánico o conocido tuyo la revisa aquí y te la enviamos con garantía de viaje',
            ...(sinGancho ? [] : ['Te agendo con anticipación?'])
        ] };
    }
    return { universo: 'foraneo', segmentos: [
        rot(['No hay bronca por la distancia', 'Que estés en otra ciudad no nos frena']),
        'Somos de Monterrey y manejamos envío a todo el país: mandas a un mecánico o conocido tuyo aquí en Mty a que la revise y te dé luz verde, y te la enviamos con garantía de viaje',
        'O si prefieres venir a verla, te agendo tu cita con anticipación para que no hagas el viaje en balde',
        ...(sinGancho ? [] : ['Cómo te acomoda mejor, envío o venir a verla?'])
    ] };
}

function detectarUniverso(t, clasif) {
    // Orden importa: primero lo específico, al final los respaldos por intención de Haiku.
    if (/(\bfotos?\b|imagenes|imágenes|mas fotos|más fotos|fotos del interior|me mandas fotos|tienes fotos|\bvideo\b|un video)/.test(t)) return /\bvideo/.test(t) ? 'video' : 'fotos';
    if (/(agencia|un lote|\blote\b|particular asi por fuera|por particular|como funciona (la compra|esto|fyradrive|su empresa|el negocio|ustedes|todo)|como (trabajan|operan)|que (empresa|negocio) son|como seria la compra|quienes son ustedes|son de fiar|comision|comisión|intermediari)/.test(t)) return 'negocio';
    if (/(a cuenta|a cambio|toman mi|tomas mi|reciben mi|en cuanto (me )?(toman|reciben)|mi (auto|carro|camioneta) (de|como|a) (cuenta|cambio))/.test(t)) return 'trade_in';
    if (/(negociable|mejor precio|es lo menos|se puede negociar|bajale|bájale|descuento|precio de contado)/.test(t)) return 'negociacion';
    // PRECIO directo ("cuál es el precio de lista?") — pregunta FACTUAL, la más común;
    // antes caía a escala/cerebro y salía con ganchos encimados (#591).
    if (/(cual es el precio|precio de lista|que precio (tiene|es|maneja)|cuanto (cuesta|sale|vale|piden)|en cuanto (la|lo) (dan|das|dejan|venden|sale|tienes|tienen)|cuanto esta el|el precio\?)/.test(t) && !/(negoci|descuento|bajale|lo menos|contado)/.test(t)) return 'precio';
    if (/(abono a capital|\ba capital\b|liquidar antes|pagar antes|adelantar pagos|pagos adelantados|penaliz)/.test(t)) return 'abono_capital';
    if (/(otros? (autos?|carros?|unidades|vehiculos)|que mas tienes|qué más tienes|mas opciones|más opciones|inventario|algo mas (nuevo|barato)|otra unidad)/.test(t)) return 'otros_autos';
    if (/(esta abierto|estan abiertos|abren (hoy|ahorita|ahora)|puedo pasar (hoy|ahorita|ahora)|sin cita|atienden (hoy|ahorita))/.test(t)) return 'abierto';
    if (/(que factura|tipo de factura|facturan|factura original|endoso|endosan|a mi nombre|es nacional)/.test(t)) return 'facturacion';
    if (/((lleva|trae|incluye|viene con)[^?]{0,14}seguro|seguro[^?]{0,16}(incluido|aparte|mensualidad|por mi cuenta)|mensualidad[^?]{0,16}seguro)/.test(t)) return 'seguro';
    if (/(que incluye la mensualidad|comision por apertura|\bcat\b|costo anual total)/.test(t)) return 'duda_cotizacion';
    if (/(que (año|ano|modelo) es|es (2019|2020|2021|2022|2023|2024|2025)|de que (año|ano))/.test(t)) return 'anio';
    if (/(que sigue|cual es el siguiente paso|como le hacemos|que procede|como procedemos)/.test(t)) return 'que_sigue';
    // "papelería/papeles/datos que OCUPO/me piden" = requisitos del crédito (antes de que
    // subInfo lo lea como papelería DEL AUTO — "está en regla" es otra pregunta).
    if (/((papeleria|papeles|documentos|datos)[^?]{0,20}(ocupo|necesito|debo|tengo que|piden|enviar|mandar|llevar))/.test(t)) return 'credito';
    // CRÉDITO A TERCERO (a nombre de otra persona) — señal manejable, respuesta de seguridad.
    if (/((a nombre|para|lo saca|lo pide|daria la cara|el credito (es|va|sea|seria)|titular)[^?]{0,18}(mi |su |de mi |otra persona|un familiar|tercero|nombre de))|((mi|su) (mama|papa|esposo|esposa|hermano|hermana|hija|hijo|pareja|suegr\w+|conyuge|novi\w)[^?]{0,20}(credito|nombre|titular|daria|sacaria|pondria|es quien))/.test(t)) return 'terceros';
    // BANCO PROPIO / crédito ya aprobado del comprador — SEÑAL DE COMPRA, salta a cita.
    if (/((tengo|traigo|cuento con|ya (tengo|traigo|me)|dispongo de)[^?]{0,18}(credito|prestamo|preaprob|aprobad|linea))|(mi (propio )?(credito|banco|prestamo))|((santander|banorte|bbva|banregio|hsbc|scotia|afirme|banamex|citibanamex|nu\b|inbursa)[^?]{0,18}(me|ya|lo|puedo|se puede|aprob))|(caja (popular|de ahorro))|(pagar? con (mi )?(credito|prestamo|banco|otra financiera))|credito externo/.test(t)) return 'banco_propio';
    // LUGAR SEGURO / cómo es el punto (característica, NO "¿dónde?") → propuesta de valor.
    if (/(el (punto|lugar) (es|sera|va a ser)? ?(seguro|confiable)|que tan seguro (es )?(el|ese|el punto|el lugar)|es seguro (ir|el punto|el lugar|ese|ahi)|como es (el|ese|el) (punto|lugar)|es (un )?(punto|lugar|zona) (seguro|segura|confiable)|es seguro (comprar )?(ahi|en el punto)|el punto es de fiar)/.test(t)) return 'lugar_seguro';
    // LLEVAR MECÁNICO / alguien de confianza a revisar → sí, sin problema.
    if (/((llevar|traer|puedo llevar|puede ir|va a ir|llevo)[^?]{0,14}(a )?(mi )?mecanico|un mecanico|alguien que (sepa|revise|checar|entienda))|(revisar(lo)?|checar(lo)?) con (un |mi )?mecanico|traer a alguien (que revise|de confianza)/.test(t)) return 'llevar_mecanico';
    // 🚩611: "mándame MÁS INFORMACIÓN" (general) → EL MACHOTE (la ficha completa del
    // Sales Brain) y luego el gancho. Va ANTES de subInfo para que no lo pesque 'detalles'.
    // 🚩628: "dame MÁS DETALLES" también es pedir la información (machote). OJO: "¿tiene
    // algún detalle?" (defectos) NO entra aquí — se exige el verbo de pedir o el "más".
    if (/((mas|toda) (la )?(informacion|informes|info)\b|(informacion|informes) (completa|del (auto|carro|coche))|manda(r|s|rme)?(me)? (mas )?(la )?(informacion|informes)|pasa(me|r)? (la )?(informacion|informes)|puedes (mandar|dar) (mas )?(informacion|informes)|la ficha( tecnica| completa)?\s*\??$|(me puedes (dar|pasar|mandar)|dame|pasame|me das|quiero) (mas )?detalles|mas detalles de(l| la| el)|que mas me (puedes (decir|contar)|cuentas) del)/.test(t)) return 'info_general';
    if (subInfo(t)) return 'info_auto';
    // FORÁNEO COMO OBJECIÓN (no solo "¿dónde están?") — está en otra ciudad / le queda lejos.
    if (esForaneoObjecion(t)) return 'foraneo';
    if (/(ubicacion|\b(a ?)?d?onde\b|\bdnd\b|se encuentran|se ubican|direccion|como llego|de donde (eres|son)|hacen envio|envian|horario|que dias|a que hora|que hora(s)?|hasta que hora|\babren\b|\bcierran\b|\batienden\b|(hay|atienden|abren|cierran)[^?]{0,12}(sabado|domingo|fin de semana)|que ciudad|cual ciudad|en que ciudad|de que ciudad|de que estado (son|es|eres)|que estado son)/.test(t)) return 'ubicacion';
    if (/((?:cotiza|coitza|cotisa|cotza|cotica|cotizc)|corrida|como (queda|quedaria)|mensualidad|de enganche|\d+ ?meses|a (48|60|36)|enganche de|otro plazo|menos enganche|mas enganche|requisito|papeleria|que (datos|documentos|papeles)|que me piden|buro|historial|apr(o|ue)b|tasa\b|que banco|financia|financiado|\bcredito\b|a meses|cuanto[^?]{0,14}enganche|cual es el enganche|que enganche|el enganche\b)/.test(t)) return 'credito';
    // Respaldo por la intención que Haiku entendió (cuando el regex no caza el fraseo).
    const int = clasif && clasif.intencion_principal;
    if (int === 'cotizar_credito') return 'credito';
    if (int === 'cita_ubicacion') return 'ubicacion';
    if (int === 'fotos_videos') return 'fotos';
    if (int === 'estado_auto') return 'info_auto';
    return null;   // long-tail → cerebro (Sonnet, voz del owner) allá afuera
}

// ══════════════════════════════════════════════════════════════════════
// EL RESPONDER — devuelve { segmentos, fotos?, fotos_after_index?, ubicacion_auto_id?,
// pin_after_index?, universo } | { escalar, motivo } | null (→ cerebro)
// ══════════════════════════════════════════════════════════════════════
async function responderEtapa3Core({ texto, auto_id, conv_id, clasif }) {
    const t = norm(texto);
    const d = (clasif && clasif.datos) || {};

    // ── MULTI-PREGUNTA de PAGO/CIERRE: eliminada por DOCTRINA (2026-07-09) —
    // "¿cuándo doy el enganche?" y "no sé si me alcance" son ZONA DE CIERRE: los caza
    // la puerta de entrada (RE_PROCESO_PAGO / RE_RIESGO) o escala3 → puente + owner. ──

    // ── Lo que NO necesita auto va PRIMERO (si el mensaje no menciona el auto,
    // auto_id llega null y estas jugadas se perderían rumbo al cerebro) ──
    const mot = escala3(t);
    if (mot) return { escalar: true, motivo: mot.motivo, puente: mot.puente };

    // ── "SÍ" PELÓN = luz verde a NUESTRA oferta → se EJECUTA, no se re-pregunta ──
    // ("Gustas que te mande un ejercicio?" → "si porfavor" → va la tabla de planes,
    //  jamás "¿cuánto de enganche?": preguntar tras un sí es una TRABA — regla 5b).
    // Solo cuenta si nuestro ÚLTIMO mensaje terminó en pregunta (oferta viva).
    const esAfirmacion = /^(s+i+|claro( que si)?|si por ?favor|por ?favor|va+|vale|sale( va)?|dale|andale|simon|ok+|okey|de acuerdo|correcto|exacto|asi es|esta bien|me parece( bien)?|perfecto|adelante|si gracias|hazlo|mandalo|mandala|mandamelo|mandamela|echale|arre)[\s.,!]*$/.test(t);
    if (esAfirmacion && conv_id) {
        const lo = await query("SELECT texto FROM mensajes WHERE conversacion_id=? AND direccion='out' ORDER BY ts DESC, id DESC LIMIT 1", [conv_id]);
        const up = (lo.length && /\?\s*$/.test(String(lo[0].texto || '').trim())) ? norm(lo[0].texto) : '';
        if (up) {
            // PRIMERO el cierre de cita: "te agendo en firme: {día} {hora}, va?" → el ✅
            // (va antes que ubicación/fotos porque ese mensaje MENCIONA el punto de venta
            //  y si no, "va" caería en la rama de ubicación por error).
            if (/te agendo en firme|agendo en firme|quedamos entonces|confirmo la cita|te dejo agendad/.test(up)) {
                const fechaU = sacaFecha(up), horaU = sacaHora(up);
                if (fechaU && horaU) {
                    const dp = auto_id ? await datosPunto(auto_id).catch(() => null) : null;
                    return citaConfirmadaSeg(fechaU, horaU, dp && dp.dir ? dp.dir : null);
                }
            }
            if (auto_id && /(ejercicio|cotiz|cotic|como quedaria|numeros|corrida|planes|financiamiento|como queda)/.test(up)) {
                const r = await planes({ auto_id });
                if (r.ok) return { universo: 'cotizacion', segmentos: [rot(['Va, mira cómo quedaría:', 'Sale, échale un ojo:']), r.placeholders.planes, 'Cómo ves, se te acomoda alguna?'] };
                return { escalar: true, motivo: 'dijo sí a la cotización pero ' + MOTIVO_COTIZA(r.error) };
            }
            if (auto_id && /(fotos|fotografias|imagenes|se lo ve|verlo por aqui)/.test(up)) {
                const urls = await fotosDeAuto(auto_id, 5);
                if (urls.length) return { universo: 'fotos', segmentos: [rot(['Van, ahí te las mando', 'Claro, ahí van'])], fotos: urls, fotos_after_index: 0 };
            }
            if (auto_id && /(ubicacion|el punto|punto de venta|te la mando|donde estamos)/.test(up)) {
                return { universo: 'ubicacion', segmentos: ['Va, aquí está el punto'], ubicacion_auto_id: auto_id, pin_primero: true };
            }
            if (/(venir a verl|prueba de manejo|te agendo|agendarte|te coordino|verlo y manejarlo|te late venir|te esperamos|una vuelta)/.test(up)) {
                return { universo: 'cita', segmentos: [rot(['Va que va', 'Perfecto']), 'Qué día y a qué hora te queda bien?'] };
            }
            return null;   // dijo sí a otra cosa → cerebro con el historial decide
        }
    }

    // ── INTERÉS EN ETAPA 3 → CITA CON INMEDIATEZ (regla del owner) ──────────────
    // "si me interesa", "me late", "me gusta" (interés SIN una duda concreta) = luz verde:
    // el norte es la PRUEBA DE MANEJO ya, no re-cotizar ni re-explicar. Si el crédito YA
    // estuvo en la mesa (cotizado/tocado), además se arranca la solicitud.
    const esInteres = /(me interesa|me interesan|me late|me gusta|me encanta|me lo llevo|lo quiero|la quiero|me convence|estoy interesad|si quiero|va que si|me anima|me atrae|me gustaria (tenerl|comprarl|llevarl))/.test(t);
    // Si el interés viene PEGADO a una duda concreta, primero se contesta la duda (no se
    // secuestra a cita). "me interesa ir a verlo QUE HORARIOS TIENEN" → contesta horario.
    // 🚩794: 'me interesa COTIZAR' = acción explícita, jamás secuestrarlo a cita.
    const traeDudaConcreta = /(precio|cuanto|donde|\bdnd\b|foto|video|banco|buro|tasa|mensualidad|enganche|adeudo|choque|factura|kilometr|horario|que dias|a que hora|abren|atienden|estacionamiento|mecanico|cotiz|financia|credito|numeros|corrida|\?)/.test(t);
    // 🚩761: interés CON día/hora concretos ("me interesa ir a verlo el domingo a las 5")
    // NO se secuestra aquí — va directo al cerrador a confirmar lo que él propuso.
    if (esInteres && !traeDudaConcreta && !sacaFecha(t) && !sacaHora(t) && auto_id && conv_id) {
        const e0 = await estadoConv(conv_id);
        if (e0.citas_pedidas < 2) {
            // LA CITA ES LO PRIMORDIAL, SIEMPRE (orden del owner): que primero la vea y
            // maneje. El crédito NO se lidera aquí; si él quiere ver aprobación primero, lo
            // pide y ahí se atiende. Cita-focused tanto con crédito en mesa como sin él.
            const slots = rot(['mañana o el sábado', 'mañana mismo o el fin', 'entre hoy y mañana', 'hoy más tarde o mañana']);
            return { universo: 'cita', segmentos: [
                rot(['Va que va, excelente', 'Perfecto']),
                'Entonces te agendo la prueba de manejo para que la veas y la manejes',
                `Qué te queda mejor, ${slots}?`
            ] };
        }
    }

    // CORTESÍA PURA ("gracias", "ok", "va", "perfecto") → cierre social, NO se
    // le vuelve a vender. Mejor callado que empujando otra jugada.
    if (/^(ok+(ey)?|okok|va+(le)?|sale|dale|listo|perfecto|excelente|de acuerdo|entendido|correcto|exacto|asi es|eso es|muy amable|gracias|muchas gracias|mil gracias|grax|thx|si gracias|ok gracias|va gracias|👍|🙏|❤️)([\s.,!]*(ok+|va+|gracias|listo|perfecto|👍|🙏))*[\s.,!]*$/.test(t)) {
        // …PERO si hay una CITA PENDIENTE (pedimos día/hora y sigue abierta), un "excelente/va"
        // RESUME la cita, no calla: se retoma con el día ya mencionado (o se pide el faltante).
        if (conv_id) {
            const lo = await query("SELECT texto, direccion FROM mensajes WHERE conversacion_id=? ORDER BY ts DESC, id DESC LIMIT 8", [conv_id]);
            // la cita solo está "pendiente" si la ÚLTIMA PREGUNTA nuestra fue de cita —
            // un "ok" a la respuesta de la tasa no resume una invitación de hace 3 turnos
            // (bug sandbox: "ok" tras la tasa → "¿a qué hora nos vemos el el 13?").
            const ultPregunta = lo.find(m => m.direccion === 'out' && String(m.texto || '').indexOf('?') !== -1);
            const citaPend = !!(ultPregunta && /(a que hora|que dia|hora te queda|dia te queda|te agendo|agendarte|prueba de manejo|te coordino)/.test(norm(ultPregunta.texto)));
            const yaConf = lo.some(m => /cita confirmada/i.test(String(m.texto || '')));
            if (citaPend && !yaConf) {
                let dia = null; for (const m of lo) { const f = sacaFecha(norm(m.texto)); if (f) { dia = f; break; } }
                if (dia) { const art = /^(hoy|manana|mañana|pasado|el )/i.test(dia) ? '' : 'el '; return { universo: 'cita', segmentos: [`Va, entonces a qué hora nos vemos ${art}${dia}?`] }; }
                return { universo: 'cita', segmentos: ['Va, qué día y a qué hora te acomoda para verlo?'] };
            }
        }
        return { silencio: true, universo: 'cortesia', motivo: 'cortesía/cierre del comprador — mejor no contestar' };
    }

    // ── PROMESA vs CITA (Haiku ya extrajo fecha/hora — por fin se consumen) ──
    // "te aviso el miércoles" = PROMESA (se acusa recibo, dueño del tiempo somos nosotros).
    // "puedo el sábado a las 2" = COORDINACIÓN (aceptar con su banco y amarrar lo que falte).
    // FRENO LEGÍTIMO ≠ objeción a vencer (#591: "deja programar la ida" recibió el empuje
    // de sábado/domingo — el registro correcto era acusar recibo y ESPERAR).
    // PREGUNTA EXPLÍCITA DE FINANCIAMIENTO (caso real +52...0546, 2026-07-10): "por motivo de
    // trabajo ahorita puedo PERO TIENE FINANCIAMIENTO?" — la objeción/freno pegado NO se
    // traga la pregunta: el financiamiento se contesta SÍ O SÍ (lista blanca, orden owner).
    const preguntaCredito = /(tiene[ns]?|hay|manejan|aceptan|dan|cuentan con|se puede|habra)[^?]{0,28}(financiamiento|financiado|credito|a meses|mensualidades)|financiamiento\s*\?|(^|\s)financian/.test(t);
    // Tolerante a typos ("prograramarme") y a "ando atareado/ocupado/compromisos": todo eso
    // es FRENO aunque Haiku lo lea como objeción (sandbox 2026-07-09: "deja prograramarme,
    // compromisos familiares" cayó como tercero → "mejor lo ven juntos", nada que ver).
    // "deja veo / déjame veo qué onda" = FRENO; pero "déjame ver EL AUTO/las fotos" = petición
    // (por eso el candado (?!) que excluye el/la/lo/fotos después del "veo/ver").
    // "me acomodo CON mis horarios/tiempos" = freno (bug sandbox: mandaba NUESTROS horarios);
    // "me acomodo el sábado" (sin "con") NO es freno — es coordinación de cita.
    const esPromesa = !preguntaCredito && /(te aviso|les aviso|le aviso|me comunico|te confirmo|les confirmo|lo platico|platicarlo|lo consulto|deja(me)? chec|lo checo|voy a ver si|lo pienso|dame (chance|oportunidad|tiempo)|aguantame|esperame|deja(me)? progr\w+|deja (cuadrar|acomodar|organizar)|deja(me)? veo\b(?! (el|la|lo|los|las|foto))|deja(me)? ver (si|que|como|cuando|mis|mi)\b|deja(me)? me (acomodo|organizo|programo|cuadro)\b|me (acomodo|organizo|cuadro|ajusto) con (mis|mi|los|el)\b|acomodo mis (horarios|tiempos)|me programo|programar(me)? (la|mi) (ida|visita|vuelta|salida)|checo mi (agenda|semana)|dejame (organizarme|acomodarme)|(ando|estoy|he andado) (muy |bien+ |re )?(atareado|atariado|ocupado|saturado|apurado)|tengo (varios )?compromisos|compromisos (familiares|de(l)? trabajo))/.test(t);
    // "DÓNDE lo puedo ver" pregunta UBICACIÓN (pin), no coordina cita — se excluye aquí
    // y cae al universo ubicacion más abajo.
    // Tolerante a errores de dedo comunes: "onde", "aonde", "adonde", "a donde" (sin la d).
    // "¿QUÉ CIUDAD?" es pregunta de UBICACIÓN (bug sandbox: Haiku la marca cita_ubicacion
    // y el cerrador la secuestraba pidiendo día/hora sin contestar la ciudad).
    const preguntaDonde = /(\b(a ?)?d?onde\b|\bdnd\b|ubicacion|direccion|en que parte|por que (zona|rumbo)|en donde|que ciudad|cual ciudad|en que ciudad|de que ciudad|de que estado (son|es|eres)|que estado son)/.test(t);
    // OJO: t viene NORMALIZADO (ñ→n) — los patrones van SIN ñ ("manana", no "mañana").
    const quiereVer = !preguntaDonde && /(puedo ir|pasar a verl|cuando (puedo|podria) (ir|verl)|lo puedo ver|vamos a verl|nos vemos|paso (el|manana|hoy|al rato)|voy (el|manana|hoy)|\bire\b|puedo (el|manana|hoy)|como a las \d|a las \d{1,2}\s?(pm|am|hrs|de la)|(quiero|me interesa|me gustaria|me late) (ir a )?(verl|manejarl|probarl|conocerl)|(verlo|manejarlo|probarlo) (en persona)?)/.test(t);
    if (esPromesa) {
        const cuando = d.fecha ? `, aquí lo vemos el ${d.fecha} entonces` : ', aquí ando pendiente';
        return { universo: 'promesa', segmentos: [rot(['Va, sin tema', 'Claro, va', 'Sin tema']) + cuando] };
    }

    // ── EL CERRADOR DE CITA (dos peldaños) ──────────────────────────────────
    // SUAVE = palabras al aire ("me doy la vuelta", "ahí caigo", "capaz paso"): aunque
    // traiga día/hora, NO se toma como firme → se BAJA a firme y se espera el "sí".
    // DURO = compromiso concreto ("paso mañana a las 6", "nos vemos el sábado a la 1"):
    // se toma directo → cita confirmada ✅ (dispara al dueño; en real al aprobar).
    // AL AIRE = lenguaje TENTATIVO: "me doy la vuelta", "ahí caigo", "a lo mejor", y
    // también CONDICIONALES ("podría", "pudiera", "tal vez", "creo que el", "quizás").
    // ── LA IA CLASIFICA (manual): Haiku ya leyó el TERMÓMETRO de compromiso y la objeción.
    // Los regex quedan solo de RESPALDO si Haiku no lo marcó (cc=null).
    const cc = (d.compromiso_cita || '').toLowerCase();          // firme | titubeo | objecion | sin_dato | ''
    const obj = (d.objecion_tipo || '').toLowerCase();           // trabajo | dinero | tercero | distancia | otra | ''
    const esSuaveRe = /(me doy (la|una) vuelta|dando(me)? (la|una) vuelta|ahi caigo|ahi paso|ahi (nos vemos|le caigo)|a lo mejor (paso|voy|caigo|me doy)|capaz (que )?(paso|voy|caigo)|igual (paso|voy|caigo)|puede que (pase|vaya|caiga)|tratare de (ir|pasar|caer)|intentare (ir|pasar)|me aviento|si puedo (paso|voy|caigo)|podria|pudiera|tal vez|talvez|quiza|creo que (el|la|paso|puedo|podria)|posiblemente|checando|viendo si|deja (veo|ver|checo|vemos)|dejame (ver|checar)|te confirmo (la hora|el dia|luego|mas tarde)|yo te (aviso|digo|confirmo))/.test(t);
    // RED DE SEGURIDAD: "PUEDO pasar/ir/llegar" está PREGUNTANDO si puede (checando la hora),
    // NO afirmando que irá → es AL AIRE. Fuerza titubeo aunque Haiku lo lea firme (nunca
    // confirmar humo: mejor formalizar "te agendo en firme, va?" y esperar el sí).
    // 🚩605: "¿mañana a las 11 ABREN?" también es preguntar permiso (propone slot en
    // forma de pregunta) → titubeo: se agenda EN FIRME y se espera el sí (anti-humo).
    const preguntaSiPuede = /\bpuedo (pasar|ir|llegar|acudir|verl|darme (la|una) vuelta|caer|asistir|conocer)/.test(t) || /\b(abren|atienden|abriran|estan abiertos)\b/.test(t);
    const esTitubeo = cc === 'titubeo' || preguntaSiPuede || (!cc && esSuaveRe);
    const esFirme = cc === 'firme';
    const hayObjecion = cc === 'objecion' || !!obj;
    // 🚩718/719: FECHA VAGA ("la sig semana", "estos días", "pronto") NO es un día —
    // JAMÁS se agenda ni se confirma con ella (se anula y el cerrador pide el día).
    // Solo pasan días CONCRETOS: hoy/mañana/pasado mañana/día de semana/el N/N de mes.
    const FECHA_OK = /^(hoy|manana|mañana|pasado ?manana|pasado ?mañana|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|el \d{1,2}|\d{1,2} de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre))$/i;
    let fecha = d.fecha || sacaFecha(t);
    if (fecha && !FECHA_OK.test(String(fecha).trim())) fecha = null;
    // d.hora de Haiku puede venir VAGA ("antes de las 4", "por la tarde") → no es hora firme.
    let hora = d.hora || sacaHora(t);
    if (hora && /(antes|despues|luego) de|por la (manana|tarde|noche)|tempran|medio ?dia|manana|tarde|noche|flexible|cualquier|no importa/.test(norm(String(hora)))) hora = null;
    const franja = sacaFranja(t) || sacaFranja(norm(String(d.hora || '')));
    // Pregunta de UBICACIÓN/FORÁNEO sin día/hora → NO es coordinación de cita.
    const esUbicPura = (preguntaDonde || esForaneoObjecion(t)) && !fecha && !hora && !franja && !quiereVer && cc !== 'objecion';
    // DUDA DE CITA (mecánico, seguridad del punto, ¿necesito cita?, horario) → es una
    // PREGUNTA sobre la cita, no una propuesta de día/hora → que no la secuestre el cerrador.
    // 🚩605: si el mensaje trae DÍA + HORA concretos ("mañana a las 11 abren?"), NO es
    // duda genérica de horario — es una PROPUESTA de slot → va al cerrador de citas.
    const esDudaCita = !(fecha && hora) && /((llevar|traer|puedo llevar|puede ir|va a ir|llevo|ir con)[^?]{0,14}(a )?(mi )?mecanico)|un mecanico|alguien que (sepa|revise|checar|entienda)|(con (un |mi )?mecanico)|(el|ese) (punto|lugar)[^?]{0,12}(seguro|confiable)|es seguro (el|ese|ir|comprar|ahi)|como es (el|ese|el) (punto|lugar)|sin cita|necesito (cita|agendar)|hay que (agendar|sacar cita)|se puede sin cita|(a que hora|que dias|horario|a que horas|que hora|hasta que hora)|\babren\b|\bcierran\b|\batienden\b|(abren|atienden|trabajan|dan servicio|hay citas?)[^?]{0,15}(sabado|domingo|fin de semana|hoy|manana|el \w+)|(hoy|manana|sabado|domingo|el (lunes|martes|miercoles|jueves|viernes|sabado|domingo))[^?]{0,10}(abren|atienden|trabajan|hay cita|dan servicio)/.test(t);
    const contextoCita = !esUbicPura && !esDudaCita && !preguntaCredito && (quiereVer || cc || (clasif && clasif.intencion_principal === 'cita_ubicacion') || esTitubeo || fecha || hora || franja);

    if (contextoCita && auto_id) {
        const dp = await datosPunto(auto_id).catch(() => null);
        const lugar = dp && dp.dir ? dp.dir : null;
        // 🚩605 espejo del verbo: si preguntó "¿ABREN?", la 1ra burbuja contesta ESO.
        const preguntoAbren = /\b(abren|atienden|abriran|estan abiertos)\b/.test(t);
        const acc = rot(['Va que va', 'Me parece bien', 'Sin tema', 'Perfecto']);

        // ── OBJECIONES: por DOCTRINA (2026-07-09) toda objeción es momento de VENTA →
        // TUYA. Puente que no enfría + aviso con el tipo exacto. El bot no persuade. ──
        if (hayObjecion) {
            if (obj === 'distancia' || esForaneoObjecion(t)) return { escalar: true, motivo: 'objeción de DISTANCIA/foráneo (jugada: cita anticipada vs envío — tuya)', puente: 'No hay bronca por la distancia; déjame veo cómo te lo acomodamos mejor y aquí te digo' };
            if (obj === 'trabajo') return { escalar: true, motivo: 'objeción de TRABAJO/tiempo para la cita — tuya', puente: 'Sin tema, por el trabajo no te apures; déjame veo cómo acomodarte y aquí te digo' };
            if (obj === 'dinero') return { escalar: true, motivo: '🔴 objeción de DINERO para la cita/enganche — tuya', puente: 'Va, sin tema; déjame veo cómo acomodarte y aquí te digo' };
            if (obj === 'tercero') return { escalar: true, motivo: 'decide con OTRA persona (pareja/familiar) — tuya', puente: 'Claro, sin tema; déjame veo cómo coordinarlo mejor y aquí te digo' };
            return { escalar: true, motivo: 'objeción en la cita (no clasificada) — tuya', puente: 'Va, déjame lo checo y aquí mismo te digo' };
        }

        // DÍA presente pero HORA VAGA (franja "antes de las 4" / "por la tarde"): propone horas.
        if (fecha && !hora && franja) {
            const dosSlots = (a, b) => (a < 1 || a === b)
                ? [`${acc}, el ${fecha} entonces`, `Te late a las ${hpm(b)}, para dejarlo en firme?`]
                : [`${acc}, el ${fecha} entonces`, `Te late a las ${hpm(a)} o a las ${hpm(b)}, para dejarlo en firme?`];
            if (franja.tipo === 'antes') return { universo: 'cita', segmentos: dosSlots(franja.n - 2, franja.n - 1) };
            if (franja.tipo === 'despues') return { universo: 'cita', segmentos: dosSlots(franja.n + 1, franja.n + 2) };
            return { universo: 'cita', segmentos: [`${acc}, el ${fecha} ${franja.txt} entonces`, 'A qué hora te acomoda mejor, para dejarlo en firme?'] };
        }
        // Falta un dato → pídelo (sin disparar nada al dueño con citas a medias).
        if (fecha && !hora) {
            // Simetría con fechaCtx: si la HORA ya se dijo en el contexto reciente
            // ("9am" → luego "el martes"), se combina y se amarra EN FIRME (no se re-pide).
            let horaCtx = null;
            if (conv_id) {
                const lo = await query("SELECT texto FROM mensajes WHERE conversacion_id=? ORDER BY ts DESC, id DESC LIMIT 4", [conv_id]);
                for (const m of lo) { const h = sacaHora(norm(m.texto)); if (h) { horaCtx = h; break; } }
            }
            if (horaCtx) return { universo: 'cita_firme', segmentos: [acc, `Entonces te agendo en firme: ${cap(fecha)} a las ${horaCtx}${lugar ? ' en ' + lugar : ''}, va?`] };
            return { universo: 'cita', segmentos: [`${acc}, ${fecha} entonces`, 'Como a qué hora te queda? Para agendarte en firme'] };
        }
        if (hora && !fecha) {
            let fechaCtx = null;
            if (conv_id) {
                const lo = await query("SELECT texto FROM mensajes WHERE conversacion_id=? AND direccion='out' ORDER BY ts DESC, id DESC LIMIT 4", [conv_id]);
                for (const m of lo) { const f = sacaFecha(norm(m.texto)); if (f) { fechaCtx = f; break; } }
            }
            // con día (contexto) + hora, cierra SOLO si no es titubeo.
            if (fechaCtx && !esTitubeo) return citaConfirmadaSeg(fechaCtx, hora, lugar);
            if (fechaCtx && esTitubeo) return { universo: 'cita_firme', segmentos: [preguntoAbren ? 'Sí, sí atendemos, es con cita' : acc, `Entonces te agendo en firme: ${cap(fechaCtx)} a las ${hora}${lugar ? ' en ' + lugar : ''}, va?`] };
            return { universo: 'cita', segmentos: [acc, `A las ${hora} entonces`, 'Qué día te queda bien? Para agendarte en firme'] };
        }
        // "AHÍ PASO / nomás me doy la vuelta / sin cita" = quiere solo aparecer → se explica
        // EL PORQUÉ de la cita (coordinar con el dueño particular) y se le pide día/hora.
        const dropByCasual = /(ahi (paso|me doy|caigo|llego|nos vemos|voy)|me doy (la|una) vuelta|nomas (paso|llego|voy|me doy)|paso cuando (pueda|ande)|cuando (ande|pueda) (paso|voy|caigo)|llego y ya|voy llegando|sin (agendar|cita)|puedo (llegar|ir) sin cita|caigo por ahi)/.test(t);
        if (dropByCasual && !fecha && !hora) {
            return { universo: 'cita', segmentos: [rot(['Va, con gusto', 'Claro que sí']), 'Es con cita para coordinarte con el dueño particular del auto, así el auto y el dueño ya te están esperando y no batallas', 'Qué día te queda mejor, hoy o mañana?'] };
        }
        if (!fecha && !hora) return { universo: 'cita', segmentos: [acc, 'Qué día y a qué hora te queda bien?'] };

        // ── Día + hora presentes → EL CANDADO ANTI-HUMO ──
        // TITUBEO (o NO firme) → NUNCA ✅: se baja a firme y se espera el sí.
        if (esTitubeo || (!esFirme && cc && cc !== 'firme')) {
            const cuando = [cap(fecha), 'a las ' + hora].join(' ');
            return { universo: 'cita_firme', segmentos: [preguntoAbren ? 'Sí, sí atendemos, es con cita' : acc, `Entonces te agendo en firme: ${cuando}${lugar ? ' en ' + lugar : ''}, va?`] };
        }
        // FIRME (o cc vacío sin titubeo) → confirmar de una (el ✅ dispara al dueño).
        return citaConfirmadaSeg(fecha, hora, lugar);
    }

    // ── El resto de universos SÍ requiere auto + conversación ──
    if (!auto_id || !conv_id) return null;

    const est = await estadoConv(conv_id);
    const u = detectarUniverso(t, clasif);
    const fin = c => c ? [c] : [];        // CTA opcional como última burbuja

    if (!u) return null;                  // juego libre real → cerebro con la voz del owner

    // ── INFO GENERAL (🚩611) — EL MACHOTE: la ficha completa del Sales Brain + gancho ──
    if (u === 'info_general') {
        const { machoteDe } = require('./machote.js');
        const m = await machoteDe(auto_id).catch(() => null);
        if (!m) return { escalar: true, motivo: 'pidió la información completa y el auto no tiene ficha para el machote' };
        const v = await vestir(texto, 'te mando la información completa del auto', ['Claro', 'Va', 'Con gusto']);
        // 🚩632 GÁNCHALO: si hay CITA PENDIENTE (pedimos día/hora y sigue abierta), el
        // gancho RETOMA la cita con el día ya dicho (cerrar el loop del desvío); si no,
        // invita a verlo. cita_resume=true lo exenta del termostato (es retomar, no insistir).
        let g = '', resume = false;
        if (conv_id) {
            const lo = await query("SELECT texto, direccion FROM mensajes WHERE conversacion_id=? ORDER BY ts DESC, id DESC LIMIT 8", [conv_id]);
            const citaPend = lo.some(x => x.direccion === 'out' && /(a que hora|que dia|hora te queda|dia te queda|te agendo|agendarte|prueba de manejo|te coordino)/.test(norm(x.texto)));
            const yaConf = lo.some(x => /cita confirmada/i.test(String(x.texto || '')));
            if (citaPend && !yaConf) {
                let dia = null; for (const x of lo) { const f = sacaFecha(norm(x.texto)); if (f) { dia = f; break; } }
                const art = dia && !/^(hoy|manana|mañana|pasado)/i.test(dia) ? 'el ' : '';
                g = dia ? `Y entonces a qué hora nos vemos ${art}${dia}?` : 'Y entonces qué día te queda para verlo?';
                resume = true;
            }
        }
        if (!g && est.citas_pedidas < 2) g = 'Te late venir a verlo y manejarlo?';
        const out = { universo: 'info_general', segmentos: [fusion(v.c, 'te la mando:'), m, ...(g ? [g] : [])] };
        if (resume) out.cita_resume = true;
        return out;
    }

    // ── FOTOS (la entrega ES el mensaje; la acción viaja en meta y se ejecuta al aprobar) ──
    if (u === 'fotos') {
        const urls = await fotosDeAuto(auto_id, 5);
        if (!urls.length) return { escalar: true, motivo: 'pidió fotos y este auto no tiene en fyradrive', puente: 'Déjame las consigo y en un momento te las mando' };
        const c = ctaEstado(est, 'producto');
        return { universo: 'fotos', segmentos: [rot(['Claro, ahí van', 'Van, ahí te las mando', 'Sí, ahí te van']), ...fin(c)], fotos: urls, fotos_after_index: 0 };
    }
    if (u === 'video') return { escalar: true, motivo: 'pide VIDEO (grabarlo/pedirlo al dueño)', puente: 'Claro que sí, dame un momento y te mando el video' };

    // ── TERCEROS (crédito a nombre de otra persona) — transmitir seguridad, sin fricción ──
    if (u === 'terceros') {
        return { universo: 'terceros', segmentos: [rot(['Claro que sí, sin problema', 'Sí, sin ningún problema']), 'El crédito puede ir a nombre de quien tú digas, solo se hace con sus documentos y su firma', ...fin(ctaEstado(est, est.ya_cotizado ? 'proseguir' : 'credito'))] };
    }
    // ── BANCO PROPIO / crédito ya aprobado — SEÑAL DE COMPRA, se celebra y salta a cita ──
    if (u === 'banco_propio') {
        const c = est.citas_pedidas < 2 ? 'Cuándo te viene bien pasar a verlo y manejarlo?' : '';
        return { universo: 'banco_propio', segmentos: [rot(['Perfecto', 'Mucho mejor así']), 'Con tu propio crédito sin ningún problema, de hecho mejor; no te cobramos nada extra y agilizamos todo', ...fin(c)] };
    }

    // ── CRÉDITO: otra cotización (nuevo enganche/plazo) o duda del universo financiero ──
    if (u === 'credito') {
        const BANCO = await bancoDeAuto(auto_id);   // HEY Banco o Renueva Car según el año
        // ── 🚩616: la NATURALEZA de "financiado" se contesta con los REPETITIVOS de
        // siempre (textos del owner, banco por año). Lo que sigue escalando: juicio de
        // costo, "cuándo doy el enganche", plazos raros, abonos, seguro, comparar bancos. ──
        // 🚩real#6 (Gerardo): CONFESIÓN de buró ("estoy en buró en algunos lugares") NO es
        // pregunta — es un comentario PERSONAL de su situación (no hay machote) → ESCALA.
        if (/((estoy|ando|salgo|aparezco|me encuentro|cai|caigo|estuve|quede) [^?]{0,10}buro|tengo (mal|feo|manchado|sucio)[^?]{0,8}(buro|historial)|mi (buro|historial) (esta|anda|no)|buro (malo|manchado|sucio|negativo)|mal historial credit|debo en buro|reportado en buro|con buro\b)/.test(t)) {
            return { escalar: true, motivo: '🔴 comprador CONFIESA su situación de buró (comentario personal, no pregunta — caso a caso, tuyo)' };
        }
        if (/(buro|historial)/.test(t)) return { universo: 'credito', segmentos: [`Es sujeto a aprobación con ${BANCO}; estés en buró o no lo vemos, y con buen historial mejora`, ...fin(ctaEstado(est, 'credito'))] };
        if (/(que|cual|de cuanto|cuanto (es|manejan|cobran)|a que|k) ?(es )?(la )?tasa|tasa de interes|que tasa|porcentaje (de interes|anual)|cuanto de interes/.test(t)) {
            if (BANCO === 'HEY Banco') return { universo: 'credito', segmentos: ['La tasa ronda el 13.99% anual con HEY Banco, y mejora entre más enganche des', ...fin(ctaEstado(est, 'credito'))] };
            return { universo: 'credito', segmentos: ['La tasa te la afino en tu cotización exacta, según tu enganche y plazo', ...fin(ctaEstado(est, 'credito'))] };
        }
        // 📤 REQUISITOS = mandar archivo, vestido + gancho de calculadora (lo gobierna el termostato).
        if (/(requisito|papeleria|que (documentos|papeles|datos|piden|necesito|me piden)|(datos|documentos|papeles)[^?]{0,25}(enviar|mandar|pasar|llevar|ocupo|necesito))/.test(t)) {
            const v = await vestir(texto, 'te paso los requisitos', ['Va', 'Claro', 'Con gusto']);
            return { universo: 'credito', segmentos: [fusion(v.c, 'te los paso:'), REQUISITOS3, 'Gustas que te cotice mientras?'] };
        }
        // 📖 MÍNIMO DE ENGANCHE = número de las reglas, vestido + gancho de calculadora.
        if (/(minimo|mínimo|lo menos|cuanto (de |es el )?(minimo|enganche minimo)|enganche minimo|con cuanto (menos|minimo)|desde cuanto|cuanto (es |seria |piden de |de |del )?(el )?enganche\b|cual es el enganche|que enganche (piden|manejan|es)|de cuanto (es )?el enganche)/.test(t) && !/\d/.test(t)) {
            const r = await enganche_minimo({ auto_id });
            if (r.ok) {
                const accion = `El enganche mínimo para este auto es de ${r.placeholders.enganche_minimo}`;
                const v = await vestir(texto, accion, ['Mira', 'Claro', 'Te cuento']);
                return { universo: 'credito', segmentos: [fusion(v.c, accion), 'De ahí para arriba el que gustes', ...fin(ctaEstado(est, 'credito'))] };
            }
        }
        // 📖 QUÉ BANCO = hecho, vestido + gancho gobernado.
        if (/(que banco|cual banco|con que banco)/.test(t)) {
            const v = await vestir(texto, `Es con ${BANCO}`, ['Mira', 'Claro', 'Te cuento']);
            return { universo: 'credito', segmentos: [fusion(v.c, `es con ${BANCO}`), ...fin(ctaEstado(est, 'credito'))] };
        }
        if (/apr(o|ue)b/.test(t)) return { universo: 'credito', segmentos: ['Ya con tus documentos, en menos de 2 horas te dicen si apruebas', ...fin(ctaEstado(est, 'credito'))] };
        // 📖 "¿Financian?" (sí/no) = afirmación fundida + banco + gancho gobernado.
        if (/(tienen|manejan|aceptan|hay|dan|cuentan con|se puede|puedo)[^?]{0,30}(financia|credito|a meses|mensualidades|financiado)/.test(t)) {
            return { universo: 'credito', segmentos: [rot(['Sí, así es', 'Claro que sí']), `Es con ${BANCO}`, ...fin(ctaEstado(est, 'credito'))] };
        }
        // 72 MESES (o cualquier plazo fuera del máximo del banco) → ESCALA con puente.
        if (/(72|84) ?meses/.test(t) || (d.plazo_meses && Number(d.plazo_meses) > 60)) {
            return { escalar: true, motivo: 'pide plazo largo (72+ meses, fuera del banco)', puente: 'Déjame confirmo hasta qué plazo te lo pueden dar y aquí mismo te digo' };
        }
        // 🧮 COTIZAR = la tarjeta tal cual, sin comentario de venta (doctrina).
        const eng = d.enganche || null, plazo = d.plazo_meses || null;
        // 🚩601: "me interesa a crédito" = interés DECLARADO en crédito → calculadora (planes), no escala.
        const esCotizar = /((?:cotiza|coitza|cotisa|cotza|cotica|cotizc)|corrida|como (queda|quedaria)|mensualidad|pago mensual|cuanto (pago|pagaria|seria|me sale|quedaria|es el pago)|al mes|otro plazo|menos enganche|mas enganche|a (48|60|36)|\d+ ?meses|me interesa (a|el|con|por|en) credito|(lo|la) (quiero|llevo|llevaria|agarro|compraria) (a|con) credito|seria (a|con) credito|quiero financiarl|me interesa financiarl|(a|en) credito me interesa)/.test(t) || ((eng || plazo) && /\d/.test(t));
        if (esCotizar) {
            let card = null, errCot = null;
            if (eng) { const r = await cotizar({ auto_id, enganche: eng, plazo_meses: plazo || undefined }); if (r.ok) card = r.placeholders.cotizacion; else errCot = r.error; }
            else if (plazo) { const r = await cotizar({ auto_id, enganche_pct: 30, plazo_meses: plazo }); if (r.ok) card = r.placeholders.cotizacion + '\n(con enganche del 30%; dime el tuyo y te la ajusto)'; else errCot = r.error; }
            else { const r = await planes({ auto_id }); if (r.ok) card = r.placeholders.planes; else errCot = r.error; }
            if (!card) return { escalar: true, motivo: MOTIVO_COTIZA(errCot) };
            // REMATE por contexto (🚩 training, restaurado por orden del owner): agrado o
            // "Cómo la ves?" ya preguntado → invitar a la CITA de manejo; si no → "Cómo la ves?".
            // El gobernador lo tira si el termostato dice que no toca.
            const agrado = /(me agrada|me gusta|me late|me convence|me conviene|me acomoda|esa esta bien|esta bien esa|me parece bien)/.test(t);
            const yaPregunto = est.ultima_pregunta && /como la ves/.test(norm(est.ultima_pregunta));
            let ctaCot = 'Cómo la ves?';
            if (agrado || yaPregunto) ctaCot = est.citas_pedidas >= 2 ? '' : rot([
                'Te agendo cita de manejo de una vez?',
                'Cuándo te viene bien venir a verlo y manejarlo?'
            ]);
            return { universo: 'cotizacion', segmentos: [rot(['Va, así queda:', 'Claro, mira:', 'Sale, te la ajusto:']), card, ...fin(ctaCot)] };
        }
        // 🚩616: proceso genérico ("¿cómo es financiado?") → EL REPETITIVO de siempre.
        return { universo: 'credito', segmentos: [`Es por medio de ${BANCO}${BANCO === 'HEY Banco' ? ', con muy buenas tasas' : ''}. Mandas tus documentos, te cotizo, solicitamos el crédito, te dicen si apruebas en menos de 2 horas, ya aprobado tú decides cuándo firmas, y el enganche lo das a la entrega — no pagas nada hasta que se te entregue el auto`, ...fin(ctaEstado(est, 'credito'))] };
    }

    // ── DUDAS FINAS DE LA COTIZACIÓN (seguro / qué incluye / CAT / comisión) ──
    if (u === 'seguro') return { universo: 'seguro', segmentos: ['El seguro va financiado dentro del crédito, ya viene incluido en la mensualidad', ...fin(ctaEstado(est, 'proseguir'))] };
    if (u === 'duda_cotizacion') {
        if (/comision por apertura/.test(t)) return { universo: 'duda_cotizacion', segmentos: ['La comisión por apertura va en el pago inicial, no en la mensualidad; la mensualidad ya incluye el seguro y los intereses', ...fin(ctaEstado(est, 'proseguir'))] };
        if (/\bcat\b|costo anual/.test(t)) return { escalar: true, motivo: 'pregunta el CAT (dato fino del banco — confírmalo tú)', puente: 'Déjame te confirmo el CAT exacto y en un momento te digo' };
        return { universo: 'duda_cotizacion', segmentos: ['La mensualidad ya incluye el seguro financiado y los intereses', ...fin(ctaEstado(est, 'proseguir'))] };
    }

    // ── NEGOCIO (agencia/particular/comisión/cómo funciona) — la duda #1 medida ──
    if (u === 'negocio') {
        const c = est.citas_pedidas < 2 ? 'Cuando gustes venir a verlo te coordino la cita' : '';
        return {
            universo: 'negocio', segmentos: [
                'No somos lote ni agencia, somos un canal digital que filtra a los dueños únicos de los autos',
                'El dueño lo sigue usando, publica con nosotros y nosotros llevamos la venta: cita, pago seguro, financiamiento y cambio de propietario. Es comprar de particular pero con la seguridad de un intermediario',
                'Aquí ves todo nuestro inventario y cómo trabajamos: fyradrive.com',
                ...(c ? [c] : [])
            ]
        };
    }

    // ── NEGOCIACIÓN sin número (con número ya escaló arriba) ──
    if (u === 'negociacion') {
        const pv = await proactivo(auto_id, 'estado', est);
        const cierre = pv || (est.citas_pedidas < 2 ? 'Qué día te queda para verlo?' : '');
        return { universo: 'negociacion', segmentos: ['Sí se puede negociar, pero eso lo vemos en la cita, ya que lo veas y lo manejes', ...(cierre ? [cierre] : [])] };
    }

    // ── ABONO A CAPITAL (gancho de proseguir, como lo corrigió el owner) ──
    if (u === 'abono_capital') {
        return { universo: 'abono_capital', segmentos: ['Sí se puede abonar a capital y liquidar antes, sin penalización alguna', 'Y si abonas a capital baja la mensualidad, sin importar el plazo', ...fin(ctaEstado(est, 'proseguir'))] };
    }

    // ── TRADE-IN (su frase real, consistente en toda su data) ──
    if (u === 'trade_in') {
        return { universo: 'trade_in', segmentos: ['Sí lo tomamos a cuenta', 'Se valúa apenas viéndolo en la cita, ahí mismo te digo en cuánto', ...fin(ctaEstado(est, 'logistica'))] };
    }

    // ── OTROS AUTOS → el catálogo ──
    if (u === 'otros_autos') {
        return { universo: 'otros_autos', segmentos: ['Aquí está todo nuestro inventario: fyradrive.com', 'Checa cuál te gusta, me dices y así mismo te agendo'] };
    }

    // ── "¿ESTÁ ABIERTO AHORITA?" ──
    if (u === 'abierto') {
        return { universo: 'abierto', segmentos: ['Sí atendemos, pero es únicamente con cita previa; es lo que pedimos para tener el auto y el dueño listos y darte toda la seguridad y eficiencia', 'Con que me digas tu horario lo coordino', ...fin(ctaEstado(est, 'logistica'))] };
    }

    // ── FACTURACIÓN (IVA completo ya escaló arriba) ──
    if (u === 'facturacion') {
        const pv = await proactivo(auto_id, 'estado', est);
        const cierre = pv || (ctaEstado(est, 'producto') || '');
        return { universo: 'facturacion', segmentos: ['Es factura original de agencia, único dueño', 'Toda la papelería en regla, uso cotidiano', ...(cierre ? [cierre] : [])] };
    }

    // ── PRECIO directo — dato concreto PERO vestido acorde al input (conector con
    // sintonía); el gancho lo decide el gobernador (termostato = "cuando sí vaya").
    if (u === 'precio') {
        const rp = await query("SELECT precio FROM inventario_autos WHERE id=?", [Number(auto_id)]);
        if (!rp.length || rp[0].precio == null) return { escalar: true, motivo: 'pregunta el precio y el auto no tiene precio en inventario' };
        const accion = 'Son $' + Number(rp[0].precio).toLocaleString('es-MX');
        const v = await vestir(texto, accion, ['Claro', 'Mira', 'Con gusto']);
        if (!v.sintonia) return { escalar: true, motivo: 'preguntó precio pero la duda no embona (sintonía) — lo ves tú' };
        return { universo: 'precio', segmentos: [fusion(v.c, accion), ...fin(ctaEstado(est, 'producto'))] };
    }

    // ── AÑO / INFO DEL AUTO (datos reales del inventario) ──
    if (u === 'anio') {
        const na = await nombreAuto(auto_id);
        if (!na) return null;
        return { universo: 'anio', segmentos: [`Es ${na}`, ...fin(ctaEstado(est, 'producto'))] };
    }
    if (u === 'info_auto') {
        const r = await infoAccion(texto, auto_id);
        if (!r || !r.accion) return { escalar: true, motivo: 'dato del auto que no tenemos en ficha (motor/versión exacta)', puente: 'Déjame lo confirmo con el dueño y en un momento te digo el dato exacto' };
        // Maquillaje EN SINTONÍA con la duda: se responde el DATO directo ("El auto tiene
        // 85,000 km"), sin "Claro/Sisi" delante (preguntó, no estamos confirmando algo suyo).
        const dato = /^(tiene|es|esta)\b/i.test(r.accion) ? 'El auto ' + r.accion.charAt(0).toLowerCase() + r.accion.slice(1) : r.accion;
        // PROACTIVIDAD: si la sub-duda lo amerita (estado/historia/calidad) → dato + proactivo
        // (reemplaza el CTA genérico porque el proactivo ya empuja a manejar).
        const pv = SUB_PROACTIVABLE.has(r.sub) ? await proactivo(auto_id, 'estado', est) : '';
        if (pv) return { universo: 'info_auto', segmentos: [dato, pv] };
        return { universo: 'info_auto', segmentos: [dato, ...fin(ctaEstado(est, 'producto'))] };
    }

    // ── LUGAR SEGURO / cómo es el punto → LA PROPUESTA DE VALOR (la que más resultados da) ──
    if (u === 'lugar_seguro') {
        return { universo: 'lugar_seguro', segmentos: [
            'Es un punto de venta seguro',
            'Uno de Fyradrive va contigo a la cita junto con el dueño del auto para mediar la compra: le compras a un particular pero a través de nosotros, con toda la seguridad y las herramientas (inspección, papeles verificados, pago seguro)',
            ...fin(ctaEstado(est, 'logistica'))
        ] };
    }

    // ── LLEVAR MECÁNICO / alguien de confianza → sí, sin problema ──
    if (u === 'llevar_mecanico') {
        return { universo: 'llevar_mecanico', segmentos: [
            'Claro, sin ningún problema, tráelo',
            'Lo revisa con toda calma en la cita, por eso es presencial',
            ...fin(ctaEstado(est, 'logistica'))
        ] };
    }

    // ── FORÁNEO COMO OBJECIÓN — cercana → cita anticipada; lejana → envío (+cita opción) ──
    if (u === 'foraneo') return respForaneo(t, est);

    // ── UBICACIÓN (pin real; la acción viaja en meta) ──
    if (u === 'ubicacion') {
        // "¿QUÉ CIUDAD / de qué ciudad son?" → se contesta LA CIUDAD (cerrar el loop del
        // comprador antes de cualquier otra cosa; bug sandbox: pedía día/hora sin decirla).
        if (/(que ciudad|cual ciudad|en que ciudad|de que ciudad|de que estado (son|es|eres)|que estado son)/.test(t)) {
            const puntoC = await datosPunto(auto_id).catch(() => null);
            const dirC = puntoC && puntoC.dir ? `; el punto es ${puntoC.dir}` : '';
            return { universo: 'ubicacion', segmentos: [`Estamos en Monterrey${dirC}`, ...fin(ctaEstado(est, 'logistica'))] };
        }
        if (/(hacen envio|envian|me lo (mandas|envias)|hasta (aca|mi))/.test(t)) {
            return { universo: 'ubicacion', segmentos: ['Sí manejamos envío', 'La viene a ver un mecánico o conocido tuyo que te dé luz verde, y te la mandamos con garantía de viaje', 'Gustas que la revise alguien de tu confianza?'] };
        }
        if (/(horario|que dias|a que hora|que hora(s)?|hasta que hora|\babren\b|\bcierran\b|\batienden\b|(abren|atienden|cierran|es) (el|los)? ?(sabado|domingo|fin de semana))/.test(t)) {
            return { universo: 'ubicacion', segmentos: ['De 9am a 7pm, pero como es con cita es flexible al horario que te acomode, incluso sábado o domingo sin problema', 'Con que me digas tu horario lo coordino', ...fin(ctaEstado(est, 'logistica'))] };
        }
        const punto = await datosPunto(auto_id);
        const dir = punto ? punto.dir : null;
        // Campo vacío → escala (doctrina): SIN punto configurado no hay pin ni dirección
        // que mandar — antes salía un "Aquí es nuestro punto de venta" hueco que el juez
        // mataba con rodeo (caso BMW 530I sandbox 2026-07-13). Ahora la causa es clara.
        if (!dir) return { universo: 'ubicacion', escalar: true, motivo: 'este auto NO tiene punto de venta configurado (configúralo en puntos.html) — no hay pin ni dirección que mandar' };
        const seg1 = `Aquí es el punto, ${dir}`;
        // 🚩715: pedir la ubicación para VER el auto = señal de cita → SIEMPRE se gancha
        // con día+hora (cita_resume: es coordinación, exenta del termostato).
        const gU = est.cita_confirmada ? '' : 'Qué día y a qué hora te agendo?';
        return { universo: 'ubicacion', segmentos: [seg1, ...(gU ? [gU] : [])], ubicacion_auto_id: auto_id, pin_primero: true, cita_resume: true };
    }

    // ── "¿QUÉ SIGUE?" — el siguiente paso lo dicta el estado ──
    if (u === 'que_sigue') {
        if (!est.ya_cotizado) return { universo: 'que_sigue', segmentos: ['Lo siguiente es hacerte los números', 'Con cuánto de enganche le hacemos la cotización?'] };
        return { universo: 'que_sigue', segmentos: ['Lo siguiente es que lo veas y lo manejes', ...(est.citas_pedidas < 2 ? ['Qué día te queda bien?'] : [])] };
    }

    return null;
}

// ══════════════════════════════════════════════════════════════════════
// LA SALIDA ÚNICA — el GOBERNADOR (lib/seb/gobernador.js) gobierna TODA ráfaga
// antes de salir: dedup, un gancho máximo, termostato (gancho ignorado → se enfría),
// candado post-✅ y cap de burbujas. Un solo punto para todos los carriles.
// ══════════════════════════════════════════════════════════════════════
async function responderEtapa3(args) {
    // PUERTA DE ENTRADA (doctrina): los momentos de gol — 🔴 humano, 🔴 venta en
    // riesgo, 🔥 comprador caliente, 💰 proceso de pago — NI SE PROCESAN → owner.
    const gol = puertaEntrada(args && args.texto);
    // ORDEN del owner (2026-07-09): al escalar NO HAY PUENTE — el bot se calla y
    // el owner contesta en persona. Se elimina el puente de TODA escalada aquí,
    // el punto único de salida (aplica también a las escalas viejas de escala3).
    if (gol) return { escalar: true, motivo: gol.motivo };
    let r = await responderEtapa3Core(args);
    // PUERTA DE SALIDA (doctrina): universos de política/persuasión → escala.
    r = puertaSalida(r);
    if (r && r.escalar) return { escalar: true, motivo: r.motivo };
    if (!r || r.silencio || !r.segmentos || !r.segmentos.length) return r;
    let est = null;
    if (args && args.conv_id) { try { est = await estadoConv(args.conv_id); } catch (e) { /* sin estado → gobierna solo dentro de la ráfaga */ } }
    const g = gobernar(r, { texto: args && args.texto, est });
    // ⚖️ EL JUEZ DE EFICACIA (orden owner): la IA interpreta si la respuesta ATIENDE
    // de verdad el mensaje — si hay desconexión (comentario personal vs plantilla,
    // pregunta X respuesta Y) → ESCALA. En la duda pasa; fail-open si la IA falla.
    if (g && g.segmentos && g.segmentos.length && !g.escalar && !g.silencio) {
        const veredicto = await juzgar(args && args.texto, g.segmentos);
        if (!veredicto.eficaz) {
            return { escalar: true, motivo: '🧠 juez IA: la respuesta no atiende el mensaje' + (veredicto.razon ? ' — ' + veredicto.razon : '') + ' (lo ves tú)' };
        }
    }
    // 📝#10 + orden owner 2026-07-10: NO SE AGENDA SIN ANTES ENVIAR LA UBICACIÓN —
    // el pin viaja desde que arranca la coordinación de cita (pedir día/hora,
    // "te agendo en firme" y la confirmación), si no se le había mandado ya.
    if (g && (g.cita_confirmada || g.universo === 'cita' || g.universo === 'cita_firme') && args && args.auto_id && g.ubicacion_auto_id == null && !(est && est.pin_enviado)) {
        g.ubicacion_auto_id = args.auto_id;
        g.pin_after_index = 0;   // el pin cae justo después de la primera burbuja
    }
    return g;
}

const cap = s => { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };

const REQUISITOS3 = `- identificación oficial vigente
- comprobante de domicilio
- 3 meses de nóminas o estados de cuenta
- RFC
- teléfono de casa y celular
- tiempo en el domicilio y en la empresa
- soltero o casado (nombre del cónyuge)
- correo, empresa (nombre, dirección, teléfono)
- 4 referencias: 2 familiares que no vivan contigo y 2 amistades (nombre y teléfono)`;

module.exports = { responderEtapa3, detectarUniverso, estadoConv, ctaEstado, escala3 };
