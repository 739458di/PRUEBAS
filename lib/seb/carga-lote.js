// lib/seb/carga-lote.js
// ══ CARGA DE LOTE POR WHATSAPP (orden owner 2026-07-13) ═══════════════════════
// El owner manda autos al WhatsApp de Fyradrive DESDE SU NÚMERO (8120066355):
//   "carga lozano"  → enciende el modo carga (protege su chat normal con el bot)
//   TEXTO de ficha  → abre un auto (la IA estructura marca/modelo/año/precio...)
//   FOTOS           → se pegan al auto abierto
//   siguiente TEXTO → cierra y PUBLICA el anterior, abre el nuevo
//   "fin carga"     → publica lo abierto y apaga el modo
// Publicar = web /api/agency/publish-batch (activo + plantilla verificada +
// propagación a Sales Brain). Recibo por WhatsApp por cada auto.
// El barredor del cron publica cargas abiertas con 4+ min sin actividad.
//
// ══ DESTINO (orden owner 2026-07-16): NO todo lo del owner es AUTOS LOZANO.
//   Marcelo → siempre AUTOS LOZANO. El owner → AUTOS LOZANO SOLO si su ficha
//   dice "lozano"; si no lo dice, el auto es de PARTICULAR y se publica como
//   particular (plantilla oscura), con los datos del dueño si vienen en la ficha.

const { query, run } = require('./db.js');
const { enviarWA } = require('./citas-vivas.js');

const WEB = process.env.FYRADRIVE_WEB_URL || 'https://www.fyradrive.com';
const OWNER_CARGA = '5218120066355';
// ══ MARCELO LOZANO (alta 2026-07-16, orden owner): responsable de AUTOS LOZANO —
// lo que él mande por WhatsApp se publica en automático como AUTOS LOZANO, y sus
// recibos/avisos de carga le llegan a ÉL (el owner recibe un resumen al publicar).
const MARCELO_LOZANO = '5218129405001';
const CARGA_AUTORIZADOS = new Set([OWNER_CARGA, MARCELO_LOZANO]);
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
                system: 'Estructuras fichas de autos usados (México). Extrae SOLO lo que diga el texto; no inventes. precio SIEMPRE en pesos completos (ej. "249,900"→249900; "250 mil"→250000; "$1,850,000"→1850000). kilometraje en km ("45 mil km"→45000). anio = 4 dígitos. transmision: "Automatica"|"Manual" si se menciona. dueno_nombre/dueno_telefono: nombre y teléfono del DUEÑO/vendedor del auto SOLO si la ficha los trae (teléfono solo dígitos). En comentarios NO metas "lozano" ni datos del dueño ni destino de publicación (son instrucciones, no ficha). Si un campo no está: null. Responde SOLO el JSON.',
                messages: [{ role: 'user', content: 'FICHA:\n' + String(texto).slice(0, 1200) }],
                output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: {
                    marca: { type: ['string', 'null'] }, modelo: { type: ['string', 'null'] }, anio: { type: ['integer', 'null'] },
                    precio: { type: ['integer', 'null'] }, kilometraje: { type: ['integer', 'null'] }, color: { type: ['string', 'null'] },
                    transmision: { type: ['string', 'null'] }, tipo_carroceria: { type: ['string', 'null'] }, version: { type: ['string', 'null'] },
                    comentarios: { type: ['string', 'null'] }, dueno_nombre: { type: ['string', 'null'] }, dueno_telefono: { type: ['string', 'null'] }
                }, required: ['marca', 'modelo', 'anio', 'precio', 'kilometraje', 'color', 'transmision', 'tipo_carroceria', 'version', 'comentarios', 'dueno_nombre', 'dueno_telefono'], additionalProperties: false } } }
            })
        });
        if (!r.ok) return null;
        const data = await r.json();
        const tb = (data.content || []).find(b => b.type === 'text');
        return JSON.parse(tb.text);
    } catch (e) { console.error('[carga parseFicha]', e.message); return null; }
}

// ── ORDEN ESTÉTICO (orden owner 2026-07-13): la visión IA clasifica cada foto y
// las acomoda: PORTADA (frontal 3/4, auto completo, buena luz) → exteriores →
// interiores → detalles. El orden de envío del owner NO importa. Fail-open.
async function ordenarFotos(fotos) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey || !Array.isArray(fotos) || fotos.length < 2) return fotos;
    try {
        const clasif = await Promise.all(fotos.map(async (url) => {
            try {
                const r = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                    body: JSON.stringify({
                        model: 'claude-haiku-4-5', max_tokens: 160,
                        // el campo "descripcion" VA PRIMERO a propósito: obliga al ojo a MIRAR
                        // antes de clasificar (sin él contestaba tipo/portada al azar — Accord).
                        system: 'Clasificas fotos de autos usados. PRIMERO describe qué parte del auto ves, LUEGO clasifica. Responde SOLO el JSON.',
                        messages: [{ role: 'user', content: [
                            { type: 'image', source: { type: 'url', url } },
                            { type: 'text', text: 'tipo: diagonal_frontal (se ven los FAROS DELANTEROS/parrilla Y un costado a la vez, auto completo — la clásica 3/4 de portada) | frontal (puro frente, sin costado) | trasera_o_lateral (se ven calaveras/cajuela, o perfil lateral puro sin faros de frente) | interior | detalle. OJO: si se ve la parte TRASERA aunque sea en ángulo, es trasera_o_lateral, NO diagonal_frontal. portada: 1-10 (auto completo, buena luz, fondo limpio).' }
                        ] }],
                        output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { descripcion: { type: 'string' }, tipo: { type: 'string', enum: ['diagonal_frontal', 'frontal', 'trasera_o_lateral', 'interior', 'detalle'] }, portada: { type: 'integer' } }, required: ['descripcion', 'tipo', 'portada'], additionalProperties: false } } }
                    })
                });
                if (!r.ok) return { url, tipo: 'trasera_o_lateral', portada: 5 };
                const d = await r.json();
                const tb = (d.content || []).find(b => b.type === 'text');
                const j = JSON.parse(tb.text);
                return { url, tipo: j.tipo, portada: Number(j.portada) || 5 };
            } catch (e) { return { url, tipo: 'trasera_o_lateral', portada: 5 }; }
        }));
        // FILTRO DE PORTADA (orden owner 2026-07-14): la DIAGONAL 3/4 es LA portada;
        // si no hay diagonal, la siguiente más estética (frontal → exterior).
        const prio = { diagonal_frontal: 0, frontal: 1, trasera_o_lateral: 2, interior: 3, detalle: 4 };
        clasif.sort((a, b) => (prio[a.tipo] - prio[b.tipo]) || (b.portada - a.portada));
        let bestIdx = 0, best = -Infinity;
        clasif.forEach((c, i) => {
            const score = c.portada + (c.tipo === 'diagonal_frontal' ? 6 : c.tipo === 'frontal' ? 2 : c.tipo === 'trasera_o_lateral' ? 1 : -8);
            if (score > best) { best = score; bestIdx = i; }
        });
        if (bestIdx > 0) { const [b] = clasif.splice(bestIdx, 1); clasif.unshift(b); }
        return clasif.map(c => c.url);
    } catch (e) { console.error('[ordenarFotos]', e.message); return fotos; }
}

// ── DESTINO de la carga (orden owner 2026-07-16, determinista) ──
// Marcelo → siempre AUTOS LOZANO. El owner → AUTOS LOZANO solo si la ficha
// DICE "lozano"; si no lo dice, el auto es de PARTICULAR.
function destinoDe(c) {
    const tel = String(c.remitente || '').replace(/\D/g, '');
    if (tel === MARCELO_LOZANO) return { tipo: 'agencia', code: 'AUTOS LOZANO' };
    if (/lozano/i.test(String(c.texto || ''))) return { tipo: 'agencia', code: 'AUTOS LOZANO' };
    return { tipo: 'particular' };
}

// Cuerpo del publish-batch según destino. Particular = mismo canal que Ignacio
// recepción (tipo+key+vendedor); si la ficha no trae dueño, queda a nombre del
// owner (y el recibo lo avisa para que él corrija si hace falta).
async function armarBody(c, f, fotos) {
    const dest = destinoDe(c);
    const modelo = [f.modelo, f.version].filter(Boolean).join(' ');
    const auto = { marca: f.marca, modelo, anio: f.anio, precio: f.precio, kilometraje: f.kilometraje || undefined, color: f.color || undefined, transmision: f.transmision || undefined, tipo_carroceria: f.tipo_carroceria || undefined, comentarios: f.comentarios || undefined, photos: fotos.map((u, i) => ({ url: u, isPrincipal: i === 0 })) };
    if (dest.tipo === 'particular') {
        let dtel = String(f.dueno_telefono || '').replace(/\D/g, '');
        let partes = String(f.dueno_nombre || '').trim().split(/\s+/).filter(Boolean);
        // DUEÑO CONOCIDO (orden owner 2026-07-18): nombre sin teléfono en la ficha
        // → si ya lo conocemos del inventario, se acredita con su número REAL.
        if (partes.length && !dtel) {
            const con = await duenoConocido(partes.join(' '));
            if (con) { dtel = String(con.tel).replace(/\D/g, ''); partes = String(con.nombre).trim().split(/\s+/).filter(Boolean); }
        }
        return {
            destino: 'particular', duenoDefault: !dtel && !partes.length,
            body: {
                tipo: 'particular', key: process.env.SELLER_BRIDGE_KEY || 'fyra-bridge-v2-2026',
                vendedor: { nombre: partes[0] || 'Sebastián', apellido: partes.slice(1).join(' ') || undefined, telefono: dtel || OWNER_CARGA },
                autos: [auto]
            }
        };
    }
    return { destino: dest.code, duenoDefault: false, body: { code: dest.code, autos: [auto] } };
}

// ══ REACREDITACIÓN (orden owner 2026-07-18, caso Mazda CX-5): el owner puede
// acreditar el dueño DESPUÉS de publicar, en un mensaje aparte — "es de autos
// lozano" / "es de Sebastián Cantisani [tel]" — y el ÚLTIMO auto publicado (≤15
// min) se corrige completo: destino, dueño, huella UID y PORTADA re-horneada.
// Regla de dueños: CONOCIDO (agencia o dueño ya en inventario) → basta el nombre;
// DESCONOCIDO → el owner debe dar nombre + número (se acredita real, jamás inventado).
const sanU = x => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]/g, '');

async function getOrCreateVendedorCarga(nombre, apellido, tel) {
    const ex = await query('SELECT v.id FROM vendedores v JOIN contactos_info c ON c.id=v.contacto_id WHERE c.telefono=? LIMIT 1', [tel]);
    if (ex.length) return Number(ex[0].id);
    const c1 = await run("INSERT INTO contactos_info (nombre, apellido, telefono, metodo_contacto_preferido, origen_creacion, fecha_creacion) VALUES (?,?,?,'whatsapp','reacreditacion',datetime('now'))", [nombre, apellido || null, tel]);
    const v1 = await run("INSERT INTO vendedores (contacto_id, direccion, disponibilidad, fecha_creacion) VALUES (?,?,'lun-sab 9-19',datetime('now'))", [Number(c1.lastInsertRowid), '']);
    return Number(v1.lastInsertRowid);
}

// ¿El nombre corresponde a un dueño YA CONOCIDO del inventario? (todas sus palabras
// deben embonar en el nombre registrado; si embona en 2+ personas distintas → null)
async function duenoConocido(nombre) {
    const toks = String(nombre || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(w => w.length >= 3);
    if (!toks.length) return null;
    const rows = await query("SELECT DISTINCT dueno_nombre, dueno_telefono FROM inventario_autos WHERE dueno_nombre IS NOT NULL AND dueno_telefono IS NOT NULL AND dueno_telefono != ''");
    const hits = [];
    for (const r of rows) {
        const full = String(r.dueno_nombre).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (toks.every(t => full.includes(t))) hits.push(r);
    }
    const tels = [...new Set(hits.map(h => String(h.dueno_telefono).replace(/\D/g, '').slice(-10)))];
    if (tels.length !== 1) return null;
    return { nombre: hits[0].dueno_nombre, tel: '521' + tels[0] };
}

async function reacreditar(autoId, dest) {
    const rows = await query('SELECT marca, modelo, año AS anio, color, kilometraje FROM autos WHERE id=?', [autoId]);
    if (!rows.length) return { ok: false, error: 'auto ' + autoId + ' no existe' };
    const a = rows[0];
    const kmk = a.kilometraje ? Math.round(Number(a.kilometraje) / 1000) + 'k' : 'SinKm';
    let uidBase;
    if (dest.tipo === 'agencia') {
        const vend = await getOrCreateVendedorCarga('Marcelo', 'Lozano', '5218129405001');
        await run("UPDATE autos SET vendedor_id=?, tipo_vendedor='agencia', agencia_nombre=? WHERE id=?", [vend, dest.code, autoId]);
        await run("UPDATE inventario_autos SET tipo_vendedor='agencia', agencia_nombre=?, dueno_nombre='Marcelo Lozano', dueno_telefono='5218129405001' WHERE fyradrive_web_id=?", [dest.code, autoId]).catch(() => {});
        uidBase = 'MarceloLozano_8129405001_' + sanU(a.marca) + sanU(a.modelo) + '-' + a.anio + '_' + (sanU(a.color) || 'SinColor') + '_' + kmk;
    } else {
        const tel = '521' + String(dest.tel).replace(/\D/g, '').slice(-10);
        const partes = String(dest.nombre).trim().split(/\s+/);
        const vend = await getOrCreateVendedorCarga(partes[0], partes.slice(1).join(' ') || null, tel);
        await run("UPDATE autos SET vendedor_id=?, tipo_vendedor='particular', agencia_nombre=NULL WHERE id=?", [vend, autoId]);
        await run("UPDATE inventario_autos SET tipo_vendedor='particular', agencia_nombre=NULL, dueno_nombre=?, dueno_telefono=? WHERE fyradrive_web_id=?", [String(dest.nombre).trim(), tel, autoId]).catch(() => {});
        uidBase = sanU(dest.nombre) + '_' + tel.slice(-10) + '_' + sanU(a.marca) + sanU(a.modelo) + '-' + a.anio + '_' + (sanU(a.color) || 'SinColor') + '_' + kmk;
    }
    let uid = uidBase;
    for (let n = 2; n < 50; n++) { const d = await query('SELECT 1 FROM autos WHERE uid=? AND id!=?', [uid, autoId]); if (!d.length) break; uid = uidBase + '-' + n; }
    await run('UPDATE autos SET uid=? WHERE id=?', [uid, autoId]);
    // portada re-horneada en su variante correcta (agencia celeste / particular oscura)
    try {
        const im = await query('SELECT id FROM imagenes_autos WHERE auto_id=? AND es_principal=1', [autoId]);
        if (im.length) await fetch(WEB + '/api/generate-template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoId, imgId: im[0].id, zoom: 1.0 }) });
    } catch (e) { console.error('[reacreditar template]', e.message); }
    return { ok: true, nombre: [a.marca, a.modelo, a.anio].filter(Boolean).join(' ') };
}

// ¿El texto (sin fotos en pool) es un mensaje de ACREDITACIÓN? Determinista y estricto
// para no confundir el chat normal del owner: o menciona lozano/marcelo en corto, o
// empieza con "es de / a nombre de / acredita / dueño".
function interpretarAcreditacion(tN) {
    const t = String(tN || '').trim();
    if (/(lozano|marcelo)/.test(t) && t.length <= 80 && !/\$/.test(t)) return { tipo: 'agencia', code: 'AUTOS LOZANO' };
    const m = t.match(/^(?:es de|a nombre de|acredita(?:lo)?(?: a)?|dueno:?|dueño:?)\s+([a-zñáéíóú][a-zñáéíóú ]{2,45}?)(?:\s+(\d[\d ]{9,14}))?$/);
    if (!m) return null;
    const nombre = m[1].trim();
    const tel = m[2] ? m[2].replace(/\D/g, '') : null;
    if (tel && tel.length >= 10) return { tipo: 'particular', nombre, tel };
    return { tipo: 'nombre_solo', nombre };   // se resuelve contra dueños conocidos
}

// ¿Qué le falta a la ficha para poder publicar? (fuente única del criterio)
function faltanDe(f) {
    const faltan = [];
    if (!f || !f.marca) faltan.push('marca'); if (!f || !f.modelo) faltan.push('modelo');
    if (!f || !f.anio) faltan.push('año'); if (!f || !f.precio) faltan.push('precio');
    return faltan;
}

async function publicarCarga(c) {
    let fotos; try { fotos = JSON.parse(c.fotos || '[]'); } catch (e) { fotos = []; }
    const resumen = String(c.texto || '').replace(/\s+/g, ' ').slice(0, 50);
    if (!fotos.length) {
        await run("UPDATE cargas_lote SET estado='error', resultado='sin fotos', updated=? WHERE id=?", [Date.now(), c.id]);
        await enviarWA(c.remitente || OWNER_CARGA, `⚠️ NO publicado (sin fotos): "${resumen}…" — manda el texto de nuevo seguido de sus fotos`);
        return false;
    }
    const f = await parseFicha(c.texto);
    const faltan = faltanDe(f);
    if (faltan.length) {
        await run("UPDATE cargas_lote SET estado='error', resultado=?, updated=? WHERE id=?", ['faltan: ' + faltan.join(','), Date.now(), c.id]);
        await enviarWA(c.remitente || OWNER_CARGA, `⚠️ NO publicado — a "${resumen}…" le faltó: ${faltan.join(', ')}. Manda el texto completo de nuevo + fotos`);
        return false;
    }
    // ══ ANTI-DUPLICADO con AUTO-REEMPLAZO (caso BMW X5 2026-07-16): la ficha puede
    // REBASAR a las fotos (suben lentas) → se publica incompleto y el owner re-manda
    // la ficha → doble publicación. Regla: mismo marca+año+precio ACTIVO de las
    // últimas 6h → si esta carga trae MÁS fotos, REEMPLAZA (publica y borra el viejo);
    // si trae las mismas o menos, se descarta como duplicado con aviso.
    let dupPrevio = null;
    try {
        const cand = await query("SELECT id, marca, modelo, año FROM autos WHERE estado='activo' AND año=? AND precio=? AND lower(marca)=lower(?) AND fecha_creacion > datetime('now','-6 hours')", [f.anio, f.precio, String(f.marca)]);
        if (cand.length === 1) {
            const nf = await query('SELECT COUNT(*) n FROM imagenes_autos WHERE auto_id=?', [cand[0].id]);
            dupPrevio = { id: cand[0].id, nombre: [cand[0].marca, cand[0].modelo, cand[0].año].join(' '), fotos: Number(nf[0].n) };
            if (fotos.length <= dupPrevio.fotos) {
                await run("UPDATE cargas_lote SET estado='descartada', resultado=?, updated=? WHERE id=?", ['duplicado del auto ' + dupPrevio.id, Date.now(), c.id]);
                await enviarWA(c.remitente || OWNER_CARGA, `⚠️ Ese auto YA está publicado (${dupPrevio.nombre} con ${dupPrevio.fotos} fotos, hace un rato) — no lo dupliqué. Si es OTRO auto igualito, dime "sube el duplicado" y lo checo contigo.`);
                return false;
            }
        }
    } catch (e) { dupPrevio = null; }
    try {
        fotos = await ordenarFotos(fotos);
        const modelo = [f.modelo, f.version].filter(Boolean).join(' ');
        const arm = await armarBody(c, f, fotos);
        const resp = await fetch(WEB + '/api/agency/publish-batch', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(arm.body)
        });
        const d = await resp.json().catch(() => ({}));
        const okPub = resp.ok && d && (d.ok !== false) && (!d.errors || !d.errors.length);
        if (okPub) {
            await run("UPDATE cargas_lote SET estado='publicada', resultado=?, updated=? WHERE id=?", [JSON.stringify(d.created || d).slice(0, 400), Date.now(), c.id]);
            // AUTO-REEMPLAZO: la versión nueva (con más fotos) ya nació → fuera la incompleta
            let notaReemplazo = '';
            if (dupPrevio) {
                try {
                    await run('DELETE FROM imagenes_autos WHERE auto_id=?', [dupPrevio.id]);
                    await run('DELETE FROM autos WHERE id=?', [dupPrevio.id]);
                    await run('DELETE FROM inventario_autos WHERE fyradrive_web_id=?', [dupPrevio.id]);
                    notaReemplazo = ` 🔁 (reemplacé la publicación anterior que tenía ${dupPrevio.fotos} fotos — queda UNA sola)`;
                } catch (e) { console.error('[carga reemplazo]', e.message); }
            }
            const tpl = d.created && d.created[0] && d.created[0].template;
            const etiqueta = arm.destino === 'particular'
                ? (arm.duenoDefault ? 'particular — la ficha no traía dueño: quedó a tu nombre' : `particular — dueño: ${[f.dueno_nombre, f.dueno_telefono].filter(Boolean).join(' ')}`)
                : arm.destino;
            await enviarWA(c.remitente || OWNER_CARGA, `✅ Publicado: ${f.marca} ${modelo} ${f.anio} — $${Number(f.precio).toLocaleString('en-US')} — ${fotos.length} fotos${tpl ? ' — diseño verificada ✓' : ' — ⚠️ diseño pendiente'} (${etiqueta})${notaReemplazo}`);
            // Marcelo publicó → resumen al owner (él no recibe cada recibo, solo el hecho)
            if (c.remitente && c.remitente !== OWNER_CARGA) await enviarWA(OWNER_CARGA, `📦 Marcelo (AUTOS LOZANO) publicó: ${f.marca} ${modelo} ${f.anio} — $${Number(f.precio).toLocaleString('en-US')}`).catch(() => {});
            return true;
        }
        const err = (d.errors && d.errors[0] && d.errors[0].error) || d.error || ('web ' + resp.status);
        await run("UPDATE cargas_lote SET estado='error', resultado=?, updated=? WHERE id=?", [String(err).slice(0, 300), Date.now(), c.id]);
        await enviarWA(c.remitente || OWNER_CARGA, `⚠️ NO publicado (${f.marca} ${modelo} ${f.anio}): ${String(err).slice(0, 120)}`);
        return false;
    } catch (e) {
        await run("UPDATE cargas_lote SET estado='error', resultado=?, updated=? WHERE id=?", [String(e.message).slice(0, 300), Date.now(), c.id]);
        await enviarWA(c.remitente || OWNER_CARGA, `⚠️ NO publicado (error de red): ${String(e.message).slice(0, 100)} — reintenta con "fin carga" o mándalo de nuevo`);
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
    if (!CARGA_AUTORIZADOS.has(tel)) return { ok: false, motivo: 'remitente no autorizado' };
    const tN = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

    // ══ "PUBLÍCALO" (solo el OWNER): publica el auto de Ignacio-recepción en
    // REVISIÓN — el "va" del human in the loop. Acepta código: "publícalo 0077"
    // (últimos dígitos del tel del vendedor) cuando hay varios en revisión.
    // auditoría #21: también matchea "va, publícalo", "publícalo ya", "publícalo 👍".
    if (tipo === 'texto' && tel === OWNER_CARGA && /(^|\s)publ[ií]ca(lo|la|r)?\b/.test(tN)) {
        try {
            const recepcion = require('./recepcion.js');
            const mHint = tN.match(/publ[ií]ca(?:lo|la|r)?\s*(?:el\s*)?(\d{4,13})/);
            const r = await recepcion.publicarPendiente(mHint ? mHint[1] : null);
            if (r.ok) {
                const a = r.auto || {};
                await enviarWA(OWNER_CARGA, `✅ Publicado (particular): ${a.marca} ${a.modelo} ${a.anio} — $${Number(a.precio || 0).toLocaleString('en-US')} — ${a.photos} fotos${a.template ? ' — diseño ✓' : ' — ⚠️ diseño pendiente'}`);
                // mensaje al vendedor: FUENTE ÚNICA (recepcion.plantillaPublicado — la misma del sandbox)
                if (r.sesion && r.sesion.telefono) {
                    for (const sgP of require('./recepcion.js').plantillaPublicado()) await enviarWA(r.sesion.telefono, sgP).catch(() => {});
                }
                // UN AUTO A LA VEZ: había un segundo auto parqueado → arranca de una vez
                if (r.siguiente && r.siguiente.segmentos && r.sesion && r.sesion.telefono) {
                    for (const sg of r.siguiente.segmentos) await enviarWA(r.sesion.telefono, sg).catch(() => {});
                    await enviarWA(OWNER_CARGA, `🅿️→🟢 Arranqué el siguiente auto parqueado del mismo vendedor`).catch(() => {});
                }
            } else if (r.opciones && r.opciones.length) {
                await enviarWA(OWNER_CARGA, `⚠️ ${r.error}:\n${r.opciones.map((o, i) => (i + 1) + ') ' + o).join('\n')}\nResponde: publícalo <últimos 4 dígitos del tel>`);
            } else {
                await enviarWA(OWNER_CARGA, `⚠️ No pude publicar: ${r.error}`);
            }
        } catch (e) { await enviarWA(OWNER_CARGA, `⚠️ No pude publicar: ${String(e.message).slice(0, 120)}`); }
        return { ok: true, modo: 'publicalo' };
    }

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
            await enviarWA(tel, `🏁 Carga cerrada — ${tot[0].n} auto(s) publicados en esta sesión`);
            return { ok: true, modo: 'off' };
        }
        if (/^carga (lozano|lote|autos)/.test(tN)) {
            await enviarWA(tel, `🚗 Listo — mándame las FOTOS de cada auto y al final su TEXTO con la ficha (marca, modelo, año, precio). El texto publica el auto.${tel === OWNER_CARGA ? '\n\nSi la ficha dice "Autos Lozano" se publica ahí; si no, se publica como PARTICULAR (puedes incluir nombre y teléfono del dueño en la ficha).' : ''}`);
            return { ok: true, modo: 'on' };
        }
        // el TEXTO se ACUMULA y publica cuando la ficha está COMPLETA (caso Cherokee
        // 2026-07-16: la ficha del owner llega en VARIAS burbujas — la principal +
        // "2 dueños" + "215,000 pesos venta" + "Factura de agencia". Antes la PRIMERA
        // burbuja cerraba y publicaba → "faltó: precio" aunque el precio venía en
        // camino. Ahora: burbuja incompleta = silencio y se espera la siguiente; el
        // barredor del cron manda el "faltó: X" solo si ya no llegó nada más.)
        const ab = await query("SELECT * FROM cargas_lote WHERE remitente=? AND estado='abierta' ORDER BY id DESC LIMIT 1", [tel]);
        let fotos = []; if (ab.length) { try { fotos = JSON.parse(ab[0].fotos || '[]'); } catch (e) { fotos = []; } }
        if (!fotos.length) {
            // Sin pool de fotos: ¿es un mensaje de ACREDITACIÓN del último auto publicado?
            // (caso Mazda CX-5 2026-07-18: "es de autos lozano" llegó DESPUÉS de publicar
            // y se ignoraba — el auto quedaba particular a nombre del owner.)
            const acred = interpretarAcreditacion(tN);
            if (acred) {
                const ult = await query("SELECT resultado FROM cargas_lote WHERE remitente=? AND estado='publicada' AND updated > ? ORDER BY updated DESC LIMIT 1", [tel, Date.now() - 15 * 60000]);
                let autoId = null, autoNom = '';
                try { const r = JSON.parse(ult[0].resultado); autoId = r[0].id; autoNom = [r[0].marca, r[0].modelo].filter(Boolean).join(' '); } catch (e) {}
                if (autoId) {
                    let dest = acred;
                    if (dest.tipo === 'nombre_solo') {
                        const con = await duenoConocido(dest.nombre);
                        if (!con) { await enviarWA(tel, `⚠️ No conozco a "${dest.nombre}" — para acreditarlo mándame: es de ${dest.nombre} <su número a 10 dígitos>`); return { ok: true, modo: 'acreditacion_pendiente' }; }
                        dest = { tipo: 'particular', nombre: con.nombre, tel: con.tel };
                    }
                    const r = await reacreditar(autoId, dest);
                    await enviarWA(tel, r.ok
                        ? `🔁 Reacreditado: ${r.nombre} → ${dest.tipo === 'agencia' ? dest.code + ' (agencias verificadas)' : 'PARTICULAR — ' + dest.nombre + ' (' + String(dest.tel).slice(-10) + ')'} ✓ portada re-horneada`
                        : `⚠️ No pude reacreditar: ${r.error}`);
                    return { ok: true, modo: 'reacreditacion', autoId };
                }
            }
            return { ok: false, motivo: 'sin fotos acumuladas — texto ignorado (chat normal)' };
        }
        const textoAcum = (ab[0].texto ? String(ab[0].texto) + '\n' : '') + String(texto || '');
        await run("UPDATE cargas_lote SET texto=?, updated=? WHERE id=?", [textoAcum, Date.now(), ab[0].id]);
        const fAcum = await parseFicha(textoAcum);
        const faltan = faltanDe(fAcum);
        if (faltan.length) return { ok: true, acumulado: true, faltan };   // aún no está completa: esperamos más burbujas
        const c = (await query("SELECT * FROM cargas_lote WHERE id=?", [ab[0].id]))[0];
        const pub = await publicarCarga(c);
        return { ok: true, publicado: pub };
    }
    return { ok: false, motivo: 'pieza no reconocida' };
}

// ── BARREDOR (cron cada 10 min) ──
// 1) Carga abierta CON texto y 4+ min quieta → intento de publicar (si a la ficha
//    acumulada le falta algo, publicarCarga manda el "⚠️ faltó: X" — ese aviso ya
//    NO se manda a media ráfaga, solo cuando de verdad dejó de llegar texto).
// 2) Fotos SIN ficha por 30+ min → se descartan con aviso (jamás publicar a ciegas).
async function barrerCargas() {
    await ensureCarga();
    let n = 0;
    const listas = await query("SELECT * FROM cargas_lote WHERE estado='abierta' AND texto IS NOT NULL AND texto != '' AND updated < ?", [Date.now() - 4 * 60000]);
    for (const c of listas) { await publicarCarga(c); n++; }
    const huerfanas = await query("SELECT * FROM cargas_lote WHERE estado='abierta' AND (texto IS NULL OR texto = '') AND updated < ?", [Date.now() - 30 * 60000]);
    for (const c of huerfanas) {
        let nf = 0; try { nf = JSON.parse(c.fotos || '[]').length; } catch (e) { }
        await run("UPDATE cargas_lote SET estado='descartada', updated=? WHERE id=?", [Date.now(), c.id]);
        if (nf) await enviarWA(c.remitente || OWNER_CARGA, `⚠️ Tenía ${nf} fotos esperando su ficha y pasaron 30 min — las descarté. Reenvía fotos + texto del auto`);
        n++;
    }
    return n;
}

module.exports = { pieza, barrerCargas, publicarCarga, parseFicha, ensureCarga, ordenarFotos, destinoDe, armarBody, faltanDe, interpretarAcreditacion, duenoConocido, reacreditar };
