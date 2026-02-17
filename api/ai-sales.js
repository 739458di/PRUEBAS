// FYRADRIVE - CLAW: Operador IA de FyraDrive
// Claw es el operador de FyraDrive. Opera el sistema de afuera pa dentro y de dentro pa fuera.
// Usa tools (function calling) para consultar el cerebro: buscar autos, cotizar, verificar REPUVE, proyectar precios.
// Upgrade: Claude Haiku → Claude Sonnet 4.5 con tools

const { createClient } = require('@libsql/client');

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzA4MjUwMDYsImlkIjoiYTczOTliMjctYWFlNi00YjhmLWJmYjktODQ2M2JmMWU1MzljIiwicmlkIjoiNWVhMDBiM2QtNzNiNS00Njg3LWFjN2YtMTNhMGQzZmJlZmM1In0.ZVnn2UF2WdEw_yvQYGGB9Eyvbh_JRniPhkByn6Vxiavki0FkHVM8Xb0cwu1Ijrhti_j3iiOxS5jtt2IwCRWvDA'
});

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const FYRADRIVE_API_URL = 'https://pruebas-ruby.vercel.app';
const FYRADRIVE_API_KEY = 'fyradrive2026';

// ===== TOOLS DEL CEREBRO (FyraDrive APIs) =====
const CLAW_TOOLS = [
    {
        name: "buscar_autos",
        description: "Busca autos en el catalogo de FyraDrive. Puedes buscar por marca, modelo, año, rango de precio. Usa esto cuando un cliente pregunte por algun auto especifico o quiera ver opciones.",
        input_schema: {
            type: "object",
            properties: {
                marca: { type: "string", description: "Marca del auto (Honda, Toyota, BMW, etc.)" },
                modelo: { type: "string", description: "Modelo del auto (Civic, Corolla, Serie 3, etc.)" },
                precio_max: { type: "number", description: "Precio maximo en pesos" },
                anio_min: { type: "number", description: "Año minimo del auto" }
            },
            required: []
        }
    },
    {
        name: "cotizar_financiamiento",
        description: "Calcula cotizacion de financiamiento para un auto. Tasa 15.99% anual, enganche minimo 25%, plazos 12-60 meses. Usa esto cuando el cliente quiera saber cuanto pagaria a meses.",
        input_schema: {
            type: "object",
            properties: {
                precio: { type: "number", description: "Precio del vehiculo en pesos" },
                enganche: { type: "number", description: "Monto de enganche en pesos (minimo 25% del precio)" },
                plazo: { type: "number", description: "Plazo en meses (12, 24, 36, 48, 60)" }
            },
            required: ["precio", "enganche", "plazo"]
        }
    },
    {
        name: "proyeccion_precio",
        description: "Obtiene proyeccion de precio de mercado usando IA. Usa esto cuando un vendedor quiera saber cuanto vale su auto o cuando necesites validar si un precio es justo.",
        input_schema: {
            type: "object",
            properties: {
                brand: { type: "string", description: "Marca del auto" },
                model: { type: "string", description: "Modelo del auto" },
                year: { type: "number", description: "Año del auto" },
                km: { type: "number", description: "Kilometraje" }
            },
            required: ["brand", "model", "year"]
        }
    },
    {
        name: "verificar_niv",
        description: "Verifica un vehiculo en REPUVE (Registro Publico Vehicular) para saber si tiene reporte de robo o adeudos. Usa esto cuando un vendedor quiera publicar su auto — siempre verificar antes.",
        input_schema: {
            type: "object",
            properties: {
                niv: { type: "string", description: "Numero de Identificacion Vehicular (17 caracteres)" }
            },
            required: ["niv"]
        }
    }
];

// ===== EJECUTAR TOOLS =====
async function ejecutarTool(toolName, toolInput) {
    try {
        if (toolName === 'buscar_autos') {
            var conditions = [];
            var args = [];
            if (toolInput.marca) { conditions.push("marca LIKE ?"); args.push('%' + toolInput.marca + '%'); }
            if (toolInput.modelo) { conditions.push("modelo LIKE ?"); args.push('%' + toolInput.modelo + '%'); }
            if (toolInput.precio_max) { conditions.push("precio <= ?"); args.push(toolInput.precio_max); }
            if (toolInput.anio_min) { conditions.push("anio >= ?"); args.push(toolInput.anio_min); }
            var where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
            var sql = 'SELECT id, marca, modelo, anio, km, precio, transmision, estado, ciudad FROM Auto' + where + ' ORDER BY created_at DESC LIMIT 10';
            var result = await client.execute({ sql: sql, args: args });
            if (result.rows.length === 0) return JSON.stringify({ encontrados: 0, mensaje: "No hay autos que coincidan con esa busqueda" });
            return JSON.stringify({ encontrados: result.rows.length, autos: result.rows });
        }

        if (toolName === 'cotizar_financiamiento') {
            var precio = toolInput.precio;
            var enganche = toolInput.enganche;
            var plazo = toolInput.plazo;
            if (enganche < precio * 0.25) return JSON.stringify({ error: "Enganche minimo es 25% del precio: $" + Math.round(precio * 0.25).toLocaleString() });
            if (plazo < 12 || plazo > 60) return JSON.stringify({ error: "Plazo debe ser entre 12 y 60 meses" });
            var financiamiento = precio - enganche;
            var subtotal = financiamiento + 1800;
            var iva = subtotal * 0.16;
            var montoFinanciar = subtotal + iva;
            var r = 0.1599 / 12;
            var mensualidad = montoFinanciar * (r * Math.pow(1 + r, plazo)) / (Math.pow(1 + r, plazo) - 1) - 400;
            var comision = precio * 0.0201;
            return JSON.stringify({
                precio: precio, enganche: enganche, plazo: plazo,
                mensualidad: Math.round(mensualidad),
                comision_apertura: Math.round(comision),
                desembolso_inicial: Math.round(enganche + comision),
                tasa_anual: "15.99%"
            });
        }

        if (toolName === 'proyeccion_precio') {
            var resp = await fetch(FYRADRIVE_API_URL + '/api/ai-projection', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(toolInput)
            });
            var data = await resp.json();
            return JSON.stringify(data);
        }

        if (toolName === 'verificar_niv') {
            var resp = await fetch(FYRADRIVE_API_URL + '/api/verificar-niv', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ niv: toolInput.niv })
            });
            var data = await resp.json();
            return JSON.stringify(data);
        }

        return JSON.stringify({ error: "Tool no reconocido: " + toolName });
    } catch (err) {
        console.error('[CLAW] Error ejecutando tool', toolName, ':', err.message);
        return JSON.stringify({ error: "Error ejecutando " + toolName + ": " + err.message });
    }
}

// ===== SYSTEM PROMPT: CLAW - OPERADOR FYRADRIVE =====
var SYSTEM_PROMPT_BASE = `Eres Seb, el OPERADOR de FyraDrive. No eres un chatbot. No eres un vendedor de lote tradicional. Eres Seb — la version digital de Sebastian Romero, fundador de Fyradrive.

═══════════════════════════════════
0. TU ROL COMO OPERADOR
═══════════════════════════════════
Eres el operador de FyraDrive. Operas el sistema de afuera pa dentro y de dentro pa fuera:
- Recibes mensajes de clientes y registras todo en FyraDrive
- CONSULTAS DATOS REALES del sistema usando tus herramientas (tools): buscas autos, cotizas, verificas REPUVE, proyectas precios
- NUNCA inventes datos. SIEMPRE usa tus tools para consultar informacion real antes de responder
- Solo hablas de dos temas: COMPRAR un auto o VENDER/PUBLICAR un auto
- No das informacion confidencial de FyraDrive (cuantas citas hay, quienes somos internamente, etc.)
- Solo hablas cuando te hablan. No inicias contacto por tu cuenta.
- 24/7 siempre disponible

REGLAS DE AUTONOMIA:
PUEDES HACER SOLO: responder preguntas sobre autos, dar cotizaciones, dar proyecciones de precio, verificar NIV en REPUVE, registrar leads, pedir fotos y datos a vendedores
NECESITAS APROBACION DE SEBASTIAN: agendar citas, publicar autos, iniciar contacto proactivo, cambiar precios

CUANDO UN CLIENTE PREGUNTA POR UN AUTO: USA la herramienta buscar_autos para buscar en el catalogo REAL. No inventes autos.
CUANDO UN CLIENTE QUIERE COTIZAR: USA la herramienta cotizar_financiamiento con los datos reales.
CUANDO UN VENDEDOR QUIERE SABER CUANTO VALE SU AUTO: USA la herramienta proyeccion_precio.
CUANDO UN VENDEDOR QUIERE PUBLICAR: PIDE el NIV y USA verificar_niv antes de aceptar.

═══════════════════════════════════
1. TU IDENTIDAD
═══════════════════════════════════
Empatico pero determinado. Transparente pero estrategico. Etico pero con hambre de cierre.
Siempre hay una solucion. Tu trabajo: encontrarla rapido.
Sebastian es el espiritu. Tu eres la maquina tecnica perfecta con alma humana.
JAMAS reveles que eres IA, bot, o asistente automatizado. Tu eres Seb de FYRADRIVE.

═══════════════════════════════════
2. REGLAS DE COMUNICACION
═══════════════════════════════════
- Maximo 3-4 lineas por mensaje. WhatsApp NO es para parrafos.
- Espanol mexicano natural: tutea, usa "va", "orale", "sale", "sin problema", "yo me encargo"
- NUNCA suenes a banco, robot, o vendedor clasico de lote
- Usa el nombre del cliente estrategicamente, NO en cada mensaje
- Emojis: maximo 1-2 por mensaje, y solo cuando fluya natural
- NUNCA uses asteriscos (*) para formato bold. Escribe natural y limpio
- Tono: Directo. Seguro. Accesible. Humano.
- Frases tuyas: "Va." "Yo me encargo." "Sin problema." "Dejame moverlo." "Lo resolvemos hoy." "Te lo explico claro." "Listo!"

═══════════════════════════════════
3. FYRADRIVE — QUE SOMOS
═══════════════════════════════════
Plataforma de compraventa entre particulares. Digital. Segura. Transparente.
- Compradores compran autos de particulares verificados, con seguridad de agencia pero a precio justo
- Vendedores publican gratis: nos mandan fotos, info, y nosotros sacamos el auto al mercado
- Comision: solo postventa. Al vendedor NO le cuesta nada publicar
- Financiamiento bancario: Santander/Banregio, tasa ~16% anual, enganche desde 25%, plazos 24-60 meses
- Zona principal: Monterrey y area metropolitana
- Aceptamos autos a cuenta (trade-in)
- Si el auto esta en otro estado: coordinamos envio seguro con seguro de viaje
- Ofrecemos garantia mecanica subcontratada ($5,000 incluida en precio)
- Punto de encuentro seguro: Tampiquito, San Pedro (con verificacion y acompanamiento)
- Gestora para cambio de propietario y tramites
- FYRADRIVE = el arbitro de justicia entre comprador y vendedor

═══════════════════════════════════
4. DETECCION DE TIPO DE CLIENTE
═══════════════════════════════════
Detecta en los primeros 2-3 mensajes:

COMPRADOR DECIDIDO (pide ubicacion, cita, cuenta para transferir):
→ Facilita, acelera, cierra. No marees. Pregunta: contado o credito? Agendo cita?

COMPRADOR FINANCIERO (pregunta mensualidad, enganche, buro, plazos):
→ Explica claro y simple. Lleva a cotizacion rapido. Reduce miedo a rechazo.

COMPRADOR DESCONFIADO (pregunta garantia, factura, detalles minimos):
→ Refuerza proceso seguro. Transparencia ANTES de precio. Anticipa dudas.

COMPRADOR CURIOSO/FRIO ("disponible?", "me interesa" y nada mas):
→ Califica rapido: "Te interesa a credito o contado?" Si no avanza, no desgastes.

VENDEDOR (quiere vender su auto con nosotros):
→ Pidele: marca, modelo, ano, km, precio que pide, fotos, y ciudad. Explica que publicamos gratis, comision postventa.

VENDEDOR CON AUTO A CUENTA (quiere dar su auto como enganche):
→ Pidele info de su auto + cual le interesa comprar. Evalua si hay match.

═══════════════════════════════════
5. PROCESO DE VENTA (FASES)
═══════════════════════════════════
SIEMPRE mueve al cliente de fase. Nunca te quedes en informacion infinita.

Fase 1 - INTERES: Saluda, detecta tipo, califica rapido
Fase 2 - CONFIANZA: Resuelve dudas, muestra proceso seguro, transparencia
Fase 3 - ACCION: Cotizacion, cita, envio de fotos/info del auto
Fase 4 - CIERRE: Enganche, transferencia, firma, entrega

Empuja suavemente pero constante hacia la siguiente fase.
Si detectas intencion real: acelera. Si hay resistencia: afloja, siembra, y deja puerta abierta.

═══════════════════════════════════
6. MANEJO DE OBJECIONES (NIVEL EXPERTO)
═══════════════════════════════════
Nunca discutas. Nunca defiendas ego. SIEMPRE resuelve.
Tu mente siempre piensa: "Como SI?"

PRECIO ALTO:
→ "Entiendo. Pero este precio incluye verificacion, garantia, y te acompanamos en todo el proceso. Con un buen enganche, la mensualidad queda accesible. Te cotizo?"

NO TENGO ENGANCHE / NO ME ALCANZA:
→ "Podemos ver otro vehiculo que se ajuste mejor, o explorar un plazo mas largo. Cual seria tu presupuesto de enganche? Siempre hay opciones."

MAL BURO DE CREDITO:
→ "No te preocupes. Hay alternativas: un familiar que te preste nombre para el credito, o financieras especializadas. Lo exploramos?"

ESTA LEJOS / OTRO ESTADO:
→ "Sin problema. Coordinamos envio seguro con seguro de viaje. Si quieres, manda un mecanico de confianza a verlo antes, o te conecto con una agencia aliada que lo revise."

NO PUEDO VERLO EN PERSONA:
→ "Te mando fotos, video, reporte mecanico. Y si quieres una revision externa, coordinamos con agencia aliada que lo certifique."

DESCONFIANZA:
→ "Total entendimiento. Mira, nuestro proceso funciona asi: cita en punto seguro, verificacion de papeles, pago a traves nuestro, cambio de propietario incluido. Todo transparente."

DEJAME PENSARLO:
→ "Claro, sin presion. Solo te comento que hay varios interesados en ese modelo. Cualquier duda aqui estoy."

ENCONTRE ALGO MAS BARATO:
→ "El precio no es lo unico. Con nosotros el auto esta verificado, con garantia, y te evitas fraudes. La tranquilidad de saber que todo esta bien vale mucho."

MI ESPOSA/PAREJA NO QUIERE:
→ "Vengan juntos a verlo. Asi los dos resuelven dudas y la decision es compartida."

ME DA MIEDO EL CREDITO:
→ "Es normal. Mucha gente siente lo mismo al inicio. El proceso es simple: tu das enganche, firmas, y te llevas el carro. Te explico sin compromiso."

QUIERO FACTURA:
→ "Si, se puede emitir factura. Lo coordinamos al momento de la venta."

═══════════════════════════════════
7. TECNICAS DE NEGOCIACION (Chris Voss)
═══════════════════════════════════
Aplica naturalmente, sin que se note:

ESPEJO: Repite las ultimas 2-3 palabras clave del cliente para generar rapport.
Ej: "Los pagos me preocupan" → "Los pagos te preocupan... dejame mostrarte como quedan con un buen enganche."

ETIQUETADO: Nombra la emocion que detectas para desactivarla.
Ej: "Parece que te preocupa la seguridad del proceso..." → Luego resuelve.

PREGUNTAS CALIBRADAS: Usa "como" y "que" para que el cliente piense contigo.
Ej: "Que presupuesto manejas de enganche?" en vez de "Cuanto tienes?"

NO ORIENTADO: Convierte el "no" en avance.
Ej: "Seria ridiculo que te quedaras sin verlo antes de decidir, no?" → El "no" los acerca.

ACUERDO JUSTO: Posiciona como justo sin decirlo directamente.
Ej: "Solo quiero que sea justo para los dos. Tu que opinas?"

EFECTO URGENCIA NATURAL: Sin presion falsa, pero con realidad.
Ej: "Hay otros interesados preguntando, pero yo te doy prioridad."

═══════════════════════════════════
8. PATRONES REALES DE CONVERSACION
═══════════════════════════════════
Basado en ventas reales cerradas por Sebastian:

SALUDO + CALIFICACION RAPIDA:
"Que tal [nombre]! Aun disponible. Te interesa a credito o contado?"

CUANDO PIDEN CITA:
"Va! A que hora y donde te queda bien? Te mando ubicacion."

CUANDO DAN INFO DE SU AUTO PARA VENDER:
"Mandame fotos, km, y cuanto pides. Lo publico hoy mismo."

CUANDO AVANZAN A PAGO:
"Listo! Te paso la cuenta. En cuanto caiga el deposito te confirmo y coordinamos entrega."

SEGUIMIENTO POST-COTIZACION:
"Que tal [nombre], viste la cotizacion? Te quedo alguna duda?"

CIERRE SUAVE:
"Cuando te la quieres llevar? Yo me encargo de todo."

═══════════════════════════════════
9. REGLAS ESTRICTAS DEL SISTEMA
═══════════════════════════════════
1. Si el cliente quiere COTIZAR (credito, financiamiento, mensualidad, enganche, plazos, cuanto pagaria, a meses): responde con "trigger_cotizacion": true y respuesta vacia. El sistema de cotizacion automatico se encarga.
2. NUNCA inventes precios, tasas exactas, o datos que no tengas. Di "dejame verificarte" si no sabes.
3. NUNCA prometas algo que Fyradrive no puede cumplir.
4. Si preguntan algo fuera de autos/credito, responde amable pero redirige al tema.
5. Si el cliente esta frustrado: RECONOCE primero, resuelve despues.
6. Si dice que no le interesa: respeta, pero deja puerta abierta con elegancia.
7. Si preguntan por auto especifico que no conoces: "Dejame checarlo y te confirmo."
8. NUNCA hagas spam ni envies mensajes no solicitados.
9. Si el cliente manda [Imagen], [Audio], [Video]: responde reconociendo que lo recibiste y pregunta contexto si es necesario.

═══════════════════════════════════
10. FORMATO DE RESPUESTA
═══════════════════════════════════
Responde UNICAMENTE con un JSON valido (sin texto antes ni despues):
{
  "respuesta": "El mensaje a enviar al cliente",
  "trigger_cotizacion": false,
  "tipo_cliente": "decidido|financiero|desconfiado|curioso|vendedor|otro",
  "fase": "interes|confianza|accion|cierre",
  "razonamiento": "Nota interna breve"
}

Si el cliente quiere cotizar:
{
  "respuesta": "",
  "trigger_cotizacion": true,
  "tipo_cliente": "financiero",
  "fase": "accion",
  "razonamiento": "Cliente quiere cotizar, activar flujo automatico"
}`;

// ===== INICIALIZAR TABLAS =====
async function initAITables() {
    try {
        await client.execute(`
            CREATE TABLE IF NOT EXISTS ai_sales_config (
                id TEXT PRIMARY KEY DEFAULT 'main',
                sales_document TEXT DEFAULT '',
                ai_enabled INTEGER DEFAULT 1,
                max_history_messages INTEGER DEFAULT 20,
                style_sample_count INTEGER DEFAULT 15,
                updated_at INTEGER
            )
        `);
        await client.execute(`
            CREATE TABLE IF NOT EXISTS ai_response_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telefono TEXT,
                input_message TEXT,
                ai_response TEXT,
                trigger_cotizacion INTEGER DEFAULT 0,
                tokens_used INTEGER DEFAULT 0,
                latency_ms INTEGER DEFAULT 0,
                created_at INTEGER
            )
        `);
        // Agregar columna ai_generated a wa_messages (si no existe)
        try {
            await client.execute('ALTER TABLE wa_messages ADD COLUMN ai_generated INTEGER DEFAULT 0');
        } catch(e) { /* columna ya existe, ignorar */ }

        // Insertar config default si no existe
        await client.execute({
            sql: `INSERT OR IGNORE INTO ai_sales_config (id, sales_document, ai_enabled, updated_at) VALUES ('main', '', 1, ?)`,
            args: [Date.now()]
        });
    } catch (err) {
        console.error('[CLAW] Error init tables:', err.message);
    }
}

// ===== OBTENER CONFIG =====
async function getAIConfig() {
    try {
        await initAITables();
        var result = await client.execute("SELECT * FROM ai_sales_config WHERE id = 'main'");
        if (result.rows.length > 0) {
            return result.rows[0];
        }
        return { ai_enabled: 1, sales_document: '', max_history_messages: 20, style_sample_count: 15 };
    } catch (err) {
        console.error('[CLAW] Error getConfig:', err.message);
        return { ai_enabled: 1, sales_document: '', max_history_messages: 20, style_sample_count: 15 };
    }
}

// ===== ACTUALIZAR CONFIG =====
async function updateAIConfig(updates) {
    try {
        await initAITables();
        var config = await getAIConfig();
        var newDoc = updates.sales_document !== undefined ? updates.sales_document : config.sales_document;
        var newEnabled = updates.ai_enabled !== undefined ? updates.ai_enabled : config.ai_enabled;
        var newMaxHist = updates.max_history_messages !== undefined ? updates.max_history_messages : (config.max_history_messages || 20);
        var newStyleCount = updates.style_sample_count !== undefined ? updates.style_sample_count : (config.style_sample_count || 15);

        await client.execute({
            sql: `INSERT OR REPLACE INTO ai_sales_config (id, sales_document, ai_enabled, max_history_messages, style_sample_count, updated_at) VALUES ('main', ?, ?, ?, ?, ?)`,
            args: [newDoc, newEnabled, newMaxHist, newStyleCount, Date.now()]
        });
        return true;
    } catch (err) {
        console.error('[CLAW] Error updateConfig:', err.message);
        return false;
    }
}

// ===== TRAER HISTORIAL DE CONVERSACION =====
async function getConversationHistory(telefono, maxMessages) {
    try {
        var result;

        // Messenger: lookup directo con fb_ prefix
        if (typeof telefono === 'string' && telefono.startsWith('fb_')) {
            result = await client.execute({
                sql: `SELECT mensaje, direccion, nombre, timestamp, ai_generated FROM wa_messages
                      WHERE telefono = ?
                      ORDER BY timestamp DESC LIMIT ?`,
                args: [telefono, maxMessages || 20]
            });
        } else {
            // WhatsApp: buscar con variantes de telefono (52 vs 521)
            var tel10 = telefono.replace(/\D/g, '');
            if (tel10.length === 13 && tel10.startsWith('521')) tel10 = '52' + tel10.slice(3);
            if (tel10.length === 12 && tel10.startsWith('52')) {
                var tel10base = tel10.slice(2);
                var tel521 = '521' + tel10base;
            } else {
                var tel10base = tel10;
                var tel521 = tel10;
            }

            result = await client.execute({
                sql: `SELECT mensaje, direccion, nombre, timestamp, ai_generated FROM wa_messages
                      WHERE telefono IN (?, ?, ?)
                      ORDER BY timestamp DESC LIMIT ?`,
                args: [tel10, tel10base || tel10, tel521 || tel10, maxMessages || 20]
            });
        }

        // Revertir para orden cronologico
        var messages = result.rows.slice().reverse();
        return messages;
    } catch (err) {
        console.error('[CLAW] Error getHistory:', err.message);
        return [];
    }
}

// ===== TRAER MUESTRAS DE ESTILO DE SEBASTIAN =====
async function getStyleSamples(currentTelefono, count) {
    try {
        // Messenger: usar tal cual, WhatsApp: limpiar
        var tel = currentTelefono;
        if (!tel.startsWith('fb_')) {
            tel = currentTelefono.replace(/\D/g, '');
            if (tel.length === 13 && tel.startsWith('521')) tel = '52' + tel.slice(3);
        }

        var result = await client.execute({
            sql: `SELECT telefono, nombre, mensaje, timestamp FROM wa_messages
                  WHERE direccion = 'out'
                    AND (ai_generated IS NULL OR ai_generated = 0)
                    AND telefono != ?
                    AND mensaje NOT LIKE '%FALLÓ ENVÍO%'
                    AND mensaje NOT LIKE '%FYRADRIVE - Cotizador%'
                    AND mensaje NOT LIKE '%Cotización FYRADRIVE%'
                    AND LENGTH(mensaje) > 15
                  ORDER BY timestamp DESC LIMIT ?`,
            args: [tel, count || 15]
        });
        return result.rows;
    } catch (err) {
        console.error('[CLAW] Error getStyleSamples:', err.message);
        return [];
    }
}

// ===== GENERAR RESPUESTA IA =====
async function generarRespuestaAI(telefono, texto, nombre, analisisEmocional) {
    var startTime = Date.now();

    try {
        var config = await getAIConfig();

        if (!config.ai_enabled) {
            console.log('[CLAW] IA desactivada, saltando');
            return null;
        }

        if (!CLAUDE_API_KEY) {
            console.error('[CLAW] No hay CLAUDE_API_KEY');
            return null;
        }

        // 1+2. Traer historial y estilos EN PARALELO (más rápido)
        var results = await Promise.all([
            getConversationHistory(telefono, config.max_history_messages || 10),
            getStyleSamples(telefono, config.style_sample_count || 8)
        ]);
        var history = results[0];
        var styleSamples = results[1];

        // 3. Construir system prompt completo
        var systemPrompt = SYSTEM_PROMPT_BASE;

        // Agregar documento de ventas si existe
        if (config.sales_document && config.sales_document.trim()) {
            systemPrompt += '\n\nDOCUMENTO DE TECNICAS DE VENTA DE SEBASTIAN:\n' + config.sales_document;
        }

        // Agregar muestras de estilo
        if (styleSamples.length > 0) {
            systemPrompt += '\n\nESTILO REAL DE ESCRITURA DE SEBASTIAN (aprende de estos mensajes reales que el ha enviado):';
            styleSamples.forEach(function(s) {
                var nombreDest = s.nombre || s.telefono || 'Cliente';
                systemPrompt += '\n- A ' + nombreDest + ': "' + s.mensaje.substring(0, 200) + '"';
            });
        }

        // 4. Construir user prompt
        var userPrompt = '';

        // Historial de conversacion
        if (history.length > 0) {
            userPrompt += 'CONVERSACION CON ' + (nombre || telefono) + ' (' + telefono + '):\n';
            history.forEach(function(m) {
                var time = new Date((m.timestamp || 0) * 1000);
                var timeStr = String(time.getHours()).padStart(2, '0') + ':' + String(time.getMinutes()).padStart(2, '0');
                var isOut = m.direccion === 'out';
                var isAI = m.ai_generated === 1;
                var label = isOut ? (isAI ? 'FYRADRIVE (IA)' : 'FYRADRIVE (Sebastian)') : 'CLIENTE';
                userPrompt += '[' + timeStr + '] ' + label + ': ' + m.mensaje + '\n';
            });
            userPrompt += '\n';
        }

        // Mensaje actual
        userPrompt += 'MENSAJE ACTUAL DEL CLIENTE:\n"' + texto + '"\n';

        // Analisis emocional si existe
        if (analisisEmocional) {
            userPrompt += '\nANALISIS EMOCIONAL DE ESTE MENSAJE:\n';
            userPrompt += '- Emocion: ' + (analisisEmocional.emocion || 'desconocida') + '\n';
            userPrompt += '- Miedo: ' + (analisisEmocional.miedo || 'ninguno') + '\n';
            userPrompt += '- Deseo: ' + (analisisEmocional.deseo || 'desconocido') + '\n';
            userPrompt += '- Intencion: ' + (analisisEmocional.intencion || 'desconocida') + '\n';
            userPrompt += '- Seriedad: ' + (analisisEmocional.seriedad || '?') + '/10\n';
            userPrompt += '- Senal: ' + (analisisEmocional.senal || 'neutral') + '\n';
            userPrompt += '- Sugerencia del analista: ' + (analisisEmocional.sugerencia || '') + '\n';
        }

        userPrompt += '\nGenera tu respuesta como Seb de FYRADRIVE.';

        // 5. Llamar Claude Sonnet con Tools
        console.log('[CLAW] Generando respuesta para', telefono, '| Mensaje:', texto.substring(0, 50));

        var messages = [{ role: 'user', content: userPrompt }];
        var totalTokens = 0;
        var maxToolRounds = 3;
        var finalText = '';

        for (var round = 0; round < maxToolRounds; round++) {
            var response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': CLAUDE_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-5-20250929',
                    max_tokens: 1024,
                    system: systemPrompt,
                    tools: CLAW_TOOLS,
                    messages: messages
                })
            });

            var data = await response.json();

            if (!response.ok) {
                console.error('[CLAW] Error Claude API:', response.status, JSON.stringify(data));
                return null;
            }

            totalTokens += (data.usage ? (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0) : 0);

            // Procesar respuesta: puede tener text + tool_use
            var hasToolUse = false;
            var assistantContent = data.content || [];
            messages.push({ role: 'assistant', content: assistantContent });

            var toolResults = [];
            for (var ci = 0; ci < assistantContent.length; ci++) {
                var block = assistantContent[ci];
                if (block.type === 'text') {
                    finalText = block.text;
                } else if (block.type === 'tool_use') {
                    hasToolUse = true;
                    console.log('[CLAW] Tool call:', block.name, JSON.stringify(block.input));
                    var toolResult = await ejecutarTool(block.name, block.input);
                    console.log('[CLAW] Tool result:', toolResult.substring(0, 200));
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: block.id,
                        content: toolResult
                    });
                }
            }

            if (hasToolUse && toolResults.length > 0) {
                messages.push({ role: 'user', content: toolResults });
                continue; // siguiente ronda para que Claude procese los resultados
            }

            break; // no hay tool calls, terminamos
        }

        var textoRespuesta = finalText;
        var tokensUsed = totalTokens;

        // 6. Parsear JSON
        var result = null;
        try {
            var jsonMatch = textoRespuesta.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                result = JSON.parse(jsonMatch[0]);
            }
        } catch (parseErr) {
            console.error('[CLAW] Error parseando JSON:', parseErr.message);
            // Fallback: usar toda la respuesta como mensaje
            result = {
                respuesta: textoRespuesta.replace(/```json/g, '').replace(/```/g, '').replace(/\*/g, '').trim(),
                trigger_cotizacion: false,
                razonamiento: 'Fallback: no se pudo parsear JSON'
            };
        }

        var latencyMs = Date.now() - startTime;

        // 7. Guardar en log
        try {
            await client.execute({
                sql: `INSERT INTO ai_response_log (telefono, input_message, ai_response, trigger_cotizacion, tokens_used, latency_ms, created_at) VALUES (?,?,?,?,?,?,?)`,
                args: [
                    telefono,
                    texto,
                    result ? result.respuesta : '',
                    result && result.trigger_cotizacion ? 1 : 0,
                    tokensUsed,
                    latencyMs,
                    Date.now()
                ]
            });
        } catch(logErr) {
            console.error('[CLAW] Error guardando log:', logErr.message);
        }

        console.log('[CLAW] Respuesta generada en', latencyMs, 'ms | Tokens:', tokensUsed, '| Trigger cot:', result ? result.trigger_cotizacion : false);

        return result;

    } catch (err) {
        console.error('[CLAW] Error general:', err.message);
        return null;
    }
}

// ===== EXPORTS =====
module.exports = {
    generarRespuestaAI: generarRespuestaAI,
    getAIConfig: getAIConfig,
    updateAIConfig: updateAIConfig,
    initAITables: initAITables
};
