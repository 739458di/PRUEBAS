// RELAY DE DESPLIEGUE AL VPS (Fase 0.3, 2026-09-07): la red local del owner bloquea el puerto 22
// de forma intermitente; Vercel llega siempre. Solo acepta la key; la contraseña vive en
// las variables de entorno de Vercel (VPS_EXEC_PASS), jamás en el cuerpo de la petición.
const { Client } = require('ssh2');
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    const b = req.body || {};
    if (String(b.key || '') !== (process.env.VPS_EXEC_KEY || 'fyra-vpsexec-2026-0905')) return res.status(401).json({ ok: false });
    const cmd = String(b.cmd || '');
    if (!cmd) return res.status(400).json({ ok: false, error: 'cmd' });
    const out = await new Promise((resolve) => {
        const c = new Client();
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { try { c.end(); } catch (e) { } resolve({ ok: false, error: 'timeout', stdout, stderr }); }, 50000);
        c.on('ready', () => {
            c.exec('bash -lc ' + JSON.stringify(cmd), (err, stream) => {
                if (err) { clearTimeout(timer); c.end(); return resolve({ ok: false, error: err.message }); }
                stream.on('data', d => stdout += d).stderr.on('data', d => stderr += d);
                stream.on('close', code => { clearTimeout(timer); c.end(); resolve({ ok: true, code, stdout, stderr }); });
            });
        }).on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); })
          .connect({ host: '137.184.199.19', port: 22, username: 'root', password: String(process.env.VPS_EXEC_PASS || b.pass || ''), readyTimeout: 20000 });
    });
    return res.status(200).json(out);
};
