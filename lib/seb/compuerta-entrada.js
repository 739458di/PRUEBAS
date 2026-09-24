'use strict';
/* COMPUERTA DE ENTRADA (orden owner 2026-09-24): en los universos de lote entran números de concesionarias y MUCHOS mensajes iniciales
 * no son para comprar un auto (informes, servicio, proveedores, saludos). Seb SOLO actúa dentro de su universo de venta:
 *   · si el PRIMER contacto no detona el flujo de venta → no contesta, no escala, no avisa. El chat queda en el WhatsApp general
 *     y la persona correspondiente le da su flujo.
 *   · detona = liga de anuncio, un auto del catálogo del lote nombrado, o intención clara de compra.
 * Determinista (regex + catálogo), cero IA. Se evalúa solo mientras nadie (ni Seb ni vendedor) le ha contestado. */
const { query } = require('./db.js');

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9$ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const GENERICOS = new Set(['auto', 'autos', 'carro', 'coche', 'camioneta', 'pickup', 'pick', 'sedan', 'suv', 'sport', 'line', 'plus', 'gt', 'ls', 'lt', 'xl', 'se', 'sl', 'sr', 'lx', 'ex', 'gl', 'premium', 'advance', 'sense', 'exclusive', 'limited', 'touring', 'edition', 'turbo', 'aut', 'std', 'the']);
const RE_LINK = /(fb\.me|facebook\.com|instagram\.com|fyradrive\.com\/car|wa\.me|marketplace)/i;
const RE_COMPRA = /\b(comprar|compro|compra|busco|buscando|interesa|interesad[oa]|precio|precios|cuanto (cuesta|sale|vale|esta)|cotiza|cotizar|cotizacion|disponible|disponibles|financiamiento|financiar|credito|enganche|mensualidad|mensualidades|apartar|apartado|seminuevo|seminuevos|kilometraje|kilometros|km|modelo|anio|cuanto piden)\b/;
const RE_VENDER = /\b(vendo|vender|venta de mi|quiero vender|compran autos|reciben autos|a cuenta)\b/;

/** ¿El texto detona el flujo de venta? autos = catálogo del universo [{marca, modelo}]. */
function detonaVenta(texto, autos) {
    const t = norm(texto); if (!t) return { detona: false, motivo: 'vacio' };
    if (RE_LINK.test(String(texto || ''))) return { detona: true, motivo: 'liga_anuncio' };
    const palabras = new Set(t.split(' '));
    for (const a of autos || []) {
        const toks = [norm(a.marca)].concat(norm(a.modelo).split(' ')).filter(w => w.length >= 3 && !GENERICOS.has(w));
        const hit = toks.find(w => palabras.has(w) || (w.length >= 5 && t.includes(w)));
        if (hit) return { detona: true, motivo: 'auto_catalogo:' + hit };
    }
    if (RE_VENDER.test(t)) return { detona: false, motivo: 'quiere_vender' };
    if (RE_COMPRA.test(t)) return { detona: true, motivo: 'intencion_compra' };
    return { detona: false, motivo: 'fuera_flujo' };
}
/** ¿Nadie le ha contestado todavía (ni Seb ni un vendedor)? Las notas de sistema no cuentan. */
async function primerContacto(chatId) {
    const r = (await query("SELECT COUNT(*) n FROM mensajes WHERE conversacion_id = ? AND direccion = 'out' AND COALESCE(emisor,'') <> 'sistema'", [Number(chatId)]))[0];
    return !Number(r && r.n);
}
/** Todo lo que ha escrito el comprador en el chat (para juzgar el primer contacto completo, no solo la última burbuja). */
async function textoEntrante(chatId) {
    const rows = await query("SELECT texto FROM mensajes WHERE conversacion_id = ? AND direccion = 'in' ORDER BY id ASC LIMIT 12", [Number(chatId)]);
    return rows.map(r => r.texto || '').join(' \n ');
}
/** Puerta única: { pasa:true } → Seb corre; { pasa:false, motivo } → silencio total. Solo universos ≠ 0 y solo en primer contacto. */
async function evaluar({ tenant, chat, autos }) {
    if (!tenant || Number(tenant.id) === 0) return { pasa: true, motivo: 'universo_0' };
    if (!(await primerContacto(chat.id))) return { pasa: true, motivo: 'ya_en_flujo' };
    const d = detonaVenta(await textoEntrante(chat.id), autos || []);
    return d.detona ? { pasa: true, motivo: d.motivo } : { pasa: false, motivo: d.motivo };
}
module.exports = { detonaVenta, primerContacto, evaluar, NOTA: 'ℹ️ Mensaje inicial fuera del flujo de venta: Seb no interviene. Lo atiende el WhatsApp general.' };
