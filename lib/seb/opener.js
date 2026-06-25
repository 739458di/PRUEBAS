// lib/seb/opener.js
// EL PLAYBOOK DEL PRIMER MENSAJE — la ÚNICA fuente de verdad del opener de Seb.
// Implementa PLAYBOOK_PRIMER_MENSAJE_SEB (.md/.json), destilado de 338
// conversaciones reales. Para el PRIMER contacto (Seb aún no respondió) NO se usa
// el loop de IA: se arma una RÁFAGA de mensajes cortos EXACTOS, que FyraChat parte
// para enviar uno por uno ("enviar, enviar, enviar").
//
// LEYES GLOBALES (aplican a TODO el opener):
//  - Estilo SOBRIO: SIN emojis, SIN signos de exclamación.
//  - Signos: solo "?" al final; NUNCA "¿" al inicio.
//  - Ráfaga: un mensaje por burbuja, una idea por mensaje.
//  - Recapitular el AUTO siempre (modelo + año del anuncio).
//  - Nombre del comprador si se tiene.
//  - UNA sola pregunta-gancho, al final, sola: "Gustas venir a verlo y manejarlo?".
//  - Ubicación HABLADA, nunca pin: "La tenemos en {punto}, por {zona}".
//  - Las cifras ([precio]/[km]) salen del inventario (datos reales), no de IA.

const { query } = require('./db.js');
const { esVendedor } = require('./clasificador.js');

// Separador de mensajes de una ráfaga. NO viaja a WhatsApp: el front lo usa para
// partir el borrador en mensajes individuales.
const SENTINEL = '||SEQ||';

// Bloques FIJOS del playbook (verbatim).
const GANCHO = 'Gustas venir a verlo y manejarlo?';
const FINANCIERA = 'Enganche desde 30%, hasta 60 meses con HEY Banco';
const BURO = 'Sí, es sujeto a aprobación bancaria';

// OBJECIONES / DUDAS comunes → respuesta exacta en la voz del owner (sacada de su
// data + dictada por él). Estructura: saludo + presentación + esta respuesta + gancho.
const RESP_OBJ = {
    garantia: 'Sí, va con garantía amplia, cobertura de motor y transmisión',
    mecanico: 'Claro que sí, puedes traerlo a revisión con tu mecánico de confianza',
    separacion: 'Sí, hay método de separación: con un mínimo de 10,000 pesos lo damos de baja de redes y te damos prioridad a ti',
    fotos: 'Claro que sí, déjame te las mando',
    pago: 'Aceptamos contado, crédito y transferencia',
    foraneo: 'Sí, contamos con envíos a toda la República con tracking en tiempo real. Mandas a alguien a revisar la unidad antes y te la enviamos',
    estado: 'Está en excelentes condiciones, sin detalles. Puedes traer tu mecánico a revisarlo'
};

const cap = s => { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Saludo por la HORA real de Monterrey (UTC-6). Sobrio, sin "!".
function saludoHora() {
    const h = new Date(Date.now() - 6 * 3600000).getUTCHours();
    if (h < 12) return 'buen día';
    if (h < 19) return 'buenas tardes';
    return 'buenas noches';
}

// Catálogo de NOMBRES COMUNES (México). Solo se saluda por nombre si el perfil
// trae uno de estos — así nunca saluda a un emoji, un número, un negocio ni un
// apodo raro. Si no está en la lista → silencio (lo seguro).
const NOMBRES_COMUNES = new Set([
    // hombres
    'juan','jose','luis','carlos','miguel','jorge','francisco','antonio','alejandro','ricardo',
    'fernando','roberto','eduardo','sergio','manuel','rafael','daniel','david','oscar','hector',
    'raul','javier','arturo','alberto','enrique','pedro','pablo','gerardo','ramon','victor',
    'mario','omar','adrian','ivan','cesar','gabriel','marco','marcos','andres','diego',
    'emilio','emiliano','santiago','sebastian','mateo','leonardo','angel','gustavo','hugo','salvador',
    'ernesto','felipe','guillermo','ignacio','isaac','jaime','joaquin','julio','lorenzo','martin',
    'mauricio','nicolas','rene','rodrigo','rogelio','ruben','abel','abraham','agustin','aldo',
    'alfonso','alfredo','armando','aaron','benjamin','bruno','cristian','christian','edgar','efrain',
    'elias','esteban','fabian','gilberto','hernan','israel','jesus','jonathan','kevin','leonel',
    'lucas','noe','octavio','ramiro','raymundo','rolando','samuel','saul','tomas','ulises',
    'uriel','valentin','vicente','yahir','axel','bryan','brandon','jordan','alexis','rodolfo',
    'gael','dylan','ian','maximiliano','matias','rigoberto','everardo','genaro','baltazar','cuauhtemoc',
    // mujeres
    'maria','guadalupe','ana','laura','gabriela','alejandra','sofia','fernanda','valeria','daniela',
    'paola','carmen','rosa','patricia','claudia','veronica','adriana','monica','sandra','leticia',
    'martha','silvia','juana','teresa','gloria','beatriz','diana','karla','lucia','andrea',
    'mariana','jimena','regina','ximena','camila','valentina','isabella','renata','victoria','natalia',
    'lorena','brenda','cristina','cecilia','dulce','elena','erika','estefania','fatima','irene',
    'itzel','jacqueline','jessica','josefina','karen','liliana','lizbeth','marisol','melissa','mayra',
    'nancy','nayeli','norma','perla','rebeca','rocio','sara','susana','tania','vanessa',
    'wendy','yolanda','zaira','abril','alondra','azul','barbara','catalina','denise','elizabeth',
    'frida','grecia','iliana','jazmin','julia','luz','margarita','miriam','paulina','ramona',
    'rosario','viviana','yaretzi','angela','antonia','blanca','consuelo','esperanza','isabel','noemi',
    // diminutivos/apodos comunes y OBVIOS de persona (México)
    'lupita','lupe','pepe','paco','lalo','tono','chuy','memo','beto','checo','kike','nacho',
    'pancho','poncho','charly','gabo','richi','tere','chela','fer','dani','mau','mauri','vale','caro','pao'
]);

// Nombre real del perfil → solo si es un NOMBRE HUMANO COMÚN; si no, silencio.
// Rechaza emojis, números, símbolos, apodos y nombres de negocio.
function nombreReal(nombre) {
    const primero = String(nombre || '').trim().split(/\s+/)[0];
    // Solo letras (con acentos/ñ): descarta emojis, números, símbolos, "."
    if (!/^[a-záéíóúüñ]{2,15}$/i.test(primero)) return null;
    const clave = primero.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (!NOMBRES_COMUNES.has(clave)) return null;         // no es un nombre común obvio → silencio
    return primero.charAt(0).toUpperCase() + primero.slice(1).toLowerCase();
}

// "Qué tal Omar buenas tardes!" — saludo a la persona; el time-of-day (por la HORA
// real) va al final CON "!". Es la ÚNICA línea del opener que lleva "!".
function saludo(nm) { return `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}!`; }

// Clasifica el primer mensaje en uno de los INPUTS del playbook.
function tipoOpener(texto, intencion) {
    const t = norm(texto);
    // DESVÍO: quiere VENDER su auto → no es comprador (escala; trade-in NO entra aquí).
    if (esVendedor(texto)) return 'vendedor';
    // COMBO — pide INFO/disponibilidad Y crédito en el mismo mensaje ("quiero más
    // información + manejan crédito?"). Se contesta TODO junto, en ≤5.
    const pideCredito = /\b(financ|credit|engan|engach|mensualidad|a meses|pagos mensuales)/.test(t);
    const pideInfo = /\b(informacion|info|detalles|mas datos|más datos|me interesa|interesad|disponible|sigue disp)/.test(t);
    if (pideCredito && pideInfo) return 'info_credito';
    // INPUT 4 — financiamiento (proceso/crédito/enganche/mensualidad). Prefijos
    // (sin \b de cierre) para cazar "financiamiento", "financiado", "enganches", etc.
    if (pideCredito) return 'financiamiento';
    // INPUT 5 — pregunta pegada (dato específico): se resuelve SOLO esa.
    if (/\b(a cuenta|a cambio|tomas mi|toman mi|cambio mi|recib)\b/.test(t)) return 'preg_cuenta';
    if (/\b(buro|buró|historial crediticio)\b/.test(t)) return 'preg_buro';
    if (/\b(precio|cuesta|cuanto vale|cuánto vale|en cuanto|en cuánto|valor)\b/.test(t)) return 'preg_precio';
    if (/\b(km|kms|kilometraje|kilometros|kilómetros|caminado|recorrido)\b/.test(t)) return 'preg_km';
    if (/\b(color|de que color|de qué color)\b/.test(t)) return 'preg_color';
    if (/\b(donde|dónde|ubicacion|ubicación|ubicado|en que parte|en qué parte|como llego|cómo llego)\b/.test(t)) return 'preg_ubic';
    // OBJECIONES / DUDAS comunes → respuesta exacta en la voz del owner.
    if (/garant/.test(t)) return 'garantia';
    if (/mecanic|llevar(lo)? a revisar|puedo revisar|reviso/.test(t)) return 'mecanico';
    if (/apart|separa|reservar|aparto/.test(t)) return 'separacion';
    if (/foto/.test(t)) return 'fotos';
    if (/formas? de pago|metodos? de pago|como (puedo |se )?pag|aceptan? (tarjeta|efectivo|transferencia|pago)|con tarjeta|en transferencia|puedo pagar|de pago acepta/.test(t)) return 'pago';
    if (/otra ciudad|otro estado|foraneo|fuera de monterrey|toda la republica|tracking|hacen envio|me lo envian|lo envian|envian a|envios a/.test(t)) return 'foraneo';
    if (/estandar o automatic|es automatic|es estandar|transmision|caja (manual|automatic)|estandar\?/.test(t)) return 'transmision';
    if (/chocad|golpe|choque|algun detalle|tiene detalle|algun problema|esta bien el|daño|dano|en buen estado/.test(t)) return 'estado';
    // INPUT 3 — me interesa / sigue disponible (caliente).
    if (/\b(me interesa|interesado|interesada)\b/.test(t)) return 'interesa';
    if (/(sigue disponible|aun disponible|aún disponible|esta disponible|está disponible|todavia.*disponible|disponible\?)/.test(t)) return 'interesa';
    // Respaldo por intención de Haiku.
    if (intencion === 'cotizar_credito') return 'financiamiento';
    if (intencion === 'precio_negociacion') return 'preg_precio';
    if (intencion === 'cita_ubicacion') return 'preg_ubic';
    if (intencion === 'disponibilidad') return 'interesa';
    // INPUT 1/2 — genérico "quiero más información / detalles".
    return 'info';
}

// Datos REALES del auto del inventario (cero invento).
async function datosAuto(auto_id) {
    const r = await query(
        "SELECT marca, modelo, anio, precio, kilometraje, color, transmision, estado, vendido_externo, vendido_fyradrive FROM inventario_autos WHERE id = ?",
        [Number(auto_id)]);
    if (!r.length) return null;
    const a = r[0];
    return {
        nombre: [a.marca, a.modelo, a.anio].filter(Boolean).join(' '),    // [Auto] = modelo + año
        precio: a.precio != null ? '$' + Number(a.precio).toLocaleString('es-MX') : null,
        km: a.kilometraje != null ? Number(a.kilometraje).toLocaleString('es-MX') : null,
        transmision: a.transmision ? String(a.transmision).toLowerCase() : null,
        color: a.color ? cap(a.color) : null
    };
}

// La "INFORMACIÓN del auto" que pidió el owner: SOLO dueño + factura de agencia +
// kilometraje (la ubicación hablada se anexa aparte). Nada de precio/transmisión/color.
function infoAuto(a) {
    const p = ['Único dueño', 'factura de agencia'];
    if (a.km) p.push(`${a.km} km`);
    return p.join(', ');
}

// Zona (colonia) sacada del link de Maps del punto, best-effort. Si no se puede, null.
function zonaDeMaps(link) {
    if (!link) return null;
    try {
        const m = String(link).match(/\/place\/([^/@]+)/);
        if (!m) return null;
        const partes = decodeURIComponent(m[1].replace(/\+/g, ' ')).split(',').map(s => s.trim()).filter(Boolean);
        if (partes.length < 2) return null;
        let z = partes[1]
            .replace(/\b\d{4,5}\b/g, '')
            .replace(/\b\d+\s*(o|a|er)?\.?\s*Sector\b/gi, '')
            .replace(/\bSector\b/gi, '')
            .replace(/\s{2,}/g, ' ').replace(/[,.]+$/, '').trim();
        return z.length >= 3 ? z : null;
    } catch (e) { return null; }
}

// Línea de ubicación HABLADA (nunca pin). Null si el auto no tiene punto configurado.
async function lineaUbicacion(auto_id) {
    const r = await query("SELECT name, maps_link FROM punto_envio WHERE auto_id = ?", [Number(auto_id)]);
    if (!r.length || !r[0].name) return null;
    const zona = zonaDeMaps(r[0].maps_link);
    return zona ? `La tenemos en ${r[0].name}, por ${zona}` : `La tenemos en ${r[0].name}`;
}

// Arma la RÁFAGA (array de mensajes) según el input.
async function construir({ tipo, texto, nombre, auto_id }) {
    const nm = nombreReal(nombre);
    const a = await datosAuto(auto_id);
    if (!a) return null;
    // RÁFAGA DE MÁXIMO 5: (1) saludo, (2) presentación, (3) "claro déjame te mando la
    // info", (4) breve info + ubicación JUNTAS, (5) gancho.
    const inicio = [saludo(nm), 'Mucho gusto, mi nombre es Sebastián Romero, para servirte'];
    const ubic = await lineaUbicacion(auto_id);

    // INPUT 5 — pregunta pegada: SIN presentación. Saludo + resuelve SOLO eso + gancho (3).
    if (tipo.startsWith('preg_')) {
        const segs = [saludo(nm)];
        if (tipo === 'preg_precio') segs.push(a.precio ? `Claro que sí, el ${a.nombre} está en ${a.precio}` : `Claro que sí, con gusto te paso el precio del ${a.nombre}`);
        else if (tipo === 'preg_km') segs.push(a.km ? `Claro que sí, el ${a.nombre} tiene ${a.km} km` : `Claro que sí, con gusto te confirmo el kilometraje del ${a.nombre}`);
        else if (tipo === 'preg_cuenta') segs.push('Claro que sí, con gusto te lo tomamos a cuenta');
        else if (tipo === 'preg_buro') segs.push(BURO);
        else if (tipo === 'preg_color') segs.push(a.color ? `Claro que sí, el ${a.nombre} es ${a.color}` : `Claro que sí, con gusto te confirmo el color del ${a.nombre}`);
        else if (tipo === 'preg_ubic') segs.push(ubic || `Claro que sí, con gusto te paso la ubicación del ${a.nombre}`);
        segs.push(GANCHO);
        return segs;
    }

    // OBJECIÓN / DUDA → saludo + presentación + respuesta exacta (voz del owner) + gancho.
    if (tipo === 'transmision') {
        return [...inicio, a.transmision ? `Es ${a.transmision}` : 'Con gusto te confirmo la transmisión', GANCHO];
    }
    if (RESP_OBJ[tipo]) {
        return [...inicio, RESP_OBJ[tipo], GANCHO];
    }

    // COMBO — info + crédito en el mismo mensaje: disponibilidad + info + marco de crédito, en 5.
    if (tipo === 'info_credito') {
        const fin = /\b(buro|buró|historial)\b/.test(norm(texto))
            ? `El financiamiento queda así: ${FINANCIERA}, sujeto a aprobación bancaria`
            : `El financiamiento queda así: ${FINANCIERA}`;
        return [...inicio, `Claro, el ${a.nombre} sigue disponible. ${infoAuto(a)}`, fin, GANCHO];
    }

    // INPUT 4 — financiamiento: SIN km, SIN ubicación. (queda así + términos en UN mensaje)
    if (tipo === 'financiamiento') {
        const segs = [...inicio, `Claro que sí, el financiamiento del ${a.nombre} queda así: ${FINANCIERA}`];
        if (/\b(buro|buró|historial)\b/.test(norm(texto))) segs.push(BURO);
        segs.push(GANCHO);
        return segs;
    }

    // INPUT 3 — me interesa / disponible (caliente). Disponible + info + ubicación.
    if (tipo === 'interesa') {
        const info = ubic ? `${infoAuto(a)}. ${ubic}` : infoAuto(a);
        return [...inicio, `Claro que sí, el ${a.nombre} sigue disponible`, info, GANCHO];
    }

    // INPUT 1/2 — genérico "quiero más información / detalles" (5 mensajes).
    // msg4 = LA INFORMACIÓN: dueño + factura + km + ubicación hablada.
    const info = ubic ? `${infoAuto(a)}. ${ubic}` : infoAuto(a);
    return [...inicio, `Claro, déjame te mando la información del ${a.nombre}`, info, GANCHO];
}

// ENTRADA: ¿el banco maneja este opener? Devuelve la ráfaga, o null para que lo
// tome el loop normal (vendedor → escala; sin auto → pregunta cuál).
async function responder({ texto, nombre, auto_id, intencion }) {
    const tipo = tipoOpener(texto, intencion);
    if (tipo === 'vendedor') return null;     // → Ignacio / escala (lo decide el loop)
    if (!auto_id) return null;                 // sin auto resuelto → loop preguntará cuál
    let segmentos = await construir({ tipo, texto, nombre, auto_id });
    if (!segmentos || segmentos.length < 2) return null;
    // GARANTÍA DURA: máximo 5 mensajes en la ráfaga (conserva los primeros 4 + el gancho).
    if (segmentos.length > 5) segmentos = [...segmentos.slice(0, 4), segmentos[segmentos.length - 1]];
    return { tipo, segmentos };
}

module.exports = { responder, SENTINEL, tipoOpener, nombreReal, saludoHora, zonaDeMaps };
