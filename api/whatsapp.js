// API para enviar mensajes de WhatsApp via Meta Cloud API
// POST /api/whatsapp
// Body: { telefono, mensaje, nombre? }
// Header: x-api-key = fyradrive2026

const WA_TOKEN = process.env.WA_TOKEN || 'EAAcJmKFNOhYBQmwLpx7E9W1LRdHZBOO1FhzKcLYDC1MmUXOHhhkOyOqFYUh4IpCLZCBBdfx2tTZAemBjH8Va7dyr2ywQ2MZBlB9SjuspHaUK9HVTj2ixZC3y2oxIehxEi4aYsMbJRGZC9M3yZCp15rY6gaTgiTkfifakjfg27c8W1IhDh3KLn8eUQZBGT9ZA8cduWROGiGv4zDXMx8QmxASkL2HsZCz08hfdH6VTL6QQN0Ln7Ovtj8ZBlQLZCZBTrwMTr71Jb3mzf0Pv04fN6ZCZAcmmVzwLQUlmQZDZD';
const PHONE_NUMBER_ID = '968960759641278';
const API_KEY = 'fyradrive2026';
const WA_API_URL = 'https://graph.facebook.com/v21.0/' + PHONE_NUMBER_ID + '/messages';

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Solo POST' });

    // Auth
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEY) {
        return res.status(401).json({ error: 'API key invalida' });
    }

    const { telefono, mensaje, nombre } = req.body;

    // Validar
    if (!telefono) {
        return res.status(400).json({ error: 'telefono requerido' });
    }
    if (!mensaje) {
        return res.status(400).json({ error: 'mensaje requerido' });
    }

    // Limpiar telefono - formato: solo digitos, con codigo de pais
    var clean = telefono.replace(/\D/g, '');
    if (clean.length === 10) {
        clean = '52' + clean; // Mexico
    } else if (clean.length === 11 && clean.startsWith('1')) {
        clean = '52' + clean;
    } else if (clean.length === 13 && clean.startsWith('521')) {
        // ya tiene 521, dejarlo
    } else if (clean.length === 12 && clean.startsWith('52')) {
        // ya tiene 52, dejarlo
    }
    // Si no matchea nada, dejarlo como esta

    try {
        const response = await fetch(WA_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + WA_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: clean,
                type: 'text',
                text: {
                    preview_url: false,
                    body: mensaje
                }
            })
        });

        const data = await response.json();

        if (response.ok) {
            return res.status(200).json({
                enviado: true,
                mensaje_id: data.messages ? data.messages[0].id : null,
                telefono: clean,
                detalle: data
            });
        } else {
            return res.status(response.status).json({
                enviado: false,
                error: data.error ? data.error.message : 'Error desconocido',
                codigo: data.error ? data.error.code : null,
                detalle: data
            });
        }

    } catch (err) {
        return res.status(500).json({
            enviado: false,
            error: err.message
        });
    }
};
