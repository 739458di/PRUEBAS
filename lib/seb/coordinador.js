// ══ COORDINADOR DE LA CITA DE 3 PARTES (orden owner 2026-09-26: "automático hasta el día D; Mario entra estratégico") ══
// Un solo intérprete (Opus) lee cada mensaje de un trato abierto —del comprador o del dueño— con la FOTO del trato y la PREGUNTA PENDIENTE,
// y escoge UNA acción de una lista cerrada. No redacta nada: el código ejecuta con plantillas. Los "sí" limpios los resuelve el código antes (sin IA).
const MODELO = process.env.COORDINADOR_MODELO || 'claude-opus-5-5';

const ACCIONES = {
    comprador: ['acepta', 'propone', 'no_puede_sin_hora', 'lo_piensa', 'cancela', 'hablar_mario', 'pregunta_otra', 'cortesia'],
    dueno: ['acepta', 'propone', 'no_puede_sin_hora', 'ya_no_disponible', 'hablar_mario', 'pregunta_otra', 'cortesia'],
};
const DESC = {
    acepta: 'dice que SÍ a la propuesta pendiente (aunque lo diga con otras palabras o repita el día/hora propuestos)',
    propone: 'da o pide OTRO día y/o hora concreta distinta a la propuesta (llena dia y hora; si solo cambia la hora, usa el mismo día de la propuesta; si solo cambia el día, usa la misma hora)',
    no_puede_sin_hora: 'dice que no puede en la propuesta pero NO da otra hora concreta',
    lo_piensa: 'lo va a revisar / te avisa / déjame ver, sin decir que no',
    cancela: 'ya no quiere ir / ya compró otro / ya no le interesa',
    ya_no_disponible: 'el auto ya no está disponible (lo vendió, lo apartó, ya no lo vende)',
    hablar_mario: 'pide hablar con Mario / que le marquen / con una persona',
    pregunta_otra: 'cualquier otra cosa que NO es acordar el horario (precio, comisión, crédito, papeles, dudas del auto, quejas)',
    cortesia: 'solo gracias / ok / saludo, sin contestar nada de la propuesta',
};

function schema(quien) {
    return { type: 'object', additionalProperties: false, required: ['razon', 'accion', 'dia', 'hora'], properties: {
        razon: { type: 'string', description: 'Qué quiso decir, en una frase, considerando la propuesta pendiente.' },
        accion: { type: 'string', enum: ACCIONES[quien] },
        dia: { type: 'string', description: 'YYYY-MM-DD solo si accion=propone; vacío si no.' },
        hora: { type: 'string', description: 'HH:MM 24h solo si accion=propone; vacío si no.' } } };
}

async function interpretar({ quien, texto, foto, pendiente, historial, hoy }) {
    const key = process.env.CLAUDE_API_KEY; if (!key) return null;
    const lista = ACCIONES[quien].map(a => '· ' + a + ' = ' + DESC[a]).join('\n');
    const system = 'Eres el coordinador de citas de un lote de autos seminuevos en Monterrey. Una cita la acuerdan 3 partes: el comprador, el dueño del auto y Mario (el vendedor). ' +
        'Tú solo interpretas el mensaje nuevo de ' + (quien === 'dueno' ? 'EL DUEÑO del auto' : 'EL COMPRADOR') + ' y escoges UNA acción. No redactas respuesta.\n' +
        'Acciones posibles:\n' + lista + '\n' +
        'Reglas: lee el mensaje contra la PROPUESTA PENDIENTE. "sí pero a las 6" = propone. "a esa hora no, mejor el viernes" = propone. "no puedo" sin otra hora = no_puede_sin_hora. ' +
        'Los días relativos ("mañana", "el jueves") se calculan desde HOY. Si dudas entre acordar horario y otra cosa, y el mensaje sí habla del horario, elige la de horario.';
    const content = 'HOY: ' + hoy + '\nTRATO: ' + (foto || 'sin datos') + '\nPROPUESTA PENDIENTE: ' + (pendiente || 'ninguna') +
        '\nÚLTIMOS MENSAJES:\n' + (historial || []).slice(-6).map(h => (h.quien || '?') + ': ' + String(h.texto || '').slice(0, 220)).join('\n') +
        '\n\nMENSAJE NUEVO DE ' + (quien === 'dueno' ? 'EL DUEÑO' : 'EL COMPRADOR') + ': ' + String(texto || '').slice(0, 600);
    for (let intento = 0; intento < 2; intento++) {
        try {
            const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({ model: MODELO, max_tokens: 2000, output_config: { effort: 'low', format: { type: 'json_schema', schema: schema(quien) } }, system, messages: [{ role: 'user', content }] }) });
            if (!r.ok) { if (r.status >= 500 || r.status === 429) continue; return null; }
            const j = await r.json(); if (j.stop_reason === 'refusal') return null;
            const tb = (j.content || []).find(b => b.type === 'text'); const o = tb ? JSON.parse(tb.text) : null;
            if (!o || !ACCIONES[quien].includes(o.accion)) return null;
            if (o.accion === 'propone' && !(/^\d{4}-\d{2}-\d{2}$/.test(o.dia) && /^\d{1,2}:\d{2}$/.test(o.hora))) o.accion = 'no_puede_sin_hora';   // sin día y hora completos no hay propuesta ejecutable
            return o;
        } catch (e) { }
    }
    return null;
}

module.exports = { interpretar, ACCIONES, MODELO };
