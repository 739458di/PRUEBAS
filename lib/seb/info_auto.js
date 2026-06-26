// lib/seb/info_auto.js
// ÁREA: INFORMACIÓN DEL AUTO (como objeto). Sub-áreas: dueños, km, color, transmisión,
// papelería/factura, detalles, motor. Se contesta con datos REALES del inventario + claims
// fijos, EN LA VOZ DEL OWNER. Lo que no tenemos (motor, transmisión sin dato) → accion=null
// = ESCALA. Lo usan el opener (ritual opener) y la continuación (ritual continuación).
//
// Devuelve { sub, accion } (accion = la línea PELONA, sin maquillada ni gancho) o null si el
// texto NO es información-del-auto.

const { query } = require('./db.js');
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const cap = s => { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
const COLOR_SUCIO = /^(no especificad[oa]|n\/a|na|sin especificar|por confirmar|-+)$/i;

// ¿A qué sub-área de "información del auto" pertenece? null = no es info-del-auto.
function subInfo(texto) {
    const t = norm(texto);
    if (/(cuantos? )?(dueñ|duen)|propietari|un solo dueño|unico dueño/.test(t)) return 'duenos';
    if (/kilometraje|cuantos? km|\bkms?\b|kilometros|kilómetros|caminado|recorrido|que tan caminad/.test(t)) return 'km';
    if (/de que color|que color|\bcolor\b/.test(t)) return 'color';
    if (/que motor|cilindr|\blitros\b|\bturbo\b|caballos|\bhp\b|\bcc\b|\bmotor\b|que tan potente/.test(t)) return 'motor';
    if (/papeleria|tipo de factura|que factura|\bfactura\b|documentos en regla|en regla|papeles en regla|esta legal|todo legal/.test(t)) return 'papeleria';
    if (/(que |algun )?detalle|como esta (el|la|ese|esa)|en que estado|tiene algun|condiciones|chocad|\bgolpe|esta bien (el|la|ese)|esta en buen|le falta algo|funciona bien/.test(t)) return 'detalles';
    if (/transmision|es estandar|es automatic|caja (manual|automatic)|estandar o automatic/.test(t)) return 'transmision';
    return null;
}

// Arma la ACCIÓN (línea pelona) con datos reales. accion=null → escala (no tenemos el dato).
async function infoAccion(texto, auto_id) {
    const sub = subInfo(texto);
    if (!sub || !auto_id) return null;
    const r = await query("SELECT marca, modelo, anio, kilometraje, color, transmision FROM inventario_autos WHERE id=?", [Number(auto_id)]);
    if (!r.length) return null;
    const a = r[0];
    const km = a.kilometraje != null ? Number(a.kilometraje).toLocaleString('es-MX') : null;
    const color = (a.color && !COLOR_SUCIO.test(String(a.color).trim())) ? cap(a.color) : null;
    const trans = a.transmision ? String(a.transmision).toLowerCase() : null;
    switch (sub) {
        case 'duenos':      return { sub, accion: 'Es de único dueño' };
        case 'km':          return { sub, accion: km ? `Tiene ${km} km` : 'Con gusto te confirmo el kilometraje exacto' };
        case 'color':       return { sub, accion: color ? `Es ${color}` : 'Con gusto te confirmo el color' };
        case 'transmision': return { sub, accion: trans ? `Es ${trans}` : null };       // sin dato → escala
        case 'motor':       return { sub, accion: null };                                // no tenemos motor → escala
        case 'papeleria':   return { sub, accion: 'Tiene factura de agencia y toda la papelería en regla, todo en orden' };
        case 'detalles':    return { sub, accion: 'Está en excelentes condiciones, único dueño, factura de agencia y papelería en regla, y puedes traer tu mecánico a revisarlo' };
    }
    return null;
}

module.exports = { subInfo, infoAccion };
