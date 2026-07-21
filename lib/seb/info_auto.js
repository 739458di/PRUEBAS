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
    // CLAIMS FIJOS del negocio (verdad de flota, aprobados por el owner):
    // servicios ANTES que adeudos ("al corriente de servicios" no debe leerse como adeudos).
    if (/(servicio|mantenimiento|carnet|agencia sus servici|al (dia|corriente) (con|en|de|los)? ?servici|historial de servici|le han dado servici)/.test(t)) return 'servicios';
    if (/(adeudo|adeud|gravamen|tenencia|multas|debe algo|deber|al corriente|libre de|refrend)/.test(t)) return 'adeudos';
    if (/(choque|chocad|golpe|golpead|volcad|siniestr|accidente|estrellad|reparad)/.test(t)) return 'choques';
    if (/(clima|aire acondicionado|\ba\/?c\b|enfria|enfría|(el )?aire (frio|sirve|funciona|enfria)|(sirve|funciona|enfria) el (aire|clima)|sirve el clima)/.test(t)) return 'clima';
    if (/papeleria|tipo de factura|que factura|\bfactura\b|documentos en regla|en regla|papeles en regla|esta legal|todo legal/.test(t)) return 'papeleria';
    if (/(que |algun )?detalle|como esta (el|la|ese|esa)|en que estado|tiene algun|condiciones|esta bien (el|la|ese)|esta en buen|le falta algo|funciona bien|mas informacion|mas info|cuentame mas|dame (mas )?info|que mas me (puedes|dices|cuentas)|mas datos|toda la (info|informacion)/.test(t)) return 'detalles';
    if (/transmision|es estandar|es automatic|caja (manual|automatic)|estandar o automatic/.test(t)) return 'transmision';
    return null;
}

// Arma la ACCIÓN (línea pelona) con datos reales. accion=null → escala (no tenemos el dato).
async function infoAccion(texto, auto_id) {
    const sub = subInfo(texto);
    if (!sub || !auto_id) return null;
    const t = norm(texto);
    const r = await query("SELECT marca, modelo, anio, kilometraje, color, transmision FROM inventario_autos WHERE id=?", [Number(auto_id)]);
    if (!r.length) return null;
    const a = r[0];
    const km = a.kilometraje != null ? Number(a.kilometraje).toLocaleString('es-MX') : null;
    const color = (a.color && !COLOR_SUCIO.test(String(a.color).trim())) ? cap(a.color) : null;
    const trans = a.transmision ? String(a.transmision).toLowerCase() : null;
    // ═══ ESPEJO DEL VERBO + POLARIDAD: el dato se dice con el MISMO verbo (y el Sí/No que
    //     corresponde) que usó la pregunta, para que la respuesta embone naturalmente.
    //     "¿cuántos dueños HA TENIDO?" → "HA TENIDO un solo dueño" · "¿TIENE adeudos?" → "NO TIENE adeudos".
    const duenoFrase = /(ha tenido|ha sido|han sido|tuvo|tenido)/.test(t) ? 'Ha tenido un solo dueño'
        : /cuantos? (dueñ|duen)[^?]*(tiene|trae)/.test(t) ? 'Tiene un solo dueño'
        : 'Es de único dueño';
    const kmVerbo = /(trae|recorrid|caminad)/.test(t) ? 'Trae' : 'Tiene';
    // Adeudos (verdad = NO debe): espeja tiene/debe/está.
    const adeudos = /(ha tenido|tuvo)[^?]*adeud|adeudos? ha tenido/.test(t) ? 'No ha tenido adeudos, está al corriente de todo'
        : /(debe|deber|adeuda)/.test(t) ? 'No debe nada, está al corriente de todo'
        : /tiene[^?]*(adeud|gravamen|multa|tenencia)/.test(t) ? 'No tiene adeudos, está libre de gravámenes y al corriente'
        : 'Está libre de adeudos, sin gravámenes y al corriente de todo';
    // Choques (verdad = NO): espeja ha chocado/tiene/está.
    const choques = /(ha (chocad|tenido)|tuvo)/.test(t) ? 'No ha chocado, cero percances'
        : /(esta|estuvo) (chocad|golpead|reparad|siniestrad)/.test(t) ? 'No, está impecable, cero choques'
        : /tiene[^?]*(choque|golpe|detalle|percance)/.test(t) ? 'No tiene choques ni detalles, está impecable'
        : 'Cero choques, nunca ha tenido percance';
    // Clima (verdad = Sí): espeja enfría/sirve/funciona.
    const clima = /(enfria|enfría)/.test(t) ? 'Sí, el clima enfría perfecto'
        : /(sirve|funciona)/.test(t) ? 'Sí, el clima sirve perfecto'
        : 'El clima enfría perfecto';
    // Servicios: espeja tiene/está.
    const servicios = /(esta|estan)[^?]*(al (dia|corriente)|servici)/.test(t) ? 'Sí, está al día con sus servicios en agencia y tenemos el carnet de mantenimientos'
        : 'Tiene todos sus servicios en agencia y contamos con el carnet de mantenimientos';
    switch (sub) {
        case 'duenos':      return { sub, accion: duenoFrase };
        case 'km':          return { sub, accion: km ? `${kmVerbo} ${km} km` : 'Con gusto te confirmo el kilometraje exacto' };
        case 'color':       return { sub, accion: color ? `Es ${color}` : 'Con gusto te confirmo el color' };
        case 'transmision': return { sub, accion: trans ? `Es ${trans}` : null };       // sin dato → escala
        case 'motor':       return { sub, accion: null };                                // no tenemos motor → escala
        case 'papeleria':   return { sub, accion: /que factura|tipo de factura/.test(t) ? 'Tiene factura de agencia, toda la papelería en regla' : 'Sí, tiene factura de agencia y toda la papelería en regla, todo en orden' };
        case 'adeudos':     return { sub, accion: adeudos };
        case 'choques':     return { sub, accion: choques };
        case 'servicios':   return { sub, accion: servicios };
        case 'clima':       return { sub, accion: clima };
        case 'detalles':    return { sub, accion: 'Está en excelentes condiciones, único dueño, cero choques, servicios en agencia con carnet, factura de agencia y papelería en regla, y puedes traer tu mecánico a revisarlo' };
    }
    return null;
}

module.exports = { subInfo, infoAccion };
