// FYRADRIVE Playground - Simulates Seb agent for training & testing
// POST /api/playground
// body: { role, message, history, context, triggers }
// Returns: { ok, response, actions, cita_detected, fase_detected }

const { createClient } = require('@libsql/client');

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || ''
});

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

const SEB_PROMPT = `Eres Seb, asistente de ventas de FYRADRIVE. Vendes autos usados con credito bancario en Monterrey, Mexico.

PERSONALIDAD:
- Joven, amigable, directo pero profesional
- Usas español mexicano casual (sin ser vulgar)
- Servicial sin ser insistente
- Respuestas concisas (2-4 oraciones maximo)

REGLAS ABSOLUTAS:
- NUNCA pidas nombre o telefono antes de dar informacion del auto
- Primero da info, despues datos de contacto surgen naturalmente
- Si preguntan ubicacion, da la direccion del vendedor
- Si quieren cita, captura dia y hora naturalmente
- Si preguntan precio, da info de cotizacion rapida
- NUNCA inventes datos que no tengas en el contexto
- NUNCA ofrezcas pasar por el comprador ni recogerlo
- Usa el nombre del auto correctamente (Chirey, no Chery)
- Si mencionan un dia relativo (manana, el sabado), confirma la fecha real

FORMULA DE COTIZACION:
- Tasa anual: 15.99%
- Enganche minimo: 25% del valor
- Plazos: 12, 24, 36, 48, 60 meses
- Si preguntan mensualidades, calcula aproximadamente

CONTEXTO DEL AUTO EN ESTA SESION:
{auto_context}

INSTRUCCIONES ADICIONALES DEL BOSS:
{boss_instructions}`;

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    var apiKey = req.headers['x-api-key'];
    if (apiKey !== 'fyradrive2026') return res.status(401).json({ error: 'No autorizado' });

    if (!CLAUDE_API_KEY) return res.status(500).json({ ok: false, error: 'CLAUDE_API_KEY no configurada' });

    var body = req.body || {};
    var role = body.role || 'comprador';
    var message = body.message || '';
    var history = body.history || [];
    var context = body.context || {};
    var triggers = body.triggers || [];

    if (!message) return res.status(400).json({ error: 'Falta mensaje' });

    try {
        // Get boss instructions from DB
        var instructions = '';
        try {
            var instr = await client.execute("SELECT value FROM claw_config WHERE key = 'boss_instructions'");
            if (instr.rows.length && instr.rows[0].value) {
                instructions = String(instr.rows[0].value);
            }
        } catch(e) { /* ignore */ }

        // Build auto context
        var autoContext = 'Sin contexto definido';
        if (context.auto) {
            autoContext = 'Auto: ' + (context.auto || 'N/A') +
                '\nPrecio: $' + (parseInt(context.precio) || 0).toLocaleString('en-US') +
                '\nUbicacion del vendedor: ' + (context.ubicacion || 'Plaza Tribecca, San Pedro Garza Garcia') +
                '\nNombre del vendedor: ' + (context.vendedor || 'N/A');
        }

        // Build system prompt
        var systemPrompt = SEB_PROMPT
            .replace('{auto_context}', autoContext)
            .replace('{boss_instructions}', instructions || 'Ninguna');

        // Add trigger hints
        if (triggers.length) {
            systemPrompt += '\n\n[SISTEMA: Triggers detectados en el mensaje del cliente: ' + triggers.join(', ') + ']';
            if (triggers.indexOf('CITA') >= 0) {
                var hoy = new Date();
                var manana = new Date(hoy); manana.setDate(manana.getDate() + 1);
                systemPrompt += '\n[FECHA HOY: ' + hoy.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ']';
                systemPrompt += '\n[MANANA: ' + manana.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }) + ']';
            }
        }

        // Build messages array for Claude
        var messages = [];
        if (history.length > 1) {
            // Add previous messages (skip last = current message)
            for (var i = 0; i < history.length - 1; i++) {
                var m = history[i];
                if (m.role === 'user' || m.role === 'assistant') {
                    messages.push({ role: m.role, content: m.content });
                }
            }
        }
        messages.push({ role: 'user', content: message });

        // Call Claude API
        var response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-5-20250929',
                max_tokens: 400,
                system: systemPrompt,
                messages: messages
            })
        });

        var data = await response.json();

        if (!response.ok) {
            var errMsg = (data.error && data.error.message) ? data.error.message : ('HTTP ' + response.status);
            return res.status(500).json({ ok: false, error: 'Claude API: ' + errMsg });
        }

        var responseText = (data.content && data.content[0]) ? data.content[0].text : '';

        // Analyze response for actions
        var actions = [];
        var lower = responseText.toLowerCase();
        var citaDetected = null;
        var faseDetected = null;

        // Detect cita in response
        if (lower.match(/cita|agendar|agenda|te espero|nos vemos|quedamos/)) {
            actions.push({ type: 'pipeline', text: 'Seb detecto intencion de cita en la conversacion' });
            var dateMatch = responseText.match(/(ma[ñn]ana|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\d{1,2}\s+de\s+\w+)/i);
            var timeMatch = responseText.match(/(\d{1,2}[:\.]?\d{0,2}\s*(am|pm|hrs|h)?)/i);
            citaDetected = {
                fecha: dateMatch ? dateMatch[0] : null,
                hora: timeMatch ? timeMatch[0] : null
            };
        }

        // Detect cotizacion
        if (lower.match(/cotizaci|mensualidad|enganche|financ|plazo|\$\d/)) {
            actions.push({ type: 'trigger', text: 'Seb proporciono info de cotizacion' });
        }

        // Detect ubicacion
        if (lower.match(/ubicaci|direcci|punto de encuentro|llegar|san jer|san pedro|tribecca/)) {
            actions.push({ type: 'trigger', text: 'Seb proporciono ubicacion' });
        }

        // Detect fase from triggers
        if (triggers.indexOf('INTERES ALTO') >= 0) faseDetected = 'interesado';
        else if (triggers.indexOf('CITA') >= 0) faseDetected = 'cita';
        else if (triggers.indexOf('COTIZACION') >= 0) faseDetected = 'negociando';
        else if (triggers.indexOf('INFO') >= 0) faseDetected = 'explorando';

        return res.status(200).json({
            ok: true,
            response: responseText,
            actions: actions,
            cita_detected: citaDetected,
            fase_detected: faseDetected
        });

    } catch(e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
};
