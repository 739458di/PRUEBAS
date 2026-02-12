// FYRADRIVE - API de Configuración del Chatbot IA
// GET: leer config | PUT: actualizar config

const { getAIConfig, updateAIConfig, initAITables } = require('./ai-sales.js');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.status(200).end();

    var apiKey = req.headers['x-api-key'];
    if (apiKey !== 'fyradrive2026') return res.status(401).json({ error: 'No autorizado' });

    // GET - Leer config actual
    if (req.method === 'GET') {
        try {
            var config = await getAIConfig();
            return res.status(200).json({ ok: true, config: config });
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message });
        }
    }

    // PUT - Actualizar config
    if (req.method === 'PUT') {
        try {
            var body = req.body || {};
            var success = await updateAIConfig(body);
            if (success) {
                var config = await getAIConfig();
                return res.status(200).json({ ok: true, config: config });
            } else {
                return res.status(500).json({ ok: false, error: 'No se pudo actualizar' });
            }
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
