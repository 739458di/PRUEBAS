// WhatsApp Webhook + Chatbot FYRADRIVE
// Recibe mensajes, detecta intención de cotización, captura datos, genera cotización
// GET  /api/webhook = verificación del webhook
// POST /api/webhook = mensaje entrante + respuesta automática

const { createClient } = require('@libsql/client');

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzA4MjUwMDYsImlkIjoiYTczOTliMjctYWFlNi00YjhmLWJmYjktODQ2M2JmMWU1MzljIiwicmlkIjoiNWVhMDBiM2QtNzNiNS00Njg3LWFjN2YtMTNhMGQzZmJlZmM1In0.ZVnn2UF2WdEw_yvQYGGB9Eyvbh_JRniPhkByn6Vxiavki0FkHVM8Xb0cwu1Ijrhti_j3iiOxS5jtt2IwCRWvDA'
});

const WA_TOKEN = process.env.WA_TOKEN || 'EAAcJmKFNOhYBQvLYIJj611y1ZCLmASwZC76pbuKuLG3sLfCBrLFEsasPOlIcWZAyQ1tbvFBbbXghvaNXIjC2MZCYilaz4y24GCO9rd7ZCMukRhqMOTZAzLyieIycDjww4DmyboZCbTSG7XknyZBJ3nWYZCMb4llOuTZAqkm9OVBn5B0AomBVezqWfrnK25wl9TJpDHiZAvHiZARAZBHUsoI2BF9tBbZAL2c9Dqe1gBYESbjLiHFIpzMUt0dE7Lraj0Xd8SBmtZArzUEDXv62UienZCCq4v8TpSBG';
const PHONE_NUMBER_ID = '968960759641278';
const WA_API_URL = 'https://graph.facebook.com/v21.0/' + PHONE_NUMBER_ID + '/messages';
const VERIFY_TOKEN = 'fyradrive_webhook_2026';

// ===== COTIZADOR FORMULAS (idénticas al CRM) =====
var COT_TASA_ANUAL = 0.1599;
var COT_TASA_MENSUAL = COT_TASA_ANUAL / 12;
var COT_SEGURO_VIDA = 1800;
var COT_COMISION = 0.0201;
var COT_IVA = 0.16;
var COT_DESCUENTO = 400;

function calcularCotizacion(precio, enganche, plazo) {
    var financiamiento = precio - enganche;
    var subtotal = financiamiento + COT_SEGURO_VIDA;
    var iva = subtotal * COT_IVA;
    var montoFinanciar = subtotal + iva;
    var r = COT_TASA_MENSUAL;
    var n = plazo;
    var mensualidad = montoFinanciar * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
    mensualidad = mensualidad - COT_DESCUENTO;
    var comision = precio * COT_COMISION;
    var desembolso = enganche + comision;
    var total = mensualidad * plazo;
    return {
        precio: precio,
        enganche: enganche,
        plazo: plazo,
        financiamiento: financiamiento,
        montoFinanciar: montoFinanciar,
        mensualidad: Math.round(mensualidad * 100) / 100,
        comision: Math.round(comision),
        desembolso: Math.round(desembolso),
        total: Math.round(total),
        iva: Math.round(iva)
    };
}

function formatMoney(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
}

// ===== KEYWORDS DE DETECCION =====
var COTIZACION_KEYWORDS = [
    'cotiza', 'cotizacion', 'cotización', 'credito', 'crédito',
    'financiamiento', 'financiar', 'mensualidad', 'mensualidades',
    'plazos', 'plazo', 'enganche', 'prestamo', 'préstamo',
    'banco', 'bancario', 'pagar a meses', 'a meses', 'meses sin intereses',
    'cuanto queda', 'cuánto queda', 'cuanto me queda', 'cuánto me queda',
    'cuanto pagaria', 'cuánto pagaría', 'cuanto saldria', 'cuánto saldría',
    'quiero financiar', 'puedo financiar', 'me financian',
    'a credito', 'a crédito', 'con credito', 'con crédito'
];

var SI_KEYWORDS = ['si', 'sí', 'sale', 'ok', 'okay', 'dale', 'va', 'claro', 'por favor', 'porfavor', 'porfa', 'yes', 'orale', 'órale', 'arre', 'simon', 'simón', 'adelante', 'quiero', 'me interesa'];
var NO_KEYWORDS = ['no', 'nel', 'nah', 'nop', 'no gracias', 'luego', 'despues', 'después', 'ahora no'];

// ===== TABLA DE CONVERSACIONES (estados del chatbot) =====
async function initTables() {
    try {
        await client.execute(`
            CREATE TABLE IF NOT EXISTS wa_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                wa_id TEXT, telefono TEXT, nombre TEXT, mensaje TEXT,
                tipo TEXT DEFAULT 'text', direccion TEXT DEFAULT 'in',
                timestamp INTEGER, mensaje_id TEXT, leido INTEGER DEFAULT 0,
                created_at INTEGER
            )
        `);
        await client.execute(`
            CREATE TABLE IF NOT EXISTS wa_conversations (
                telefono TEXT PRIMARY KEY,
                estado TEXT DEFAULT 'idle',
                nombre TEXT DEFAULT '',
                dato_precio REAL DEFAULT 0,
                dato_enganche REAL DEFAULT 0,
                dato_plazo INTEGER DEFAULT 0,
                dato_vehiculo TEXT DEFAULT '',
                paso TEXT DEFAULT '',
                updated_at INTEGER
            )
        `);
    } catch (err) {
        console.error('initTables error:', err);
    }
}

async function getConversation(telefono) {
    var result = await client.execute({
        sql: 'SELECT * FROM wa_conversations WHERE telefono = ?',
        args: [telefono]
    });
    if (result.rows.length === 0) return null;
    return result.rows[0];
}

async function setConversation(telefono, data) {
    var existing = await getConversation(telefono);
    if (existing) {
        await client.execute({
            sql: `UPDATE wa_conversations SET estado=?, nombre=?, dato_precio=?, dato_enganche=?, dato_plazo=?, dato_vehiculo=?, paso=?, updated_at=? WHERE telefono=?`,
            args: [data.estado || 'idle', data.nombre || '', data.dato_precio || 0, data.dato_enganche || 0, data.dato_plazo || 0, data.dato_vehiculo || '', data.paso || '', Date.now(), telefono]
        });
    } else {
        await client.execute({
            sql: `INSERT INTO wa_conversations (telefono, estado, nombre, dato_precio, dato_enganche, dato_plazo, dato_vehiculo, paso, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
            args: [telefono, data.estado || 'idle', data.nombre || '', data.dato_precio || 0, data.dato_enganche || 0, data.dato_plazo || 0, data.dato_vehiculo || '', data.paso || '', Date.now()]
        });
    }
}

// ===== LIMPIAR TELEFONO MEXICO =====
function cleanPhone(tel) {
    var clean = tel.replace(/\D/g, '');
    // Meta manda 521XXXXXXXXXX (13 digitos) pero el API necesita 52XXXXXXXXXX (12 digitos)
    if (clean.length === 13 && clean.startsWith('521')) {
        clean = '52' + clean.substring(3);
    }
    return clean;
}

// ===== ENVIAR MENSAJE =====
async function sendMessage(to, text) {
    try {
        var cleanTo = cleanPhone(to);
        console.log('[FYRA-BOT] Enviando mensaje a:', cleanTo, '| Texto:', text.substring(0, 50) + '...');

        var response = await fetch(WA_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + WA_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: cleanTo,
                type: 'text',
                text: { preview_url: false, body: text }
            })
        });
        var data = await response.json();

        console.log('[FYRA-BOT] Respuesta Meta:', response.status, JSON.stringify(data));

        // SOLO guardar si Meta realmente envió el mensaje
        if (response.ok && data.messages && data.messages.length > 0) {
            await client.execute({
                sql: `INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
                args: [cleanTo, cleanTo, 'FYRADRIVE', text, 'text', 'out', Math.floor(Date.now() / 1000), data.messages[0].id, Date.now()]
            });
            console.log('[FYRA-BOT] Mensaje enviado y guardado OK:', data.messages[0].id);
            return data;
        } else {
            // Meta falló - guardar error para debug pero NO como mensaje enviado
            console.error('[FYRA-BOT] ERROR Meta API:', response.status, JSON.stringify(data));
            // Guardar como mensaje fallido para que aparezca en el CRM con indicación de error
            await client.execute({
                sql: `INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
                args: [cleanTo, cleanTo, 'FYRADRIVE', '❌ FALLÓ ENVÍO: ' + text, 'text', 'out', Math.floor(Date.now() / 1000), 'ERROR-' + Date.now(), Date.now()]
            });
            return null;
        }
    } catch (err) {
        console.error('[FYRA-BOT] sendMessage EXCEPCION:', err.message);
        return null;
    }
}

// ===== GUARDAR MENSAJE ENTRANTE =====
async function saveMessage(data) {
    try {
        await client.execute({
            sql: `INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
            args: [data.wa_id || '', data.telefono || '', data.nombre || '', data.mensaje || '', data.tipo || 'text', data.direccion || 'in', data.timestamp || Math.floor(Date.now() / 1000), data.mensaje_id || '', Date.now()]
        });
    } catch (err) {
        console.error('saveMessage error:', err);
    }
}

// ===== EXTRAER NUMERO DE UN TEXTO =====
function extraerNumero(texto) {
    // Buscar números con o sin formato: 590000, 590,000, $590,000, 590k, 590mil
    var t = texto.toLowerCase().replace(/,/g, '').replace(/\$/g, '').trim();

    // "590k" o "590 mil"
    var matchK = t.match(/(\d+(?:\.\d+)?)\s*(?:k|mil)/);
    if (matchK) return parseFloat(matchK[1]) * 1000;

    // Número directo
    var matchNum = t.match(/(\d+(?:\.\d+)?)/);
    if (matchNum) {
        var num = parseFloat(matchNum[1]);
        // Si es menor a 1000 probablemente es en miles (ej: "590" = 590,000 para precio)
        return num;
    }
    return 0;
}

function extraerPlazo(texto) {
    var t = texto.toLowerCase();
    // Buscar meses directamente
    var matchMeses = t.match(/(\d+)\s*(?:meses|mes)/);
    if (matchMeses) return parseInt(matchMeses[1]);
    // Solo número
    var matchNum = t.match(/(\d+)/);
    if (matchNum) return parseInt(matchNum[1]);
    return 0;
}

// ===== LOGICA DEL CHATBOT =====
async function procesarMensaje(telefono, nombre, texto) {
    await initTables();
    var conv = await getConversation(telefono);
    var estado = conv ? conv.estado : 'idle';
    var textoLower = texto.toLowerCase().trim();

    // ---- ESTADO: IDLE (sin conversación activa) ----
    if (estado === 'idle' || !estado) {
        // Detectar keywords de cotización
        var esCotizacion = COTIZACION_KEYWORDS.some(function(kw) {
            return textoLower.includes(kw);
        });

        if (esCotizacion) {
            await setConversation(telefono, {
                estado: 'ofreciendo_cotizacion',
                nombre: nombre,
                dato_precio: 0, dato_enganche: 0, dato_plazo: 0, dato_vehiculo: '',
                paso: ''
            });
            await sendMessage(telefono,
                '🚗 *FYRADRIVE - Cotizador de Crédito Automotriz*\n\n' +
                'Con gusto te cotizamos tu crédito! 📊\n\n' +
                'Manejamos financiamiento bancario con:\n' +
                '✅ Tasa competitiva\n' +
                '✅ Plazos de 24 a 60 meses\n' +
                '✅ Enganche desde 25%\n\n' +
                '¿Te gustaría que te hagamos una cotización personalizada? 🤔\n\n' +
                '_Responde *SI* para continuar_'
            );
            return;
        }

        // Si no es cotización, saludo genérico
        await setConversation(telefono, { estado: 'idle', nombre: nombre });
        await sendMessage(telefono,
            '¡Hola' + (nombre ? ' ' + nombre.split(' ')[0] : '') + '! 👋\n\n' +
            'Bienvenido a *FYRADRIVE* 🚗\n' +
            'Somos especialistas en compra y venta de autos.\n\n' +
            '¿En qué te podemos ayudar?\n\n' +
            '📊 Escribe *"cotización"* para cotizar un crédito automotriz\n' +
            '📞 O un asesor se comunicará contigo pronto'
        );
        return;
    }

    // ---- ESTADO: OFRECIENDO COTIZACION (esperando SI/NO) ----
    if (estado === 'ofreciendo_cotizacion') {
        var esSi = SI_KEYWORDS.some(function(kw) { return textoLower === kw || textoLower.startsWith(kw + ' '); });
        var esNo = NO_KEYWORDS.some(function(kw) { return textoLower === kw || textoLower.startsWith(kw + ' '); });

        if (esSi) {
            await setConversation(telefono, {
                estado: 'pidiendo_precio',
                nombre: nombre || (conv ? conv.nombre : ''),
                dato_precio: 0, dato_enganche: 0, dato_plazo: 0, dato_vehiculo: '',
                paso: 'precio'
            });
            await sendMessage(telefono,
                '¡Perfecto! Vamos a armar tu cotización 📋\n\n' +
                '*Paso 1 de 3:* 💰 ¿Cuál es el *precio del vehículo*?\n\n' +
                '_Ejemplo: 350000 o 350k_'
            );
            return;
        }

        if (esNo) {
            await setConversation(telefono, { estado: 'idle', nombre: nombre || (conv ? conv.nombre : '') });
            await sendMessage(telefono,
                'Sin problema! 👍\n\n' +
                'Cuando quieras cotizar, solo escribe *"cotización"* y con gusto te ayudamos.\n\n' +
                '¡Estamos para servirte! 🚗'
            );
            return;
        }

        // No entendió
        await sendMessage(telefono, '¿Te gustaría que te hagamos la cotización? Responde *SI* o *NO* 🤔');
        return;
    }

    // ---- ESTADO: PIDIENDO PRECIO ----
    if (estado === 'pidiendo_precio') {
        var precio = extraerNumero(textoLower);
        if (precio > 0 && precio < 1000) precio = precio * 1000; // 350 → 350,000

        if (precio < 50000) {
            await sendMessage(telefono, 'Hmm, ese precio parece muy bajo 🤔\n\n¿Cuál es el *precio del vehículo*? (ej: 350000)');
            return;
        }
        if (precio > 5000000) {
            await sendMessage(telefono, 'Ese precio parece muy alto 🤔\n\n¿Cuál es el *precio del vehículo*? (ej: 350000)');
            return;
        }

        await setConversation(telefono, {
            estado: 'pidiendo_enganche',
            nombre: conv ? conv.nombre : nombre,
            dato_precio: precio,
            dato_vehiculo: conv ? conv.dato_vehiculo : '',
            paso: 'enganche'
        });
        await sendMessage(telefono,
            '✅ Precio: *' + formatMoney(precio) + '*\n\n' +
            '*Paso 2 de 3:* 💵 ¿Cuánto darías de *enganche*?\n\n' +
            'Mínimo el 25% = ' + formatMoney(precio * 0.25) + '\n\n' +
            '_Ejemplo: ' + Math.round(precio * 0.30 / 1000) + '000 o ' + Math.round(precio * 0.30 / 1000) + 'k_'
        );
        return;
    }

    // ---- ESTADO: PIDIENDO ENGANCHE ----
    if (estado === 'pidiendo_enganche') {
        var precioActual = conv ? conv.dato_precio : 0;
        var enganche = extraerNumero(textoLower);
        if (enganche > 0 && enganche < 1000) enganche = enganche * 1000;

        // Si puso porcentaje
        var matchPct = textoLower.match(/(\d+)\s*%/);
        if (matchPct) {
            enganche = precioActual * (parseInt(matchPct[1]) / 100);
        }

        var minEnganche = precioActual * 0.25;
        if (enganche < minEnganche) {
            await sendMessage(telefono,
                '⚠️ El enganche mínimo es *25%* del precio = *' + formatMoney(minEnganche) + '*\n\n' +
                '¿Cuánto darías de enganche?\n_Puedes escribir el monto o el porcentaje (ej: 30%)_'
            );
            return;
        }
        if (enganche >= precioActual) {
            await sendMessage(telefono, '⚠️ El enganche no puede ser mayor al precio 🤔\n\n¿Cuánto darías de *enganche*?');
            return;
        }

        await setConversation(telefono, {
            estado: 'pidiendo_plazo',
            nombre: conv ? conv.nombre : nombre,
            dato_precio: precioActual,
            dato_enganche: enganche,
            dato_vehiculo: conv ? conv.dato_vehiculo : '',
            paso: 'plazo'
        });
        await sendMessage(telefono,
            '✅ Enganche: *' + formatMoney(enganche) + '* (' + Math.round(enganche / precioActual * 100) + '%)\n\n' +
            '*Paso 3 de 3:* 📅 ¿A cuántos *meses* te gustaría pagarlo?\n\n' +
            '• 24 meses (2 años)\n' +
            '• 36 meses (3 años)\n' +
            '• 48 meses (4 años)\n' +
            '• 60 meses (5 años)\n\n' +
            '_Escribe el número de meses_'
        );
        return;
    }

    // ---- ESTADO: PIDIENDO PLAZO ----
    if (estado === 'pidiendo_plazo') {
        var plazo = extraerPlazo(textoLower);
        if (plazo < 12 || plazo > 72) {
            await sendMessage(telefono, '⚠️ El plazo debe ser entre *12 y 60 meses*\n\n¿A cuántos meses? (24, 36, 48 o 60)');
            return;
        }

        var precioFinal = conv ? conv.dato_precio : 0;
        var engancheFinal = conv ? conv.dato_enganche : 0;

        // CALCULAR COTIZACION
        var cot = calcularCotizacion(precioFinal, engancheFinal, plazo);

        // Guardar estado completado
        await setConversation(telefono, {
            estado: 'cotizacion_enviada',
            nombre: conv ? conv.nombre : nombre,
            dato_precio: precioFinal,
            dato_enganche: engancheFinal,
            dato_plazo: plazo,
            dato_vehiculo: conv ? conv.dato_vehiculo : '',
            paso: 'completado'
        });

        // Enviar cotización formateada
        await sendMessage(telefono,
            '🎉 *¡Tu Cotización FYRADRIVE está lista!*\n\n' +
            '━━━━━━━━━━━━━━━━━━━\n' +
            '📊 *COTIZACIÓN DE CRÉDITO*\n' +
            '━━━━━━━━━━━━━━━━━━━\n\n' +
            '🚗 *Precio del vehículo:* ' + formatMoney(cot.precio) + '\n' +
            '💵 *Enganche:* ' + formatMoney(cot.enganche) + ' (' + Math.round(cot.enganche / cot.precio * 100) + '%)\n' +
            '🏦 *Financiamiento:* ' + formatMoney(cot.financiamiento) + '\n' +
            '📋 *IVA:* ' + formatMoney(cot.iva) + '\n' +
            '💰 *Monto a financiar:* ' + formatMoney(cot.montoFinanciar) + '\n\n' +
            '━━━━━━━━━━━━━━━━━━━\n' +
            '📅 *Plazo:* ' + cot.plazo + ' meses\n' +
            '💳 *MENSUALIDAD:* *' + formatMoney(cot.mensualidad) + '*\n' +
            '━━━━━━━━━━━━━━━━━━━\n\n' +
            '📌 *Desembolso inicial:*\n' +
            '   Enganche: ' + formatMoney(cot.enganche) + '\n' +
            '   Comisión apertura: ' + formatMoney(cot.comision) + '\n' +
            '   *Total desembolso: ' + formatMoney(cot.desembolso) + '*\n\n' +
            '━━━━━━━━━━━━━━━━━━━\n' +
            '_Tasa anual: 15.99% | Incluye seguro de vida_\n' +
            '_Cotización sujeta a aprobación crediticia_\n\n' +
            '¿Te gustaría agendar una cita para ver el vehículo? 🤝\n' +
            'Escribe *"SI"* y un asesor te contactará\n\n' +
            '¿Quieres cotizar con otros montos? Escribe *"cotización"*'
        );
        return;
    }

    // ---- ESTADO: COTIZACION ENVIADA ----
    if (estado === 'cotizacion_enviada') {
        var esSi2 = SI_KEYWORDS.some(function(kw) { return textoLower === kw || textoLower.startsWith(kw + ' '); });

        // Detectar si quiere otra cotización
        var otraCot = COTIZACION_KEYWORDS.some(function(kw) { return textoLower.includes(kw); });

        if (otraCot) {
            await setConversation(telefono, {
                estado: 'pidiendo_precio',
                nombre: conv ? conv.nombre : nombre,
                dato_precio: 0, dato_enganche: 0, dato_plazo: 0,
                paso: 'precio'
            });
            await sendMessage(telefono,
                '📋 ¡Vamos con otra cotización!\n\n' +
                '*Paso 1 de 3:* 💰 ¿Cuál es el *precio del vehículo*?\n\n' +
                '_Ejemplo: 350000 o 350k_'
            );
            return;
        }

        if (esSi2) {
            await setConversation(telefono, { estado: 'idle', nombre: conv ? conv.nombre : nombre });
            await sendMessage(telefono,
                '🤝 *¡Excelente!*\n\n' +
                'Un asesor de FYRADRIVE se pondrá en contacto contigo muy pronto para agendar tu cita.\n\n' +
                '📞 También puedes llamarnos directamente.\n\n' +
                '¡Gracias por tu interés! 🚗✨'
            );
            return;
        }

        // Cualquier otra cosa, reset
        await setConversation(telefono, { estado: 'idle', nombre: conv ? conv.nombre : nombre });
        await sendMessage(telefono,
            '¡Gracias por tu interés! 😊\n\n' +
            'Si necesitas otra cotización, escribe *"cotización"*\n' +
            'Un asesor te contactará pronto 📞'
        );
        return;
    }

    // ---- ESTADO NO RECONOCIDO: reset ----
    await setConversation(telefono, { estado: 'idle', nombre: nombre });
    await sendMessage(telefono,
        '¡Hola! 👋 Bienvenido a *FYRADRIVE* 🚗\n\n' +
        'Escribe *"cotización"* para cotizar un crédito automotriz 📊'
    );
}

// ===== HANDLER PRINCIPAL =====
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // GET = Verificación del webhook por Meta
    if (req.method === 'GET') {
        var mode = req.query['hub.mode'];
        var token = req.query['hub.verify_token'];
        var challenge = req.query['hub.challenge'];
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            return res.status(200).send(challenge);
        }
        return res.status(403).send('Token invalido');
    }

    // POST = Mensaje entrante
    if (req.method === 'POST') {
        try {
            await initTables();
            var body = req.body;

            if (body.object === 'whatsapp_business_account') {
                var entries = body.entry || [];
                for (var i = 0; i < entries.length; i++) {
                    var changes = entries[i].changes || [];
                    for (var j = 0; j < changes.length; j++) {
                        var value = changes[j].value;

                        if (value.messages) {
                            for (var k = 0; k < value.messages.length; k++) {
                                var msg = value.messages[k];
                                var contacto = value.contacts && value.contacts[0] ? value.contacts[0] : {};
                                var telefono = msg.from || '';
                                var nombre = contacto.profile ? contacto.profile.name : '';
                                var texto = '';

                                if (msg.type === 'text' && msg.text) {
                                    texto = msg.text.body || '';
                                } else if (msg.type === 'image') {
                                    texto = '[Imagen]';
                                } else if (msg.type === 'audio') {
                                    texto = '[Audio]';
                                } else if (msg.type === 'video') {
                                    texto = '[Video]';
                                } else if (msg.type === 'document') {
                                    texto = '[Documento]';
                                } else {
                                    texto = '[' + msg.type + ']';
                                }

                                // Guardar mensaje entrante
                                await saveMessage({
                                    wa_id: telefono,
                                    telefono: telefono,
                                    nombre: nombre,
                                    mensaje: texto,
                                    tipo: msg.type || 'text',
                                    direccion: 'in',
                                    timestamp: parseInt(msg.timestamp) || Math.floor(Date.now() / 1000),
                                    mensaje_id: msg.id || ''
                                });

                                // Procesar con chatbot (solo texto)
                                if (msg.type === 'text' && texto) {
                                    await procesarMensaje(telefono, nombre, texto);
                                }
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error('Webhook error:', err);
        }

        return res.status(200).send('OK');
    }

    return res.status(405).send('Method not allowed');
};
