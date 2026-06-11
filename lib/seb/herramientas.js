// lib/seb/herramientas.js
// Herramientas determinísticas de Seb. EL CONTRATO DE HUECOS:
//
//   Cada tool devuelve { ok, datos, placeholders }.
//   - datos: lo que el modelo LEE para razonar (puede verlo).
//   - placeholders: mapa plano clave → string YA FORMATEADO, listo para
//     insertarse en el borrador. Sonnet escribe {{precio}} y el código
//     (validador.js) lo rellena. LA IA NUNCA TECLEA UNA CIFRA.
//
// Reglas:
//   - Solo SELECT a Turso (la única excepción futura será crear_cita, Paso 4).
//   - Si el dato no existe, se dice (ok:false / campos null) — nunca se inventa.

const { query } = require('./db.js');

const fmtMXN = (n) => '$' + Number(n || 0).toLocaleString('es-MX');
const fmtKM = (n) => Number(n || 0).toLocaleString('es-MX') + ' km';

// ======================================================================
// autos_activos() — el menú del inventario (para el clasificador y Seb)
// ======================================================================
async function autos_activos() {
    const rows = await query(
        `SELECT id, marca, modelo, version, anio, precio, codigo_corto
         FROM inventario_autos WHERE estado = 'activo'
         ORDER BY marca, modelo`
    );
    return {
        ok: true,
        datos: rows.map(a => ({
            id: a.id,
            nombre: [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' '),
            precio: a.precio,
            codigo_corto: a.codigo_corto || null
        })),
        placeholders: {}
    };
}

// ======================================================================
// info_auto(auto_id) — la ficha viva del auto
// ======================================================================
async function info_auto({ auto_id }) {
    const rows = await query(
        `SELECT id, marca, modelo, version, anio, precio, kilometraje,
                transmision, color, tipo_carroceria, estado,
                vendido_externo, vendido_fyradrive
         FROM inventario_autos WHERE id = ?`,
        [Number(auto_id)]
    );
    if (rows.length === 0) return { ok: false, error: 'auto_no_existe', datos: null, placeholders: {} };
    const a = rows[0];

    // Auto vendido o inactivo: la tool lo DICE — Seb debe pivotar, no fingir.
    const disponible = a.estado === 'activo' && !a.vendido_externo && !a.vendido_fyradrive;

    const nombre = [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' ');
    return {
        ok: true,
        datos: {
            id: a.id,
            nombre,
            disponible,
            marca: a.marca, modelo: a.modelo, anio: a.anio,
            transmision: a.transmision || null,
            color: a.color || null,
            carroceria: a.tipo_carroceria || null
        },
        placeholders: {
            auto_nombre: nombre,
            precio: fmtMXN(a.precio),
            kilometraje: a.kilometraje != null ? fmtKM(a.kilometraje) : null,
            anio: String(a.anio || '')
        }
    };
}

// ======================================================================
// ubicacion(auto_id) — punto de venta + link de Maps
// ======================================================================
async function ubicacion({ auto_id }) {
    const rows = await query(
        'SELECT puntos_venta FROM inventario_autos WHERE id = ?',
        [Number(auto_id)]
    );
    if (rows.length === 0) return { ok: false, error: 'auto_no_existe', datos: null, placeholders: {} };

    let puntos = [];
    try { puntos = JSON.parse(rows[0].puntos_venta || '[]'); } catch (e) { puntos = []; }
    if (!Array.isArray(puntos) || puntos.length === 0) {
        // Sin punto asignado: NO se inventa. Seb responde con contención
        // ("te confirmo el punto en un momento") y escala.
        return { ok: false, error: 'sin_punto_asignado', datos: null, placeholders: {} };
    }
    const p = puntos[0];
    const maps = (p.lat != null && p.lng != null)
        ? `https://maps.google.com/?q=${p.lat},${p.lng}`
        : null;
    return {
        ok: true,
        datos: { nombre: p.name || 'Punto Fyradrive', direccion: p.address || null, total_puntos: puntos.length },
        placeholders: {
            punto_nombre: p.name || 'Punto Fyradrive',
            punto_direccion: p.address || null,
            punto_maps: maps
        }
    };
}

// ======================================================================
// cotizar — STAND BY (decisión de Sebastián 2026-06-11).
// Las reglas de elegibilidad de banco (Santander/Banregio por auto) aún no
// se modelan. Hasta entonces, cotizar SIEMPRE escala a humano: jamás se
// inventa una mensualidad.
// ======================================================================
async function cotizar() {
    return {
        ok: false,
        error: 'cotizador_stand_by',
        escalar: true,
        datos: { mensaje_interno: 'Cotización requiere humano (reglas de banco pendientes)' },
        placeholders: {}
    };
}

module.exports = { autos_activos, info_auto, ubicacion, cotizar, _fmtMXN: fmtMXN };
