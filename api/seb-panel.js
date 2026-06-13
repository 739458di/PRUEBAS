// api/seb-panel.js — Backend del panel copiloto (el WhatsApp de Seb).
// GET  ?action=chats              → lista de conversaciones de COMPRADORES
// GET  ?action=chat&telefono=     → mensajes + borrador pendiente + estado
// POST {action:'sugerir', telefono}                  → corre entender+pensar y encola borrador
// POST {action:'resolver', queue_id, resolucion, texto_final} → aprueba/edita/manual + ENTRENAMIENTO
//
// Entrenamiento (medible, sin auto-mutación): cada resolución guarda borrador
// vs texto_final + similitud + intención en seb_entrenamiento. El análisis por
// lotes usa eso para afinar la biblioteca donde Seb falla.

const { query, run } = require('../lib/seb/db.js');
const { entender } = require('../lib/seb/clasificador.js');
const { pensar } = require('../lib/seb/loop.js');

// Similitud simple por tokens (1 = idéntico, 0 = nada en común)
function similitud(a, b) {
    const ta = new Set(String(a || '').toLowerCase().split(/\s+/).filter(Boolean));
    const tb = new Set(String(b || '').toLowerCase().split(/\s+/).filter(Boolean));
    if (ta.size === 0 && tb.size === 0) return 1;
    let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
    return Math.round((2 * inter / (ta.size + tb.size)) * 100) / 100;
}

async function telefonosDueno() {
    const rows = await query("SELECT DISTINCT dueno_telefono t FROM inventario_autos WHERE dueno_telefono IS NOT NULL");
    return new Set(rows.map(r => String(r.t).replace(/\D/g, '').slice(-10)).filter(x => x.length === 10));
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

        // ============ LISTA DE CHATS (solo compradores) ============
        if (action === 'chats') {
            const duenos = await telefonosDueno();
            // UNA query plana y agregación en JS (las subqueries correlacionadas
            // sobre Turso remoto tardaban demasiado)
            // substr: hay mensajes gigantes (imágenes base64) que revientan el
            // sort de SQLite (SQLITE_NOMEM) si se arrastran completos
            const ult = await query(
                "SELECT telefono, nombre, substr(mensaje,1,120) mensaje, direccion, timestamp FROM wa_messages WHERE platform='whatsapp' AND mensaje IS NOT NULL ORDER BY timestamp DESC LIMIT 800");
            const porTel = new Map();
            for (const m of ult) {
                if (!porTel.has(m.telefono)) {
                    porTel.set(m.telefono, { telefono: m.telefono, nombre: m.nombre, ult_msg: m.mensaje, ult_dir: m.direccion, ult_ts: m.timestamp });
                } else if (!porTel.get(m.telefono).nombre && m.nombre) {
                    porTel.get(m.telefono).nombre = m.nombre;
                }
                if (porTel.size >= 60) { /* sigue para rellenar nombres */ }
            }
            const rows = [...porTel.values()].slice(0, 60);
            const pend = await query("SELECT telefono, COUNT(*) n FROM seb_queue WHERE estado='pendiente' GROUP BY telefono");
            const pendMap = {}; pend.forEach(p => pendMap[p.telefono] = p.n);
            const chats = rows
                .filter(r => !duenos.has(String(r.telefono).replace(/\D/g, '').slice(-10)))
                .map(r => ({
                    telefono: r.telefono,
                    nombre: r.nombre || ('+' + String(r.telefono).slice(0, 3) + ' ' + String(r.telefono).slice(-10)),
                    ult_msg: String(r.ult_msg || '').slice(0, 90),
                    ult_dir: r.ult_dir,
                    ult_ts: Number(r.ult_ts),
                    pendientes: pendMap[r.telefono] || 0
                }));
            return res.status(200).json({ ok: true, chats });
        }

        // ============ UN CHAT COMPLETO ============
        if (action === 'chat') {
            const tel = String(req.query.telefono || '');
            const msgs = await query(
                "SELECT id, substr(mensaje,1,1500) mensaje, direccion, timestamp, origen_envio FROM wa_messages WHERE telefono=? AND mensaje IS NOT NULL ORDER BY timestamp DESC LIMIT 50",
                [tel]);
            const draft = await query(
                "SELECT id, borrador, intencion, creado_en FROM seb_queue WHERE telefono=? AND estado='pendiente' ORDER BY id DESC LIMIT 1",
                [tel]);
            const conv = await query("SELECT estado_json, auto_id_activo FROM wa_conversations WHERE telefono=?", [tel]);
            return res.status(200).json({
                ok: true,
                mensajes: msgs.reverse(),
                borrador: draft[0] || null,
                estado: conv[0] ? { ...JSON.parse(conv[0].estado_json || '{}'), auto_id_activo: conv[0].auto_id_activo } : {}
            });
        }

        // ============ SUGERIR (corre el cerebro on-demand) ============
        if (action === 'sugerir' && req.method === 'POST') {
            const tel = String(req.body.telefono || '');
            const last = await query(
                "SELECT id, substr(mensaje,1,1000) mensaje FROM wa_messages WHERE telefono=? AND direccion='in' AND mensaje IS NOT NULL ORDER BY timestamp DESC LIMIT 1", [tel]);
            if (last.length === 0) return res.status(400).json({ error: 'sin mensajes entrantes' });
            const dedupe = tel + ':' + last[0].id;
            const ya = await query("SELECT id, borrador FROM seb_queue WHERE dedupe_key=? AND estado='pendiente'", [dedupe]);
            if (ya.length) return res.status(200).json({ ok: true, queue_id: ya[0].id, borrador: ya[0].borrador, cached: true });

            const hist = await query(
                "SELECT substr(mensaje,1,300) mensaje, direccion FROM wa_messages WHERE telefono=? AND mensaje IS NOT NULL ORDER BY timestamp DESC LIMIT 8", [tel]);
            const historial = hist.reverse().map(h => ({ direccion: h.direccion, mensaje: h.mensaje }));
            const convRow = await query("SELECT estado_json, auto_id_activo FROM wa_conversations WHERE telefono=?", [tel]);
            const estado = convRow[0] ? { ...JSON.parse(convRow[0].estado_json || '{}'), auto_id_activo: convRow[0].auto_id_activo } : {};

            const clasif = await entender({ mensaje: last[0].mensaje, historial, estado });
            const r = await pensar({ telefono: tel, mensaje: last[0].mensaje, clasificacion: clasif, estado });
            if (!r.ok) {
                return res.status(200).json({ ok: false, escalar: true, motivo: r.motivo, intencion: clasif.intencion_principal });
            }
            const ins = await run(
                `INSERT INTO seb_queue (telefono, borrador, estado, intencion, tools_usadas, dedupe_key, creado_en)
                 VALUES (?, ?, 'pendiente', ?, ?, ?, ?)`,
                [tel, r.borrador, clasif.intencion_principal,
                 JSON.stringify({ tools: r.tools_usadas.map(t => t.tool), estado_nuevo: r.estado_nuevo, auto_id: clasif.auto_id }),
                 dedupe, Date.now()]);
            return res.status(200).json({ ok: true, queue_id: Number(ins.lastInsertRowid), borrador: r.borrador, intencion: clasif.intencion_principal });
        }

        // ============ RESOLVER (aprobar / editar / manual) + ENTRENAMIENTO ============
        if (action === 'resolver' && req.method === 'POST') {
            const { queue_id, resolucion, texto_final } = req.body;
            if (!queue_id || !['aprobado', 'editado', 'manual'].includes(resolucion)) {
                return res.status(400).json({ error: 'queue_id y resolucion válida requeridos' });
            }
            const q = await query("SELECT * FROM seb_queue WHERE id=?", [Number(queue_id)]);
            if (!q.length) return res.status(404).json({ error: 'no existe' });
            const item = q[0];
            const meta = JSON.parse(item.tools_usadas || '{}');
            const final = resolucion === 'aprobado' ? item.borrador : String(texto_final || '');
            if (!final.trim()) return res.status(400).json({ error: 'texto_final vacío' });

            // 1) ENTRENAMIENTO: registrar la decisión humana (la materia prima del lote)
            const sim = resolucion === 'aprobado' ? 1 : similitud(item.borrador, final);
            await run(
                `INSERT INTO seb_entrenamiento (queue_id, telefono, intencion, auto_id, borrador, texto_final, accion, similitud, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [item.id, item.telefono, item.intencion, meta.auto_id || null, item.borrador, final, resolucion, sim, Date.now()]);

            // 2) Persistir estado nuevo de la conversación
            if (meta.estado_nuevo) {
                const upd = await run("UPDATE wa_conversations SET estado_json=?, auto_id_activo=?, updated_at=? WHERE telefono=?",
                    [JSON.stringify(meta.estado_nuevo), meta.estado_nuevo.auto_id_activo || null, Date.now(), item.telefono]);
                if (!upd.rowsAffected) {
                    await run("INSERT INTO wa_conversations (telefono, estado, platform, estado_json, auto_id_activo, updated_at) VALUES (?, 'seb', 'whatsapp', ?, ?, ?)",
                        [item.telefono, JSON.stringify(meta.estado_nuevo), meta.estado_nuevo.auto_id_activo || null, Date.now()]);
                }
            }

            // 3) Intentar envío por el bridge (si está configurado y vivo)
            let enviado = false, error_envio = null;
            const bridgeUrl = process.env.BRIDGE_SEND_URL, bridgeKey = process.env.BRIDGE_API_KEY;
            if (bridgeUrl && bridgeKey) {
                try {
                    let phone = String(item.telefono).replace(/\D/g, '');
                    if (phone.length === 10) phone = '521' + phone;
                    const r = await fetch(bridgeUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': bridgeKey },
                        body: JSON.stringify({ phone, text: final })
                    });
                    const d = await r.json().catch(() => ({}));
                    enviado = r.ok && d.ok !== false;
                    if (!enviado) error_envio = d.error || ('bridge ' + r.status);
                } catch (e) { error_envio = e.message; }
            } else { error_envio = 'bridge no configurado (BRIDGE_SEND_URL/BRIDGE_API_KEY)'; }

            // 4) Solo si SE ENVIÓ se registra el mensaje saliente (lección: nunca guardar envíos fallidos)
            if (enviado) {
                await run(
                    "INSERT INTO wa_messages (telefono, mensaje, tipo, direccion, timestamp, created_at, ai_generated, platform, origen_envio) VALUES (?, ?, 'text', 'out', ?, ?, ?, 'whatsapp', ?)",
                    [item.telefono, final, Math.floor(Date.now() / 1000), Date.now(), resolucion !== 'manual' ? 1 : 0,
                     resolucion === 'aprobado' ? 'borrador_aprobado' : (resolucion === 'editado' ? 'editado' : 'manual')]);
            }
            await run("UPDATE seb_queue SET estado=?, texto_final=?, resuelto_en=? WHERE id=?",
                [enviado ? 'enviado' : 'aprobado_sin_enviar', final, Date.now(), item.id]);

            return res.status(200).json({ ok: true, enviado, error_envio, similitud: sim });
        }

        // ============ MANUAL DIRECTO (escribes sin borrador pendiente) ============
        if (action === 'manual_directo' && req.method === 'POST') {
            const tel = String(req.body.telefono || '');
            const texto = String(req.body.texto || '').trim();
            if (!tel || !texto) return res.status(400).json({ error: 'telefono y texto requeridos' });
            let enviado = false, error_envio = null;
            const bridgeUrl = process.env.BRIDGE_SEND_URL, bridgeKey = process.env.BRIDGE_API_KEY;
            if (bridgeUrl && bridgeKey) {
                try {
                    let phone = tel.replace(/\D/g, '');
                    if (phone.length === 10) phone = '521' + phone;
                    const r = await fetch(bridgeUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': bridgeKey },
                        body: JSON.stringify({ phone, text: texto })
                    });
                    const d = await r.json().catch(() => ({}));
                    enviado = r.ok && d.ok !== false;
                    if (!enviado) error_envio = d.error || ('bridge ' + r.status);
                } catch (e) { error_envio = e.message; }
            } else { error_envio = 'bridge no configurado'; }
            if (enviado) {
                await run(
                    "INSERT INTO wa_messages (telefono, mensaje, tipo, direccion, timestamp, created_at, ai_generated, platform, origen_envio) VALUES (?, ?, 'text', 'out', ?, ?, 0, 'whatsapp', 'manual')",
                    [tel, texto, Math.floor(Date.now() / 1000), Date.now()]);
            }
            return res.status(200).json({ ok: true, enviado, error_envio });
        }

        return res.status(400).json({ error: 'action inválida' });
    } catch (err) {
        console.error('[SEB-PANEL]', err);
        return res.status(500).json({ error: err.message });
    }
};
