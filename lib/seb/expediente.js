// lib/seb/expediente.js
// Arma el "expediente" de Seb para un turno: las capas de contexto en orden
// estable (REGLAS → FICHA → ESTADO → HISTORIAL → TÉCNICA → MENSAJE).
// Lo fijo va arriba (se cachea); lo vivo va abajo.
// Regla de oro: relevancia sobre completitud — si una capa no aporta, no entra.

const { query } = require('./db.js');

// Mapa intención → búsqueda de casilleros en sales_library.
// La biblioteca hoy tiene 7 casilleros con respuestas extraídas; cuando el
// admin la llene (proceso por lotes), Seb mejora sin tocar código.
const MAPA_TECNICA = {
    info_inicial: '%Primeras Jugadas%',
    disponibilidad: '%Triggers%',
    estado_auto: '%Calificación%',
    cotizar_credito: '%Crédito%',
    cita_ubicacion: '%Cita%',
    precio_negociacion: '%Precio%',
    fotos_videos: '%Medios%',
    continuacion: null,   // la continuación se guía por el ESTADO, no por casillero
    fuera_alcance: null,
    otro: null
};

async function capaTecnica(intencion) {
    const patron = MAPA_TECNICA[intencion];
    if (!patron) return null;
    const rows = await query(
        `SELECT casillero_titulo, casillero_pregunta, respuesta_manual, respuestas_extraidas
         FROM sales_library
         WHERE estante_nombre LIKE ?
           AND (LENGTH(COALESCE(respuesta_manual,'')) > 10 OR LENGTH(COALESCE(respuestas_extraidas,'')) > 10)
         LIMIT 2`,
        [patron]
    );
    if (rows.length === 0) return null;
    return rows.map(r => {
        const resp = (r.respuesta_manual && r.respuesta_manual.length > 10)
            ? r.respuesta_manual : r.respuestas_extraidas;
        return `[${r.casillero_titulo}]\n${String(resp).slice(0, 500)}`;
    }).join('\n\n');
}

async function capaHistorial(telefono, limite = 10) {
    // substr en SQL: hay mensajes de hasta 109MB (media en base64) que no
    // deben viajar completos por la red
    const rows = await query(
        `SELECT substr(mensaje,1,300) mensaje, direccion FROM wa_messages
         WHERE telefono = ? AND mensaje IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`,
        [telefono, limite]
    );
    return rows.reverse()
        .map(m => (m.direccion === 'in' ? 'COMPRADOR: ' : 'SEB: ') + String(m.mensaje).slice(0, 200))
        .join('\n');
}

// fichaAuto = resultado de herramientas.info_auto (datos + placeholders).
// estado = JSON parseado de wa_conversations.estado_json.
async function armarExpediente({ telefono, mensaje, clasificacion, fichaAuto, estado }) {
    const partes = [];

    if (fichaAuto && fichaAuto.ok) {
        const d = fichaAuto.datos;
        partes.push('# FICHA DEL AUTO ACTIVO\n' + [
            `Auto: ${d.nombre}` + (d.disponible ? '' : '  ⚠️ YA NO DISPONIBLE — ofrece alternativa'),
            `auto_id: ${d.id}  ← USA EXACTAMENTE este número como auto_id al llamar cotizar, enganche_minimo o ubicacion.`,
            d.transmision ? `Transmisión: ${d.transmision}` : null,
            d.color ? `Color: ${d.color}` : null,
            'Precio y kilometraje: usa los huecos {{precio}} y {{kilometraje}} (NO los escribas tú).'
        ].filter(Boolean).join('\n'));
    } else {
        partes.push('# FICHA DEL AUTO ACTIVO\n(No hay auto resuelto: si el comprador no dijo cuál, pregúntale cuál le interesa u ofrece el menú con autos_activos.)');
    }

    const est = estado || {};
    const estLineas = [];
    if (est.pregunta_pendiente) estLineas.push(`Tu última pregunta pendiente: "${est.pregunta_pendiente}"`);
    if (est.enganche) estLineas.push(`Enganche mencionado: ya lo dio (no lo vuelvas a pedir)`);
    if (est.cita_propuesta) estLineas.push(`Cita ya propuesta: ${est.cita_propuesta} (no la re-propongas; confirma o ajusta)`);
    if (est.nombre) estLineas.push(`Nombre del comprador: ${est.nombre}`);
    if (estLineas.length) partes.push('# ESTADO DE LA CONVERSACIÓN\n' + estLineas.join('\n'));

    const hist = await capaHistorial(telefono);
    if (hist) partes.push('# HISTORIAL RECIENTE\n' + hist);

    const tecnica = await capaTecnica(clasificacion.intencion_principal);
    if (tecnica) partes.push('# TÉCNICA PARA ESTA SITUACIÓN (adáptala, no la copies literal)\n' + tecnica);

    partes.push('# SITUACIÓN DETECTADA\nIntención: ' + clasificacion.intencion_principal +
        (clasificacion.datos && Object.values(clasificacion.datos).some(v => v != null)
            ? '\nDatos extraídos: ' + JSON.stringify(clasificacion.datos) : ''));

    partes.push('# MENSAJE DEL COMPRADOR\n"' + mensaje + '"');

    return partes.join('\n\n');
}

module.exports = { armarExpediente, capaTecnica, capaHistorial };
