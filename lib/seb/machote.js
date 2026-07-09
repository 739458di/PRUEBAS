// lib/seb/machote.js
// EL MACHOTE (🚩611): la descripción COMPLETA del auto — el mismo "Texto para
// Instagram" del Sales Brain (lib/instagram-text.js) — para cuando el comprador
// pide "más información": se le manda el copy-paste y luego se gancha.
// Diferencias vs el de publicación: SIN la línea "Informes y citas" (ya está
// hablando con nosotros) y el bloque FINANCIAMIENTO sale de reglasFin(año)
// (nada de "desde 30% con HEY" fijo — la Tacoma 2014 es 45% Renueva Car).

const { query } = require('./db.js');
const { reglasFin } = require('./herramientas.js');

const MARCAS_LUJO = ['mercedes', 'bmw', 'audi', 'porsche', 'maserati', 'tesla', 'volvo', 'lincoln', 'cadillac', 'lexus', 'infiniti', 'land rover', 'jaguar', 'acura'];
const MARCAS_DEPORTIVO = ['porsche', 'mustang', 'charger', 'challenger', 'camaro', 'corvette'];
const TIPOS_FAMILIAR = ['suv', 'camioneta', 'wagon', 'pickup'];

function detectarTono(a) {
    const marca = String(a.marca || '').toLowerCase();
    const modelo = String(a.modelo || '').toLowerCase();
    const tipo = String(a.tipo_carroceria || '').toLowerCase();
    if (a.precio > 800000 || MARCAS_LUJO.some(m => marca.includes(m))) return 'lujo';
    if (MARCAS_DEPORTIVO.some(m => marca.includes(m) || modelo.includes(m))) return 'deportivo';
    if (TIPOS_FAMILIAR.some(x => tipo.includes(x)) || modelo.includes('odyssey') || modelo.includes('sienna') || modelo.includes('suburban') || modelo.includes('tahoe') || modelo.includes('tacoma')) return 'familiar';
    if (a.precio < 200000) return 'economico';
    return 'general';
}
function fraseCierre(tono, marca, modelo) {
    switch (tono) {
        case 'lujo': return `Elegancia y sofisticacion en cada detalle. ${marca} ${modelo}: para quienes exigen lo mejor.`;
        case 'deportivo': return `Potencia y estilo que se sienten al volante. ${marca} ${modelo}: manejo que emociona.`;
        case 'familiar': return `Espacio, comodidad y seguridad para toda la familia. ${marca} ${modelo}: tu companero ideal.`;
        case 'economico': return `Rendimiento y economia para tu dia a dia. ${marca} ${modelo}: la mejor inversion.`;
        default: return `Calidad y confianza garantizada. ${marca} ${modelo}: tu proximo vehiculo te espera.`;
    }
}
function bulletsExtra(tono, a) {
    const e = [];
    switch (tono) {
        case 'lujo': e.push('Acabados premium', 'Tecnologia de punta', 'Confort de primer nivel'); if (a.motor) e.push(`Motor ${a.motor}`); break;
        case 'deportivo': e.push('Rendimiento excepcional', 'Diseno aerodinamico', 'Suspension deportiva'); break;
        case 'familiar': e.push('Amplio espacio interior', 'Seguridad para toda la familia', 'Gran capacidad de carga'); break;
        case 'economico': e.push('Excelente rendimiento de combustible', 'Bajo costo de mantenimiento', 'Ideal para ciudad'); break;
        default: e.push('Excelente estado general', 'Mantenimiento al dia', 'Listo para entregar');
    }
    return e.slice(0, 4);
}
const fmtPrecio = p => '$' + Number(p || 0).toLocaleString('es-MX');
const fmtKm = k => Number(k || 0).toLocaleString('es-MX');
function fmtDuenos(d) {
    if (!d) return 'Unico dueno';
    const s = String(d);
    if (s.includes('unico') || s === '1') return 'Unico dueno';
    if (s.includes('dos') || s === '2') return 'Segundo dueno';
    if (s.includes('tres') || s === '3') return 'Tercer dueno';
    return s;
}
function fmtFactura(f) {
    if (!f) return 'Factura original';
    const s = String(f).toLowerCase();
    if (s.includes('original') || s.includes('agencia')) return 'Factura de agencia';
    if (s.includes('banco') || s.includes('bbva') || s.includes('financ')) return 'Factura de banco';
    if (s.includes('refactur') || s.includes('endos')) return 'Refacturado';
    if (s.includes('carta')) return 'Carta factura';
    return f;
}

function generarMachote(a) {
    const tono = detectarTono(a);
    const titulo = `${a.marca || ''} ${a.modelo || ''} ${a.anio || ''}`.toUpperCase();
    const precio = fmtPrecio(a.precio);
    const km = a.kilometraje ? fmtKm(a.kilometraje) : 'Consultar';
    const color = a.color || 'Consultar';
    const transmision = a.transmision ? (String(a.transmision).charAt(0).toUpperCase() + String(a.transmision).slice(1)) : 'Automatica';
    const duenos = fmtDuenos(a.numero_duenos);
    const factura = fmtFactura(a.factura_original || a.info_documentos_legales);
    const extras = bulletsExtra(tono, a);
    const cierre = fraseCierre(tono, a.marca, a.modelo);
    const rf = reglasFin(a.anio);   // el bloque de financiamiento con las reglas REALES del año

    let texto = `fyradrive \u{1F698} ${titulo}
\u{1F4B5} ${precio}
✅ TODOS NUESTROS VEHÍCULOS SE MANDAN A INSPECCIÓN MECÁNICA Y LEGAL

CARACTERÍSTICAS
\u{1F535} ${km} km
\u{1F535} Año ${a.anio}
\u{1F535} Color ${color}
\u{1F535} Motor ${a.motor || 'gasolina'}
\u{1F535} Transmisión ${transmision}
\u{1F535} Dirección hidráulica
\u{1F535} ${duenos}
`;
    for (const ex of extras) texto += `\u{1F535} ${ex}\n`;
    texto += `
\u{1F4AF} ${cierre}

ESTADO
✅ Sin adeudos
✅ ${factura}

FINANCIAMIENTO
✅ Enganche desde ${rf.minPct}%
✅ Hasta ${rf.plazoMax} meses
✅ Tasas competitivas
✅ Entrega inmediata`;
    return texto;
}

// machoteDe(auto_id de inventario) → el machote con la ficha REAL (web si existe,
// si no con lo del inventario). Precio SIEMPRE el del Sales Brain (el vigente).
async function machoteDe(auto_id) {
    if (!auto_id) return null;
    const inv = await query("SELECT marca, modelo, anio, precio, kilometraje, color, transmision, fyradrive_web_id FROM inventario_autos WHERE id=?", [Number(auto_id)]);
    if (!inv.length) return null;
    const i = inv[0];
    let a = { marca: i.marca, modelo: i.modelo, anio: i.anio, precio: i.precio, kilometraje: i.kilometraje, color: i.color, transmision: i.transmision };
    if (i.fyradrive_web_id) {
        const w = await query('SELECT marca, modelo, "año" AS anio, kilometraje, color, motor, transmision, tipo_carroceria, numero_duenos, factura_original, info_documentos_legales FROM autos WHERE id=?', [Number(i.fyradrive_web_id)]).catch(() => []);
        if (w.length) a = { ...w[0], marca: w[0].marca || i.marca, modelo: w[0].modelo || i.modelo, anio: w[0].anio || i.anio, precio: i.precio };
    }
    if (!a.precio || !a.anio) return null;   // sin precio/año no hay machote honesto
    return generarMachote(a);
}

module.exports = { machoteDe, generarMachote };
