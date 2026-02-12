// FYRADRIVE - Análisis Emocional con Claude API
// Recibe un mensaje y devuelve análisis: emoción, miedo, deseo, intención, seriedad
// También se usa internamente desde el webhook

const { createClient } = require('@libsql/client');

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzA4MjUwMDYsImlkIjoiYTczOTliMjctYWFlNi00YjhmLWJmYjktODQ2M2JmMWU1MzljIiwicmlkIjoiNWVhMDBiM2QtNzNiNS00Njg3LWFjN2YtMTNhMGQzZmJlZmM1In0.ZVnn2UF2WdEw_yvQYGGB9Eyvbh_JRniPhkByn6Vxiavki0FkHVM8Xb0cwu1Ijrhti_j3iiOxS5jtt2IwCRWvDA'
});

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// ===== PROMPT DEL ANALISTA FYRADRIVE =====
var SYSTEM_PROMPT = `Eres el analista emocional de FYRADRIVE, una empresa de compra-venta de autos usados con crédito bancario en Monterrey, México.

CONTEXTO DEL NEGOCIO:
- Vendemos autos usados financiados con crédito bancario
- Enganche mínimo: 25% del valor del auto
- Plazos: 12 a 60 meses
- Tasa anual: ~16%
- Clientes típicos: personas de 25-50 años, ingreso 15k-40k mensuales
- Zona: Monterrey y área metropolitana
- El proceso: cliente pregunta → cotización → enganche → aprobación crédito → cierre

MIEDOS COMUNES DE LOS CLIENTES:
- Que el crédito los ahogue financieramente
- Que el auto tenga problemas mecánicos
- Que no les aprueben el crédito
- Que el enganche sea muy alto
- Compromiso a largo plazo
- Que les vendan un auto malo
- Que su pareja no esté de acuerdo

SEÑALES DE COMPRA:
- Preguntan por plazos específicos
- Mencionan un auto específico
- Preguntan por el enganche
- Dicen "me interesa" o "me gusta"
- Preguntan por disponibilidad
- Quieren agendar cita

SEÑALES DE ABANDONO:
- "Luego te aviso"
- "Déjame pensarlo"
- "Ahorita no puedo"
- Dejan de responder
- Solo piden info sin comprometerse

Tu trabajo es analizar CADA mensaje de un cliente y devolver un JSON con:
1. emocion: La emoción principal (interés, miedo, duda, entusiasmo, desconfianza, frustración, urgencia, indiferencia)
2. miedo: El miedo oculto si existe (financiero, compromiso, engaño, rechazo, familiar, ninguno)
3. deseo: El deseo real del cliente (auto, estatus, solución_transporte, independencia, mejor_vida, ninguno)
4. intencion: Qué quiere lograr con este mensaje (informarse, negociar, cerrar, huir, validar, comparar)
5. seriedad: Del 1 al 10, qué tan cerca está de comprar
6. señal: "compra", "abandono", o "neutral"
7. sugerencia: Qué debería hacer el vendedor (1-2 oraciones, directo, práctico)
8. resumen: Interpretación humana del mensaje (1-2 oraciones, como si le explicaras a un amigo)

IMPORTANTE:
- Responde SOLO con el JSON, nada más
- Sé directo y práctico en las sugerencias
- Piensa como vendedor de calle, no como psicólogo
- Si el mensaje es simple (hola, gracias, ok), analízalo igual pero con seriedad baja
- Usa lenguaje coloquial mexicano en el resumen`;

// ===== INICIALIZAR TABLAS =====
async function initBehaviorTable() {
    try {
        await client.execute(`
            CREATE TABLE IF NOT EXISTS wa_behavior (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telefono TEXT,
                mensaje TEXT,
                direccion TEXT DEFAULT 'in',
                emocion TEXT DEFAULT '',
                miedo TEXT DEFAULT '',
                deseo TEXT DEFAULT '',
                intencion TEXT DEFAULT '',
                seriedad INTEGER DEFAULT 0,
                senal TEXT DEFAULT 'neutral',
                sugerencia TEXT DEFAULT '',
                resumen TEXT DEFAULT '',
                raw_analysis TEXT DEFAULT '',
                created_at INTEGER
            )
        `);
        await client.execute(`
            CREATE TABLE IF NOT EXISTS intuiciones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telefono TEXT DEFAULT '',
                texto TEXT,
                tipo TEXT DEFAULT 'general',
                created_at INTEGER
            )
        `);
        await client.execute(`
            CREATE TABLE IF NOT EXISTS bola_magica_reportes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tipo TEXT DEFAULT 'semanal',
                contenido TEXT,
                datos_json TEXT DEFAULT '',
                created_at INTEGER
            )
        `);
        // Agregar columna platform si no existe
        try { await client.execute("ALTER TABLE wa_behavior ADD COLUMN platform TEXT DEFAULT 'whatsapp'"); } catch(e) {}
    } catch (err) {
        console.error('initBehaviorTable error:', err);
    }
}

// ===== ANALIZAR MENSAJE CON CLAUDE =====
async function analizarMensaje(telefono, mensaje, direccion, contextoExtra, platform) {
    try {
        var userContent = 'Mensaje del cliente (teléfono ' + telefono + '):\n"' + mensaje + '"';
        if (contextoExtra) {
            userContent += '\n\nContexto adicional: ' + contextoExtra;
        }

        var response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 500,
                system: SYSTEM_PROMPT,
                messages: [{ role: 'user', content: userContent }]
            })
        });

        var data = await response.json();

        if (!response.ok) {
            console.error('[FYRA-ANALYZE] Error Claude API:', response.status, JSON.stringify(data));
            return null;
        }

        var textoRespuesta = data.content && data.content[0] ? data.content[0].text : '';

        // Parsear JSON de la respuesta
        var analysis = null;
        try {
            // Buscar JSON en la respuesta (puede venir con texto extra)
            var jsonMatch = textoRespuesta.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                analysis = JSON.parse(jsonMatch[0]);
            }
        } catch (parseErr) {
            console.error('[FYRA-ANALYZE] Error parseando JSON:', parseErr.message);
            console.error('[FYRA-ANALYZE] Respuesta raw:', textoRespuesta);
        }

        if (!analysis) {
            return null;
        }

        // Guardar en base de datos
        await initBehaviorTable();
        var plat = platform || (typeof telefono === 'string' && telefono.startsWith('fb_') ? 'messenger' : 'whatsapp');
        await client.execute({
            sql: `INSERT INTO wa_behavior (telefono, mensaje, direccion, emocion, miedo, deseo, intencion, seriedad, senal, sugerencia, resumen, raw_analysis, platform, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            args: [
                telefono,
                mensaje,
                direccion || 'in',
                analysis.emocion || '',
                analysis.miedo || '',
                analysis.deseo || '',
                analysis.intencion || '',
                analysis.seriedad || 0,
                analysis.senal || 'neutral',
                analysis.sugerencia || '',
                analysis.resumen || '',
                textoRespuesta,
                plat,
                Date.now()
            ]
        });

        console.log('[FYRA-ANALYZE] Análisis guardado:', analysis.emocion, '| Seriedad:', analysis.seriedad, '| Señal:', analysis.senal);
        return analysis;

    } catch (err) {
        console.error('[FYRA-ANALYZE] Error general:', err.message);
        return null;
    }
}

// ===== HANDLER API =====
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    var apiKey = req.headers['x-api-key'];
    if (apiKey !== 'fyradrive2026') return res.status(401).json({ error: 'No autorizado' });

    var body = req.body || {};
    var telefono = body.telefono || '';
    var mensaje = body.mensaje || '';
    var direccion = body.direccion || 'in';
    var contexto = body.contexto || '';

    if (!mensaje) return res.status(400).json({ error: 'Falta mensaje' });

    var analysis = await analizarMensaje(telefono, mensaje, direccion, contexto);

    if (analysis) {
        return res.status(200).json({ ok: true, analysis: analysis });
    } else {
        return res.status(500).json({ ok: false, error: 'No se pudo analizar' });
    }
};

// Exportar función para uso interno (desde webhook)
module.exports.analizarMensaje = analizarMensaje;
module.exports.initBehaviorTable = initBehaviorTable;
