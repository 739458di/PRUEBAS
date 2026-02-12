// FYRADRIVE - Envío manual de mensajes a Messenger desde CRM
// POST /api/messenger-send { psid, mensaje, nombre }
// Header: x-api-key = fyradrive2026

const { createClient } = require('@libsql/client');

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzA4MjUwMDYsImlkIjoiYTczOTliMjctYWFlNi00YjhmLWJmYjktODQ2M2JmMWU1MzljIiwicmlkIjoiNWVhMDBiM2QtNzNiNS00Njg3LWFjN2YtMTNhMGQzZmJlZmM1In0.ZVnn2UF2WdEw_yvQYGGB9Eyvbh_JRniPhkByn6Vxiavki0FkHVM8Xb0cwu1Ijrhti_j3iiOxS5jtt2IwCRWvDA'
});

const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN || '';
const FB_API_URL = 'https://graph.facebook.com/v21.0/me/messages';
const API_KEY = 'fyradrive2026';

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Solo POST' });

    var apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEY) return res.status(401).json({ error: 'API key invalida' });

    var body = req.body || {};
    var psid = body.psid || '';
    var mensaje = body.mensaje || '';
    var nombre = body.nombre || '';

    if (!psid) return res.status(400).json({ error: 'Falta psid' });
    if (!mensaje) return res.status(400).json({ error: 'Falta mensaje' });

    // El psid puede venir como "fb_12345" o solo "12345"
    var rawPSID = psid.startsWith('fb_') ? psid.substring(3) : psid;
    var contactId = psid.startsWith('fb_') ? psid : 'fb_' + psid;

    if (!FB_PAGE_TOKEN) {
        return res.status(500).json({ error: 'FB_PAGE_TOKEN no configurado en Vercel', enviado: false });
    }

    try {
        var response = await fetch(FB_API_URL + '?access_token=' + FB_PAGE_TOKEN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipient: { id: rawPSID },
                message: { text: mensaje }
            })
        });
        var data = await response.json();

        if (response.ok && data.message_id) {
            // Guardar en DB
            await client.execute({
                sql: `INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, ai_generated, platform, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                args: [contactId, contactId, nombre || 'FYRADRIVE', mensaje, 'text', 'out', Math.floor(Date.now() / 1000), data.message_id, 0, 'messenger', Date.now()]
            });
            console.log('[FYRA-FB-SEND] Mensaje enviado a', contactId, ':', mensaje.substring(0, 50));
            return res.status(200).json({ enviado: true, message_id: data.message_id });
        } else {
            console.error('[FYRA-FB-SEND] Error Meta:', response.status, JSON.stringify(data));
            // Guardar como fallido
            await client.execute({
                sql: `INSERT INTO wa_messages (wa_id, telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, ai_generated, platform, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                args: [contactId, contactId, nombre || 'FYRADRIVE', '❌ FALLÓ ENVÍO: ' + mensaje, 'text', 'out', Math.floor(Date.now() / 1000), 'ERROR-' + Date.now(), 0, 'messenger', Date.now()]
            });
            return res.status(500).json({ enviado: false, error: data.error ? data.error.message : 'Error Meta API' });
        }
    } catch (err) {
        console.error('[FYRA-FB-SEND] Excepcion:', err.message);
        return res.status(500).json({ enviado: false, error: err.message });
    }
};
