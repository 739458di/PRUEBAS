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

// Producto Autoregio (HEY) — modelo de cotización calibrado contra 5 cotizaciones reales (error <0.25%).
// Seguro Qualitas FINANCIADO (escala con el valor); el pago = amort(precio−enganche, tasaNom, n) + SEGURO_K*seguro.
const SEGURO_BASE = 10028;       // base del seguro Qualitas financiado
const SEGURO_PCT = 0.015873;     // + 1.587% del valor del auto
const SEGURO_K = 0.0918;         // sobreprecio mensual = 9.18% del seguro (lo que el bot antes NO metía)

// REGLAS DE FINANCIAMIENTO POR AÑO — el banco/tasa/enganche mínimo/plazo salen de aquí.
// ≤2017 NO entra a HEY → va por FINANCIERA "Renueva Car": tasa fija 24% (NO se muestra en
// la cotización), enganche mínimo 45%. Mismo proceso, mismo gancho, mismos requisitos.
function reglasFin(anio) {
    anio = Number(anio || 0);
    if (anio <= 2017) return { banco: 'Renueva Car', minPct: 45, plazoMax: 48, plazosDefault: [48, 36], tasaFija: 24, mostrarTasa: false };
    if (anio === 2018) return { banco: 'HEY Banco', minPct: 35, plazoMax: 36, plazosDefault: [36], mostrarTasa: true };
    if (anio <= 2021) return { banco: 'HEY Banco', minPct: 35, plazoMax: 48, plazosDefault: [48, 36], mostrarTasa: true };
    return { banco: 'HEY Banco', minPct: 25, plazoMax: 60, plazosDefault: [60, 48], mostrarTasa: true };
}
// Tasa nominal: HEY escala por enganche (≥30% mejor tasa); Renueva Car es fija.
const tasaDe = (reglas, engPct) => reglas.tasaFija != null ? reglas.tasaFija : (engPct >= 30 ? 13.99 : 14.99);
// Banco del auto (para que los bancos de crédito digan HEY o Renueva Car según el año).
async function bancoDeAuto(auto_id) {
    if (!auto_id) return 'HEY Banco';
    const r = await query("SELECT anio FROM inventario_autos WHERE id=?", [Number(auto_id)]).catch(() => []);
    return reglasFin(r.length ? r[0].anio : 2020).banco;
}

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
    // 1) PREFERIR el paquete configurado en el generador de mapa (punto_envio):
    //    trae la captura branded + el link de Maps + el pin. La captura y el pin
    //    los manda FyraChat solo; aquí solo devolvemos el texto (nombre + link).
    const pe = await query(
        "SELECT (image_b64 IS NOT NULL) AS tiene_img, maps_link, name, lat, lng FROM punto_envio WHERE auto_id = ?",
        [Number(auto_id)]
    );
    if (pe.length && (pe[0].name || pe[0].maps_link || pe[0].lat != null)) {
        const e = pe[0];
        const nombre = e.name || 'Punto de venta Fyradrive';
        const maps = e.maps_link || (e.lat != null && e.lng != null ? `https://maps.google.com/?q=${e.lat},${e.lng}` : null);
        const ph = { punto_nombre: nombre };
        if (maps) ph.punto_maps = maps;
        return {
            ok: true,
            datos: {
                nombre,
                tiene_paquete: true,
                nota: 'La captura del mapa y el pin de ubicación se mandan AUTOMÁTICAMENTE con tu mensaje. Tú solo da el texto formal + cita; no describas la imagen.'
            },
            placeholders: ph
        };
    }

    // 2) Fallback: puntos_venta del inventario (sin captura ni pin guardados)
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
async function cotizar({ auto_id, enganche, enganche_pct, plazo_meses } = {}) {
    if (!auto_id) return { ok: false, error: 'falta_auto', datos: { mensaje_interno: 'no sé qué auto cotizar' }, placeholders: {} };
    const rows = await query("SELECT marca, modelo, version, anio, precio FROM inventario_autos WHERE id = ?", [Number(auto_id)]);
    if (rows.length === 0) return { ok: false, error: 'auto_no_existe', datos: null, placeholders: {} };
    const a = rows[0];
    const valor = Number(a.precio || 0);
    const anio = Number(a.anio || 0);
    const nombre = [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' ');
    if (!valor) return { ok: false, error: 'sin_precio', datos: null, placeholders: {} };

    // Reglas por año (HEY o Renueva Car): banco, enganche mínimo, plazo, tasa.
    const R = reglasFin(anio);

    // El enganche puede venir en PESOS (enganche) o en PORCENTAJE (enganche_pct → % del precio).
    let eng = Number(enganche || 0);
    if ((!eng || eng <= 0) && enganche_pct) {
        const pct = Number(enganche_pct);
        if (pct > 0 && pct < 100) eng = Math.round(valor * pct / 100);
    }
    if (!eng || eng <= 0) return { ok: false, error: 'falta_enganche', datos: { mensaje_interno: 'falta el enganche del comprador — Seb debe preguntarlo o mandar planes' }, placeholders: {} };
    if (eng >= valor) return { ok: false, error: 'enganche_mayor_precio', datos: { mensaje_interno: 'el enganche es mayor o igual al precio' }, placeholders: {} };

    // Enganche mínimo por reglas (Renueva Car exige 45%; HEY su mínimo por año). Si el
    // comprador dio menos, se cotiza al mínimo y se le avisa (no se le rechaza).
    let notaMin = '';
    const minMonto = Math.round(valor * R.minPct / 100);
    if (eng < minMonto) { eng = minMonto; notaMin = `\n(el enganche mínimo para este auto es del ${R.minPct}%, así queda)`; }

    const plazos = plazo_meses ? [Math.min(Number(plazo_meses), R.plazoMax)] : R.plazosDefault;
    // red team #2: pidió 60 meses y el banco topa en 48 → se le AVISA, no se cambia mudo
    const notaPlazo = (plazo_meses && Number(plazo_meses) > R.plazoMax) ? `\n(el plazo máximo para este auto es ${R.plazoMax} meses, así te lo corrí)` : '';
    const tasa = tasaDe(R, eng / valor * 100);
    // Producto financiado: el seguro Qualitas va FINANCIADO y escala con el valor; el pago
    // real = amortización de (precio−enganche) a la tasa nominal + 9.18% del seguro por mes.
    // Modelo calibrado contra 5 cotizaciones reales (error < 0.25%). El seguro NO es por cuenta
    // del cliente en este producto: va dentro del crédito (de ahí que el bot antes subcotizaba).
    const seguro = Math.round(SEGURO_BASE + SEGURO_PCT * valor);
    const monto = (valor - eng) + seguro;                          // monto a financiar (incluye seguro)
    const mensual = (autoMonto, t, n, seg) => { const i = t / 100 / 12; return autoMonto * i / (1 - Math.pow(1 + i, -n)) + SEGURO_K * seg; };
    const f = n => '$' + Math.round(n).toLocaleString('en-US');

    // OJO: en Renueva Car (mostrarTasa=false) la tasa NO va en la tarjeta (decisión del owner).
    let card = `${nombre}\nPrecio: ${f(valor)}\nEnganche: ${f(eng)}\nSeguro financiado: ${f(seguro)}\nMonto a financiar: ${f(monto)}\n${R.mostrarTasa ? `Tasa: ${tasa}% anual (${R.banco})\n` : ''}`;
    plazos.forEach(p => { card += `- ${p} meses: ${f(mensual(valor - eng, tasa, p, seguro))}\n`; });
    card += `Sujeto a aprobación bancaria — ${R.banco}. La mensualidad ya incluye el seguro financiado.${notaMin}${notaPlazo}`;

    // datos SIN cifras crudas a propósito: si el modelo viera precio/mensualidad
    // sueltos, intentaría re-armar la tarjeta a mano (y teclear dinero). Solo ve
    // que la cotización está LISTA → obligado a responder con el hueco {{cotizacion}}.
    return {
        ok: true,
        datos: { cotizacion_lista: true, auto: nombre, banco: R.banco },
        placeholders: { cotizacion: card }
    };
}

// ======================================================================
// planes(auto_id) — TABLA de opciones (varios enganches × varias mensualidades).
// Para el comprador que DIVAGA y quiere VER planes sin dar aún un enganche fijo:
// Seb se adelanta y manda la comparación para que él decida o dé su enganche.
// Mismas fórmulas/tasas que cotizar (verificadas con HEY). <2018 = financiera.
// ======================================================================
async function planes({ auto_id } = {}) {
    if (!auto_id) return { ok: false, error: 'falta_auto', datos: { mensaje_interno: 'no sé qué auto' }, placeholders: {} };
    const rows = await query("SELECT marca, modelo, version, anio, precio FROM inventario_autos WHERE id = ?", [Number(auto_id)]);
    if (rows.length === 0) return { ok: false, error: 'auto_no_existe', datos: null, placeholders: {} };
    const a = rows[0];
    const valor = Number(a.precio || 0);
    const anio = Number(a.anio || 0);
    const nombre = [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' ');
    if (!valor) return { ok: false, error: 'sin_precio', datos: null, placeholders: {} };

    const R = reglasFin(anio);
    const plazos = R.plazosDefault;
    const niveles = [R.minPct, R.minPct + 5, R.minPct + 15].filter(p => p < 70);

    // Mismo modelo financiado que cotizar(): auto a tasa nominal + 9.18% del seguro financiado.
    const seguro = Math.round(SEGURO_BASE + SEGURO_PCT * valor);
    const mensual = (autoMonto, t, n) => { const i = t / 100 / 12; return autoMonto * i / (1 - Math.pow(1 + i, -n)) + SEGURO_K * seguro; };
    const f = n => '$' + Math.round(n).toLocaleString('en-US');

    let card = `${nombre}\nPrecio: ${f(valor)}\nSeguro financiado: ${f(seguro)}\nPlanes de financiamiento (${R.banco}, ya con seguro):\n`;
    niveles.forEach(pct => {
        const eng = Math.round(valor * pct / 100);
        const tasa = tasaDe(R, pct);
        const cuotas = plazos.map(p => `${p}m ${f(mensual(valor - eng, tasa, p))}`).join(' · ');
        card += `\n${pct}% (${f(eng)}): ${cuotas}`;
    });
    card += `\n\nSujeto a aprobación bancaria — ${R.banco}. La mensualidad ya incluye el seguro. Elige el que más te acomode, o dime tu enganche ideal y a cuántos meses.`;

    return {
        ok: true,
        datos: { planes_listos: true, auto: nombre, banco: R.banco },
        placeholders: { planes: card }
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

    const R = reglasFin(anio);
    const pct = R.minPct, plazoMax = R.plazoMax;
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

// ======================================================================
// fotosDeAuto(auto_id, max) — URLs de las fotos del auto. SOLO de TUS autos:
// imagenes_autos.auto_id es el fyradrive_web_id, así que resolvemos por ahí.
// Portada (es_principal) primero. URLs públicas (Vercel Blob) → el bridge las
// descarga y manda por WhatsApp. Auto sin web_id / sin fotos → [].
// ======================================================================
async function fotosDeAuto(auto_id, max = 5) {
    if (!auto_id) return [];
    const a = await query("SELECT fyradrive_web_id FROM inventario_autos WHERE id = ?", [Number(auto_id)]);
    if (!a.length || !a[0].fyradrive_web_id) return [];
    const r = await query(
        "SELECT url_imagen FROM imagenes_autos WHERE auto_id = ? AND url_imagen IS NOT NULL ORDER BY es_principal DESC, orden_imagen ASC LIMIT ?",
        [Number(a[0].fyradrive_web_id), Number(max) || 5]);
    return r.map(x => x.url_imagen).filter(Boolean);
}

module.exports = { autos_activos, info_auto, ubicacion, cotizar, enganche_minimo, planes, fotosDeAuto, reglasFin, bancoDeAuto, _fmtMXN: fmtMXN };
