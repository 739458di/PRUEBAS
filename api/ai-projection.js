// FYRADRIVE - Proyeccion de precio de auto con IA
// Analiza marca, modelo, año, km y da un rango de precio estimado

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    var CLAUDE_KEY = process.env.CLAUDE_API_KEY;
    if (!CLAUDE_KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY no configurada' });

    var { brand, model, year, km } = req.body || {};
    if (!brand || !model || !year) {
        return res.status(400).json({ error: 'Faltan campos: brand, model, year (km opcional)' });
    }

    try {
        var prompt = `Eres un experto en el mercado automotriz mexicano. Analiza este vehiculo y da una proyeccion de precio realista para el mercado de Monterrey, Mexico.

Vehiculo:
- Marca: ${brand}
- Modelo: ${model}
- Año: ${year}
${km ? '- Kilometraje: ' + km.toLocaleString() + ' km' : '- Kilometraje: no especificado'}

Responde UNICAMENTE con JSON valido:
{
  "precio_bajo": numero (precio minimo razonable en pesos MXN),
  "precio_medio": numero (precio promedio de mercado),
  "precio_alto": numero (precio alto pero justificable),
  "precio_recomendado": numero (precio que recomendarias publicar),
  "tendencia": "estable|al_alza|a_la_baja",
  "demanda": "alta|media|baja",
  "tiempo_venta_estimado": "rapido (1-2 sem)|normal (2-4 sem)|lento (1-2 meses)",
  "notas": "breve comentario sobre el auto en el mercado actual"
}`;

        var resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CLAUDE_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-20250414',
                max_tokens: 400,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        var data = await resp.json();
        if (!resp.ok) {
            console.error('[AI-PROJECTION] Claude error:', data);
            return res.status(500).json({ error: 'Error de Claude', details: data });
        }

        var text = '';
        for (var i = 0; i < (data.content || []).length; i++) {
            if (data.content[i].type === 'text') text = data.content[i].text;
        }

        // Parsear JSON de la respuesta
        var jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            var projection = JSON.parse(jsonMatch[0]);
            projection.vehiculo = { marca: brand, modelo: model, anio: year, km: km || null };
            return res.status(200).json(projection);
        }

        return res.status(200).json({
            precio_recomendado: null,
            notas: text,
            vehiculo: { marca: brand, modelo: model, anio: year, km: km || null }
        });

    } catch (err) {
        console.error('[AI-PROJECTION] Error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
