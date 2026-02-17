// CLAW CONFIG API — Controla a Seb desde el CRM
// GET: ver config actual
// POST: modificar config, agregar grupo, cambiar prompt
// Ejemplos:
//   POST { action: "set_config", key: "system_prompt_dm", value: "..." }
//   POST { action: "add_group", jid: "12345@g.us", nombre: "FyraDrive Team" }
//   POST { action: "remove_group", jid: "12345@g.us" }
//   POST { action: "set_triggers", triggers: "seb,claw,fyradrive,cotiza" }
//   POST { action: "toggle_groups", enabled: true }
//   POST { action: "set_model", model: "claude-sonnet-4-5-20250929" }
//   GET ?action=groups — lista grupos
//   GET ?action=config — toda la config

const { createClient } = require('@libsql/client');

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN
});

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // Auth simple
    var key = req.headers['x-api-key'] || req.query?.key;
    if (key !== 'fyradrive2026') {
        return res.status(401).json({ error: 'No autorizado' });
    }

    try {
        // ===== GET =====
        if (req.method === 'GET') {
            var action = req.query?.action || 'config';

            if (action === 'groups') {
                var groups = await client.execute('SELECT jid, nombre, activo FROM claw_groups ORDER BY created_at DESC');
                return res.status(200).json({ ok: true, groups: groups.rows });
            }

            // Default: toda la config
            var config = await client.execute('SELECT key, value FROM claw_config');
            var obj = {};
            config.rows.forEach(function(r) { obj[r.key] = r.value; });
            var groups = await client.execute('SELECT jid, nombre, activo FROM claw_groups');
            return res.status(200).json({ ok: true, config: obj, groups: groups.rows });
        }

        // ===== POST =====
        if (req.method === 'POST') {
            var body = req.body || {};
            var action = body.action;

            if (!action) return res.status(400).json({ error: 'Falta action' });

            // Modificar cualquier config
            if (action === 'set_config') {
                if (!body.key || body.value === undefined) return res.status(400).json({ error: 'Falta key/value' });
                await client.execute({
                    sql: 'INSERT OR REPLACE INTO claw_config (key, value, updated_at) VALUES (?, ?, unixepoch())',
                    args: [body.key, String(body.value)]
                });
                // Notificar a Claw que recargue
                try { await fetch('http://134.209.51.172:3000/reload'); } catch(e) {}
                return res.status(200).json({ ok: true, key: body.key, updated: true });
            }

            // Agregar grupo
            if (action === 'add_group') {
                if (!body.jid) return res.status(400).json({ error: 'Falta jid del grupo' });
                await client.execute({
                    sql: 'INSERT OR REPLACE INTO claw_groups (jid, nombre, activo, created_at) VALUES (?, ?, 1, unixepoch())',
                    args: [body.jid, body.nombre || 'Grupo']
                });
                try { await fetch('http://134.209.51.172:3000/reload'); } catch(e) {}
                return res.status(200).json({ ok: true, group: body.jid, added: true });
            }

            // Quitar grupo
            if (action === 'remove_group') {
                if (!body.jid) return res.status(400).json({ error: 'Falta jid' });
                await client.execute({
                    sql: 'UPDATE claw_groups SET activo = 0 WHERE jid = ?',
                    args: [body.jid]
                });
                try { await fetch('http://134.209.51.172:3000/reload'); } catch(e) {}
                return res.status(200).json({ ok: true, group: body.jid, removed: true });
            }

            // Cambiar triggers
            if (action === 'set_triggers') {
                await client.execute({
                    sql: "INSERT OR REPLACE INTO claw_config (key, value, updated_at) VALUES ('group_triggers', ?, unixepoch())",
                    args: [body.triggers || '']
                });
                try { await fetch('http://134.209.51.172:3000/reload'); } catch(e) {}
                return res.status(200).json({ ok: true, triggers: body.triggers });
            }

            // Toggle grupos
            if (action === 'toggle_groups') {
                var val = body.enabled ? 'true' : 'false';
                await client.execute({
                    sql: "INSERT OR REPLACE INTO claw_config (key, value, updated_at) VALUES ('groups_enabled', ?, unixepoch())",
                    args: [val]
                });
                try { await fetch('http://134.209.51.172:3000/reload'); } catch(e) {}
                return res.status(200).json({ ok: true, groups_enabled: val });
            }

            // Cambiar modelo
            if (action === 'set_model') {
                await client.execute({
                    sql: "INSERT OR REPLACE INTO claw_config (key, value, updated_at) VALUES ('model', ?, unixepoch())",
                    args: [body.model || 'claude-sonnet-4-5-20250929']
                });
                try { await fetch('http://134.209.51.172:3000/reload'); } catch(e) {}
                return res.status(200).json({ ok: true, model: body.model });
            }

            return res.status(400).json({ error: 'Action desconocido: ' + action });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch(err) {
        return res.status(500).json({ error: err.message });
    }
};
