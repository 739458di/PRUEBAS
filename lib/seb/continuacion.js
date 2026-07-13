// lib/seb/continuacion.js
// EN_CURSO (CONTINUACIÓN): contesta la RESPUESTA del comprador a un opener YA enviado.
// SOLO 2 universos, los de sus manuales: FINANCIAMIENTO y UBICACIÓN. Cualquier otra cosa
// → null (el bot se calla / lo ve el owner). Aplica UNA sola vez (la 1ra respuesta al
// opener); después, silencio.
//
// Formato (de los manuales): 3 RÁFAGAS → maquillada+nombre · acción PELONA · gancho.
// Sobrio: sin emojis, sin "!", solo "?" al final. Números SIEMPRE del cotizador HEY Banco.
// Fuente: lib/seb/playbook/MANUAL_FINANCIAMIENTO_SEB.md + MANUAL_UBICACION_SEB.md.

const { cotizar, planes, fotosDeAuto, bancoDeAuto, enganche_minimo } = require('./herramientas.js');
const { nombreReal } = require('./opener.js');
const { subInfo, infoAccion } = require('./info_auto.js');
const { maquillar } = require('./conector.js');
const { query } = require('./db.js');

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const fmtMXN = n => '$' + Number(n || 0).toLocaleString('es-MX');
const rot = arr => arr[Math.floor(Math.random() * arr.length)];
const cap = s => { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };

// El conector lo elige la IA (sintonía input→output); si falla, cae a rot(pool).
// nm = nombre ya formateado (" Juan" o ""). Devuelve { c, sintonia }:
//   c = 1ra burbuja "Conector{nm}";  sintonia=false → la respuesta NO contesta la duda → escala.
async function conectar({ texto, accion, pool, nm = '', gancho = '' }) {
    const r = await maquillar({ texto, accion, pool, gancho });
    return { c: `${r.conector}${nm}`, sintonia: r.sintonia };
}

// ── Textos exactos de los manuales ───────────────────────────────────────────
const REQUISITOS = `Estos son los requisitos:
- identificación oficial vigente
- comprobante de domicilio
- 3 meses de nóminas o estados de cuenta
- RFC
- teléfono de casa
- Celular
- Tiempo viviendo en el domicilio
- Soltero o casado, en caso de ser casado, nombre del cónyuge
- correo electrónico
- nombre de la empresa, dirección y teléfono
- Tiempo trabajando en la empresa
- 4 referencias: 2 familiares que no vivan contigo (nombre y teléfono) y 2 amistades (nombre y teléfono)`;
// El BANCO sale del AUTO (bancoDeAuto: 2018+ → HEY Banco; ≤2017 → Renueva Car).
// #591: una Tacoma 2014 recibió "es por medio de HEY Banco" — dato falso.
// DOCTRINA (2026-07-09): el bot NO explica el proceso/tasa/buró (eso es venta → escala);
// solo dice el HECHO del banco, manda la lista y calcula la tarjeta.
// PITCH de SEGURIDAD (tipo B). SOLO se manda DESPUÉS del pin y SOLO en "¿dónde está / la veo?"
// (input 1/2). Propósito: que al ver el pin en una colonia (casa del dueño) no se asusten. Rota.
const PITCH_UBI = [
    'El auto es de un dueño particular y nosotros te respaldamos como agencia — te quitamos el riesgo de comprarle a un desconocido y le damos toda la formalidad legal',
    'Le compras directo al dueño particular, pero a través de nosotros, para darte seguridad de compra y herramientas financieras',
    'Es de un dueño particular, pero la compra va a través de nosotros — así te llevas la seguridad de una agencia y las herramientas financieras, sin el riesgo de hacerlo por tu cuenta'
];
// ── UBICACIÓN: foráneos y "¿de dónde eres?" ──────────────────────────────────
// Ciudades de donde SÍ vienen sus clientes manejando: NO se asume envío, se sugiere
// "cita con anticipación" (palabras del owner). Envío solo si lo piden EXPLÍCITO.
const CIUDADES_CERCANAS = new Set([
    'saltillo', 'ramos arizpe', 'arteaga', 'monclova', 'montemorelos', 'santiago', 'garcia',
    'escobedo', 'guadalupe', 'apodaca', 'juarez', 'san nicolas', 'cadereyta', 'allende',
    'linares', 'sabinas', 'tampico', 'victoria', 'ciudad victoria', 'reynosa', 'matamoros',
    'nuevo laredo', 'laredo', 'torreon', 'tamaulipas', 'coahuila'
]);
// Piden envío TAL CUAL (lo único que dispara el pitch de envío).
const RE_ENVIO_EXP = /(hacen envio|haces envio|hay envio|envias|envian|me lo (mandas|envias|envian|llevan)|(lo|la) (envias|envian|mandan|llevan)|mandar(lo|la)|envio a|envios a|me lo puedes? (mandar|enviar)|hasta (mi|donde|aca|aqui))/;
// Preguntan por NUESTRA ubicación ("¿de dónde eres/son?"), NO por envío.
const RE_DEDONDE = /(de donde (eres|es|son|me escribes|me hablas|me contactas)|ustedes de donde|de que (ciudad|parte|estado|lado) (eres|es|son)|quienes? son ustedes|donde estan ustedes|tu de donde|de donde son ustedes|de donde me)/;
// El comprador dice que es foráneo (sin pedir envío y sin preguntar por nuestra ubic).
const RE_FORANEO = /(soy de|vengo de|estoy en|vivo en|radico en|me encuentro en|me queda (lejos|retirado|retirada)|esta (lejos|retirado)|otra ciudad|otro estado|foraneo|de fuera|fuera de (monterrey|mty)|que tan lejos|queda (lejos|retirado)|de lejos|ando en|aqui en)/;
function ciudadCercana(t) { for (const c of CIUDADES_CERCANAS) if (t.includes(c)) return c; return null; }

// ESCALA del módulo ubicación: problema técnico, o ubicación + otra duda NO-manual (precio/color/etc).
const RE_TECNICO = /(no me deja|no abre|no carga|no funciona|no puedo abrir|no se abre|el link|error)/;
// PRECIO ya es tema de la continuación (sale del inventario). Las DEMÁS dudas no-manual
// (color/km/garantía/etc.) junto a ubicación siguen escalando (#8).
const RE_PRECIO = /(precio|cuesta|cuanto (vale|cuesta|piden|sale|es)|que precio|en cuanto (lo|la|esta|sale|dan)|cuanto cuesta)/;
// Dudas que NO tienen banco en continuación (color/km/factura/detalle/motor ahora SÍ los
// maneja info_auto). Quedan: garantía, fotos, aire/clima, 4x4, versión, año → escalan junto a ubic.
const RE_OTRA_DUDA = /(garantia|version|año|anio|aire|clima|4x4|seguro)/;
const RE_FOTOS = /(\bfotos?\b|imagenes|imágenes|fotografias|me mandas? (las )?fotos|tienes? fotos|ver el auto en foto|mas fotos|más fotos)/;

// ¿En qué universo cae la respuesta del comprador? null = ninguno → silencio/escala.
// Lo que el manual manda escalar (objeción de tasa, comparar bancos, permuta-enganche,
// seguro, abono a capital) también devuelve null.
// Lo que el manual §7 manda ESCALAR (el bot NO contesta): objeción de tasa, comparar
// bancos, permuta-de-enganche, seguro en la mensualidad, abono a capital, liquidar antes.
const RE_ESCALA = [
    /esta (muy )?cara|muy cara/,
    /baja\w*\b[^?]{0,14}tasa|tasa[^?]{0,14}(alta|cara|elevada|carisima)|(cara|alta)[^?]{0,6}(la )?tasa/,
    /otro banco|otra financiera|comparar banco|cambiar de banco/,
    /(lleva|trae|incluye|viene con|va con|tiene)[^?]{0,14}seguro|seguro[^?]{0,14}(incluido|mensualidad|aparte|va)|mensualidad[^?]{0,16}seguro/,
    /abono a capital|\ba capital\b|liquidar antes|pagar antes|adelantar pagos/,
    /(dej\w+|pongo|doy|entrego|tomas?|recibes?)[^?]{0,18}(carro|auto|camioneta|coche|nave)[^?]{0,10}(de |como )?enganche|(carro|auto|camioneta|coche) (de|como) enganche|permuta[^?]*enganche|enganche[^?]*permuta/
];
const RE_FIN = /(financ|credito|de enganche|enganche|mensualidad|tasa|interes(es)?\b|requisito|que (documentos|papeles|piden|necesito|ocupan)|buro|historial|apr(o|ue)b|apto|califico|cotiza|corrida|preautoriz|a (cuantos )?meses|cuantos meses|\d+ ?meses|que banco|cual banco|con que banco|de que banco|banco es|que financiera)/;
const RE_UBI = /(ubicacion|\bdonde\b|\bdnd\b|\bdnde\b|se encuentran|donde se encuentra|se localizan|estan ubicados|en que parte|de que parte|en que ciudad|como llego|direccion|domicilio|pasame la ubic|mandame la ubic|mande la ubic|enviame la ubic|comparte.*ubic|donde se ubican|donde estan|que (parte|zona)|a que hora (abren|cierran)|horario|que dias|dias atienden|abren (los )?(domingo|sabado)|atienden (el |los )?(domingo|sabado|fin de semana)|trabajan (el |los )?(domingo|sabado)|puedo ir (el )?(domingo|sabado)|hacen envio|envi(o|os|as|an|ar)|me lo (mandas|envias|llevan|puedes? (mandar|enviar))|hasta (mi|donde|aca|aqui)|otra ciudad|otro estado|me queda (lejos|retirado)|de lejos|esta (lejos|cerca|retirado)|que tan lejos|queda (lejos|cerca|retirado)|foraneo|de fuera|fuera de (monterrey|mty)|saltillo|ramos arizpe|arteaga|monclova|montemorelos|escobedo|apodaca|cadereyta|linares|sabinas|tampico|reynosa|matamoros|torreon|tamaulipas|coahuila|cdmx|guadalajara|cancun|tijuana)/;

function universoCont(texto) {
    const t = norm(texto);
    if (RE_ESCALA.some(re => re.test(t))) return null;
    if (RE_TECNICO.test(t)) return null;           // problema técnico ("no me deja abrirlo") → humano
    if (RE_FOTOS.test(t)) return 'fotos';          // pide fotos → se las mandamos de verdad
    const sFin = RE_FIN.test(t), sUbi = RE_UBI.test(t), sPre = RE_PRECIO.test(t), sInfo = !!subInfo(texto);
    if (sUbi && !sFin && !sPre && !sInfo && RE_OTRA_DUDA.test(t)) return null;   // #8 ubic + duda sin banco (garantía/fotos…) → humano
    if (sFin && sUbi) return 'ambos';              // crédito (su cotización ya trae el precio) + ubicación → las DOS
    if (sPre && sUbi) return 'precio_ubic';        // precio + ubicación → las DOS
    if (sInfo && sUbi) return 'info_ubic';         // info del auto (dueños/km/color…) + ubicación → las DOS
    if (sFin) return 'financiamiento';
    if (sPre) return 'precio';
    if (sInfo) return 'info';                      // información del auto
    if (sUbi) return 'ubicacion';
    if (/(plazo|como queda|cuanto.*queda)/.test(t)) return 'financiamiento';
    // AFIRMACIÓN DE INTERÉS al "¿te interesa venir a verlo?" del opener (turno 1) → luz verde:
    // se le pone TODO sobre la mesa (ubicación) y se amarra la hora, asumiendo que ya lo va a ver.
    if (/^(s+i+|claro( que si)?|va+(le)?|sale( va)?|dale|de acuerdo|obvio|simon|perfecto|excelente|estoy interesad\w*|si me interesa|si quiero|me interesa|me late|si porfavor|si claro|claro que si|de una|orale)[\s.,!]*$/.test(t)) return 'interes_venir';
    return null;
}

// ── FINANCIAMIENTO (manual §3) ───────────────────────────────────────────────
async function responderFin({ texto, nombre, auto_id, enganche, plazo }) {
    const t = norm(texto);
    const nm = nombre ? ' ' + nombre : '';
    const tieneDato = !!(enganche || plazo);
    const esCotizar = tieneDato || /((?:cotiza|coitza|cotisa|cotza|cotica|cotizc)|corrida|como queda|cuanto (me )?queda|mensualidad|a (cuantos )?meses|de enganche|ejercicio|me interesa (a|el|con|por|en) credito|(lo|la) (quiero|llevo|llevaria|agarro|compraria) (a|con) credito|seria (a|con) credito|quiero financiarl|me interesa financiarl|(a|en) credito me interesa)/.test(t);
    const esRequisitos = /(requisito|que (documentos|papeles|necesito|piden|ocupan))/.test(t);
    const esBanco = /(que banco|cual banco|con que banco|de que banco|banco es|que financiera)/.test(t);
    const esAprob = /((en cuanto|cuanto tiempo|que tan rapido|cuanto tardan?|tiempo de)[^?]{0,15}apr(o|ue)b|cuando[^?]{0,8}apr(o|ue)b)/.test(t);
    const esTasa = /(tasa|interes(es)?\b|porcentaje)/.test(t);
    const esBuro = /(buro|historial|apto|califico|me prestan|me dan el credito)/.test(t);

    // 🧮 COTIZAR — la tarjeta tal cual, SIN comentario de venta (doctrina).
    if (esCotizar) {
        let card = null, eng = enganche || null;
        if (eng && plazo) { const r = await cotizar({ auto_id, enganche: eng, plazo_meses: plazo }); if (r.ok) card = r.placeholders.cotizacion; }
        else if (eng) { const r = await cotizar({ auto_id, enganche: eng }); if (r.ok) card = r.placeholders.cotizacion; }
        else { const r = await planes({ auto_id }); if (r.ok) card = r.placeholders.planes; }
        if (!card) return null;                       // <2018 / sin precio → escala (no inventa)
        const { c, sintonia } = await conectar({ texto, accion: 'te paso la cotización con tus números', pool: ['Va', 'Mira', 'Con gusto'], nm });
        const r1 = eng
            ? `${c}, con tus ${fmtMXN(eng)} de enganche queda así:`
            : `${c}, te paso la corrida para que veas las opciones:`;
        return { _sintonia: sintonia, segmentos: [r1, card, eng ? 'Cómo la ves?' : 'Cómo ves, se te acomoda alguna?'] };
    }
    // 📤 REQUISITOS — la lista, vestida + gancho de calculadora.
    if (esRequisitos) {
        const { c, sintonia } = await conectar({ texto, accion: REQUISITOS, pool: ['Va', 'Con gusto', 'Claro'], nm });
        return { _sintonia: sintonia, segmentos: [`${c}, con gusto`, REQUISITOS, 'Gustas que te cotice mientras?'] };
    }
    const banco = await bancoDeAuto(auto_id);   // HEY Banco (2018+) o Renueva Car (≤2017)
    // 📖 MÍNIMO DE ENGANCHE (🚩fyrachat#4): "¿cuánto es el enganche?" se contesta con EL
    // NÚMERO, no con el rollo del proceso.
    if (/(minimo|lo menos|cuanto (de |del |es el |es |piden de )?(el )?enganche\b|cual es el enganche|que enganche (piden|manejan|es)|de cuanto (es )?el enganche|con cuanto (menos|minimo)|desde cuanto|enganche minimo)/.test(t) && !/\d/.test(t)) {
        const rMin = await enganche_minimo({ auto_id });
        if (rMin.ok) {
            const accionM = `El enganche mínimo es de ${rMin.placeholders.enganche_minimo}`;
            const { c, sintonia } = await conectar({ texto, accion: accionM, pool: ['Mira', 'Claro', 'Te cuento'], nm });
            return { _sintonia: sintonia, segmentos: [`${c}, ${accionM.charAt(0).toLowerCase()}${accionM.slice(1)}`, 'De ahí para arriba el que gustes', 'Gustas que te cotice para que veas los números?'] };
        }
    }
    // 📖 QUÉ BANCO — hecho, vestido + gancho de calculadora.
    if (esBanco) {
        const lineaBanco = `Es con ${banco}`;
        const { c, sintonia } = await conectar({ texto, accion: lineaBanco, pool: ['Mira', 'Claro', 'Va'], nm });
        return { _sintonia: sintonia, segmentos: [c, lineaBanco, 'Gustas que te mande un ejercicio para que veas cómo quedaría?'] };
    }
    // 🚩616: la naturaleza de "financiado" → los REPETITIVOS de siempre (banco por año).
    const PROCESO = `Es por medio de ${banco}${banco === 'HEY Banco' ? ', con muy buenas tasas' : ''}. Mandas tus documentos, te cotizo, solicitamos el crédito, te dicen si apruebas en menos de 2 horas, ya aprobado tú decides cuándo firmas, y el enganche lo das a la entrega — no pagas nada hasta que se te entregue el auto`;
    if (esAprob) {
        const { c, sintonia } = await conectar({ texto, accion: 'en menos de 2 horas te dicen si apruebas', pool: ['Va', 'Mira', 'Claro'], nm });
        return { _sintonia: sintonia, segmentos: [c, 'Ya con tus documentos, en menos de 2 horas te dicen si apruebas', 'Gustas que te mande los requisitos para empezar?'] };
    }
    if (esTasa) {
        const TASA = banco === 'HEY Banco' ? 'Manejamos del 13.99% al 15%, dependiendo de tu buró e historial, con HEY Banco' : 'La tasa te la afino en tu cotización exacta, según tu enganche y plazo';
        const { c, sintonia } = await conectar({ texto, accion: TASA, pool: ['Mira', 'Claro', 'Va'], nm });
        return { _sintonia: sintonia, segmentos: [c, TASA, 'Gustas que te mande un ejercicio para que veas cómo quedaría?'] };
    }
    // 🚩real#6: confesión de buró = comentario personal → ESCALA (no hay machote).
    if (/((estoy|ando|salgo|aparezco|me encuentro|cai|caigo|estuve|quede) [^?]{0,10}buro|tengo (mal|feo|manchado|sucio)[^?]{0,8}(buro|historial)|mi (buro|historial) (esta|anda|no)|buro (malo|manchado|sucio|negativo)|mal historial credit|debo en buro|reportado en buro|con buro\b)/.test(t)) {
        return { escalar: true, motivo: '🔴 comprador CONFIESA su situación de buró (comentario personal — caso a caso, tuyo)' };
    }
    if (esBuro) {
        const BURO = `Es sujeto a aprobación con ${banco}; estés en buró o no lo vemos${banco === 'HEY Banco' ? ', y con buen historial mejora la tasa' : ''}`;
        const { c, sintonia } = await conectar({ texto, accion: BURO, pool: ['Va', 'Mira', 'Claro'], nm });
        return { _sintonia: sintonia, segmentos: [c, BURO, 'Gustas que te cotice?'] };
    }
    // "¿Financian?" (sí/no) = afirmación + banco + gancho de calculadora.
    if (/(tienen|manejan|aceptan|hay|dan|cuentan con|se puede|puedo)[^?]{0,30}(financia|credito|a meses|mensualidades|financiado)|financian/.test(t)) {
        return { segmentos: [rot(['Sí, así es', 'Claro que sí']), `Es con ${banco}`, 'Gustas que te mande un ejercicio para que veas cómo quedaría?'] };
    }
    // Proceso genérico ("¿cómo es financiado?") → EL REPETITIVO completo.
    const { c, sintonia } = await conectar({ texto, accion: PROCESO, pool: ['Con gusto', 'Va', 'Mira'], nm });
    return { _sintonia: sintonia, segmentos: [`${c}, te explico`, PROCESO, 'Gustas que te mande un ejercicio para que veas cómo quedaría?'] };
}

// ── UBICACIÓN (manual §3) — SIEMPRE manda el pin ─────────────────────────────
async function datosPunto(auto_id) {
    const pe = await query("SELECT name, (image_b64 IS NOT NULL) tiene_img, lat, lng FROM punto_envio WHERE auto_id=?", [Number(auto_id)]);
    if (pe.length && (pe[0].name || pe[0].lat != null)) return { dir: pe[0].name || 'nuestro punto de venta', tienePin: !!(pe[0].tiene_img || pe[0].lat != null) };
    const inv = await query("SELECT puntos_venta FROM inventario_autos WHERE id=?", [Number(auto_id)]);
    if (inv.length) { try { const p = JSON.parse(inv[0].puntos_venta || '[]'); if (p[0] && p[0].name) return { dir: p[0].name, tienePin: p[0].lat != null }; } catch (e) { } }
    return null;
}
async function esCamioneta(auto_id) {
    const r = await query("SELECT tipo_carroceria, modelo FROM inventario_autos WHERE id=?", [Number(auto_id)]);
    if (!r.length) return false;
    const s = norm((r[0].tipo_carroceria || '') + ' ' + (r[0].modelo || ''));
    return /(camioneta|pickup|pick up|suv|truck|doble cabina|bighorn|suburban|tacoma|ranger|hilux|frontier|l ?200|macan|tiguan|cr-?v|rav4|cx-?\d|q[357]|x[1-7]|explorer|tahoe|durango|journey|equinox|kicks|hr-?v|seltos)/.test(s);
}
async function responderUbi({ texto, nombre, auto_id }) {
    const t = norm(texto);
    const nm = nombre ? ' ' + nombre : '';
    const punto = await datosPunto(auto_id);
    const dir = punto ? punto.dir : null;
    const base = { ubicacion_auto_id: auto_id };       // señal: mandar el pin del punto
    const ciudad = ciudadCercana(t);
    const esLocal = /(monterrey|\bmty\b|san pedro|aqui en (mty|monterrey|la ciudad)|aqui mismo)/.test(t);
    const esForaneo = !esLocal && (RE_FORANEO.test(t) || !!ciudad);
    // Gancho de foráneo (palabras del owner): NO se asume envío, se sugiere cita anticipada.

    // 1. ENVÍO EXPLÍCITO → jugada de persuasión (doctrina 2026-07-09) → TUYA.
    if (RE_ENVIO_EXP.test(t)) {
        return { escalar: true, motivo: 'pide ENVÍO a su ciudad (jugada de distancia — tuya)', puente: 'Sí manejamos envío; déjame te explico bien cómo funciona y aquí te digo' };
    }
    // 2. "¿DE DÓNDE ERES / SON?" → dato de ubicación (📖 leer ficha).
    if (RE_DEDONDE.test(t)) {
        const accion = 'Somos de Monterrey, Nuevo León, nos ubicamos en San Pedro Garza García sobre Vasconcelos';
        const { c, sintonia } = await conectar({ texto, accion, pool: ['Claro', 'Mira', 'Te cuento'], nm });
        return { ...base, _sintonia: sintonia, segmentos: [c, accion, 'Te interesa venir a verla y manejarla?'] };
    }
    // F. HORARIOS / DÍAS (manual §3.F)
    if (/(a que hora (abren|cierran)|horario|que horario|que dias|dias atienden|abren (los )?(domingo|sabado)|atienden (el |los )?(domingo|sabado|fin de semana)|trabajan (el |los )?(domingo|sabado)|puedo ir (el )?(domingo|sabado))/.test(t)) {
        const accion = 'El horario es de 9 a 7pm, pero como son consignaciones de particulares de uso cotidiano es con cita previa; la hora no importa, igual sábado o domingo';
        const { c, sintonia } = await conectar({ texto, accion, pool: ['Mira', 'Claro', 'Va'], nm });
        return { ...base, _sintonia: sintonia, segmentos: [c, accion, 'Qué día y hora te coordino?'] };
    }
    // 3. FORÁNEO ("soy de Saltillo", "me queda lejos") → jugada de distancia (doctrina) → TUYA.
    if (esForaneo) {
        return { escalar: true, motivo: `comprador FORÁNEO${ciudad ? ' (' + cap(ciudad) + ')' : ''} — jugada: cita anticipada vs envío, tuya`, puente: 'No hay bronca por la distancia; déjame veo cómo te lo acomodamos mejor y aquí te digo' };
    }
    // B. GENERAL ("¿dónde se encuentran / de qué parte / ciudad / zona?") (manual §3.B)
    if (/(de que parte|en que parte|en que ciudad|de que ciudad|que (zona|ciudad)|por donde (estan|se ubican)|por que (zona|rumbo)|se encuentran|donde se encuentra|se localizan|estan ubicados|\bdnd\b|\bdnde\b|donde (se ubican|estan|quedan))/.test(t)) {
        const accion = 'Estamos en San Pedro Garza García, Nuevo León, sobre Vasconcelos';
        const { c, sintonia } = await conectar({ texto, accion, pool: ['Claro', 'Mira', 'Te cuento'], nm });
        return { ...base, _sintonia: sintonia, segmentos: [c, accion, 'Te interesa venir a verla y manejarla?'] };
    }
    // C. "PÁSAME LA UBICACIÓN" (orden directa → pin PRIMERO) (manual §3.C)
    if (/(pasame la ubic|mandame la ubic|mande la ubic|enviame la ubic|comparte.*ubic|mandar.*ubic)/.test(t)) {
        const accion = dir ? `aquí en ${dir}` : 'aquí está';
        const { c, sintonia } = await conectar({ texto, accion, pool: ['Va', 'Claro', 'Mira'], nm });
        return { ...base, _sintonia: sintonia, pin_primero: true, segmentos: [`${c}, ${accion}`, 'A qué hora te esperamos para agendarte?'] };
    }
    // A. EXACTITUD (input 1/2: "¿dónde está / la veo?") → con PITCH de seguridad DESPUÉS del pin.
    const laLo = (await esCamioneta(auto_id)) ? 'la' : 'lo';
    const accionA = dir ? `te mando la ubicación, aquí es nuestro punto de venta, ${dir}` : 'te mando la ubicación de nuestro punto de venta';
    const { c, sintonia } = await conectar({ texto, accion: accionA, pool: ['Claro', 'Mira', 'Con gusto'], nm });
    const r2 = dir ? `Aquí es nuestro punto de venta, ${dir}` : 'Aquí es nuestro punto de venta';
    // Orden: conector → [pin] → "Aquí es nuestro punto de venta, dir" → gancho.
    // Maquillado CONFORME A LA DUDA: "¿dónde lo tienen?" solo quiere el punto — sin la
    // parrafada de venta (el pitch de seguridad va en el universo 'negocio', no aquí).
    return { ...base, _sintonia: sintonia, segmentos: [`${c}, déjame te mando la ubicación`, r2, `A qué hora te coordinamos una cita${nm}, para que ${laLo} manejes y ${laLo} veas?`] };
}

// ── FOTOS (las manda de verdad, de fyradrive, solo de TUS autos) ─────────────
async function responderFotos({ texto, nombre, auto_id }) {
    const nm = nombre ? ' ' + nombre : '';
    const urls = await fotosDeAuto(auto_id, 5);
    if (!urls.length) return { segmentos: [`Claro${nm}, déjame te las consigo y te las paso en un momento`, 'Te late venir a verlo y manejarlo?'] };
    return { segmentos: [`Claro${nm}, déjame te las mando`, 'Te late venir a verlo y manejarlo?'], fotos: urls, fotos_after_index: 0 };
}

// ── INFORMACIÓN DEL AUTO (dueños/km/color/papelería/detalles/motor) ──────────
async function responderInfo({ texto, nombre, auto_id }) {
    const r = await infoAccion(texto, auto_id);
    if (!r || !r.accion) return null;              // motor / sin dato → escala (humano)
    const nm = nombre ? ' ' + nombre : '';
    const { c, sintonia } = await conectar({ texto, accion: r.accion, pool: ['Mira', 'Va', 'Con gusto'], nm });
    return { _sintonia: sintonia, segmentos: [c, r.accion, 'Te late venir a verlo y manejarlo?'] };
}
// COMBO info del auto + ubicación → las dos.
async function responderInfoUbic({ texto, nombre, auto_id }) {
    const info = await responderInfo({ texto, nombre, auto_id });
    if (!info) return null;                        // info no resolvió (motor) → escala todo
    const punto = await datosPunto(auto_id);
    const dir = punto ? punto.dir : null;
    const ubiLine = dir ? `Y aquí es nuestro punto de venta, ${dir}` : 'Y aquí es nuestro punto de venta';
    const segs = [...info.segmentos.slice(0, 2), ubiLine, 'A qué hora te coordinamos la cita para que lo veas y lo manejes?'];
    return { segmentos: segs, ubicacion_auto_id: auto_id, pin_after_index: 2 };
}

// ── PRECIO (tema de continuación; sale del inventario) ───────────────────────
async function responderPrecio({ texto, nombre, auto_id }) {
    const a = await query("SELECT marca, modelo, anio, precio FROM inventario_autos WHERE id=?", [Number(auto_id)]);
    if (!a.length || a[0].precio == null) return null;
    const nombreAuto = [a[0].marca, a[0].modelo, a[0].anio].filter(Boolean).join(' ');
    const nm = nombre ? ' ' + nombre : '';
    const accion = `El ${nombreAuto} está en ${fmtMXN(a[0].precio)}`;
    const { c, sintonia } = await conectar({ texto, accion, pool: ['Mira', 'Claro', 'Va'], nm });
    return { _sintonia: sintonia, segmentos: [c, accion, 'Te late venir a verlo y manejarlo, y si te gusta lo negociamos en persona?'] };
}
// COMBO precio + ubicación → las dos.
async function responderPrecioUbic({ texto, nombre, auto_id }) {
    const pre = await responderPrecio({ texto, nombre, auto_id });
    if (!pre) return await responderUbi({ texto, nombre, auto_id });
    const punto = await datosPunto(auto_id);
    const dir = punto ? punto.dir : null;
    const ubiLine = dir ? `Y aquí es nuestro punto de venta, ${dir}` : 'Y aquí es nuestro punto de venta';
    const segs = [...pre.segmentos.slice(0, 2), ubiLine, 'A qué hora te coordinamos la cita para que lo veas y lo manejes?'];
    return { segmentos: segs, ubicacion_auto_id: auto_id, pin_after_index: 2 };
}

// ── COMBO crédito + ubicación (preguntó las DOS) ─────────────────────────────
// Maquillada + acción de crédito + línea de ubicación (+pin) + UN gancho a cita.
async function responderAmbos({ texto, nombre, auto_id, enganche, plazo }) {
    const fin = await responderFin({ texto, nombre, auto_id, enganche, plazo });
    if (fin && fin.escalar) return fin;                                // crédito escala → escala todo (doctrina)
    if (!fin) return await responderUbi({ texto, nombre, auto_id });   // crédito no resolvió → solo ubicación
    const punto = await datosPunto(auto_id);
    const dir = punto ? punto.dir : null;
    const ubiLine = dir ? `Y aquí es nuestro punto de venta, ${dir}` : 'Y aquí es nuestro punto de venta';
    // fin.segmentos[0..1] = maquillada + acción (tasa/proceso/requisitos/cotización); se tira su gancho.
    const segs = [...fin.segmentos.slice(0, 2), ubiLine, 'A qué hora te coordinamos la cita para que lo veas y te paso los números ahí mismo?'];
    return { segmentos: segs, ubicacion_auto_id: auto_id, pin_after_index: 2 };
}

// Si el REGEX no cazó pero Haiku SÍ entendió la intención (ej. "Dnd se encuentran"
// abreviado, o sinónimos que el regex no contempla), enruta por la intención de Haiku.
// Esto es la IA interpretando: el código no adivina, usa lo que la IA ya entendió.
const INTENCION_A_UNIVERSO = {
    cita_ubicacion: 'ubicacion',
    cotizar_credito: 'financiamiento',
    precio_negociacion: 'precio',
    fotos_videos: 'fotos',
    estado_auto: 'info'
};

// ENTRADA: ¿la respuesta del comprador cae en un universo con manual? Si sí, arma la
// ráfaga. Si no, null (silencio/escala). `enganche`/`plazo`/`intencion` los da el clasificador.
// ── INTERÉS → VENIR (turno 1): dijo que sí a "¿te interesa venir a verlo?" → todo sobre
// la mesa: ubicación + amarrar la hora con inmediatez (hoy o mañana), asumiendo que ya va.
async function responderInteresVenir({ nombre, auto_id }) {
    const nm = nombre ? ' ' + nombre : '';
    const dp = await datosPunto(auto_id).catch(() => null);
    const dir = dp && dp.dir ? dp.dir : null;
    const r2 = dir ? `Déjame te mando la ubicación, aquí es nuestro punto de venta, ${dir}` : 'Déjame te mando la ubicación de nuestro punto de venta';
    return { ubicacion_auto_id: auto_id, pin_after_index: 1, segmentos: [`Excelente${nm}, va`, r2, 'A qué hora te queda mejor, hoy o mañana?'] };
}

async function responderCont({ texto, nombre, auto_id, enganche, plazo, intencion, conv_id, clasif }) {
    if (!auto_id) return null;
    // ── PUERTA DE ENTRADA (doctrina 2026-07-09): momentos de gol → owner ──
    // ORDEN del owner: al escalar NO HAY PUENTE — el bot se calla, él contesta.
    const { puertaEntrada } = require('./doctrina.js');
    const gol = puertaEntrada(texto);
    if (gol) return { escalar: true, motivo: gol.motivo };
    const t = norm(texto);
    // CORTESÍA pura → silencio (recepcionista); FRENO simple → acuse y silencio.
    if (/^(ok+(ey)?|okok|va+(le)?|sale|dale|listo|perfecto|excelente|de acuerdo|entendido|muy amable|gracias|muchas gracias|mil gracias|grax|si gracias|ok gracias|👍|🙏)([\s.,!]*(ok+|va+|gracias|listo|perfecto|👍|🙏))*[\s.,!]*$/.test(t)) return { silencio: true };
    if (/(te aviso|les aviso|me comunico|te confirmo|lo pienso|lo platico|lo consulto|deja(me)? chec|deja(me)? veo\b(?! (el|la|lo|los|las|foto))|deja(me)? ver (si|que|como|cuando|mis|mi)\b|deja(me)? (progr\w+|cuadrar|acomodar|organizar)|deja(me)? me (acomodo|organizo|programo|cuadro)\b|me (acomodo|organizo|cuadro|ajusto) con (mis|mi|los|el)\b|acomodo mis (horarios|tiempos)|me programo|dame (chance|tiempo|oportunidad)|aguantame|esperame|(ando|estoy|he andado) (muy |bien+ |re )?(atareado|atariado|ocupado|saturado)|tengo (varios )?compromisos)/.test(t)) {
        return { universo: 'freno', segmentos: ['Va, sin tema, aquí ando pendiente'] };
    }
    nombre = nombreReal(nombre);                            // SOLO el primer nombre (o null si no es nombre común)
    // ── CITA EN TURNO 2 (🚩756/758/761): el turno 2 no sabía cerrar citas — "ssi",
    // "alas 5", "me interesa ir a verlo el domingo a las 5" escalaban o los secuestraba
    // la ubicación. Si huele a COORDINACIÓN DE CITA → se DELEGA al cerrador de etapa 3
    // (mismo motor: anti-humo, día+hora, confirmada ✅). Require perezoso (sin ciclo).
    if (conv_id) {
        const afirmacionPura = /^(s+i+|claro( que si)?|va+|vale|sale|dale|ok+|okey|perfecto|de acuerdo|simon|arre|me parece|si por ?favor|si claro|si gracias)[\s.,!]*$/.test(t);
        const traeDiaHora = /\b(hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b|\ba ?las? \d{1,2}\b|\d{1,2} ?(pm|am)\b/.test(t);
        const quiereVer2 = /(ir a verl|venir a verl|puedo (ir|pasar)|paso (el|hoy|manana)|voy (el|hoy|manana)|nos vemos|me interesa (ir|verl)|quiero (ir|verl)|agenda|una cita)/.test(t);
        if (afirmacionPura || traeDiaHora || quiereVer2) {
            const { responderEtapa3 } = require('./etapa3.js');
            const e3 = await responderEtapa3({ texto, auto_id, conv_id, clasif: clasif || {} });
            if (e3 && (e3.escalar || e3.silencio || (e3.segmentos && e3.segmentos.length))) return e3;
        }
    }
    // 🚩611+628: "mándame más información / dame más detalles" → EL MACHOTE + gancho.
    if (/((mas|toda) (la )?(informacion|informes|info)\b|(informacion|informes) (completa|del (auto|carro|coche))|manda(r|s|rme)?(me)? (mas )?(la )?(informacion|informes)|pasa(me|r)? (la )?(informacion|informes)|puedes (mandar|dar) (mas )?(informacion|informes)|(me puedes (dar|pasar|mandar)|dame|pasame|me das|quiero) (mas )?detalles|mas detalles de(l| la| el)|que mas me (puedes (decir|contar)|cuentas) del)/.test(t)) {
        const { machoteDe } = require('./machote.js');
        const m = await machoteDe(auto_id).catch(() => null);
        if (m) {
            const nm2 = nombre ? ' ' + nombre : '';
            return { universo: 'info_general', segmentos: [`Claro${nm2}, te mando la información completa`, m, 'Te late venir a verlo y manejarlo?'] };
        }
    }
    let u = universoCont(texto);
    if (!u && (enganche || plazo)) u = 'financiamiento';   // Haiku extrajo enganche/plazo → cotización
    if (!u && intencion) u = INTENCION_A_UNIVERSO[intencion] || null;   // FALLBACK por intención de Haiku
    let r = null;
    if (u === 'fotos') r = await responderFotos({ texto, nombre, auto_id });
    else if (u === 'ambos') r = await responderAmbos({ texto, nombre, auto_id, enganche, plazo });
    else if (u === 'precio_ubic') r = await responderPrecioUbic({ texto, nombre, auto_id });
    else if (u === 'info_ubic') r = await responderInfoUbic({ texto, nombre, auto_id });
    else if (u === 'financiamiento') r = await responderFin({ texto, nombre, auto_id, enganche, plazo });
    else if (u === 'precio') r = await responderPrecio({ texto, nombre, auto_id });
    else if (u === 'info') r = await responderInfo({ texto, nombre, auto_id });
    else if (u === 'ubicacion') r = await responderUbi({ texto, nombre, auto_id });
    else if (u === 'interes_venir') r = await responderInteresVenir({ nombre, auto_id });
    // ESCALA desde cualquier banco (doctrina) → SIN puente (orden owner: te callas).
    if (r && r.escalar) return { escalar: true, motivo: r.motivo };
    // SINTONÍA: si la IA juzgó que la respuesta NO contesta lo que el comprador preguntó
    // (la duda no cae bien en ningún banco), no contestes a medias → escala (lo ve el owner).
    if (r && r._sintonia === false) return null;
    if (!(r && r.segmentos && r.segmentos.length)) return null;
    // ⚖️ EL JUEZ DE EFICACIA (orden owner): misma red que en etapa 3.
    const { juzgar } = require('./juez.js');
    const veredicto = await juzgar(texto, r.segmentos);
    if (!veredicto.eficaz) {
        return { escalar: true, motivo: '🧠 juez IA: la respuesta no atiende el mensaje' + (veredicto.razon ? ' — ' + veredicto.razon : '') + ' (lo ves tú)' };
    }
    return { universo: u, ...r };
}

module.exports = { responderCont, universoCont, datosPunto, esCamioneta, ciudadCercana };
