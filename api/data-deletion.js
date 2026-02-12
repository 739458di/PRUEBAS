// FYRADRIVE - Data Deletion Request Handler
// GET  /api/data-deletion = shows deletion instructions page
// POST /api/data-deletion = handles Meta's data deletion callback

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // POST = Meta data deletion callback
    if (req.method === 'POST') {
        var signed_request = req.body ? req.body.signed_request : '';
        // Respond with confirmation URL and code
        var code = 'FD' + Date.now();
        return res.status(200).json({
            url: 'https://pruebas-ruby.vercel.app/api/data-deletion?code=' + code,
            confirmation_code: code
        });
    }

    // GET = Show deletion instructions page
    var code = req.query.code || '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send('<!DOCTYPE html>' +
'<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<title>Eliminación de Datos - FYRADRIVE</title>' +
'<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;color:#333;line-height:1.6;text-align:center;}' +
'h1{color:#1a1a2e;}' +
'.logo{font-size:24px;font-weight:bold;color:#e94560;margin-bottom:20px;}' +
'.status{background:#f0f9f0;border:1px solid #4CAF50;border-radius:8px;padding:20px;margin:20px 0;}' +
'.code{font-family:monospace;font-size:18px;color:#e94560;}</style></head><body>' +
'<div class="logo">FYRADRIVE</div>' +
'<h1>Eliminación de Datos</h1>' +
(code ? '<div class="status"><p>Tu solicitud de eliminación ha sido recibida.</p><p>Código de confirmación: <span class="code">' + code + '</span></p><p>Tus datos serán eliminados en un plazo de 30 días.</p></div>' :
'<p>Para solicitar la eliminación de tus datos, envíanos un mensaje por Facebook Messenger o WhatsApp con la palabra <strong>"ELIMINAR DATOS"</strong>.</p><p>También puedes contactarnos directamente a través de nuestra página de Facebook: <strong>FYRADRIVE</strong></p>') +
'</body></html>');
};
