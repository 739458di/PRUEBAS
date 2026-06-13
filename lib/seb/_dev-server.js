// Servidor local de desarrollo del panel copiloto.
// Sirve copilot.html y enruta /api/seb-panel al handler real (mismo código
// que correrá en Vercel). Correr: node lib/seb/_dev-server.js [puerto]
const fs = require('fs');
const http = require('http');
const path = require('path');

fs.readFileSync(path.join(__dirname, '../../.env'), 'utf8').split('\n').forEach(l => {
    const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
});

const handler = require('../../api/seb-panel.js');
const PUERTO = Number(process.argv[2]) || 3210;

http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // Shim estilo Vercel: req.query + req.body + res.status().json()
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    req.query = Object.fromEntries(url.searchParams);

    if (url.pathname.startsWith('/api/seb-panel')) {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = {}; }
            try { await handler(req, res); }
            catch (e) { res.status(500).json({ error: e.message }); }
        });
        return;
    }
    // Estáticos: copilot.html en raíz
    const f = url.pathname === '/' ? 'copilot.html' : url.pathname.slice(1);
    const fp = path.join(__dirname, '../../', f);
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        res.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain');
        res.end(fs.readFileSync(fp));
    } else { res.status(404).end('404'); }
}).listen(PUERTO, () => console.log('FyraChat copiloto → http://localhost:' + PUERTO));
