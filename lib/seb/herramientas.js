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
// cotizar(auto_id, enganche, plazo_meses) — cotización HEY Banco.
// Agarra el enganche (y plazo) que DIO el comprador + el precio/año del auto.
// Devuelve la TARJETA FORMAL completa como UN solo hueco {{cotizacion}}
// (Seb la pega tal cual; la IA no teclea cifras). 2018+ por HEY; <2018 = financiera (pendiente).
// Fórmula verificada al centavo contra los PDFs de HEY.
// ======================================================================
async function cotizar({ auto_id, enganche, plazo_meses } = {}) {
    if (!auto_id) return { ok: false, error: 'falta_auto', datos: { mensaje_interno: 'no sé qué auto cotizar' }, placeholders: {} };
    const rows = await query("SELECT marca, modelo, version, anio, precio FROM inventario_autos WHERE id = ?", [Number(auto_id)]);
    if (rows.length === 0) return { ok: false, error: 'auto_no_existe', datos: null, placeholders: {} };
    const a = rows[0];
    const valor = Number(a.precio || 0);
    const anio = Number(a.anio || 0);
    const nombre = [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' ');
    if (!valor) return { ok: false, error: 'sin_precio', datos: null, placeholders: {} };

    // Reglas por año: plazo máximo (el enganche lo decide el comprador).
    let plazoMax, plazosDefault;
    if (anio < 2018) return { ok: false, error: 'auto_financiera_pendiente', datos: { mensaje_interno: 'auto <2018 → financiera (fórmulas pendientes); Seb dice que arma la cotización exacta' }, placeholders: {} };
    if (anio === 2018) { plazoMax = 36; plazosDefault = [36]; }
    else if (anio <= 2021) { plazoMax = 48; plazosDefault = [48, 36]; }
    else { plazoMax = 60; plazosDefault = [60, 48]; }

    const eng = Number(enganche || 0);
    if (!eng || eng <= 0) return { ok: false, error: 'falta_enganche', datos: { mensaje_interno: 'falta el enganche del comprador — Seb debe preguntarlo antes de cotizar' }, placeholders: {} };
    if (eng >= valor) return { ok: false, error: 'enganche_mayor_precio', datos: { mensaje_interno: 'el enganche es mayor o igual al precio' }, placeholders: {} };

    const plazos = plazo_meses ? [Math.min(Number(plazo_meses), plazoMax)] : plazosDefault;
    const tasa = (eng / valor * 100) >= 30 ? 13.99 : 14.99;       // tabla por enganche (verificada con PDFs)
    const monto = valor - eng;
    const mensual = (m, t, n) => { const i = t / 100 / 12; return m * i / (1 - Math.pow(1 + i, -n)); };
    const f = n => '$' + Math.round(n).toLocaleString('en-US');

    let card = `🚗 ${nombre}\n💰 Precio: ${f(valor)}\n💵 Enganche: ${f(eng)}\n📊 Tasa: ${tasa}% anual (HEY Banco)\n✅ Monto a financiar: ${f(monto)}\n`;
    plazos.forEach(p => { card += `   • ${p} meses: ${f(mensual(monto, tasa, p))}\n`; });
    card += `📌 Sujeto a aprobación bancaria — HEY Banco.`;

    // datos SIN cifras crudas a propósito: si el modelo viera precio/mensualidad
    // sueltos, intentaría re-armar la tarjeta a mano (y teclear dinero). Solo ve
    // que la cotización está LISTA → obligado a responder con el hueco {{cotizacion}}.
    return {
        ok: true,
        datos: { cotizacion_lista: true, auto: nombre, banco: 'HEY Banco' },
        placeholders: { cotizacion: card }
    };
}

// ======================================================================
// enganche_minimo(auto_id) — el enganche MÍNIMO requerido según el AÑO del auto.
// Reglas HEY: 2018 → 35% (máx 36 meses) · 2019-2021 → 35% (máx 48) ·
// 2022+ → 25% (máx 60) · <2018 → financiera (fórmulas pendientes).
// Úsala cuando el comprador pregunte "¿cuánto de enganche?" ANTES de dar una
// cantidad. Devuelve el monto YA formateado en {{enganche_minimo}} (la IA no
// teclea cifras); el % sí lo puede decir el modelo (no es cifra de dinero).
// ======================================================================
async function enganche_minimo({ auto_id } = {}) {
    if (!auto_id) return { ok: false, error: 'falta_auto', datos: { mensaje_interno: 'no sé qué auto' }, placeholders: {} };
    const rows = await query("SELECT marca, modelo, version, anio, precio FROM inventario_autos WHERE id = ?", [Number(auto_id)]);
    if (rows.length === 0) return { ok: false, error: 'auto_no_existe', datos: null, placeholders: {} };
    const a = rows[0];
    const valor = Number(a.precio || 0);
    const anio = Number(a.anio || 0);
    const nombre = [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' ');
    if (!valor) return { ok: false, error: 'sin_precio', datos: null, placeholders: {} };
    if (anio < 2018) return { ok: false, error: 'auto_financiera_pendiente', datos: { mensaje_interno: 'auto <2018 → financiera (fórmulas pendientes); Seb dice que arma la cotización exacta' }, placeholders: {} };

    let pct, plazoMax;
    if (anio === 2018) { pct = 35; plazoMax = 36; }
    else if (anio <= 2021) { pct = 35; plazoMax = 48; }
    else { pct = 25; plazoMax = 60; }

    const minimo = Math.round(valor * pct / 100);
    const f = n => '$' + Math.round(n).toLocaleString('en-US');
    // Sin el monto crudo en datos (para que no lo teclee): el monto va por hueco.
    return {
        ok: true,
        datos: { auto: nombre, porcentaje_minimo: pct, plazo_max_meses: plazoMax },
        placeholders: {
            enganche_minimo: `${f(minimo)} (${pct}%)`,
            plazo_max: `${plazoMax} meses`
        }
    };
}

module.exports = { autos_activos, info_auto, ubicacion, cotizar, enganche_minimo, _fmtMXN: fmtMXN };
