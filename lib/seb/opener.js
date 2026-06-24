// lib/seb/opener.js
// EL BANCO DE FRASES DEL MENSAJE INICIAL — la ÚNICA fuente de verdad para el
// PRIMER contacto (cuando Seb aún no ha respondido en la conversación).
//
// Fuente: /Users/Shared/seb-agente/BANCO_FRASES_POR_OPENER.md (362 conversaciones
// reales de Sebastián). Para el opener NO se usa el loop de IA: se arma una
// SECUENCIA de mensajes cortos EXACTOS del banco, que FyraChat parte para que
// Sebastián pique "enviar, enviar, enviar" en orden (como manda él de verdad).
//
// Las cifras del auto ([FICHA]/[PRECIO]) salen de info_auto (datos REALES del
// inventario) — cero invento. Solo se afirman campos que existen en la BD.
//
// Familias que maneja el banco directo: generico, disponible, interesa, contado,
// permuta. UBICACIÓN y CRÉDITO NO: esos usan el loop con herramientas (el pin del
// punto se manda solo; la cotización la arma el cotizador). Ahí devolvemos null.

const { info_auto } = require('./herramientas.js');

// Separador de mensajes de una secuencia. NO viaja a WhatsApp: el front lo usa
// para partir el borrador en mensajes individuales y enviarlos uno por uno.
const SENTINEL = '||SEQ||';

const cap = s => { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Saludo por la HORA real de Monterrey (UTC-6) — su voz lleva la hora del día.
function saludoHora() {
    const h = new Date(Date.now() - 6 * 3600000).getUTCHours();
    if (h < 12) return 'buen día';
    if (h < 19) return 'buenas tardes';
    return 'buenas noches';
}

// ¿El nombre del perfil de WhatsApp es un NOMBRE de verdad? Si no, MEJOR SILENCIO
// (regla del banco). Devuelve el primer nombre capitalizado, o null.
function nombreReal(nombre) {
    const n = String(nombre || '').trim();
    if (!n || n === '.') return null;
    if (/^\+?[\d\s().-]+$/.test(n)) return null;        // es un teléfono
    const primero = n.split(/\s+/)[0];
    if (primero.length < 2 || /\d/.test(primero)) return null;
    return primero.charAt(0).toUpperCase() + primero.slice(1).toLowerCase();
}

// Clasifica el opener en una familia. Determinístico por palabras clave (cero
// tokens); usa la intención de Haiku como respaldo.
function tipoOpener(texto, intencion) {
    const t = norm(texto);
    if (/\b(donde|ubicacion|ubicado|en que parte|como llego|direccion|se ve|lo veo)\b/.test(t)) return 'ubicacion';
    if (/\b(credito|enganche|engache|financ|mensualidad|a meses|quincenal|buro|cotiza)\b/.test(t)) return 'credito';
    if (/\b(a cuenta|a cambio|cambio mi|tomas mi|toman mi|reciben|doy mi|entrego mi)\b/.test(t)) return 'permuta';
    if (/\b(contado|de contado|en efectivo|lo menos|ultimo precio|menos precio|rebaja|descuento|negociable)\b/.test(t)) return 'contado';
    if (/\b(me interesa|interesado|interesada)\b/.test(t)) return 'interesa';
    if (/(sigue disponible|aun disponible|aún disponible|esta disponible|está disponible|todavia.*disponible|disponible\?)/.test(t)) return 'disponible';
    // respaldo por intención de Haiku
    if (intencion === 'cita_ubicacion') return 'ubicacion';
    if (intencion === 'cotizar_credito') return 'credito';
    if (intencion === 'precio_negociacion') return 'contado';
    if (intencion === 'disponibilidad') return 'disponible';
    return 'generico';
}

// Familias que el banco contesta directo (secuencia exacta).
const FAMILIAS_BANCO = new Set(['generico', 'disponible', 'interesa', 'contado', 'permuta']);

// Ficha = SOLO datos reales del inventario (info_auto). Nunca "único dueño/factura"
// si no está en la BD.
function fichaDe(info, { corta } = {}) {
    if (!info || !info.ok) return null;
    const d = info.datos || {}, p = info.placeholders || {};
    const det = [];
    if (p.precio) det.push(p.precio);
    if (p.kilometraje) det.push(p.kilometraje);
    if (d.transmision) det.push(cap(d.transmision));
    if (!corta && d.color) det.push(cap(d.color));
    return p.auto_nombre + (det.length ? '\n' + det.join(' · ') : '');
}

// Arma la SECUENCIA de mensajes (array de strings) para una familia.
async function construir({ tipo, nombre, auto_id }) {
    const sal = saludoHora();
    const nm = nombreReal(nombre);
    const hola = `Qué tal${nm ? ' ' + nm : ''}, ${sal}!`;
    const presenta = 'Mucho gusto, Sebastián Romero, para servirte';

    let info = null;
    if (auto_id) { try { info = await info_auto({ auto_id }); } catch (e) { info = null; } }
    const ficha = fichaDe(info, { corta: tipo === 'interesa' });

    const segs = [];
    if (tipo === 'contado') {
        segs.push(hola, presenta);
        if (ficha) segs.push(ficha);
        segs.push('Vente a verlo y manejarlo, y si te gusta lo negociamos en persona 👍');
        segs.push('¿Qué día te queda mejor para verlo?');
        return segs;
    }
    if (tipo === 'permuta') {
        segs.push(hola, presenta);
        if (ficha) segs.push(ficha);
        segs.push('Sí, recibimos tu auto a cuenta 👍');
        segs.push('La valuación es en sitio: tráelo a la cita y ahí te doy el número exacto');
        segs.push('¿Qué día te queda para verlo?');
        return segs;
    }
    if (tipo === 'disponible') {
        segs.push(hola);
        segs.push('Sí, aún sigue disponible 👍');
        if (ficha) segs.push(ficha);
        segs.push('¿Gustas que te agende para verlo y manejarlo?');
        return segs;
    }
    if (tipo === 'interesa') {
        segs.push(hola);
        segs.push('Aún disponible 🙌');
        if (ficha) segs.push(ficha);
        segs.push('¿Gustas venir a verlo y manejarlo? ¿Te queda mejor mañana o por la tarde? Para agendarte de una vez');
        return segs;
    }
    // generico (el de mayor volumen)
    segs.push(hola);
    segs.push(presenta);
    segs.push('Claro que sí, aún sigue disponible 👇');
    if (ficha) segs.push(ficha);
    segs.push('¿Gustas venir a verlo y manejarlo? Para coordinarte una cita 👍');
    return segs;
}

// ENTRADA: ¿esta apertura la maneja el banco? Si sí, devuelve la secuencia.
// Devuelve null cuando NO aplica (familia de herramientas, o sin auto resuelto →
// que lo maneje el loop normal, que sabe pedir de cuál auto se trata).
async function responder({ texto, nombre, auto_id, intencion }) {
    const tipo = tipoOpener(texto, intencion);
    if (!FAMILIAS_BANCO.has(tipo)) return null;     // ubicacion/credito → loop con herramientas
    if (!auto_id) return null;                       // sin auto → loop normal (preguntará cuál)
    const segmentos = await construir({ tipo, nombre, auto_id });
    if (!segmentos || segmentos.length < 2) return null;
    return { tipo, segmentos };
}

module.exports = { responder, SENTINEL, tipoOpener, nombreReal, saludoHora };
