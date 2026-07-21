// lib/seb/conector.js
// LA IA DEL CONECTOR (la "maquillada" con SINTONÍA).
//
// El problema que resuelve: antes el conector ("Mira", "Claro", "Con gusto") salía por
// rotación AL AZAR (rot()), sin sintonía con lo que el comprador preguntó. Caso real:
// comprador "de dónde eres?" → Seb "claro, sí manejamos envío" (NO embona con la pregunta).
//
// Ahora una llamada BARATA a Haiku ELIGE el conector con sintonía input→output:
//   - PRIMERO intenta elegir uno del POOL (tus palabras, cero riesgo de inventar).
//   - Si NINGUNO embona, actúa como JUEZ y compone el suyo, mínimo y sobrio (≤4 palabras).
// La IA SOLO toca el CONECTOR; el CUERPO de la respuesta (tus bancos) NUNCA cambia.
// Si la IA falla (sin key / red / 5xx) → cae a rot(pool) determinístico: jamás rompe el flujo.

const HAIKU = 'claude-haiku-4-5';
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const rot = arr => arr[Math.floor(Math.random() * arr.length)];

// Limpia a SOBRIO: sin emojis, sin "!"/"¡"/"¿", sin puntuación final, máx 4 palabras.
function sobrio(s, pool) {
    let x = String(s || '')
        .replace(/[\u{1F000}-\u{1FFFF}☀-➿←-⇿⬀-⯿]/gu, '')
        .replace(/[!¡¿]/g, '')
        .replace(/[.:;,]+\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!x) return rot(pool || ['Mira']);
    const w = x.split(' ');
    if (w.length > 4) x = w.slice(0, 4).join(' ');
    return x.charAt(0).toUpperCase() + x.slice(1);
}

const SCHEMA = {
    type: 'object',
    properties: {
        desde_pool: { type: 'boolean', description: 'true si elegiste uno del pool tal cual' },
        conector: { type: 'string', description: 'el conector elegido del pool, o el que compusiste' },
        sintonia: { type: 'boolean', description: 'false solo si la respuesta de Seb NO contesta lo que el comprador preguntó' }
    },
    required: ['desde_pool', 'conector', 'sintonia'],
    additionalProperties: false
};

const SYSTEM = `Eres el "conector" de Seb, un vendedor de autos sobrio y directo de Monterrey.
Recibes: lo que el COMPRADOR escribió, la RESPUESTA fija que Seb le va a dar (NO la cambies), y un POOL de conectores.
Tu trabajo: elegir el conector que mejor EMBONE (sintonía) con lo que el comprador preguntó, para anteceder la respuesta con naturalidad.
Reglas:
- PRIMERO intenta usar uno del POOL tal cual (desde_pool=true y copia uno del pool exacto).
- Solo si NINGUNO del pool embona con la pregunta, compón el tuyo (desde_pool=false): máximo 4 palabras, sobrio, SIN emojis, SIN signos de exclamación, SIN "¿". Debe reconocer lo que preguntó.
- NUNCA metas datos en el conector (precios, sí/no de la duda, nombres, lugares). El conector SOLO conecta; el dato va en la respuesta.
- sintonia=false ÚNICAMENTE si la RESPUESTA de Seb no contesta de verdad lo que el comprador preguntó.
Conectores típicos de Seb: "Mira", "Claro", "Con gusto", "Va", "Te cuento", "Buena pregunta", "Sí mira", "Claro que sí".`;

// Devuelve { conector, sintonia, desde_pool }. Nunca lanza.
async function maquillar({ texto, accion, pool, gancho = '' }) {
    const fb = { conector: rot(pool || ['Mira']), sintonia: true, desde_pool: true, _fallback: true };
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey || !pool || !pool.length || !texto) return fb;

    const user = `COMPRADOR ESCRIBIÓ: "${texto}"
RESPUESTA FIJA DE SEB: "${accion || ''}"${gancho ? `\nCIERRE QUE SIGUE: "${gancho}"` : ''}
POOL DE CONECTORES: ${pool.map(p => `"${p}"`).join(', ')}`;

    try {
        for (let intento = 0; intento < 2; intento++) {
            const r = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: HAIKU,
                    max_tokens: 120,
                    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
                    messages: [{ role: 'user', content: user }],
                    output_config: { format: { type: 'json_schema', schema: SCHEMA } }
                })
            });
            const data = await r.json();
            if (r.ok) {
                const tb = (data.content || []).find(b => b.type === 'text');
                const out = JSON.parse(tb.text);
                let con = out.conector;
                // Anti-alucinación: si dijo "desde_pool", forzar que SEA del pool.
                if (out.desde_pool) {
                    const hit = pool.find(p => norm(p) === norm(con)) || pool.find(p => norm(con).includes(norm(p)));
                    con = hit || con;
                }
                con = sobrio(con, pool);
                return { conector: con, sintonia: out.sintonia !== false, desde_pool: !!out.desde_pool };
            }
            if (r.status !== 429 && r.status < 500) break;  // 4xx no-retry
            await new Promise(s => setTimeout(s, 800));
        }
    } catch (e) { /* cae al fallback */ }
    return fb;
}

module.exports = { maquillar };
