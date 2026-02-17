// WhatsApp + Messenger Webhook + Chatbot FYRADRIVE + WA-Bridge
// Recibe mensajes de WhatsApp, Messenger, y WA-Bridge (Baileys)
// Detecta intencion de cotizacion, captura datos, genera cotizacion, responde con IA
// GET  /api/webhook = verificacion del webhook (WhatsApp)
// POST /api/webhook = mensaje entrante WhatsApp/Bridge + respuesta automatica
// POST /api/webhook con source:'wa-bridge' = Bridge mode (devuelve JSON)

const { createClient } = require('@libsql/client');
const { analizarMensaje } = require('./analyze.js');
const { generarRespuestaAI, getAIConfig, initAITables } = require('./ai-sales.js');

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzA4MjUwMDYsImlkIjoiYTczOTliMjctYWFlNi00YjhmLWJmYjktODQ2M2JmMWU1MzljIiwicmlkIjoiNWVhMDBiM2QtNzNiNS00Njg3LWFjN2YtMTNhMGQzZmJlZmM1In0.ZVnn2UF2WdEw_yvQYGGB9Eyvbh_JRniPhkByn6Vxiavki0FkHVM8Xb0cwu1Ijrhti_j3iiOxS5jtt2IwCRWvDA'
});

const WA_TOKEN = process.env.WA_TOKEN || 'EAAcJmKFNOhYBQvLYIJj611y1ZCLmASwZC76pbuKuLG3sLfCBrLFEsasPOlIcWZAyQ1tbvFBbbXghvaNXIjC2MZCYilaz4y24GCO9rd7ZCMukRhqMOTZAzLyieIycDjww4DmyboZCbTSG7XknyZBJ3nWYZCMb4llOuTZAqkm9OVBn5B0AomBVezqWfrnK25wl9TJpDHiZAvHiZARAZBHUsoI2BF9tBbZAL2c9Dqe1gBYESbjLiHFIpzMUt0dE7Lraj0Xd8SBmtZArzUEDXv62UienZCCq4v8TpSBG';
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN || '';
const PHONE_NUMBER_ID = '968960759641278';
const WA_API_URL = 'https://graph.facebook.com/v21.0/' + PHONE_NUMBER_ID + '/messages';
const FB_API_URL = 'https://graph.facebook.com/v21.0/me/messages';
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
        // Agregar columnas nuevas si no existen
        try { await client.execute('ALTER TABLE wa_messages ADD COLUMN ai_generated INTEGER DEFAULT 0'); } catch(e) {}
        try { await client.execute('ALTER TABLE wa_messages ADD COLUMN platform TEXT DEFAULT \'whatsapp\''); } catch(e) {}
        try { await client.execute('ALTER TABLE wa_conversations ADD COLUMN platform TEXT DEFAULT \'whatsapp\''); } catch(e) {}
    } catch (err) {
        console.error('initTables error:', err);
    }
}

async function getConversation(telefono) {
    var clean = cleanPhone(telefono);

    // Messenger: lookup directo, sin variantes de teléfono
    if (clean.startsWith('fb_')) {
        var result = await client.execute({
            sql: 'SELECT * FROM wa_conversations WHERE telefono = ?',
            args: [clean]
        });
        if (result.rows.length === 0) return null;
        var conv = result.rows[0];
        // Auto-reset: si lleva >30 min en estado de cotización, resetear a idle
        if (conv.estado !== 'idle' && conv.updated_at) {
            var minutos = (Date.now() - conv.updated_at) / 60000;
            if (minutos > 30) {
                console.log('[FYRA-BOT] Auto-reset conversación atrapada:', clean, 'estado:', conv.estado);
                await client.execute({
                    sql: 'UPDATE wa_conversations SET estado = ?, updated_at = ? WHERE telefono = ?',
                    args: ['idle', Date.now(), clean]
                });
                conv.estado = 'idle';
            }
        }
        return conv;
    }

    // WhatsApp: buscar con variantes 52/521
    var result = await client.execute({
        sql: 'SELECT * FROM wa_conversations WHERE telefono = ?',
        args: [clean]
    });
    if (result.rows.length === 0 && clean.length === 12 && clean.startsWith('52')) {
        var alt = '521' + clean.substring(2);
        result = await client.execute({
            sql: 'SELECT * FROM wa_conversations WHERE telefono = ?',
            args: [alt]
        });
        if (result.rows.length > 0) {
            await client.execute({
                sql: 'UPDATE wa_conversations SET telefono = ? WHERE telefono = ?',
                args: [clean, alt]
            });
        }
    }
    if (result.rows.length === 0) return null;
    var conv = result.rows[0];
    // Auto-reset
    if (conv.estado !== 'idle' && conv.updated_at) {
        var minutos = (Date.now() - conv.updated_at) / 60000;
        if (minutos > 30) {
            console.log('[FYRA-BOT] Auto-reset conversación atrapada:', clean, 'estado:', conv.estado, 'minutos:', Math.round(minutos));
            await client.execute({
                sql: 'UPDATE wa_conversations SET estado = ?, updated_at = ? WHERE telefono = ?',
                args: ['idle', Date.now(), clean]
            });
            conv.estado = 'idle';
        }
    }
    return conv;
}

async function setConversation(telefono, data) {
    var existing = await getConversation(telefono);
    if (existing) {
        await client.execute({
            sql: `UPDATE wa_conversations SET estado=?, nombre=?, dato_precio=?, dato_enganche=?, dato_plazo=?, dato_vehiculo=?, paso=?, updated_at=? WHERE telefono=?`,
            args: [data.estado || 'idle', data.nombre || '', data.dato_precio || 0, data.dato_enganche || 0, data.dato_plazo || 0, data.dato_vehiculo || '', data.paso || '', Date.now(), telefono]
        });
    } else {
        var platform = telefono.startsWith('fb_') ? 'messenger' : 'whatsapp';
        await client.execute({
            sql: `INSERT INTO wa_conversations (telefono, estado, nombre, dato_precio, dato_enganche, dato_plazo, dato_vehiculo, paso, platform, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            args: [telefono, data.estado || 'idle', data.nombre || '', data.dato_precio || 0, data.dato_enganche || 0, data.dato_plazo || 0, data.dato_vehiculo || '', data.paso || '', platform, Date.now()]
        });
    }
}

// ===== LIMPIAR TELEFONO / IDENTIFICADOR =====
function cleanPhone(tel) {
    if (!tel) return '';
    // Messenger PSIDs: no limpiar, retornar tal cual
    if (typeof tel === 'string' && tel.startsWith('fb_')) return tel;
    var clean = tel.replace(/\D/g, '');
    // Meta manda 521XXXXXXXXXX (13 digitos) pero el API necesita 52XXXXXXXXXX (12 digitos)
    if (clean.length === 13 && clean.startsWith('521')) {
        clean = '52' + clean.substring(3);
    }
    return clean;
}

// ===== ENVIAR MENSAJE (router por plataforma) =====
async function sendMessage(to, text, aiGenerated, platform) {
    platform = platform || 'whatsapp';
    if (platform === 'messenger') {
        return sendMessengerMessage(to, text, aiGenerated);
    }
    return sendWhatsAppMessage(to, text, aiGenerated);
}

// ===== ENVIAR MENSAJE WHATSAPP =====
async function sendWhatsAppMessage(to, text, aiGenerated) {
    try {
        var cleanTo = cleanPhone(to);
        var isAI = aiGenerated ? 1 : 0;
        console.log('[FYRA-WA] Enviando a:', cleanTo, '| AI:', isAI, '| Texto:', text.substring(0, 50) + '...');

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
        console.log('[FYRA-WA] Respuesta Meta:', response.status, JSON.stringify(data));

        if (response.ok && data.messages && data.messages.length > 0) {
            await client.execute({
                sql: `INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, ai_generated, platform, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                args: [cleanTo, cleanTo, 'FYRADRIVE', text, 'text', 'out', Math.floor(Date.now() / 1000), data.messages[0].id, isAI, 'whatsapp', Date.now()]
            });
            console.log('[FYRA-WA] Mensaje enviado OK:', data.messages[0].id, isAI ? '(IA)' : '(BOT)');
            return data;
        } else {
            console.error('[FYRA-WA] ERROR Meta API:', response.status, JSON.stringify(data));
            await client.execute({
                sql: `INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, ai_generated, platform, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                args: [cleanTo, cleanTo, 'FYRADRIVE', '❌ FALLÓ ENVÍO: ' + text, 'text', 'out', Math.floor(Date.now() / 1000), 'ERROR-' + Date.now(), isAI, 'whatsapp', Date.now()]
            });
            return null;
        }
    } catch (err) {
        console.error('[FYRA-WA] sendMessage EXCEPCION:', err.message);
        return null;
    }
}

// ===== ENVIAR MENSAJE MESSENGER =====
async function sendMessengerMessage(to, text, aiGenerated) {
    try {
        // Extraer PSID del formato fb_XXXXX
        var psid = to.startsWith('fb_') ? to.substring(3) : to;
        var isAI = aiGenerated ? 1 : 0;
        console.log('[FYRA-FB] Enviando a PSID:', psid, '| AI:', isAI, '| Texto:', text.substring(0, 50) + '...');

        if (!FB_PAGE_TOKEN) {
            console.error('[FYRA-FB] No hay FB_PAGE_TOKEN configurado');
            await client.execute({
                sql: `INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, ai_generated, platform, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                args: [to, to, 'FYRADRIVE', '❌ FALLÓ ENVÍO (sin token FB): ' + text, 'text', 'out', Math.floor(Date.now() / 1000), 'ERROR-' + Date.now(), isAI, 'messenger', Date.now()]
            });
            return null;
        }

        // Messenger no soporta markdown de WhatsApp (*bold*, _italic_) — limpiar
        var cleanText = text.replace(/\*(.*?)\*/g, '$1').replace(/_(.*?)_/g, '$1');

        var response = await fetch(FB_API_URL + '?access_token=' + FB_PAGE_TOKEN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipient: { id: psid },
                message: { text: cleanText }
            })
        });
        var data = await response.json();
        console.log('[FYRA-FB] Respuesta Meta:', response.status, JSON.stringify(data));

        if (response.ok && data.message_id) {
            await client.execute({
                sql: `INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, ai_generated, platform, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                args: [to, to, 'FYRADRIVE', cleanText, 'text', 'out', Math.floor(Date.now() / 1000), data.message_id, isAI, 'messenger', Date.now()]
            });
            console.log('[FYRA-FB] Mensaje enviado OK:', data.message_id, isAI ? '(IA)' : '(BOT)');
            return data;
        } else {
            console.error('[FYRA-FB] ERROR Messenger API:', response.status, JSON.stringify(data));
            await client.execute({
                sql: `INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, ai_generated, platform, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                args: [to, to, 'FYRADRIVE', '❌ FALLÓ ENVÍO: ' + cleanText, 'text', 'out', Math.floor(Date.now() / 1000), 'ERROR-' + Date.now(), isAI, 'messenger', Date.now()]
            });
            return null;
        }
    } catch (err) {
        console.error('[FYRA-FB] sendMessengerMessage EXCEPCION:', err.message);
        return null;
    }
}

// ===== GUARDAR MENSAJE ENTRANTE =====
async function saveMessage(data) {
    try {
        var tel = cleanPhone(data.telefono || '');
        var platform = data.platform || 'whatsapp';
        await client.execute({
            sql: `INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, platform, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            args: [tel, tel, data.nombre || '', data.mensaje || '', data.tipo || 'text', data.direccion || 'in', data.timestamp || Math.floor(Date.now() / 1000), data.mensaje_id || '', platform, Date.now()]
        });
    } catch (err) {
        console.error('saveMessage error:', err);
    }
}

// ===== EXTRAER NUMERO DE UN TEXTO =====
function extraerNumero(texto) {
    var t = texto.toLowerCase().replace(/,/g, '').replace(/\$/g, '').trim();
    var matchK = t.match(/(\d+(?:\.\d+)?)\s*(?:k|mil)/);
    if (matchK) return parseFloat(matchK[1]) * 1000;
    var matchNum = t.match(/(\d+(?:\.\d+)?)/);
    if (matchNum) {
        var num = parseFloat(matchNum[1]);
        return num;
    }
    return 0;
}

function extraerPlazo(texto) {
    var t = texto.toLowerCase();
    var matchMeses = t.match(/(\d+)\s*(?:meses|mes)/);
    if (matchMeses) return parseInt(matchMeses[1]);
    var matchNum = t.match(/(\d+)/);
    if (matchNum) return parseInt(matchNum[1]);
    return 0;
}

// ===== LOGICA DEL CHATBOT (platform-aware) =====
async function procesarMensaje(telefono, nombre, texto, platform) {
    await initTables();
    platform = platform || 'whatsapp';
    telefono = cleanPhone(telefono);

    // Messenger: análisis en background + responder como Vendedor Estrella
    if (platform === 'messenger') {
        console.log('[FYRA-BOT] Messenger activo — Vendedor Estrella para', telefono);
        // Fire-and-forget: no esperar análisis
        analizarMensaje(telefono, texto, 'in', 'Nombre: ' + nombre, 'messenger').catch(function(ae) {
            console.error('[FYRA-BOT] Error análisis Messenger:', ae.message);
        });
    }

    var conv = await getConversation(telefono);
    var estado = conv ? conv.estado : 'idle';
    var textoLower = texto.toLowerCase().trim();

    // ---- ESTADO: IDLE ----
    if (estado === 'idle' || !estado) {
        var esCotizacion = COTIZACION_KEYWORDS.some(function(kw) {
            return textoLower.includes(kw);
        });

        if (esCotizacion) {
            // Saltar directo a pedir precio — no hacer perder tiempo al cliente
            await setConversation(telefono, {
                estado: 'pidiendo_precio', nombre: nombre,
                dato_precio: 0, dato_enganche: 0, dato_plazo: 0, dato_vehiculo: '', paso: 'precio'
            });
            await sendMessage(telefono,
                'Va! Te armo la cotizacion 📊\n\n' +
                'Cual es el precio del vehiculo?\n\n' +
                'Ej: 350000 o 350k',
                false, platform
            );
            return;
        }

        // ===== CHATBOT IA =====
        try {
            var config = await getAIConfig();
            if (config && config.ai_enabled) {
                // Fire-and-forget: análisis emocional en background (no bloquea respuesta)
                analizarMensaje(telefono, texto, 'in', 'Nombre: ' + nombre).catch(function(ae) {
                    console.error('[FYRA-AI] Error análisis background:', ae.message);
                });
                // Generar respuesta IA sin esperar análisis (más rápido)
                var aiResult = await generarRespuestaAI(telefono, texto, nombre, null);

                if (aiResult && aiResult.trigger_cotizacion) {
                    console.log('[FYRA-AI] Trigger cotización detectado por IA');
                    await setConversation(telefono, {
                        estado: 'pidiendo_precio', nombre: nombre,
                        dato_precio: 0, dato_enganche: 0, dato_plazo: 0, dato_vehiculo: '', paso: 'precio'
                    });
                    await sendMessage(telefono,
                        'Va! Te armo la cotizacion 📊\n\n' +
                        'Cual es el precio del vehiculo?\n\n' +
                        'Ej: 350000 o 350k',
                        false, platform
                    );
                    return;
                }

                if (aiResult && aiResult.respuesta) {
                    await setConversation(telefono, { estado: 'idle', nombre: nombre });
                    await sendMessage(telefono, aiResult.respuesta, true, platform);
                    return;
                }
            }
        } catch(aiErr) {
            console.error('[FYRA-AI] Error chatbot IA:', aiErr.message);
        }

        // FALLBACK — Vendedor Estrella
        await setConversation(telefono, { estado: 'idle', nombre: nombre });
        var primerNombre = nombre ? nombre.split(' ')[0] : '';
        var saludo = primerNombre ? 'Que tal ' + primerNombre + '!' : 'Que tal!';
        await sendMessage(telefono,
            saludo + ' Soy Seb de Fyradrive 🚗\n\n' +
            'Te interesa comprar, vender, o cotizar un credito?\n\n' +
            'Dime en que te ayudo y lo resolvemos',
            false, platform
        );
        return;
    }

    // ---- ESTADO: OFRECIENDO COTIZACION ----
    if (estado === 'ofreciendo_cotizacion') {
        var esSi = SI_KEYWORDS.some(function(kw) { return textoLower === kw || textoLower.startsWith(kw + ' '); });
        var esNo = NO_KEYWORDS.some(function(kw) { return textoLower === kw || textoLower.startsWith(kw + ' '); });

        if (esSi) {
            await setConversation(telefono, {
                estado: 'pidiendo_precio', nombre: nombre || (conv ? conv.nombre : ''),
                dato_precio: 0, dato_enganche: 0, dato_plazo: 0, dato_vehiculo: '', paso: 'precio'
            });
            await sendMessage(telefono,
                'Va! Cual es el precio del vehiculo?\n\nEj: 350000 o 350k',
                false, platform
            );
            return;
        }

        if (esNo) {
            await setConversation(telefono, { estado: 'idle', nombre: nombre || (conv ? conv.nombre : '') });
            await sendMessage(telefono,
                'Sin problema 👍 Cuando quieras cotizar solo dime. Aqui estoy.',
                false, platform
            );
            return;
        }

        await sendMessage(telefono, 'Te armo la cotizacion? Solo dime si o no', false, platform);
        return;
    }

    // ---- ESTADO: PIDIENDO PRECIO ----
    if (estado === 'pidiendo_precio') {
        var precio = extraerNumero(textoLower);
        if (precio > 0 && precio < 1000) precio = precio * 1000;

        if (precio < 50000) {
            await sendMessage(telefono, 'Ese precio esta muy bajo. Cual es el precio del vehiculo? Ej: 350000', false, platform);
            return;
        }
        if (precio > 5000000) {
            await sendMessage(telefono, 'Ese precio es muy alto para el rango que manejamos. Cual seria el precio correcto?', false, platform);
            return;
        }

        await setConversation(telefono, {
            estado: 'pidiendo_enganche', nombre: conv ? conv.nombre : nombre,
            dato_precio: precio, dato_vehiculo: conv ? conv.dato_vehiculo : '', paso: 'enganche'
        });
        await sendMessage(telefono,
            'Listo, ' + formatMoney(precio) + ' ✅\n\n' +
            'Cuanto darias de enganche?\n' +
            'Minimo 25% = ' + formatMoney(precio * 0.25) + '\n\n' +
            'Ej: ' + Math.round(precio * 0.30 / 1000) + '000 o ' + Math.round(precio * 0.30 / 1000) + 'k',
            false, platform
        );
        return;
    }

    // ---- ESTADO: PIDIENDO ENGANCHE ----
    if (estado === 'pidiendo_enganche') {
        var precioActual = conv ? conv.dato_precio : 0;
        var enganche = extraerNumero(textoLower);
        if (enganche > 0 && enganche < 1000) enganche = enganche * 1000;

        var matchPct = textoLower.match(/(\d+)\s*%/);
        if (matchPct) {
            enganche = precioActual * (parseInt(matchPct[1]) / 100);
        }

        var minEnganche = precioActual * 0.25;
        if (enganche < minEnganche) {
            await sendMessage(telefono,
                'El minimo de enganche es 25% = ' + formatMoney(minEnganche) + '\n\nCuanto podrias dar? Puedes poner monto o porcentaje (ej: 30%)',
                false, platform
            );
            return;
        }
        if (enganche >= precioActual) {
            await sendMessage(telefono, 'El enganche no puede ser mayor al precio. Cuanto darias de enganche?', false, platform);
            return;
        }

        await setConversation(telefono, {
            estado: 'pidiendo_plazo', nombre: conv ? conv.nombre : nombre,
            dato_precio: precioActual, dato_enganche: enganche,
            dato_vehiculo: conv ? conv.dato_vehiculo : '', paso: 'plazo'
        });
        await sendMessage(telefono,
            'Enganche: ' + formatMoney(enganche) + ' (' + Math.round(enganche / precioActual * 100) + '%) ✅\n\n' +
            'Ultimo paso! A cuantos meses?\n\n' +
            '24 | 36 | 48 | 60 meses',
            false, platform
        );
        return;
    }

    // ---- ESTADO: PIDIENDO PLAZO ----
    if (estado === 'pidiendo_plazo') {
        var plazo = extraerPlazo(textoLower);
        if (plazo < 12 || plazo > 72) {
            await sendMessage(telefono, 'El plazo va de 12 a 60 meses. Cual prefieres? 24, 36, 48 o 60', false, platform);
            return;
        }

        var precioFinal = conv ? conv.dato_precio : 0;
        var engancheFinal = conv ? conv.dato_enganche : 0;
        var cot = calcularCotizacion(precioFinal, engancheFinal, plazo);

        await setConversation(telefono, {
            estado: 'cotizacion_enviada', nombre: conv ? conv.nombre : nombre,
            dato_precio: precioFinal, dato_enganche: engancheFinal, dato_plazo: plazo,
            dato_vehiculo: conv ? conv.dato_vehiculo : '', paso: 'completado'
        });

        await sendMessage(telefono,
            '🚗 COTIZACION FYRADRIVE\n\n' +
            'Precio: ' + formatMoney(cot.precio) + '\n' +
            'Enganche: ' + formatMoney(cot.enganche) + ' (' + Math.round(cot.enganche / cot.precio * 100) + '%)\n' +
            'Financiamiento: ' + formatMoney(cot.financiamiento) + '\n' +
            'Plazo: ' + cot.plazo + ' meses\n\n' +
            '💳 Mensualidad: ' + formatMoney(cot.mensualidad) + '\n\n' +
            'Desembolso inicial:\n' +
            '  Enganche: ' + formatMoney(cot.enganche) + '\n' +
            '  Comision apertura: ' + formatMoney(cot.comision) + '\n' +
            '  Total: ' + formatMoney(cot.desembolso) + '\n\n' +
            'Tasa 15.99% anual | Incluye seguro de vida\n' +
            'Sujeto a aprobacion crediticia\n\n' +
            'Te agendo cita para verlo? O quieres cotizar con otros montos?',
            false, platform
        );
        return;
    }

    // ---- ESTADO: COTIZACION ENVIADA ----
    if (estado === 'cotizacion_enviada') {
        var esSi2 = SI_KEYWORDS.some(function(kw) { return textoLower === kw || textoLower.startsWith(kw + ' '); });
        var otraCot = COTIZACION_KEYWORDS.some(function(kw) { return textoLower.includes(kw); });

        if (otraCot) {
            await setConversation(telefono, {
                estado: 'pidiendo_precio', nombre: conv ? conv.nombre : nombre,
                dato_precio: 0, dato_enganche: 0, dato_plazo: 0, paso: 'precio'
            });
            await sendMessage(telefono,
                'Va! Otra cotizacion. Cual es el precio del vehiculo?',
                false, platform
            );
            return;
        }

        if (esSi2) {
            await setConversation(telefono, { estado: 'idle', nombre: conv ? conv.nombre : nombre });
            await sendMessage(telefono,
                'Excelente! 🤝 Yo me encargo de agendarte. Te contacto en breve para coordinar dia y hora.',
                false, platform
            );
            return;
        }

        // IA maneja post-cotización
        await setConversation(telefono, { estado: 'idle', nombre: conv ? conv.nombre : nombre });
        try {
            var configPost = await getAIConfig();
            if (configPost && configPost.ai_enabled) {
                var analisisPost = null;
                try {
                    analisisPost = await analizarMensaje(telefono, texto, 'in', 'Nombre: ' + nombre + ' | Acaba de recibir cotización');
                } catch(aePost) {}
                var aiPost = await generarRespuestaAI(telefono, texto, nombre, analisisPost);
                if (aiPost && aiPost.respuesta) {
                    await sendMessage(telefono, aiPost.respuesta, true, platform);
                    return;
                }
            }
        } catch(aiPostErr) {
            console.error('[FYRA-AI] Error post-cotización:', aiPostErr.message);
        }
        await sendMessage(telefono,
            'Cualquier duda aqui estoy. Si quieres otra cotizacion solo dime 👍',
            false, platform
        );
        return;
    }

    // ---- ESTADO NO RECONOCIDO ----
    await setConversation(telefono, { estado: 'idle', nombre: nombre });
    await sendMessage(telefono,
        'Que tal! Soy Seb de Fyradrive 🚗 En que te ayudo?',
        false, platform
    );
}

// ===== HANDLER PRINCIPAL (WhatsApp) =====
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

    // POST = Mensaje entrante WhatsApp o Bridge
    if (req.method === 'POST') {
        try {
            await initTables();
            var body = req.body;

            // ===== BRIDGE MODE: mensaje del WA-Bridge (Baileys en DigitalOcean) =====
            if (body.source === 'wa-bridge' && req.headers['x-bridge-key'] === (process.env.BRIDGE_KEY || 'fyradrive-bridge-2026')) {
                var bridgeTel = cleanPhone(body.telefono || '');
                var bridgeNombre = body.nombre || '';
                var bridgeTexto = body.texto || '';
                console.log('[BRIDGE] Mensaje de', bridgeTel, ':', bridgeTexto.substring(0, 80));

                if (!bridgeTel || !bridgeTexto) {
                    return res.status(400).json({ error: 'Missing telefono or texto' });
                }

                // Guardar mensaje entrante
                await saveMessage({
                    wa_id: bridgeTel, telefono: bridgeTel, nombre: bridgeNombre,
                    mensaje: bridgeTexto, tipo: 'text', direccion: 'in',
                    timestamp: Math.floor(Date.now() / 1000), mensaje_id: 'bridge-' + Date.now(),
                    platform: 'whatsapp'
                });

                // Procesar con el mismo flujo que WhatsApp pero capturar respuestas en vez de enviar por Meta
                var bridgeResponses = [];
                var origSendMessage = sendMessage;

                // Interceptar sendMessage para capturar respuestas
                var capturedMessages = [];
                var fakeSend = async function(to, text, aiGenerated, platform) {
                    capturedMessages.push({ text: text, aiGenerated: aiGenerated ? true : false });
                    // Guardar en DB como out
                    await saveMessage({
                        wa_id: cleanPhone(to), telefono: cleanPhone(to), nombre: 'FYRADRIVE',
                        mensaje: text, tipo: 'text', direccion: 'out',
                        timestamp: Math.floor(Date.now() / 1000), mensaje_id: 'bridge-out-' + Date.now(),
                        platform: 'whatsapp'
                    });
                };

                // Monkey-patch sendMessage temporalmente
                // No podemos monkey-patch directamente porque procesarMensaje usa closure
                // Mejor: procesar manualmente igual que procesarMensaje pero devolver

                try { await initAITables(); } catch(e) {}

                // Análisis en background
                analizarMensaje(bridgeTel, bridgeTexto, 'in', 'Nombre: ' + bridgeNombre).catch(function(ae) {
                    console.error('[BRIDGE] Error análisis:', ae.message);
                });

                var conv = await getConversation(bridgeTel);
                var estado = conv ? conv.estado : 'idle';
                var textoLower = bridgeTexto.toLowerCase().trim();

                // ---- IDLE: usar Claw IA ----
                if (estado === 'idle' || !estado) {
                    var esCotizacion = COTIZACION_KEYWORDS.some(function(kw) { return textoLower.includes(kw); });

                    if (esCotizacion) {
                        await setConversation(bridgeTel, { estado: 'pidiendo_precio', nombre: bridgeNombre, paso: 'precio' });
                        return res.status(200).json({ ok: true, respuestas: ['Va! Te armo la cotizacion 📊\n\nCual es el precio del vehiculo?\n\nEj: 350000 o 350k'], aiGenerated: false });
                    }

                    try {
                        var config = await getAIConfig();
                        if (config && config.ai_enabled) {
                            var aiResult = await generarRespuestaAI(bridgeTel, bridgeTexto, bridgeNombre, null);
                            if (aiResult && aiResult.trigger_cotizacion) {
                                await setConversation(bridgeTel, { estado: 'pidiendo_precio', nombre: bridgeNombre, paso: 'precio' });
                                return res.status(200).json({ ok: true, respuestas: ['Va! Te armo la cotizacion 📊\n\nCual es el precio del vehiculo?\n\nEj: 350000 o 350k'], aiGenerated: false });
                            }
                            if (aiResult && aiResult.respuesta) {
                                await setConversation(bridgeTel, { estado: 'idle', nombre: bridgeNombre });
                                return res.status(200).json({ ok: true, respuestas: [aiResult.respuesta], aiGenerated: true });
                            }
                        }
                    } catch(aiErr) { console.error('[BRIDGE] Error IA:', aiErr.message); }

                    // Fallback
                    await setConversation(bridgeTel, { estado: 'idle', nombre: bridgeNombre });
                    var primerNombre = bridgeNombre ? bridgeNombre.split(' ')[0] : '';
                    var saludo = primerNombre ? 'Que tal ' + primerNombre + '!' : 'Que tal!';
                    return res.status(200).json({ ok: true, respuestas: [saludo + ' Soy Seb de Fyradrive 🚗\n\nTe interesa comprar, vender, o cotizar un credito?\n\nDime en que te ayudo y lo resolvemos'], aiGenerated: false });
                }

                // ---- PIDIENDO PRECIO ----
                if (estado === 'pidiendo_precio') {
                    var precio = extraerNumero(textoLower);
                    if (precio > 0 && precio < 1000) precio = precio * 1000;
                    if (precio < 50000) return res.status(200).json({ ok: true, respuestas: ['Ese precio esta muy bajo. Cual es el precio del vehiculo? Ej: 350000'], aiGenerated: false });
                    if (precio > 5000000) return res.status(200).json({ ok: true, respuestas: ['Ese precio es muy alto. Cual seria el precio correcto?'], aiGenerated: false });
                    await setConversation(bridgeTel, { estado: 'pidiendo_enganche', nombre: conv ? conv.nombre : bridgeNombre, dato_precio: precio, paso: 'enganche' });
                    return res.status(200).json({ ok: true, respuestas: ['Listo, ' + formatMoney(precio) + ' ✅\n\nCuanto darias de enganche?\nMinimo 25% = ' + formatMoney(precio * 0.25) + '\n\nEj: ' + Math.round(precio * 0.30 / 1000) + '000 o ' + Math.round(precio * 0.30 / 1000) + 'k'], aiGenerated: false });
                }

                // ---- PIDIENDO ENGANCHE ----
                if (estado === 'pidiendo_enganche') {
                    var precioActual = conv ? conv.dato_precio : 0;
                    var enganche = extraerNumero(textoLower);
                    if (enganche > 0 && enganche < 1000) enganche = enganche * 1000;
                    var matchPct = textoLower.match(/(\d+)\s*%/);
                    if (matchPct) enganche = precioActual * (parseInt(matchPct[1]) / 100);
                    var minEnganche = precioActual * 0.25;
                    if (enganche < minEnganche) return res.status(200).json({ ok: true, respuestas: ['El minimo de enganche es 25% = ' + formatMoney(minEnganche) + '\n\nCuanto podrias dar?'], aiGenerated: false });
                    if (enganche >= precioActual) return res.status(200).json({ ok: true, respuestas: ['El enganche no puede ser mayor al precio. Cuanto darias?'], aiGenerated: false });
                    await setConversation(bridgeTel, { estado: 'pidiendo_plazo', nombre: conv ? conv.nombre : bridgeNombre, dato_precio: precioActual, dato_enganche: enganche, paso: 'plazo' });
                    return res.status(200).json({ ok: true, respuestas: ['Enganche: ' + formatMoney(enganche) + ' (' + Math.round(enganche / precioActual * 100) + '%) ✅\n\nUltimo paso! A cuantos meses?\n\n24 | 36 | 48 | 60 meses'], aiGenerated: false });
                }

                // ---- PIDIENDO PLAZO ----
                if (estado === 'pidiendo_plazo') {
                    var plazo = extraerPlazo(textoLower);
                    if (plazo < 12 || plazo > 72) return res.status(200).json({ ok: true, respuestas: ['El plazo va de 12 a 60 meses. Cual prefieres? 24, 36, 48 o 60'], aiGenerated: false });
                    var precioFinal = conv ? conv.dato_precio : 0;
                    var engancheFinal = conv ? conv.dato_enganche : 0;
                    var cot = calcularCotizacion(precioFinal, engancheFinal, plazo);
                    await setConversation(bridgeTel, { estado: 'cotizacion_enviada', nombre: conv ? conv.nombre : bridgeNombre, dato_precio: precioFinal, dato_enganche: engancheFinal, dato_plazo: plazo, paso: 'completado' });
                    return res.status(200).json({ ok: true, respuestas: [
                        '🚗 COTIZACION FYRADRIVE\n\nPrecio: ' + formatMoney(cot.precio) + '\nEnganche: ' + formatMoney(cot.enganche) + ' (' + Math.round(cot.enganche / cot.precio * 100) + '%)\nFinanciamiento: ' + formatMoney(cot.financiamiento) + '\nPlazo: ' + cot.plazo + ' meses\n\n💳 Mensualidad: ' + formatMoney(cot.mensualidad) + '\n\nDesembolso inicial:\n  Enganche: ' + formatMoney(cot.enganche) + '\n  Comision apertura: ' + formatMoney(cot.comision) + '\n  Total: ' + formatMoney(cot.desembolso) + '\n\nTasa 15.99% anual | Incluye seguro de vida\nSujeto a aprobacion crediticia\n\nTe agendo cita para verlo? O quieres cotizar con otros montos?'
                    ], aiGenerated: false });
                }

                // ---- COTIZACION ENVIADA ----
                if (estado === 'cotizacion_enviada') {
                    var otraCot = COTIZACION_KEYWORDS.some(function(kw) { return textoLower.includes(kw); });
                    if (otraCot) {
                        await setConversation(bridgeTel, { estado: 'pidiendo_precio', nombre: conv ? conv.nombre : bridgeNombre, paso: 'precio' });
                        return res.status(200).json({ ok: true, respuestas: ['Va! Otra cotizacion. Cual es el precio del vehiculo?'], aiGenerated: false });
                    }
                    var esSi2 = SI_KEYWORDS.some(function(kw) { return textoLower === kw || textoLower.startsWith(kw + ' '); });
                    if (esSi2) {
                        await setConversation(bridgeTel, { estado: 'idle', nombre: conv ? conv.nombre : bridgeNombre });
                        return res.status(200).json({ ok: true, respuestas: ['Excelente! 🤝 Yo me encargo de agendarte. Te contacto en breve para coordinar dia y hora.'], aiGenerated: false });
                    }
                    await setConversation(bridgeTel, { estado: 'idle', nombre: conv ? conv.nombre : bridgeNombre });
                    try {
                        var aiPost = await generarRespuestaAI(bridgeTel, bridgeTexto, bridgeNombre, null);
                        if (aiPost && aiPost.respuesta) return res.status(200).json({ ok: true, respuestas: [aiPost.respuesta], aiGenerated: true });
                    } catch(e) {}
                    return res.status(200).json({ ok: true, respuestas: ['Cualquier duda aqui estoy. Si quieres otra cotizacion solo dime 👍'], aiGenerated: false });
                }

                // ---- OFRECIENDO COTIZACION ----
                if (estado === 'ofreciendo_cotizacion') {
                    var esSi = SI_KEYWORDS.some(function(kw) { return textoLower === kw || textoLower.startsWith(kw + ' '); });
                    if (esSi) {
                        await setConversation(bridgeTel, { estado: 'pidiendo_precio', nombre: bridgeNombre, paso: 'precio' });
                        return res.status(200).json({ ok: true, respuestas: ['Va! Cual es el precio del vehiculo?\n\nEj: 350000 o 350k'], aiGenerated: false });
                    }
                    var esNo = NO_KEYWORDS.some(function(kw) { return textoLower === kw || textoLower.startsWith(kw + ' '); });
                    if (esNo) {
                        await setConversation(bridgeTel, { estado: 'idle', nombre: bridgeNombre });
                        return res.status(200).json({ ok: true, respuestas: ['Sin problema 👍 Cuando quieras cotizar solo dime.'], aiGenerated: false });
                    }
                    return res.status(200).json({ ok: true, respuestas: ['Te armo la cotizacion? Solo dime si o no'], aiGenerated: false });
                }

                // Default
                await setConversation(bridgeTel, { estado: 'idle', nombre: bridgeNombre });
                return res.status(200).json({ ok: true, respuestas: ['Que tal! Soy Seb de Fyradrive 🚗 En que te ayudo?'], aiGenerated: false });
            }

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

                                await saveMessage({
                                    wa_id: telefono, telefono: telefono, nombre: nombre,
                                    mensaje: texto, tipo: msg.type || 'text', direccion: 'in',
                                    timestamp: parseInt(msg.timestamp) || Math.floor(Date.now() / 1000),
                                    mensaje_id: msg.id || '', platform: 'whatsapp'
                                });

                                if (msg.type === 'text' && texto) {
                                    try { await initAITables(); } catch(e) {}
                                    await procesarMensaje(telefono, nombre, texto, 'whatsapp');
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

// ===== EXPORTS para messenger.js =====
module.exports.procesarMensaje = procesarMensaje;
module.exports.saveMessage = saveMessage;
module.exports.sendMessage = sendMessage;
module.exports.initTables = initTables;
module.exports.cleanPhone = cleanPhone;
