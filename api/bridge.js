// Bridge endpoint: recibe mensajes del WA-Bridge (Baileys en DigitalOcean)
// POST /api/bridge — procesa mensaje y devuelve respuesta de Claw
// No depende de Meta Business API — Baileys envia/recibe directamente
// v1.0

const { generarRespuestaAI, getAIConfig, initAITables } = require('./ai-sales.js');
const { createClient } = require('@libsql/client');
const { analizarMensaje } = require('./analyze.js');

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || ''
});

const BRIDGE_KEY = process.env.BRIDGE_KEY || 'fyradrive-bridge-2026';

// Cotizador (mismas formulas que webhook.js)
var COT_TASA_ANUAL = 0.1599;
var COT_SEGURO_VIDA = 1800;
var COT_COMISION = 0.0201;
var COT_IVA = 0.16;
var COT_DESCUENTO = 400;

function calcularCotizacion(precio, enganche, plazo) {
    var financiamiento = precio - enganche;
    var subtotal = financiamiento + COT_SEGURO_VIDA;
    var iva = subtotal * COT_IVA;
    var montoFinanciar = subtotal + iva;
    var r = COT_TASA_ANUAL / 12;
    var mensualidad = montoFinanciar * (r * Math.pow(1 + r, plazo)) / (Math.pow(1 + r, plazo) - 1) - COT_DESCUENTO;
    var comision = precio * COT_COMISION;
    return {
        precio: precio, enganche: enganche, plazo: plazo,
        financiamiento: financiamiento, montoFinanciar: montoFinanciar,
        mensualidad: Math.round(mensualidad * 100) / 100,
        comision: Math.round(comision),
        desembolso: Math.round(enganche + comision),
        total: Math.round(mensualidad * plazo), iva: Math.round(iva)
    };
}

function formatMoney(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

function extraerNumero(texto) {
    var t = texto.toLowerCase().replace(/,/g, '').replace(/\$/g, '').trim();
    var matchK = t.match(/(\d+(?:\.\d+)?)\s*(?:k|mil)/);
    if (matchK) return parseFloat(matchK[1]) * 1000;
    var matchNum = t.match(/(\d+(?:\.\d+)?)/);
    if (matchNum) return parseFloat(matchNum[1]);
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

var COTIZACION_KEYWORDS = [
    'cotiza', 'cotizacion', 'cotización', 'credito', 'crédito',
    'financiamiento', 'financiar', 'mensualidad', 'mensualidades',
    'plazos', 'plazo', 'enganche', 'prestamo', 'préstamo',
    'banco', 'bancario', 'pagar a meses', 'a meses',
    'cuanto queda', 'cuánto queda', 'cuanto pagaria', 'cuánto pagaría',
    'quiero financiar', 'puedo financiar', 'a credito', 'a crédito'
];
var SI_KEYWORDS = ['si', 'sí', 'sale', 'ok', 'okay', 'dale', 'va', 'claro', 'por favor', 'porfa', 'yes', 'orale', 'simon', 'adelante', 'quiero', 'me interesa'];
var NO_KEYWORDS = ['no', 'nel', 'nah', 'nop', 'no gracias', 'luego', 'despues'];

function cleanPhone(tel) {
    if (!tel) return '';
    var clean = tel.replace(/\D/g, '');
    if (clean.length === 13 && clean.startsWith('521')) clean = '52' + clean.substring(3);
    return clean;
}

async function initTables() {
    try {
        await client.execute(`CREATE TABLE IF NOT EXISTS wa_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, wa_id TEXT, telefono TEXT, nombre TEXT, mensaje TEXT,
            tipo TEXT DEFAULT 'text', direccion TEXT DEFAULT 'in', timestamp INTEGER,
            mensaje_id TEXT, leido INTEGER DEFAULT 0, created_at INTEGER
        )`);
        await client.execute(`CREATE TABLE IF NOT EXISTS wa_conversations (
            telefono TEXT PRIMARY KEY, estado TEXT DEFAULT 'idle', nombre TEXT DEFAULT '',
            dato_precio REAL DEFAULT 0, dato_enganche REAL DEFAULT 0, dato_plazo INTEGER DEFAULT 0,
            dato_vehiculo TEXT DEFAULT '', paso TEXT DEFAULT '', updated_at INTEGER
        )`);
        try { await client.execute('ALTER TABLE wa_messages ADD COLUMN ai_generated INTEGER DEFAULT 0'); } catch(e) {}
        try { await client.execute('ALTER TABLE wa_messages ADD COLUMN platform TEXT DEFAULT \'whatsapp\''); } catch(e) {}
        try { await client.execute('ALTER TABLE wa_conversations ADD COLUMN platform TEXT DEFAULT \'whatsapp\''); } catch(e) {}
    } catch (err) { console.error('initTables error:', err); }
}

async function getConversation(telefono) {
    var result = await client.execute({ sql: 'SELECT * FROM wa_conversations WHERE telefono = ?', args: [telefono] });
    if (result.rows.length === 0 && telefono.length === 12 && telefono.startsWith('52')) {
        var alt = '521' + telefono.substring(2);
        result = await client.execute({ sql: 'SELECT * FROM wa_conversations WHERE telefono = ?', args: [alt] });
        if (result.rows.length > 0) {
            await client.execute({ sql: 'UPDATE wa_conversations SET telefono = ? WHERE telefono = ?', args: [telefono, alt] });
        }
    }
    if (result.rows.length === 0) return null;
    var conv = result.rows[0];
    if (conv.estado !== 'idle' && conv.updated_at) {
        var minutos = (Date.now() - conv.updated_at) / 60000;
        if (minutos > 30) {
            await client.execute({ sql: 'UPDATE wa_conversations SET estado = ?, updated_at = ? WHERE telefono = ?', args: ['idle', Date.now(), telefono] });
            conv.estado = 'idle';
        }
    }
    return conv;
}

async function setConversation(telefono, data) {
    var existing = await getConversation(telefono);
    if (existing) {
        await client.execute({
            sql: 'UPDATE wa_conversations SET estado=?, nombre=?, dato_precio=?, dato_enganche=?, dato_plazo=?, dato_vehiculo=?, paso=?, updated_at=? WHERE telefono=?',
            args: [data.estado || 'idle', data.nombre || '', data.dato_precio || 0, data.dato_enganche || 0, data.dato_plazo || 0, data.dato_vehiculo || '', data.paso || '', Date.now(), telefono]
        });
    } else {
        await client.execute({
            sql: 'INSERT INTO wa_conversations (telefono, estado, nombre, dato_precio, dato_enganche, dato_plazo, dato_vehiculo, paso, platform, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            args: [telefono, data.estado || 'idle', data.nombre || '', data.dato_precio || 0, data.dato_enganche || 0, data.dato_plazo || 0, data.dato_vehiculo || '', data.paso || '', 'whatsapp', Date.now()]
        });
    }
}

async function saveMessage(telefono, nombre, mensaje, direccion, aiGenerated) {
    await client.execute({
        sql: 'INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, ai_generated, platform, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        args: [telefono, telefono, nombre, mensaje, 'text', direccion, Math.floor(Date.now() / 1000), 'bridge-' + Date.now(), aiGenerated ? 1 : 0, 'whatsapp', Date.now()]
    });
}

// Procesa mensaje y devuelve array de respuestas (en vez de enviar por Meta API)
async function procesarMensajeBridge(telefono, nombre, texto) {
    await initTables();
    telefono = cleanPhone(telefono);
    var respuestas = [];

    // Guardar mensaje entrante
    await saveMessage(telefono, nombre, texto, 'in', false);

    // Analisis emocional en background
    analizarMensaje(telefono, texto, 'in', 'Nombre: ' + nombre).catch(function(e) {
        console.error('[BRIDGE] Error análisis:', e.message);
    });

    var conv = await getConversation(telefono);
    var estado = conv ? conv.estado : 'idle';
    var textoLower = texto.toLowerCase().trim();

    // ---- IDLE ----
    if (estado === 'idle' || !estado) {
        var esCotizacion = COTIZACION_KEYWORDS.some(function(kw) { return textoLower.includes(kw); });

        if (esCotizacion) {
            await setConversation(telefono, { estado: 'pidiendo_precio', nombre: nombre, paso: 'precio' });
            respuestas.push('Va! Te armo la cotizacion 📊\n\nCual es el precio del vehiculo?\n\nEj: 350000 o 350k');
            return { respuestas: respuestas, aiGenerated: false };
        }

        // Claw IA
        try {
            await initAITables();
            var config = await getAIConfig();
            if (config && config.ai_enabled) {
                var aiResult = await generarRespuestaAI(telefono, texto, nombre, null);
                if (aiResult && aiResult.trigger_cotizacion) {
                    await setConversation(telefono, { estado: 'pidiendo_precio', nombre: nombre, paso: 'precio' });
                    respuestas.push('Va! Te armo la cotizacion 📊\n\nCual es el precio del vehiculo?\n\nEj: 350000 o 350k');
                    return { respuestas: respuestas, aiGenerated: false };
                }
                if (aiResult && aiResult.respuesta) {
                    await setConversation(telefono, { estado: 'idle', nombre: nombre });
                    respuestas.push(aiResult.respuesta);
                    return { respuestas: respuestas, aiGenerated: true };
                }
            }
        } catch(aiErr) { console.error('[BRIDGE] Error IA:', aiErr.message); }

        // Fallback
        await setConversation(telefono, { estado: 'idle', nombre: nombre });
        var primerNombre = nombre ? nombre.split(' ')[0] : '';
        var saludo = primerNombre ? 'Que tal ' + primerNombre + '!' : 'Que tal!';
        respuestas.push(saludo + ' Soy Seb de Fyradrive 🚗\n\nTe interesa comprar, vender, o cotizar un credito?\n\nDime en que te ayudo y lo resolvemos');
        return { respuestas: respuestas, aiGenerated: false };
    }

    // ---- OFRECIENDO COTIZACION ----
    if (estado === 'ofreciendo_cotizacion') {
        var esSi = SI_KEYWORDS.some(function(kw) { return textoLower === kw || textoLower.startsWith(kw + ' '); });
        var esNo = NO_KEYWORDS.some(function(kw) { return textoLower === kw || textoLower.startsWith(kw + ' '); });
        if (esSi) {
            await setConversation(telefono, { estado: 'pidiendo_precio', nombre: nombre || (conv ? conv.nombre : ''), paso: 'precio' });
            respuestas.push('Va! Cual es el precio del vehiculo?\n\nEj: 350000 o 350k');
        } else if (esNo) {
            await setConversation(telefono, { estado: 'idle', nombre: nombre || (conv ? conv.nombre : '') });
            respuestas.push('Sin problema 👍 Cuando quieras cotizar solo dime. Aqui estoy.');
        } else {
            respuestas.push('Te armo la cotizacion? Solo dime si o no');
        }
        return { respuestas: respuestas, aiGenerated: false };
    }

    // ---- PIDIENDO PRECIO ----
    if (estado === 'pidiendo_precio') {
        var precio = extraerNumero(textoLower);
        if (precio > 0 && precio < 1000) precio = precio * 1000;
        if (precio < 50000) { respuestas.push('Ese precio esta muy bajo. Cual es el precio del vehiculo? Ej: 350000'); return { respuestas: respuestas, aiGenerated: false }; }
        if (precio > 5000000) { respuestas.push('Ese precio es muy alto. Cual seria el precio correcto?'); return { respuestas: respuestas, aiGenerated: false }; }
        await setConversation(telefono, { estado: 'pidiendo_enganche', nombre: conv ? conv.nombre : nombre, dato_precio: precio, paso: 'enganche' });
        respuestas.push('Listo, ' + formatMoney(precio) + ' ✅\n\nCuanto darias de enganche?\nMinimo 25% = ' + formatMoney(precio * 0.25) + '\n\nEj: ' + Math.round(precio * 0.30 / 1000) + '000 o ' + Math.round(precio * 0.30 / 1000) + 'k');
        return { respuestas: respuestas, aiGenerated: false };
    }

    // ---- PIDIENDO ENGANCHE ----
    if (estado === 'pidiendo_enganche') {
        var precioActual = conv ? conv.dato_precio : 0;
        var enganche = extraerNumero(textoLower);
        if (enganche > 0 && enganche < 1000) enganche = enganche * 1000;
        var matchPct = textoLower.match(/(\d+)\s*%/);
        if (matchPct) enganche = precioActual * (parseInt(matchPct[1]) / 100);
        var minEnganche = precioActual * 0.25;
        if (enganche < minEnganche) { respuestas.push('El minimo de enganche es 25% = ' + formatMoney(minEnganche) + '\n\nCuanto podrias dar?'); return { respuestas: respuestas, aiGenerated: false }; }
        if (enganche >= precioActual) { respuestas.push('El enganche no puede ser mayor al precio. Cuanto darias?'); return { respuestas: respuestas, aiGenerated: false }; }
        await setConversation(telefono, { estado: 'pidiendo_plazo', nombre: conv ? conv.nombre : nombre, dato_precio: precioActual, dato_enganche: enganche, paso: 'plazo' });
        respuestas.push('Enganche: ' + formatMoney(enganche) + ' (' + Math.round(enganche / precioActual * 100) + '%) ✅\n\nUltimo paso! A cuantos meses?\n\n24 | 36 | 48 | 60 meses');
        return { respuestas: respuestas, aiGenerated: false };
    }

    // ---- PIDIENDO PLAZO ----
    if (estado === 'pidiendo_plazo') {
        var plazo = extraerPlazo(textoLower);
        if (plazo < 12 || plazo > 72) { respuestas.push('El plazo va de 12 a 60 meses. Cual prefieres? 24, 36, 48 o 60'); return { respuestas: respuestas, aiGenerated: false }; }
        var precioFinal = conv ? conv.dato_precio : 0;
        var engancheFinal = conv ? conv.dato_enganche : 0;
        var cot = calcularCotizacion(precioFinal, engancheFinal, plazo);
        await setConversation(telefono, { estado: 'cotizacion_enviada', nombre: conv ? conv.nombre : nombre, dato_precio: precioFinal, dato_enganche: engancheFinal, dato_plazo: plazo, paso: 'completado' });
        respuestas.push(
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
            'Te agendo cita para verlo? O quieres cotizar con otros montos?'
        );
        return { respuestas: respuestas, aiGenerated: false };
    }

    // ---- COTIZACION ENVIADA ----
    if (estado === 'cotizacion_enviada') {
        var otraCot = COTIZACION_KEYWORDS.some(function(kw) { return textoLower.includes(kw); });
        if (otraCot) {
            await setConversation(telefono, { estado: 'pidiendo_precio', nombre: conv ? conv.nombre : nombre, paso: 'precio' });
            respuestas.push('Va! Otra cotizacion. Cual es el precio del vehiculo?');
            return { respuestas: respuestas, aiGenerated: false };
        }
        var esSi2 = SI_KEYWORDS.some(function(kw) { return textoLower === kw || textoLower.startsWith(kw + ' '); });
        if (esSi2) {
            await setConversation(telefono, { estado: 'idle', nombre: conv ? conv.nombre : nombre });
            respuestas.push('Excelente! 🤝 Yo me encargo de agendarte. Te contacto en breve para coordinar dia y hora.');
            return { respuestas: respuestas, aiGenerated: false };
        }
        // IA para post-cotización
        await setConversation(telefono, { estado: 'idle', nombre: conv ? conv.nombre : nombre });
        try {
            var aiPost = await generarRespuestaAI(telefono, texto, nombre, null);
            if (aiPost && aiPost.respuesta) {
                respuestas.push(aiPost.respuesta);
                return { respuestas: respuestas, aiGenerated: true };
            }
        } catch(e) {}
        respuestas.push('Cualquier duda aqui estoy. Si quieres otra cotizacion solo dime 👍');
        return { respuestas: respuestas, aiGenerated: false };
    }

    // ---- ESTADO NO RECONOCIDO ----
    await setConversation(telefono, { estado: 'idle', nombre: nombre });
    respuestas.push('Que tal! Soy Seb de Fyradrive 🚗 En que te ayudo?');
    return { respuestas: respuestas, aiGenerated: false };
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bridge-key');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    // Autenticar
    var key = req.headers['x-bridge-key'] || req.body.bridge_key || '';
    if (key !== BRIDGE_KEY) return res.status(401).json({ error: 'Invalid bridge key' });

    var { telefono, nombre, texto } = req.body;
    if (!telefono || !texto) return res.status(400).json({ error: 'Missing telefono or texto' });

    console.log('[BRIDGE] Mensaje de', telefono, ':', texto.substring(0, 80));

    try {
        var result = await procesarMensajeBridge(telefono, nombre || '', texto);

        // Guardar mensajes de salida
        for (var i = 0; i < result.respuestas.length; i++) {
            await saveMessage(cleanPhone(telefono), 'FYRADRIVE', result.respuestas[i], 'out', result.aiGenerated);
        }

        console.log('[BRIDGE] Respondiendo con', result.respuestas.length, 'mensajes | AI:', result.aiGenerated);
        return res.status(200).json({
            ok: true,
            respuestas: result.respuestas,
            aiGenerated: result.aiGenerated
        });
    } catch (err) {
        console.error('[BRIDGE] Error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
