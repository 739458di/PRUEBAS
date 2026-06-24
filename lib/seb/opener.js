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

// Separador de mensajes de una ráfaga. NO viaja a WhatsApp: el front lo usa para
// partir el borrador en mensajes individuales.
const SENTINEL = '||SEQ||';

// Bloques FIJOS del playbook (verbatim).
const GANCHO = 'Gustas venir a verlo y manejarlo?';
const FINANCIERA = 'Enganche desde 30%, hasta 60 meses con HEY Banco';
const BURO = 'Sí, es sujeto a aprobación bancaria';

const cap = s => { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Saludo por la HORA real de Monterrey (UTC-6). Sobrio, sin "!".
function saludoHora() {
    const h = new Date(Date.now() - 6 * 3600000).getUTCHours();
    if (h < 12) return 'buen día';
    if (h < 19) return 'buenas tardes';
    return 'buenas noches';
}

// Nombre real del perfil (si no es un nombre de verdad → silencio). 1er nombre.
function nombreReal(nombre) {
    const n = String(nombre || '').trim();
    if (!n || n === '.') return null;
    if (/^\+?[\d\s().-]+$/.test(n)) return null;          // es un teléfono
    const primero = n.split(/\s+/)[0];
    if (primero.length < 2 || /\d/.test(primero)) return null;
    return primero.charAt(0).toUpperCase() + primero.slice(1).toLowerCase();
}

// "Qué tal Omar buenas tardes" / "Qué tal buen día" — sin coma, sin "!".
function saludo(nm) { return `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}`; }

// Clasifica el primer mensaje en uno de los INPUTS del playbook.
function tipoOpener(texto, intencion) {
    const t = norm(texto);
    // DESVÍO: quiere VENDER su auto → no es comprador (lo atiende Ignacio).
    if (/\b(vender mi|vendo mi|quiero vender|me interesa vender|consignar|remato mi)\b/.test(t)) return 'vendedor';
    // INPUT 4 — financiamiento (proceso/crédito/enganche/mensualidad). Prefijos
    // (sin \b de cierre) para cazar "financiamiento", "financiado", "enganches", etc.
    if (/\b(financ|credit|engan|engach|mensualidad|a meses|a cuantos meses|pagos mensuales)/.test(t)) return 'financiamiento';
    // INPUT 5 — pregunta pegada (dato específico): se resuelve SOLO esa.
    if (/\b(a cuenta|a cambio|tomas mi|toman mi|cambio mi|recib)\b/.test(t)) return 'preg_cuenta';
    if (/\b(buro|buró|historial crediticio)\b/.test(t)) return 'preg_buro';
    if (/\b(precio|cuesta|cuanto vale|cuánto vale|en cuanto|en cuánto|valor)\b/.test(t)) return 'preg_precio';
    if (/\b(km|kms|kilometraje|kilometros|kilómetros|caminado|recorrido)\b/.test(t)) return 'preg_km';
    if (/\b(color|de que color|de qué color)\b/.test(t)) return 'preg_color';
    if (/\b(donde|dónde|ubicacion|ubicación|ubicado|en que parte|en qué parte|como llego|cómo llego)\b/.test(t)) return 'preg_ubic';
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
        "SELECT marca, modelo, anio, precio, kilometraje, color, estado, vendido_externo, vendido_fyradrive FROM inventario_autos WHERE id = ?",
        [Number(auto_id)]);
    if (!r.length) return null;
    const a = r[0];
    return {
        nombre: [a.marca, a.modelo, a.anio].filter(Boolean).join(' '),    // [Auto] = modelo + año
        precio: a.precio != null ? '$' + Number(a.precio).toLocaleString('es-MX') : null,
        km: a.kilometraje != null ? Number(a.kilometraje).toLocaleString('es-MX') : null,
        color: a.color ? cap(a.color) : null
    };
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
    const inicio = [saludo(nm), 'Cómo estás', 'Mucho gusto, mi nombre es Sebastián Romero, para servirte'];
    const ubic = await lineaUbicacion(auto_id);

    // INPUT 5 — pregunta pegada: SIN presentación. Saludo corto + resuelve SOLO eso + gancho.
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

    // INPUT 4 — financiamiento: SIN km, SIN ubicación.
    if (tipo === 'financiamiento') {
        const segs = [...inicio, `Claro que sí, el financiamiento del ${a.nombre} queda así:`, FINANCIERA];
        if (/\b(buro|buró|historial)\b/.test(norm(texto))) segs.push(BURO);
        segs.push(GANCHO);
        return segs;
    }

    // INPUT 3 — me interesa / disponible (caliente).
    if (tipo === 'interesa') {
        const segs = [...inicio, `Claro que sí, el ${a.nombre} sigue disponible`];
        if (ubic) segs.push(ubic);
        segs.push(GANCHO);
        return segs;
    }

    // INPUT 1/2 — genérico "quiero más información / detalles".
    const segs = [...inicio, `Claro, déjame te mando la información del ${a.nombre}`, 'Sigue disponible'];
    if (ubic) segs.push(ubic);
    segs.push(GANCHO);
    return segs;
}

// ENTRADA: ¿el banco maneja este opener? Devuelve la ráfaga, o null para que lo
// tome el loop normal (vendedor → escala; sin auto → pregunta cuál).
async function responder({ texto, nombre, auto_id, intencion }) {
    const tipo = tipoOpener(texto, intencion);
    if (tipo === 'vendedor') return null;     // → Ignacio / escala (lo decide el loop)
    if (!auto_id) return null;                 // sin auto resuelto → loop preguntará cuál
    const segmentos = await construir({ tipo, texto, nombre, auto_id });
    if (!segmentos || segmentos.length < 2) return null;
    return { tipo, segmentos };
}

module.exports = { responder, SENTINEL, tipoOpener, nombreReal, saludoHora, zonaDeMaps };
