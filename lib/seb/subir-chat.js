// lib/seb/subir-chat.js — SUBIR AUTO POR CHAT (orden owner 2026-09-12)
// En cada universo de vendedor, "Subir auto" ya no es un cuestionario: es un chat con Seb dentro de FyraChat.
// El vendedor manda fotos y datos como le acomode; el chat extrae lo que traiga (Haiku con salida forzada), palomea
// lo que ya tiene y pide SOLO lo que falta (marca/modelo/año · kilometraje · precio · 4 fotos mínimo). Varios autos =
// uno por uno (borradores en fila). Al completar un auto, Seb propone la CONSIGNACIÓN VIRTUAL con el costo de la
// fórmula del owner: $10,000 en autos de hasta $500,000 · 2% del precio arriba de $500,000 (a $500,000 el 2% son
// exactamente $10,000, así la regla es continua). Botones Sí / No:
//   Sí → el auto nace en REVISIÓN en el admin de fyradrive.com (autos pendientes) con consignacion_json para que el owner acepte.
//   No → el auto queda 'privado': solo en el universo del vendedor (su Seb lo manda, cotiza y agenda), fuera de fyradrive.com.
// Estado en la base (Ley: estado en tablas, no en el prompt): subir_chat_sesiones (un borrador por auto) + subir_chat_msgs (el hilo).
const { query, run } = require('./db.js');

const HAIKU = 'claude-haiku-4-5';
const MIN_FOTOS = 4;
const MAX_FOTOS = 30;

async function haiku(system, schema, content, maxTokens) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return null;
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: HAIKU, max_tokens: maxTokens || 400, system, messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema } } })
        });
        if (!r.ok) return null;
        const d = await r.json();
        return JSON.parse((d.content || []).find(b => b.type === 'text').text);
    } catch (e) { return null; }
}

let listo = false;
async function ensure() {
    if (listo) return;
    await run(`CREATE TABLE IF NOT EXISTS subir_chat_sesiones (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, estado TEXT NOT NULL DEFAULT 'abierto',
        datos TEXT, fotos TEXT, web_id INTEGER, inv_id INTEGER, consignacion TEXT, comision INTEGER, created INTEGER, updated INTEGER)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_scs_tenant ON subir_chat_sesiones(tenant_id, estado)`);
    await run(`CREATE TABLE IF NOT EXISTS subir_chat_msgs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, sesion_id INTEGER, dir TEXT NOT NULL,
        texto TEXT, fotos TEXT, botones TEXT, ts INTEGER)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_scm_tenant ON subir_chat_msgs(tenant_id, ts)`);
    listo = true;
}

// ── FÓRMULA DE CONSIGNACIÓN VIRTUAL (owner 2026-09-12) ──
function comisionDe(precio) {
    const p = Number(precio) || 0; if (!(p > 0)) return null;
    return Math.max(10000, Math.round(p * 0.02));
}
const reglaDe = (precio) => (Number(precio) || 0) <= 500000 ? '$10,000 en autos de hasta $500,000' : '2% del precio en autos arriba de $500,000';
const pesos = n => '$' + Number(n || 0).toLocaleString('es-MX');
const nombreAuto = d => [d && d.marca, d && d.modelo, d && d.anio].filter(Boolean).join(' ');

// ── EXTRACTOR: saca TODO lo que traiga el mensaje (nunca re-preguntar lo que ya dijo) ──
const SCHEMA = {
    type: 'object', properties: {
        descripcion: { type: 'string', description: 'una frase: qué datos del auto trae el texto' },
        marca: { type: ['string', 'null'] }, modelo: { type: ['string', 'null'] }, version: { type: ['string', 'null'] },
        anio: { type: ['integer', 'null'] }, precio: { type: ['integer', 'null'] }, kilometraje: { type: ['integer', 'null'] },
        color: { type: ['string', 'null'] }, transmision: { type: ['string', 'null'], description: 'Automática | Manual | null' },
        combustible: { type: ['string', 'null'], description: 'Gasolina | Diésel | Híbrido | Eléctrico | null' }
    }, required: ['descripcion', 'marca', 'modelo', 'version', 'anio', 'precio', 'kilometraje', 'color', 'transmision', 'combustible'], additionalProperties: false
};
async function extraer(texto) {
    const t = String(texto || '').trim(); if (!t) return {};
    const ex = await haiku(
        'Extraes datos de un vendedor de autos usados (México) que está dando de alta su auto. Extrae SOLO lo que diga el texto; no inventes. ' +
        'precio SIEMPRE en pesos completos ("249,900"→249900; "250 mil"→250000; "lo dejo en 240"→240000). kilometraje en km enteros ("45 mil km"→45000; "45k"→45000). ' +
        'anio = año del modelo (4 dígitos). marca y modelo separados ("Mazda CX-5 2021 Grand Touring" → marca Mazda, modelo CX-5, version Grand Touring, anio 2021). ' +
        'Si el texto es una corrección ("no, son 60 mil km"), regresa el dato corregido.',
        SCHEMA, t, 300);
    const out = {};
    if (ex && typeof ex === 'object') { for (const k of ['marca', 'modelo', 'version', 'anio', 'precio', 'kilometraje', 'color', 'transmision', 'combustible']) if (ex[k] != null && ex[k] !== '') out[k] = ex[k]; }
    else {   // sin IA (llave ausente o caída): lo determinista mínimo
        const y = /\b((?:19|20)\d{2})\b/.exec(t); if (y) out.anio = Number(y[1]);
        const km = /(\d[\d.,]*)\s*(mil\s*)?k(m|ilómetros|ilometros)?\b/i.exec(t); if (km) { let n = Number(km[1].replace(/[.,]/g, '')); if (km[2]) n *= 1000; if (n >= 0) out.kilometraje = n; }
        const pr = /\$\s?(\d[\d.,]*)|(\d[\d.,]*)\s*(mil\s*)?(pesos|mxn)/i.exec(t); if (pr) { let n = Number(String(pr[1] || pr[2]).replace(/[.,]/g, '')); if (pr[3]) n *= 1000; if (n > 0) out.precio = n; }
    }
    // saneo
    const yNow = new Date().getFullYear();
    if (out.anio != null && !(Number(out.anio) >= 1990 && Number(out.anio) <= yNow + 1)) delete out.anio;
    if (out.precio != null && !(Number(out.precio) > 0)) delete out.precio;
    if (out.kilometraje != null && !(Number(out.kilometraje) >= 0)) delete out.kilometraje;
    return out;
}

// ── SESIONES (un borrador por auto) ──
const parse = (s) => { try { return JSON.parse(s || 'null'); } catch (e) { return null; } };
function fila(r) { return { id: Number(r.id), tenant_id: Number(r.tenant_id), estado: r.estado, datos: parse(r.datos) || {}, fotos: parse(r.fotos) || [], web_id: r.web_id == null ? null : Number(r.web_id), inv_id: r.inv_id == null ? null : Number(r.inv_id), consignacion: r.consignacion || null, comision: r.comision == null ? null : Number(r.comision), created: Number(r.created) || 0 }; }
async function abierta(tid) { const r = await query("SELECT * FROM subir_chat_sesiones WHERE tenant_id = ? AND estado IN ('abierto','consignacion') ORDER BY id DESC LIMIT 1", [tid]); return r.length ? fila(r[0]) : null; }
async function porId(tid, id) { const r = await query("SELECT * FROM subir_chat_sesiones WHERE id = ? AND tenant_id = ? LIMIT 1", [Number(id), tid]); return r.length ? fila(r[0]) : null; }
async function crear(tid) { const now = Date.now(); const ins = await run("INSERT INTO subir_chat_sesiones (tenant_id, estado, datos, fotos, created, updated) VALUES (?,?,?,?,?,?)", [tid, 'abierto', '{}', '[]', now, now]); return { id: Number(ins.lastInsertRowid), tenant_id: tid, estado: 'abierto', datos: {}, fotos: [], web_id: null, inv_id: null, consignacion: null, comision: null, created: now }; }
async function guardar(s) { await run("UPDATE subir_chat_sesiones SET estado = ?, datos = ?, fotos = ?, web_id = ?, inv_id = ?, consignacion = ?, comision = ?, updated = ? WHERE id = ?", [s.estado, JSON.stringify(s.datos || {}), JSON.stringify(s.fotos || []), s.web_id, s.inv_id, s.consignacion, s.comision, Date.now(), s.id]); }
const resumenSesion = s => s ? { id: s.id, estado: s.estado, datos: s.datos, fotos: (s.fotos || []).length, faltan: faltantes(s), comision: s.comision } : null;

async function guardarMsg(tid, sesionId, dir, texto, fotos, botones) {
    const ts = Date.now();
    const ins = await run("INSERT INTO subir_chat_msgs (tenant_id, sesion_id, dir, texto, fotos, botones, ts) VALUES (?,?,?,?,?,?,?)",
        [tid, sesionId, dir, texto || null, fotos && fotos.length ? JSON.stringify(fotos) : null, botones && botones.length ? JSON.stringify(botones) : null, ts]);
    return { id: Number(ins.lastInsertRowid), sesion_id: sesionId, dir, texto: texto || '', fotos: fotos || [], botones: botones || [], ts };
}
const msgFila = m => ({ id: Number(m.id), sesion_id: m.sesion_id == null ? null : Number(m.sesion_id), dir: m.dir, texto: m.texto || '', fotos: parse(m.fotos) || [], botones: parse(m.botones) || [], ts: Number(m.ts) || 0 });

// ── TEXTOS (plantillas fijas; la IA solo extrae) ──
function faltantes(s) {
    const d = (s && s.datos) || {}; const f = [];
    if (d.marca == null || d.modelo == null || d.anio == null) f.push('¿Qué auto es? Marca, modelo y año.');
    if (d.kilometraje == null) f.push('¿Qué kilometraje tiene?');
    if (d.precio == null) f.push('¿A qué precio lo quieres vender?');
    const nf = ((s && s.fotos) || []).length;
    if (nf < MIN_FOTOS) f.push(nf ? 'Mándame ' + (MIN_FOTOS - nf) + (MIN_FOTOS - nf === 1 ? ' foto más' : ' fotos más') + ' (mínimo ' + MIN_FOTOS + ').' : 'Mándame las fotos del auto (mínimo ' + MIN_FOTOS + '; la primera será la portada).');
    return f;
}
function saludo(tenant) {
    const n = String((tenant && tenant.nombre) || '').trim().split(/\s+/)[0];
    return 'Hola' + (n ? ' ' + n : '') + '. Aquí subimos tus autos platicando: mándame las fotos del auto (mínimo ' + MIN_FOTOS + ', la primera será la portada) y sus datos: marca, modelo, año, kilometraje y precio.\n' +
        'Mándalo como te acomode y yo voy palomeando lo que falte. Si son varios autos, vamos uno por uno: al terminar uno me mandas el siguiente.';
}
function progreso(s) {
    const d = s.datos || {}; const t = [];
    if (d.marca || d.modelo) t.push('✅ Auto: ' + [d.marca, d.modelo, d.version, d.anio].filter(Boolean).join(' '));
    if (d.kilometraje != null) t.push('✅ Kilometraje: ' + Number(d.kilometraje).toLocaleString('es-MX') + ' km');
    if (d.precio != null) t.push('✅ Precio: ' + pesos(d.precio));
    if (d.color || d.transmision || d.combustible) t.push('✅ ' + [d.color, d.transmision, d.combustible].filter(Boolean).join(' · '));
    const nf = (s.fotos || []).length; if (nf) t.push('✅ Fotos: ' + nf + (nf < MIN_FOTOS ? ' de ' + MIN_FOTOS : ''));
    return t.length ? 'Va quedando así:\n' + t.join('\n') : 'Anotado.';
}
function resumen(s) {
    const d = s.datos || {};
    return '¡Listo! Ya tengo todo:\n🚘 ' + [d.marca, d.modelo, d.version, d.anio].filter(Boolean).join(' ') + '\n💵 ' + pesos(d.precio) + '\n🛣 ' + Number(d.kilometraje).toLocaleString('es-MX') + ' km' +
        (d.color ? '\n🎨 ' + d.color : '') + (d.transmision ? '\n⚙️ ' + d.transmision : '') + (d.combustible ? '\n⛽ ' + d.combustible : '') + '\n📸 ' + (s.fotos || []).length + ' fotos';
}
function preguntaConsignacion(s) {
    const d = s.datos || {}; const c = comisionDe(d.precio);
    return '¿Gustas que Fyradrive te ayude a distribuir tu ' + nombreAuto(d) + ' y a venderlo como consignación virtual? Lo publicamos en fyradrive.com y en nuestros canales, y te mandamos a los compradores que van en serio.\n' +
        'Costo sugerido: ' + pesos(c) + ' (' + reglaDe(d.precio) + '). Se cobra solo cuando el auto se venda.';
}
const BOTONES = [{ a: 'consignar_si', t: 'Sí, acepto' }, { a: 'consignar_no', t: 'No, gracias' }];

// ── API ──
/** El hilo del chat de alta del universo (+ el borrador abierto). Si nunca ha hablado, nace el saludo. */
async function hilo(tenant) {
    await ensure(); const tid = Number(tenant.id);
    let msgs = (await query("SELECT id, sesion_id, dir, texto, fotos, botones, ts FROM subir_chat_msgs WHERE tenant_id = ? ORDER BY ts DESC, id DESC LIMIT 80", [tid])).reverse().map(msgFila);
    if (!msgs.length) msgs = [await guardarMsg(tid, null, 'out', saludo(tenant), [], [])];
    return { ok: true, mensajes: msgs, sesion: resumenSesion(await abierta(tid)) };
}
/** Mensaje del vendedor (texto y/o fotos ya subidas al Blob) → Seb contesta con lo que palomea y lo que falta. */
async function mensaje(tenant, { texto, fotos }) {
    await ensure(); const tid = Number(tenant.id);
    const t = String(texto || '').trim();
    const fs = (Array.isArray(fotos) ? fotos : []).map(String).filter(u => /^https?:\/\//.test(u));
    if (!t && !fs.length) return { ok: false, error: 'Manda texto o fotos.' };
    let s = await abierta(tid);
    // respuesta escrita a la pregunta de consignación (sin tocar botón)
    if (s && s.estado === 'consignacion' && t && !fs.length) {
        if (/^\s*(s[ií]\b|acepto|va\b|dale|claro|ok\b)/i.test(t)) return { ok: true, redirigir: 'consignar_si', sesion_id: s.id };
        if (/^\s*(no\b|nel|gracias no|paso)/i.test(t)) return { ok: true, redirigir: 'consignar_no', sesion_id: s.id };
    }
    if (!s || s.estado === 'consignacion') {
        if (s && s.estado === 'consignacion') {
            // ya está completo: si manda fotos/datos nuevos, es OTRO auto; pero primero que conteste el anterior
            const entrada0 = await guardarMsg(tid, s.id, 'in', t, fs, []);
            const out0 = await guardarMsg(tid, s.id, 'out', 'Antes de seguir con otro auto, dime si quieres la consignación virtual del ' + nombreAuto(s.datos) + ' (toca Sí o No aquí abajo).', [], BOTONES);
            return { ok: true, entrada: entrada0, salida: [out0], sesion: resumenSesion(s) };
        }
        s = await crear(tid);
    }
    const entrada = await guardarMsg(tid, s.id, 'in', t, fs, []);
    if (/^\s*(cancelar|olv[ií]dalo|b[oó]rralo|quita este auto)\b/i.test(t) && !fs.length) {
        s.estado = 'descartado'; await guardar(s);
        const out = await guardarMsg(tid, s.id, 'out', 'Listo, descarté ese auto. Cuando quieras mándame las fotos del siguiente.', [], []);
        return { ok: true, entrada, salida: [out], sesion: null };
    }
    if (fs.length) s.fotos = (s.fotos || []).concat(fs).slice(0, MAX_FOTOS);
    if (t) { const ex = await extraer(t); for (const k of Object.keys(ex)) s.datos[k] = ex[k]; }
    const f = faltantes(s);
    let txt, botones = [];
    if (f.length) { s.estado = 'abierto'; txt = progreso(s) + '\n\n' + f.join('\n'); }
    else { s.estado = 'consignacion'; s.comision = comisionDe(s.datos.precio); txt = resumen(s) + '\n\n' + preguntaConsignacion(s); botones = BOTONES; }
    await guardar(s);
    const out = await guardarMsg(tid, s.id, 'out', txt, [], botones);
    return { ok: true, entrada, salida: [out], sesion: resumenSesion(s) };
}
/** Botón Sí / No de la consignación. `subir(s, acepta)` lo pone seb-panel (misma puerta que auto_subir). */
async function boton(tenant, { sesion_id, accion, subir }) {
    await ensure(); const tid = Number(tenant.id);
    const s = await porId(tid, sesion_id);
    if (!s) return { ok: false, status: 404, error: 'ese auto ya no está en el chat' };
    if (s.estado === 'cerrado') return { ok: true, ya: true, sesion: null, salida: [] };
    if (s.estado !== 'consignacion') return { ok: false, status: 409, error: 'aún faltan datos de este auto', faltan: faltantes(s) };
    if (!['consignar_si', 'consignar_no'].includes(String(accion))) return { ok: false, status: 400, error: 'acción inválida' };
    const acepta = accion === 'consignar_si';
    await guardarMsg(tid, s.id, 'in', acepta ? 'Sí, acepto' : 'No, gracias', [], []);
    const r = await subir(s, acepta);
    if (!r || !r.ok) {
        const out = await guardarMsg(tid, s.id, 'out', 'No pude guardar el auto (' + String((r && r.error) || 'error') + '). Vuelve a tocar el botón para intentarlo otra vez.', [], BOTONES);
        return { ok: false, status: (r && r.status) || 502, error: (r && r.error) || 'no se pudo guardar', salida: [out], sesion: resumenSesion(s) };
    }
    s.estado = 'cerrado'; s.consignacion = acepta ? 'si' : 'no'; s.web_id = r.web_id || null; s.inv_id = r.inv_id || null; await guardar(s);
    const nom = nombreAuto(s.datos);
    const txt = acepta
        ? 'Perfecto ✅ Tu ' + nom + ' ya quedó en revisión con Fyradrive como consignación virtual (' + pesos(s.comision) + ' al venderse). Te aviso por aquí cuando quede publicado.\n\n¿Subimos otro auto? Mándame sus fotos.'
        : 'Listo ✅ Tu ' + nom + ' ya está en tu FyraChat, solo en tu universo: Seb lo puede mandar, cotizar y agendar citas con tus compradores.\n\n¿Subimos otro auto? Mándame sus fotos.';
    const out = await guardarMsg(tid, s.id, 'out', txt, [], []);
    const d = s.datos || {};
    return { ok: true, salida: [out], sesion: null, consignacion: acepta, comision: s.comision,
        auto: { id: r.auto_id, web_id: r.web_id, nombre: nom, marca: d.marca, modelo: d.modelo, anio: d.anio, precio: d.precio, km: d.kilometraje, portada: (s.fotos || [])[0] || null, estado: acepta ? 'revision' : 'activo', fotos: (s.fotos || []).length } };
}

module.exports = { hilo, mensaje, boton, comisionDe, reglaDe, faltantes, MIN_FOTOS, BOTONES };
