// lib/seb/juez.js
// EL JUEZ DE EFICACIA (orden owner 2026-07-10): encima de las reglas deterministas,
// la IA interpreta si la respuesta que el bot VA A MANDAR realmente ATIENDE lo que
// el comprador dijo. Si hay DESCONEXIÓN (él está comentando/confesando algo y la
// respuesta es plantilla que no aplica; pregunta X y se contesta Y) → ESCALA.
// Caso semilla: "Estoy en buró en algunos lugares" → el repetitivo de buró no aplica.
//
// Diseño anti-falsos-positivos:
//  - En la duda, eficaz=true (los casos claros ya los cubren la doctrina y los bancos).
//  - "Cita confirmada ✅" NUNCA se juzga (trigger literal, ya trae anti-humo).
//  - Si la IA falla (red/key) → fail-open: la respuesta sale (jamás bloquea el flujo).
//  - Interruptor: JUEZ_EFICACIA=0 lo apaga.

const HAIKU = 'claude-haiku-4-5';

const SYSTEM = `Eres el JUEZ DE EFICACIA de Seb, un vendedor de autos por WhatsApp en Monterrey.
Recibes lo que el COMPRADOR escribió y la RESPUESTA que Seb está a punto de mandarle.
Tu único trabajo: decidir si la respuesta ATIENDE con eficacia el mensaje.

VOCABULARIO DEL NEGOCIO: "simulación", "ejercicio", "corrida", "los números" = COTIZACIÓN
de financiamiento (la tarjeta con precio/enganche/mensualidades SÍ los atiende).

eficaz=true cuando:
- La respuesta contesta la pregunta que hizo, ejecuta lo que pidió (cotización, fotos, ubicación, información), o coordina la cita que él está moviendo (pedir día/hora, agendar en firme).
- Es un acuse razonable a una cortesía o a un "te aviso".

eficaz=false SOLO cuando hay DESCONEXIÓN CLARA:
- El comprador está CONTANDO o CONFESANDO algo personal / comentando su situación (NO preguntó nada) y la respuesta es una plantilla que no atiende ese comentario.
- Preguntó X y la respuesta contesta Y (no responde lo que pidió).
- La respuesta ignora la parte importante o delicada del mensaje.

EN LA DUDA: eficaz=true. No castigues respuestas cortas ni sobrias — ese es el estilo.
Responde SOLO el JSON.`;

// juzgar(textoComprador, segmentos) → { eficaz: bool, razon: string }
async function juzgar(texto, segmentos) {
    const fb = { eficaz: true, razon: '' };
    if (process.env.JUEZ_EFICACIA === '0') return fb;
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey || !texto || !segmentos || !segmentos.length) return fb;
    const respuesta = segmentos.join('\n');
    if (/cita confirmada/i.test(respuesta)) return fb;   // el trigger jamás se juzga
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
                model: HAIKU, max_tokens: 130,
                system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
                messages: [{ role: 'user', content: `COMPRADOR: "${String(texto).slice(0, 500)}"\nRESPUESTA DE SEB:\n"${respuesta.slice(0, 900)}"` }],
                output_config: { format: { type: 'json_schema', schema: {
                    type: 'object',
                    properties: {
                        eficaz: { type: 'boolean' },
                        razon: { type: 'string', description: 'si eficaz=false: en pocas palabras POR QUÉ la respuesta no atiende el mensaje' }
                    }, required: ['eficaz', 'razon'], additionalProperties: false } } }
            })
        });
        if (!r.ok) return fb;
        const data = await r.json();
        const tb = (data.content || []).find(b => b.type === 'text');
        const out = JSON.parse(tb.text);
        return { eficaz: out.eficaz !== false, razon: String(out.razon || '').slice(0, 160) };
    } catch (e) { return fb; }
}

module.exports = { juzgar };
