// FYRADRIVE - 🔮 BOLA MÁGICA
// Métricas duras (reglas fijas) + Resumen inteligente (IA)
// GET /api/bola-magica = obtener dashboard completo
// POST /api/bola-magica = generar licuadora semanal

const { createClient } = require('@libsql/client');

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzA4MjUwMDYsImlkIjoiYTczOTliMjctYWFlNi00YjhmLWJmYjktODQ2M2JmMWU1MzljIiwicmlkIjoiNWVhMDBiM2QtNzNiNS00Njg3LWFjN2YtMTNhMGQzZmJlZmM1In0.ZVnn2UF2WdEw_yvQYGGB9Eyvbh_JRniPhkByn6Vxiavki0FkHVM8Xb0cwu1Ijrhti_j3iiOxS5jtt2IwCRWvDA'
});

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.status(200).end();

    var apiKey = req.headers['x-api-key'];
    if (apiKey !== 'fyradrive2026') return res.status(401).json({ error: 'No autorizado' });

    // ===== GET: Dashboard Bola Mágica =====
    if (req.method === 'GET') {
        try {
            var periodo = req.query.periodo || '7'; // días
            var desde = Date.now() - (parseInt(periodo) * 24 * 60 * 60 * 1000);

            // 1. MÉTRICAS DURAS (reglas fijas)
            // Total conversaciones únicas
            var totalConvs = await client.execute({
                sql: 'SELECT COUNT(DISTINCT telefono) as total FROM wa_messages WHERE direccion = ? AND created_at > ?',
                args: ['in', desde]
            });

            // Conversaciones que llegaron a cotización
            var convsCotizacion = await client.execute({
                sql: 'SELECT COUNT(DISTINCT telefono) as total FROM wa_conversations WHERE estado != ? AND updated_at > ?',
                args: ['idle', desde]
            });

            // Conversaciones que completaron cotización
            var convsCompletadas = await client.execute({
                sql: "SELECT COUNT(DISTINCT telefono) as total FROM wa_conversations WHERE (estado = 'cotizacion_enviada' OR paso = 'completado') AND updated_at > ?",
                args: [desde]
            });

            // Mensajes totales IN vs OUT
            var mensajesIn = await client.execute({
                sql: 'SELECT COUNT(*) as total FROM wa_messages WHERE direccion = ? AND created_at > ?',
                args: ['in', desde]
            });
            var mensajesOut = await client.execute({
                sql: "SELECT COUNT(*) as total FROM wa_messages WHERE direccion = 'out' AND mensaje NOT LIKE '❌%' AND created_at > ?",
                args: [desde]
            });

            // Mensajes fallidos
            var mensajesFallidos = await client.execute({
                sql: "SELECT COUNT(*) as total FROM wa_messages WHERE mensaje LIKE '❌%' AND created_at > ?",
                args: [desde]
            });

            // 2. ANÁLISIS EMOCIONAL (de wa_behavior)
            // Emociones más frecuentes
            var emociones = await client.execute({
                sql: "SELECT emocion, COUNT(*) as total FROM wa_behavior WHERE emocion != '' AND created_at > ? GROUP BY emocion ORDER BY total DESC LIMIT 5",
                args: [desde]
            });

            // Miedos más frecuentes
            var miedos = await client.execute({
                sql: "SELECT miedo, COUNT(*) as total FROM wa_behavior WHERE miedo != '' AND miedo != 'ninguno' AND created_at > ? GROUP BY miedo ORDER BY total DESC LIMIT 5",
                args: [desde]
            });

            // Deseos más frecuentes
            var deseos = await client.execute({
                sql: "SELECT deseo, COUNT(*) as total FROM wa_behavior WHERE deseo != '' AND deseo != 'ninguno' AND created_at > ? GROUP BY deseo ORDER BY total DESC LIMIT 5",
                args: [desde]
            });

            // Señales (compra vs abandono vs neutral)
            var senales = await client.execute({
                sql: "SELECT senal, COUNT(*) as total FROM wa_behavior WHERE created_at > ? GROUP BY senal",
                args: [desde]
            });

            // Seriedad promedio
            var seriedadProm = await client.execute({
                sql: "SELECT AVG(seriedad) as promedio FROM wa_behavior WHERE seriedad > 0 AND created_at > ?",
                args: [desde]
            });

            // Intenciones más frecuentes
            var intenciones = await client.execute({
                sql: "SELECT intencion, COUNT(*) as total FROM wa_behavior WHERE intencion != '' AND created_at > ? GROUP BY intencion ORDER BY total DESC LIMIT 5",
                args: [desde]
            });

            // Últimas sugerencias de la IA
            var ultimasSugerencias = await client.execute({
                sql: "SELECT telefono, mensaje, emocion, miedo, seriedad, sugerencia, resumen, created_at FROM wa_behavior WHERE sugerencia != '' ORDER BY created_at DESC LIMIT 10",
                args: []
            });

            // Intuiciones de Sebastián
            var intuiciones = await client.execute({
                sql: "SELECT * FROM intuiciones ORDER BY created_at DESC LIMIT 10",
                args: []
            });

            // CRM estados (de la tabla principal de compradores)
            var estadosCRM = [];
            try {
                estadosCRM = await client.execute({
                    sql: "SELECT estado, COUNT(*) as total FROM compradores WHERE created_at > ? GROUP BY estado",
                    args: [desde]
                });
            } catch(e) { /* tabla puede no existir aún */ }

            var totalConvsNum = totalConvs.rows[0] ? Number(totalConvs.rows[0].total) : 0;
            var cotizacionNum = convsCotizacion.rows[0] ? Number(convsCotizacion.rows[0].total) : 0;
            var completadasNum = convsCompletadas.rows[0] ? Number(convsCompletadas.rows[0].total) : 0;

            // Construir respuesta
            var dashboard = {
                periodo: periodo + ' días',
                metricas: {
                    conversaciones_total: totalConvsNum,
                    llegaron_cotizacion: cotizacionNum,
                    completaron_cotizacion: completadasNum,
                    tasa_cotizacion: totalConvsNum > 0 ? Math.round(cotizacionNum / totalConvsNum * 100) : 0,
                    tasa_completado: cotizacionNum > 0 ? Math.round(completadasNum / cotizacionNum * 100) : 0,
                    mensajes_recibidos: mensajesIn.rows[0] ? Number(mensajesIn.rows[0].total) : 0,
                    mensajes_enviados: mensajesOut.rows[0] ? Number(mensajesOut.rows[0].total) : 0,
                    mensajes_fallidos: mensajesFallidos.rows[0] ? Number(mensajesFallidos.rows[0].total) : 0
                },
                emocional: {
                    emociones: emociones.rows.map(function(r) { return { nombre: r.emocion, total: Number(r.total) }; }),
                    miedos: miedos.rows.map(function(r) { return { nombre: r.miedo, total: Number(r.total) }; }),
                    deseos: deseos.rows.map(function(r) { return { nombre: r.deseo, total: Number(r.total) }; }),
                    senales: senales.rows.map(function(r) { return { tipo: r.senal, total: Number(r.total) }; }),
                    intenciones: intenciones.rows.map(function(r) { return { nombre: r.intencion, total: Number(r.total) }; }),
                    seriedad_promedio: seriedadProm.rows[0] ? Math.round(Number(seriedadProm.rows[0].promedio) * 10) / 10 : 0
                },
                ultimos_analisis: ultimasSugerencias.rows.map(function(r) {
                    return {
                        telefono: r.telefono,
                        mensaje: r.mensaje,
                        emocion: r.emocion,
                        miedo: r.miedo,
                        seriedad: Number(r.seriedad),
                        sugerencia: r.sugerencia,
                        resumen: r.resumen
                    };
                }),
                intuiciones: intuiciones.rows.map(function(r) {
                    return { id: r.id, telefono: r.telefono, texto: r.texto, tipo: r.tipo, fecha: r.created_at };
                }),
                estados_crm: estadosCRM.rows ? estadosCRM.rows.map(function(r) { return { estado: r.estado, total: Number(r.total) }; }) : []
            };

            return res.status(200).json({ ok: true, data: dashboard });

        } catch (err) {
            console.error('[BOLA-MAGICA] Error:', err);
            return res.status(500).json({ ok: false, error: err.message });
        }
    }

    // ===== POST: Generar Licuadora Semanal con IA =====
    if (req.method === 'POST') {
        try {
            var periodo2 = 7;
            var desde2 = Date.now() - (periodo2 * 24 * 60 * 60 * 1000);

            // Obtener todos los análisis de la semana
            var analisis = await client.execute({
                sql: "SELECT telefono, mensaje, emocion, miedo, deseo, intencion, seriedad, senal, sugerencia, resumen FROM wa_behavior WHERE created_at > ? ORDER BY created_at DESC",
                args: [desde2]
            });

            // Obtener intuiciones de Sebastián
            var intui = await client.execute({
                sql: "SELECT texto, tipo, created_at FROM intuiciones WHERE created_at > ? ORDER BY created_at DESC",
                args: [desde2]
            });

            // Obtener estados CRM
            var estados = [];
            try {
                estados = await client.execute({
                    sql: "SELECT estado, notas FROM compradores WHERE updated_at > ?",
                    args: [desde2]
                });
            } catch(e) {}

            // Construir contexto para Claude
            var contextData = 'DATOS DE LA SEMANA FYRADRIVE:\n\n';
            contextData += 'Total mensajes analizados: ' + analisis.rows.length + '\n\n';

            if (analisis.rows.length > 0) {
                contextData += 'ANÁLISIS DE MENSAJES:\n';
                analisis.rows.forEach(function(r, idx) {
                    if (idx < 50) { // máximo 50 para no pasarnos de tokens
                        contextData += '- Tel:' + r.telefono + ' | Msg:"' + r.mensaje + '" | Emoción:' + r.emocion + ' | Miedo:' + r.miedo + ' | Deseo:' + r.deseo + ' | Seriedad:' + r.seriedad + '/10 | Señal:' + r.senal + '\n';
                    }
                });
            }

            if (intui.rows && intui.rows.length > 0) {
                contextData += '\nINTUICIONES DEL VENDEDOR (Sebastián):\n';
                intui.rows.forEach(function(r) {
                    contextData += '- ' + r.texto + ' (' + r.tipo + ')\n';
                });
            }

            if (estados.rows && estados.rows.length > 0) {
                contextData += '\nESTADOS CRM:\n';
                estados.rows.forEach(function(r) {
                    contextData += '- Estado: ' + r.estado + (r.notas ? ' | Notas: ' + r.notas : '') + '\n';
                });
            }

            var licuadoraPrompt = `Eres el estratega de ventas de FYRADRIVE. Con los datos de esta semana, genera un reporte DIRECTO y HUMANO.

NO uses tecnicismos. NO uses métricas complicadas. Habla como un mentor de ventas experimentado hablándole a su alumno Sebastián.

ESTRUCTURA DEL REPORTE:

🔥 DÓNDE ESTÁS FALLANDO
(Qué está saliendo mal emocionalmente con los clientes)

💭 QUÉ ESTÁN SINTIENDO TUS CLIENTES
(Miedos reales, deseos ocultos, lo que no te dicen pero sienten)

✅ QUÉ SÍ ESTÁ FUNCIONANDO
(Qué parte de tu propuesta de valor conecta)

❌ QUÉ NO IMPORTA
(Qué parte de lo que dices o haces es irrelevante para ellos)

🚫 QUÉ DEBERÍAS DEJAR DE DECIR
(Frases o enfoques que no sirven)

💡 QUÉ DEBERÍAS EMPEZAR A DECIR
(Nuevos enfoques basados en lo que realmente necesitan)

🔧 ACCIÓN CONCRETA ESTA SEMANA
(Una cosa específica que debes implementar ya)

🚀 IDEA DE PRODUCTO/SERVICIO
(Basado en los miedos y deseos, qué podrías crear que ellos necesitan)

IMPORTANTE:
- Cada conclusión debe tener EVIDENCIA: menciona mensajes específicos o patrones que viste
- Sé brutalmente honesto
- No seas genérico, sé específico al negocio de autos usados con crédito
- Incluye las intuiciones de Sebastián en tu análisis, confirma o cuestiona sus observaciones
- Máximo 800 palabras

` + contextData;

            var response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': CLAUDE_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-5-20250929',
                    max_tokens: 2000,
                    messages: [{ role: 'user', content: licuadoraPrompt }]
                })
            });

            var data = await response.json();
            var reporte = data.content && data.content[0] ? data.content[0].text : 'No se pudo generar el reporte';

            // Guardar reporte
            await client.execute({
                sql: "INSERT INTO bola_magica_reportes (tipo, contenido, datos_json, created_at) VALUES (?,?,?,?)",
                args: ['semanal', reporte, JSON.stringify({ total_analisis: analisis.rows.length, total_intuiciones: intui.rows ? intui.rows.length : 0 }), Date.now()]
            });

            return res.status(200).json({ ok: true, reporte: reporte });

        } catch (err) {
            console.error('[LICUADORA] Error:', err);
            return res.status(500).json({ ok: false, error: err.message });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
