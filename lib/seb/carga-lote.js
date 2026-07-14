// lib/seb/carga-lote.js
// ══ CARGA DE LOTE POR WHATSAPP (orden owner 2026-07-13) ═══════════════════════
// El owner manda autos al WhatsApp de Fyradrive DESDE SU NÚMERO (8120066355):
//   "carga lozano"  → enciende el modo carga (protege su chat normal con el bot)
//   TEXTO de ficha  → abre un auto (la IA estructura marca/modelo/año/precio...)
//   FOTOS           → se pegan al auto abierto
//   siguiente TEXTO → cierra y PUBLICA el anterior, abre el nuevo
//   "fin carga"     → publica lo abierto y apaga el modo
// Publicar = web /api/agency/publish-batch (activo + tipo agencia + plantilla
// verificada + propagación a Sales Brain). Recibo por WhatsApp por cada auto.
// El barredor del cron publica cargas abiertas con 4+ min sin actividad.

const { query, run } = require('./db.js');
const { enviarWA } = require('./citas-vivas.js');

const WEB = process.env.FYRADRIVE_WEB_URL || 'https://www.fyradrive.com';
const OWNER_CARGA = '5218120066355';
const CODE_DEFAULT = 'AUTOS LOZANO';

async function ensureCarga() {
    await run(`CREATE TABLE IF NOT EXISTS cargas_lote (
        id INTEGER PRIMARY KEY AUTOINCREMENT, remitente TEXT, code TEXT, texto TEXT,
        fotos TEXT, estado TEXT, resultado TEXT, created INTEGER, updated INTEGER)`);
    await run("CREATE TABLE IF NOT EXISTS carga_modo (remitente TEXT PRIMARY KEY, activo INTEGER, code TEXT, updated INTEGER)");
}

// ── IA: estructurar la ficha libre del owner (determinista en lo que importa) ──
async function parseFicha(texto) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return null;
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
                model: 'claude-haiku-4-5', max_tokens: 300,
                system: 'Estructuras fichas de autos usados (México). Extrae SOLO lo que diga el texto; no inventes. precio SIEMPRE en pesos completos (ej. "249,900"→249900; "250 mil"→250000; "$1,850,000"→1850000). kilometraje en km ("45 mil km"→45000). anio = 4 dígitos. transmision: "Automatica"|"Manual" si se menciona. Si un campo no está: null. Responde SOLO el JSON.',
                messages: [{ role: 'user', content: 'FICHA:\n' + String(texto).slice(0, 1200) }],
                output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: {
                    marca: { type: ['string', 'null'] }, modelo: { type: ['string', 'null'] }, anio: { type: ['integer', 'null'] },
                    precio: { type: ['integer', 'null'] }, kilometraje: { type: ['integer', 'null'] }, color: { type: ['string', 'null'] },
                    transmision: { type: ['string', 'null'] }, tipo_carroceria: { type: ['string', 'null'] }, version: { type: ['string', 'null'] },
                    comentarios: { type: ['string', 'null'] }
                }, required: ['marca', 'modelo', 'anio', 'precio', 'kilometraje', 'color', 'transmision', 'tipo_carroceria', 'version', 'comentarios'], additionalProperties: false } } }
            })
        });
        if (!r.ok) return null;
        const data = await r.json();
        const tb = (data.content || []).find(b => b.type === 'text');
        return JSON.parse(tb.text);
    } catch (e) { console.error('[carga parseFicha]', e.message); return null; }
}

async function publicarCarga(c) {
    let fotos; try { fotos = JSON.parse(c.fotos || '[]'); } catch (e) { fotos = []; }
    const resumen = String(c.texto || '').replace(/\s+/g, ' ').slice(0, 50);
    if (!fotos.length) {
        await run("UPDATE cargas_lote SET estado='error', resultado='sin fotos', updated=? WHERE id=?", [Date.now(), c.id]);
        await enviarWA(OWNER_CARGA, `⚠️ NO publicado (sin fotos): "${resumen}…" — manda el texto de nuevo seguido de sus fotos`);
        return false;
    }
    const f = await parseFicha(c.texto);
    const faltan = [];
    if (!f || !f.marca) faltan.push('marca'); if (!f || !f.modelo) faltan.push('modelo');
    if (!f || !f.anio) faltan.push('año'); if (!f || !f.precio) faltan.push('precio');
    if (faltan.length) {
        await run("UPDATE cargas_lote SET estado='error', resultado=?, updated=? WHERE id=?", ['faltan: ' + faltan.join(','), Date.now(), c.id]);
        await enviarWA(OWNER_CARGA, `⚠️ NO publicado — a "${resumen}…" le faltó: ${faltan.join(', ')}. Manda el texto completo de nuevo + fotos`);
        return false;
    }
    try {
        const modelo = [f.modelo, f.version].filter(Boolean).join(' ');
        const resp = await fetch(WEB + '/api/agency/publish-batch', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: c.code || CODE_DEFAULT,
                autos: [{ marca: f.marca, modelo, anio: f.anio, precio: f.precio, kilometraje: f.kilometraje || undefined, color: f.color || undefined, transmision: f.transmision || undefined, tipo_carroceria: f.tipo_carroceria || undefined, comentarios: f.comentarios || undefined, photos: fotos.map((u, i) => ({ url: u, isPrincipal: i === 0 })) }]
            })
        });
        const d = await resp.json().catch(() => ({}));
        const okPub = resp.ok && d && (d.ok !== false) && (!d.errors || !d.errors.length);
        if (okPub) {
            await run("UPDATE cargas_lote SET estado='publicada', resultado=?, updated=? WHERE id=?", [JSON.stringify(d.created || d).slice(0, 400), Date.now(), c.id]);
            await enviarWA(OWNER_CARGA, `✅ Publicado: ${f.marca} ${modelo} ${f.anio} — $${Number(f.precio).toLocaleString('en-US')} — ${fotos.length} fotos (${c.code || CODE_DEFAULT})`);
            return true;
        }
        const err = (d.errors && d.errors[0] && d.errors[0].error) || d.error || ('web ' + resp.status);
        await run("UPDATE cargas_lote SET estado='error', resultado=?, updated=? WHERE id=?", [String(err).slice(0, 300), Date.now(), c.id]);
        await enviarWA(OWNER_CARGA, `⚠️ NO publicado (${f.marca} ${modelo} ${f.anio}): ${String(err).slice(0, 120)}`);
        return false;
    } catch (e) {
        await run("UPDATE cargas_lote SET estado='error', resultado=?, updated=? WHERE id=?", [String(e.message).slice(0, 300), Date.now(), c.id]);
        await enviarWA(OWNER_CARGA, `⚠️ NO publicado (error de red): ${String(e.message).slice(0, 100)} — reintenta con "fin carga" o mándalo de nuevo`);
        return false;
    }
}

// ── UNA PIEZA llega del puente: FOTOS se acumulan, el TEXTO cierra y publica ──
// (patrón real del owner 2026-07-13: manda las fotos del auto y LUEGO su ficha.
//  Sin comando de modo: el candado es que haya fotos acumuladas + ficha completa —
//  su chat normal con el bot jamás dispara nada.)
async function pieza({ remitente, tipo, texto, url }) {
    await ensureCarga();
    const tel = String(remitente || '').replace(/\D/g, '');
    if (tel !== OWNER_CARGA) return { ok: false, motivo: 'remitente no autorizado' };
    const tN = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

    if (tipo === 'foto' && url) {
        const ab = await query("SELECT * FROM cargas_lote WHERE remitente=? AND estado='abierta' ORDER BY id DESC LIMIT 1", [tel]);
        let id;
        if (ab.length) id = ab[0].id;
        else {
            const ins = await run("INSERT INTO cargas_lote (remitente, code, texto, fotos, estado, created, updated) VALUES (?,?,NULL,'[]','abierta',?,?)", [tel, CODE_DEFAULT, Date.now(), Date.now()]);
            id = Number(ins.lastInsertRowid);
        }
        const row = ab.length ? ab[0] : { fotos: '[]' };
        let fotos; try { fotos = JSON.parse(row.fotos || '[]'); } catch (e) { fotos = []; }
        fotos.push(String(url));
        await run("UPDATE cargas_lote SET fotos=?, updated=? WHERE id=?", [JSON.stringify(fotos), Date.now(), id]);
        return { ok: true, fotos: fotos.length };
    }

    if (tipo === 'texto') {
        if (/^fin (de )?(la )?carga/.test(tN)) {
            await run("UPDATE cargas_lote SET estado='descartada', updated=? WHERE remitente=? AND estado='abierta'", [Date.now(), tel]);
            const tot = await query("SELECT COUNT(*) n FROM cargas_lote WHERE remitente=? AND estado='publicada' AND updated > ?", [tel, Date.now() - 12 * 3600000]);
            await enviarWA(OWNER_CARGA, `🏁 Carga cerrada — ${tot[0].n} auto(s) publicados en esta sesión`);
            return { ok: true, modo: 'off' };
        }
        if (/^carga (lozano|lote|autos)/.test(tN)) {
            await enviarWA(OWNER_CARGA, `🚗 Listo — mándame las FOTOS de cada auto y al final su TEXTO con la ficha (marca, modelo, año, precio). El texto publica el auto.`);
            return { ok: true, modo: 'on' };
        }
        // el TEXTO cierra: fotos acumuladas + esta ficha = un auto
        const ab = await query("SELECT * FROM cargas_lote WHERE remitente=? AND estado='abierta' ORDER BY id DESC LIMIT 1", [tel]);
        if (!ab.length) return { ok: false, motivo: 'sin fotos acumuladas — texto ignorado (chat normal)' };
        let fotos; try { fotos = JSON.parse(ab[0].fotos || '[]'); } catch (e) { fotos = []; }
        if (!fotos.length) return { ok: false, motivo: 'sin fotos acumuladas — texto ignorado' };
        await run("UPDATE cargas_lote SET texto=?, updated=? WHERE id=?", [String(texto || ''), Date.now(), ab[0].id]);
        const c = (await query("SELECT * FROM cargas_lote WHERE id=?", [ab[0].id]))[0];
        const pub = await publicarCarga(c);
        return { ok: true, publicado: pub };
    }
    return { ok: false, motivo: 'pieza no reconocida' };
}

// ── BARREDOR (cron cada 10 min): carga abierta con 4+ min sin actividad → publica ──
async function barrerCargas() {
    await ensureCarga();
    // fotos acumuladas SIN ficha por 30+ min → se descartan con aviso (jamás publicar a ciegas)
    const huerfanas = await query("SELECT * FROM cargas_lote WHERE estado='abierta' AND updated < ?", [Date.now() - 30 * 60000]);
    let n = 0;
    for (const c of huerfanas) {
        let nf = 0; try { nf = JSON.parse(c.fotos || '[]').length; } catch (e) { }
        await run("UPDATE cargas_lote SET estado='descartada', updated=? WHERE id=?", [Date.now(), c.id]);
        if (nf) await enviarWA(OWNER_CARGA, `⚠️ Tenía ${nf} fotos esperando su ficha y pasaron 30 min — las descarté. Reenvía fotos + texto del auto`);
        n++;
    }
    return n;
}

module.exports = { pieza, barrerCargas, publicarCarga, parseFicha, ensureCarga };
