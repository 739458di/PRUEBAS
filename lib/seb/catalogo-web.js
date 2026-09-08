// lib/seb/catalogo-web.js — avisa a fyradrive.com que re-proyecte autos concretos en public_catalog_items
// (proyección pública del catálogo, orden owner 2026-09-08). Best-effort y esperado.
const WEB = process.env.FYRADRIVE_WEB_URL || 'https://www.fyradrive.com';
const KEY = process.env.CATALOG_KEY || 'fyra-catalog-2026';
async function proyectarWeb(webIds, all) {
    const ids = [...new Set((webIds || []).map(Number).filter(n => n > 0))];
    if (!ids.length && !all) return { ok: true, n: 0 };
    try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), all ? 50000 : 6000);
        const r = await fetch(WEB + '/api/catalog/project', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-catalog-key': KEY }, body: JSON.stringify(all ? { all: true } : { auto_ids: ids }), signal: ctl.signal });
        clearTimeout(t);
        return { ok: r.ok, n: all ? 'all' : ids.length };
    } catch (e) { console.warn('[catalogo-web]', e.message); return { ok: false, error: e.message }; }
}
module.exports = { proyectarWeb };
