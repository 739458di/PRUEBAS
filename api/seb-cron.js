// api/seb-cron.js — EL CRON REAL de los recordatorios de cita (citas vivas).
// Lo dispara el crontab del VPS cada 10 min:
//   */10 * * * * curl -s 'https://fyrachat.vercel.app/api/seb-cron?key=fyra-cron-2026'
// Manda por WhatsApp los recordatorios que ya tocan (víspera, día D, espera del
// dueño, 1h antes, aviso de salida) — el MISMO plan que el sandbox (citas-vivas.js).
const { tickRecordatorios } = require('../lib/seb/citas-vivas.js');
const { tickEspejo } = require('../lib/seb/espejo.js');

module.exports = async function handler(req, res) {
    if ((req.query && req.query.key) !== 'fyra-cron-2026') return res.status(401).json({ ok: false });
    try {
        const r = await tickRecordatorios();
        // espejo SB → fyradrive: si falla no tumba los recordatorios
        try { r.espejo = await tickEspejo(); } catch (e) { r.espejo = { error: e.message }; }
        // canal Messenger: registra leads con la clave aunque aún no contesten
        try { r.messenger = await require('../lib/seb/canal-messenger.js').barrerMessenger(); } catch (e) { r.messenger = { error: e.message }; }
        // ══ VIGÍA DEL TELÉFONO (caso Roy 2026-08-25): si en 48h llegan entrantes pero
        // CERO manuales tuyos, el teléfono vinculado dejó de sincronizar → aviso (1/día).
        // Este hoyo estuvo 18 días mudo (8-25 ago) y el bot divagó con leads tuyos.
        try {
            const { query: q2, run: r2 } = require('../lib/seb/db.js');
            const desde48 = Date.now() - 48 * 3600000;
            const c = (await q2(`SELECT SUM(CASE WHEN direccion='in' THEN 1 ELSE 0 END) ins,
                SUM(CASE WHEN direccion='out' AND COALESCE(ai_generated,0)=0 THEN 1 ELSE 0 END) manuales
                FROM mensajes WHERE ts > ?`, [desde48]))[0];
            if (Number(c.ins) >= 5 && Number(c.manuales) === 0) {
                const hoy = new Date().toISOString().slice(0, 10);
                const marca = 'vigia_manual_outs:' + hoy;
                const ya = await q2("SELECT 1 FROM prueba_reset WHERE telefono=?", [marca]);
                if (!ya.length) {
                    await r2("INSERT INTO prueba_reset (telefono, reset_ts) VALUES (?,?)", [marca, Date.now()]);
                    const { enviarWA } = require('../lib/seb/citas-vivas.js');
                    await enviarWA('5218120066355', '📵 VIGÍA: en las últimas 48h llegaron ' + c.ins + ' mensajes de clientes pero CERO mensajes manuales tuyos pasaron por el puente. El teléfono vinculado al WhatsApp del bot NO está sincronizando lo que escribes — checa Dispositivos Vinculados en ese teléfono, o escríbeles desde FyraChat. Mientras tanto el bot puede divagar con leads que TÚ contactaste.');
                }
                r.vigia_telefono = 'ALERTA';
            } else r.vigia_telefono = 'ok';
        } catch (e) { r.vigia_telefono = 'error: ' + e.message; }
        return res.status(200).json(r);
    } catch (e) {
        console.error('[seb-cron]', e.message);
        return res.status(500).json({ ok: false, error: e.message });
    }
};
