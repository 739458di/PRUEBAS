// FYRADRIVE - AI Sales Agent (Seb)
// Genera respuestas IA para el chatbot del webhook
// Exports: getAIConfig, generarRespuestaAI, initAITables

const { createClient } = require('@libsql/client');

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || ''
});

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// ===== PROMPT DE SEB (mismo que playground.js) =====
var SEB_SYSTEM_PROMPT = `Eres Seb, asistente de ventas de FYRADRIVE. Vendes autos usados con credito bancario en Monterrey, Mexico.

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
- Si preguntan precio, ofrece armar cotizacion rapida
- NUNCA inventes datos que no tengas en el contexto
- NUNCA ofrezcas pasar por el comprador ni recogerlo
- Usa el nombre del auto correctamente (Chirey, no Chery)
- Si mencionan un dia relativo (manana, el sabado), confirma la fecha real
- Si detectas que quieren cotizar credito, responde EXACTAMENTE con el texto: [TRIGGER_COTIZACION]

FORMULA DE COTIZACION:
- Tasa anual: 15.99%
- Enganche minimo: 25% del valor
- Plazos: 12, 24, 36, 48, 60 meses
- Si preguntan mensualidades, ofrece armar cotizacion completa

SERVICIOS DE FYRADRIVE:
- Compra-venta de autos usados
- Credito bancario para autos
- Cotizaciones rapidas
- Citas para ver autos

Responde al cliente de forma natural y concisa.`;

// ===== KEYWORDS DE COTIZACION (para detección IA) =====
var COTIZACION_KEYWORDS = [
    'cotiza', 'cotizacion', 'cotización', 'credito', 'crédito',
    'financiamiento', 'financiar', 'mensualidad', 'mensualidades',
    'plazo', 'plazos', 'enganche', 'prestamo', 'préstamo',
    'banco', 'pagar a meses', 'a meses', 'cuanto queda',
    'cuanto pagaria', 'cuánto pagaría', 'quiero financiar',
    'me financian', 'a credito', 'a crédito'
];

// ===== OBTENER CONFIGURACION AI =====
async function getAIConfig() {
    try {
        var rows = await client.execute("SELECT key, value FROM claw_config WHERE key IN ('ai_enabled', 'model', 'boss_instructions', 'system_prompt_dm')");
        var config = { ai_enabled: false, model: 'claude-sonnet-4-5-20250929', boss_instructions: '', system_prompt_dm: '' };
        for (var i = 0; i < rows.rows.length; i++) {
            var row = rows.rows[i];
            var key = String(row.key);
            var val = String(row.value || '');
            if (key === 'ai_enabled') config.ai_enabled = (val === 'true' || val === '1');
            else if (key === 'model') config.model = val || config.model;
            else if (key === 'boss_instructions') config.boss_instructions = val;
            else if (key === 'system_prompt_dm') config.system_prompt_dm = val;
        }
        return config;
    } catch (err) {
        console.error('[AI-SALES] Error getAIConfig:', err.message);
        return { ai_enabled: false, model: 'claude-sonnet-4-5-20250929', boss_instructions: '', system_prompt_dm: '' };
    }
}

// ===== OBTENER HISTORIAL RECIENTE =====
async function getRecentMessages(telefono, limit) {
    try {
        var result = await client.execute({
            sql: "SELECT mensaje, direccion FROM wa_messages WHERE telefono = ? ORDER BY timestamp DESC LIMIT ?",
            args: [telefono, limit || 6]
        });
        var messages = [];
        for (var i = result.rows.length - 1; i >= 0; i--) {
            var row = result.rows[i];
            messages.push({
                role: String(row.direccion) === 'out' ? 'assistant' : 'user',
                content: String(row.mensaje || '')
            });
        }
        return messages;
    } catch (err) {
        console.error('[AI-SALES] Error getRecentMessages:', err.message);
        return [];
    }
}

// ===== GENERAR RESPUESTA IA =====
async function generarRespuestaAI(telefono, texto, nombre, analysis) {
    if (!CLAUDE_API_KEY) {
        console.error('[AI-SALES] CLAUDE_API_KEY no configurada');
        return null;
    }

    try {
        var config = await getAIConfig();
        if (!config.ai_enabled) return null;

        // Build system prompt
        var systemPrompt = config.system_prompt_dm || SEB_SYSTEM_PROMPT;

        // Add boss instructions if any
        if (config.boss_instructions) {
            systemPrompt += '\n\nINSTRUCCIONES ADICIONALES DEL BOSS:\n' + config.boss_instructions;
        }

        // Add customer context
        if (nombre) {
            systemPrompt += '\n\nCLIENTE ACTUAL: ' + nombre;
        }

        // Add analysis context if available
        if (analysis) {
            systemPrompt += '\n\nANALISIS EMOCIONAL DEL MENSAJE:';
            if (analysis.emocion) systemPrompt += '\n- Emocion: ' + analysis.emocion;
            if (analysis.seriedad) systemPrompt += '\n- Seriedad de compra: ' + analysis.seriedad + '/10';
            if (analysis.senal) systemPrompt += '\n- Señal: ' + analysis.senal;
            if (analysis.sugerencia) systemPrompt += '\n- Sugerencia: ' + analysis.sugerencia;
        }

        // Add date context
        var hoy = new Date();
        var manana = new Date(hoy); manana.setDate(manana.getDate() + 1);
        systemPrompt += '\n\n[FECHA HOY: ' + hoy.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ']';

        // Get recent conversation history
        var history = await getRecentMessages(telefono, 6);

        // Build messages array
        var messages = [];
        for (var i = 0; i < history.length; i++) {
            messages.push(history[i]);
        }
        // Add current message
        messages.push({ role: 'user', content: texto });

        // Call Claude API
        var model = config.model || 'claude-sonnet-4-5-20250929';
        var response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: model,
                max_tokens: 400,
                system: systemPrompt,
                messages: messages
            })
        });

        var data = await response.json();

        if (!response.ok) {
            var errMsg = (data.error && data.error.message) ? data.error.message : ('HTTP ' + response.status);
            console.error('[AI-SALES] Error Claude API:', errMsg);
            return null;
        }

        var respuesta = (data.content && data.content[0]) ? data.content[0].text : '';

        if (!respuesta) return null;

        // Check if AI detected cotizacion intent
        var triggerCotizacion = false;
        if (respuesta.includes('[TRIGGER_COTIZACION]')) {
            triggerCotizacion = true;
            respuesta = respuesta.replace('[TRIGGER_COTIZACION]', '').trim();
        }

        // Also check message for cotizacion keywords as fallback
        if (!triggerCotizacion) {
            var textoLower = texto.toLowerCase();
            var cotKeywords = COTIZACION_KEYWORDS.some(function(kw) { return textoLower.includes(kw); });
            if (cotKeywords) {
                triggerCotizacion = true;
            }
        }

        console.log('[AI-SALES] Respuesta generada (' + model + ') trigger_cot=' + triggerCotizacion);

        return {
            respuesta: respuesta,
            trigger_cotizacion: triggerCotizacion,
            model: model
        };

    } catch (err) {
        console.error('[AI-SALES] Error generarRespuestaAI:', err.message);
        return null;
    }
}

// ===== INICIALIZAR TABLAS AI =====
async function initAITables() {
    try {
        // Ensure claw_config exists
        await client.execute(`
            CREATE TABLE IF NOT EXISTS claw_config (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at INTEGER
            )
        `);

        // Set defaults if not exist
        var defaults = [
            ['ai_enabled', 'true'],
            ['model', 'claude-sonnet-4-5-20250929'],
            ['boss_instructions', ''],
            ['system_prompt_dm', '']
        ];
        for (var i = 0; i < defaults.length; i++) {
            await client.execute({
                sql: "INSERT OR IGNORE INTO claw_config (key, value, updated_at) VALUES (?, ?, ?)",
                args: [defaults[i][0], defaults[i][1], Date.now()]
            });
        }

        console.log('[AI-SALES] Tablas AI inicializadas');
    } catch (err) {
        console.error('[AI-SALES] Error initAITables:', err.message);
    }
}

// ===== EXPORTS =====
module.exports = { getAIConfig, generarRespuestaAI, initAITables };
