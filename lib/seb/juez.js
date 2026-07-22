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

// ══════════════════════════════════════════════════════════════════════════
// EL JUEZ DE DISPARO (orden owner 2026-07-22, caso Mar/instagram):
// "siempre van a haber combinaciones que podrían disparar — para eso está la IA,
//  para determinar la acción en concreto debido al razonamiento."
//
// LA LEY: los disparadores siguen siendo DETERMINISTAS (letras, regex, hechos
// duros). El juez es el RESPALDO: solo se le llama cuando un disparador ya
// disparó con evidencia que puede ser falsa (primer contacto, pedazos de URL,
// palabras que contienen un nombre). El juez RAZONA y dice si el disparo era
// real — y el código ejecuta los machotes de siempre. El juez JAMÁS escribe
// texto al comprador ni elige algo que las letras no propusieron.
//
// COSTO: cero llamadas en el flujo normal — solo cuando hay disparo dudoso
// (una vez por lead nuevo cuando ocurre), con memo para no pagar dos veces
// el mismo turno.
// ══════════════════════════════════════════════════════════════════════════
async function haikuJson(system, schema, texto, maxTokens) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return null;
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
                model: HAIKU, max_tokens: maxTokens || 200, system,
                messages: [{ role: 'user', content: texto }],
                output_config: { format: { type: 'json_schema', schema } }
            })
        });
        if (!r.ok) return null;
        const d = await r.json();
        return JSON.parse((d.content || []).find(b => b.type === 'text').text);
    } catch (e) { return null; }
}

// memo del turno: el mismo texto+candidatos no se paga dos veces (arranqueCarrusel
// y entradaMultiple ven el mismo opener). Vive lo que vive la instancia serverless.
const memo = new Map();

// ══ ¿EL COMPRADOR DE VERDAD NOMBRÓ ESE/ESOS AUTO(S)? ══════════════════════
// Se llama SOLO cuando el matcher de letras ya encontró candidatos en el texto
// de un PRIMER CONTACTO. Regresa {nombro, auto_id, razon} o null (sin juez →
// el caller se queda con su comportamiento determinista).
async function juezNombroAuto({ texto, candidatos }) {
    const cands = (candidatos || []).map(c => ({ id: c.id, nombre: c.nombre }));
    if (!cands.length) return null;
    const key = 'nombro|' + String(texto || '').slice(0, 300) + '|' + cands.map(c => c.id).join(',');
    if (memo.has(key)) return memo.get(key);
    const j = await haikuJson(
        'Eres el JUEZ DE DISPARO de un sistema de ventas de autos seminuevos. Un matcher de letras detectó que el mensaje de un comprador PODRÍA nombrar auto(s) del inventario, pero el disparo puede ser FALSO: pedazos de una URL ("instagram" contiene "ram", "Da3O" contiene "a3"), palabras que contienen el nombre ("programa" contiene "ram"), o puro interés general ("Me interesa un auto"). RAZONA: ¿el comprador se refirió DE VERDAD a alguno de los candidatos con sus propias palabras? Reglas: interés general sin marca/modelo → nombro=false. Nombra claramente UNO → nombro=true y su auto_id. Nombra VARIOS de verdad → nombro=true y auto_id=null. Ante la duda razonable → nombro=false (el flujo genérico lo atiende mejor que un falso disparo). Responde SOLO el JSON.',
        { type: 'object', properties: { nombro: { type: 'boolean' }, auto_id: { type: ['integer', 'null'] }, razon: { type: 'string' } }, required: ['nombro', 'auto_id', 'razon'], additionalProperties: false },
        'MENSAJE DEL COMPRADOR:\n' + String(texto || '').slice(0, 800) + '\n\nCANDIDATOS QUE EL MATCHER PROPONE:\n' + cands.map(c => `- id ${c.id}: ${c.nombre}`).join('\n'),
        200);
    // candado: el juez jamás inventa un id fuera de los candidatos
    if (j && j.auto_id != null && !cands.some(c => c.id === Number(j.auto_id))) j.auto_id = null;
    memo.set(key, j || null);
    return j || null;
}

// ══ ¿COMPRADOR O VENDEDOR? ═════════════════════════════════════════════════
// Respaldo del candado comprador (caso 3223506761): antes de que una foto de
// primer contacto despierte a Ignacio, si hay TEXTO del contacto, el juez lee
// y razona el rol. Solo 'comprador' frena a Ignacio; vendedor/duda/sin-juez →
// comportamiento determinista de siempre.
async function juezRol({ mensajes }) {
    const txt = (mensajes || []).map(m => String(m || '')).join('\n').replace(/\[[^\]]{1,20}\]/g, ' ').trim();
    if (txt.length < 4) return null;   // sin palabras no hay qué razonar — no se gasta
    const key = 'rol|' + txt.slice(0, 300);
    if (memo.has(key)) return memo.get(key);
    const j = await haikuJson(
        'Eres el JUEZ DE ROL de un lote de autos seminuevos. Lee los mensajes de un contacto nuevo de WhatsApp y RAZONA: ¿QUIERE COMPRAR un auto (viene de un anuncio, pide info/precio/fotos de unidades del lote) o QUIERE VENDER su propio auto al lote (ofrece su unidad, manda fotos de su carro para venderlo)? Si no hay señal clara → "duda". Responde SOLO el JSON.',
        { type: 'object', properties: { rol: { type: 'string', enum: ['comprador', 'vendedor', 'duda'] }, razon: { type: 'string' } }, required: ['rol', 'razon'], additionalProperties: false },
        'MENSAJES DEL CONTACTO:\n' + txt.slice(0, 900),
        150);
    memo.set(key, j || null);
    return j || null;
}

module.exports = { juzgar, juezNombroAuto, juezRol };
