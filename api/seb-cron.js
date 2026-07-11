// api/seb-cron.js — EL CRON REAL de los recordatorios de cita (citas vivas).
// Lo dispara el crontab del VPS cada 10 min:
//   */10 * * * * curl -s 'https://fyrachat.vercel.app/api/seb-cron?key=fyra-cron-2026'
// Manda por WhatsApp los recordatorios que ya tocan (víspera, día D, espera del
// dueño, 1h antes, aviso de salida) — el MISMO plan que el sandbox (citas-vivas.js).
const { tickRecordatorios } = require('../lib/seb/citas-vivas.js');

module.exports = async function handler(req, res) {
    if ((req.query && req.query.key) !== 'fyra-cron-2026') return res.status(401).json({ ok: false });
    try {
        const r = await tickRecordatorios();
        return res.status(200).json(r);
    } catch (e) {
        console.error('[seb-cron]', e.message);
        return res.status(500).json({ ok: false, error: e.message });
    }
};
