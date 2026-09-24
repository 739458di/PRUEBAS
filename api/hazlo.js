// HazloGPT — panel público donde el comprador habla con el inventario de Fyradrive.
// La IA (Haiku, JSON forzado) solo LEE la intención y el filtro; el CÓDIGO filtra el inventario, arma las tarjetas
// y lleva la cita. Nunca inventa autos: cada tarjeta sale de inventario_autos activo.
const { query, run } = require('../lib/seb/db.js');
const HAIKU = 'claude-haiku-4-5-20251001';
const WA_BOT = '5215659423834';
const ORIGEN = {
    japones: ['nissan', 'toyota', 'honda', 'mazda', 'subaru', 'mitsubishi', 'suzuki', 'infiniti', 'acura', 'lexus'],
    coreano: ['kia', 'hyundai', 'genesis'],
    americano: ['ford', 'chevrolet', 'gmc', 'dodge', 'ram', 'jeep', 'chrysler', 'buick', 'cadillac', 'lincoln', 'tesla'],
    aleman: ['bmw', 'audi', 'mercedes', 'mercedes benz', 'volkswagen', 'porsche', 'mini', 'smart'],
    europeo: ['bmw', 'audi', 'mercedes', 'mercedes benz', 'volkswagen', 'porsche', 'mini', 'seat', 'peugeot', 'renault', 'fiat', 'alfa romeo', 'volvo', 'range rover', 'land rover', 'jaguar', 'cupra'],
    ingles: ['mini', 'range rover', 'land rover', 'jaguar']
};
const TIPO_MODELO = [[/wrangler|cherokee|compass|renegade|rav4|cr-?v|hr-?v|cx-?\d|x-?trail|kicks|tucson|santa fe|sportage|seltos|suburban|explorer|escape|bronco|edge|expedition|tahoe|suburban|equinox|traverse|trax|blazer|x\d|q\d|gl[abcse]|ml\d|terrain|acadia|yukon|durango|journey|range rover|highlander|4runner|sequoia|pilot|outlander|eclipse cross|tiguan|touareg|taos|cayenne|macan|countryman|navigator|aviator|corsair|nautilus|murano|pathfinder|armada|juke/i, 'suv'], [/tacoma|hilux|f-?\d{3}|silverado|sierra|ram|ranger|frontier|np300|colorado|tundra|ridgeline|maverick|gladiator|amarok|l200|titan|cheyenne|lobo/i, 'pickup'], [/mustang|camaro|challenger|corvette|911|cayman|boxster|supra|gt-?r|370z|350z|m[2-8]\b|rs\d|amg|s5|a5|tt\b|mx-?5|miata|86\b|brz|4c|mini cooper s/i, 'deportivo'], [/golf|polo|fiesta|yaris|fit|march|swift|i10|i20|rio hb|spark|sonic|beat|ibiza|leon|onix hb|mazda ?2|mazda ?3 hb|a1|a3\b|serie 1|clase a/i, 'hatchback']];
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const nombre = a => [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
const tipoDe = a => { const s = norm(a.marca + ' ' + a.modelo + ' ' + (a.version || '')); for (const [re, tp] of TIPO_MODELO) if (re.test(s)) return tp; const t = norm(a.tipo_carroceria); return t || 'sedan'; };   // el modelo conocido manda (la base trae Suburban/Sportage como pickup)
const origenDe = a => { const m = norm(a.marca); return Object.keys(ORIGEN).filter(k => ORIGEN[k].some(b => m === b || m.startsWith(b))); };
const fmt = n => '$' + Number(n).toLocaleString('es-MX');

let CACHE = { t: 0, autos: [] };
async function inventario() {
    if (Date.now() - CACHE.t < 60000 && CACHE.autos.length) return CACHE.autos;
    const rows = await query("SELECT id, fyradrive_web_id, marca, modelo, version, anio, precio, kilometraje, color, transmision, tipo_carroceria, agencia_nombre FROM inventario_autos WHERE estado='activo' AND fyradrive_web_id IS NOT NULL ORDER BY listed_at DESC, id DESC");
    const puntos = {}; for (const p of await query('SELECT auto_id, name, address, maps_link FROM punto_envio').catch(() => [])) puntos[Number(p.auto_id)] = { nombre: p.name || null, direccion: p.address || null, mapa: p.maps_link || null };
    const lotes = {}; for (const t of await query("SELECT nombre, config_json FROM tenants WHERE activo = 1").catch(() => [])) { let c = {}; try { c = JSON.parse(t.config_json || '{}') || {}; } catch (e) { } if (c.tipo === 'lote') lotes[norm(t.nombre)] = { marca: c.marca || t.nombre, zona: c.zona || c.direccion || null, mapa: c.mapa_url || null }; }
    CACHE.lotes = lotes;
    const ids = rows.map(r => Number(r.fyradrive_web_id)).filter(Boolean);
    const fotos = {};
    if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        for (const f of await query(`SELECT auto_id, url_imagen, es_principal, orden_imagen FROM imagenes_autos WHERE auto_id IN (${ph}) AND url_imagen IS NOT NULL ORDER BY es_principal DESC, COALESCE(orden_imagen,99) ASC, id ASC`, ids).catch(() => [])) {
            const k = Number(f.auto_id); (fotos[k] = fotos[k] || []).push(f.url_imagen);
        }
    }
    const autos = rows.map(r => {
        const w = Number(r.fyradrive_web_id); const fs = fotos[w] || [];
        const lt = r.agencia_nombre ? (lotes[norm(r.agencia_nombre)] || null) : null;
        return { id: w, nombre: nombre(r), marca: r.marca, modelo: r.modelo, anio: Number(r.anio) || null, precio: Number(r.precio) || null, km: Number(r.kilometraje) || null, color: r.color && !/no espec/i.test(r.color) ? r.color : null, transmision: r.transmision || null, tipo: tipoDe(r), origen: origenDe(r), foto: fs[0] || null, fotos: fs.slice(0, 12), link: 'https://www.fyradrive.com/car/' + w, lote: r.agencia_nombre || null, lote_marca: lt ? lt.marca : null, zona: lt ? lt.zona : ((puntos[Number(r.id)] || {}).direccion || null), punto: puntos[Number(r.id)] || null };
    }).filter(a => a.foto);
    // VENDEDORES DE HAZLO (orden owner 2026-09-24): autos que la gente dejó "aquí en Hazlo" (modo 'hazlo'). NO son de Fyradrive; Hazlo solo conecta.
    try {
        await ensureVentas();
        for (const v of await query("SELECT id, token, nombre, telefono, marca, modelo, anio, km, precio FROM hazlo_ventas WHERE modo = 'hazlo' AND estado = 'activo' ORDER BY id DESC LIMIT 200")) {
            const r = { marca: v.marca, modelo: v.modelo, version: null, anio: v.anio, tipo_carroceria: null };
            autos.push({ id: HZ_BASE + Number(v.id), hazlo: true, token: v.token, vendedor: v.nombre, vendedor_tel: v.telefono, nombre: nombre(r), marca: v.marca, modelo: v.modelo, anio: Number(v.anio) || null, precio: Number(v.precio) || null, km: Number(v.km) || null, color: null, transmision: null, tipo: tipoDe(r), origen: origenDe(r), foto: null, fotos: [], link: 'https://fyrachat.vercel.app/hazlo.html?venta=' + v.token, lote: null, lote_marca: null, zona: 'Trato directo con ' + String(v.nombre || '').split(' ')[0], punto: null });
        }
    } catch (e) { console.error('[hazlo ventas]', e.message); }
    CACHE = { t: Date.now(), autos };
    return autos;
}
// ══ VENDER EN HAZLO (orden owner 2026-09-24) ══
// La gente llega a vender: la IA solo extrae los datos del auto; el CÓDIGO pregunta lo que falta y ofrece 3 caminos:
//  1) consignación con Fyradrive (vendedor + seguimiento; paga la comisión al venderse) · 2) dejarlo en Hazlo (aparece cuando alguien busque;
//  se le avisa y se ponen de acuerdo) · 3) ofertas inmediatas: los lotes lo ven en su panel ("X está rematando su auto") y ofertan a reserva de verlo.
// El contacto final SIEMPRE es click-to-chat de WhatsApp (wa.me), nunca el bot.
const HZ_BASE = 900000000;
const comisionRegla = precio => Math.max(10000, Math.round(Number(precio || 0) * 0.02));
const waLink = (tel, texto) => 'https://wa.me/' + String(tel || '').replace(/\D/g, '').replace(/^521(\d{10})$/, '52$1') + '?text=' + encodeURIComponent(texto);
async function ensureVentas() {
    if (global.__hzVentasOk) return; global.__hzVentasOk = true;
    await run('CREATE TABLE IF NOT EXISTS hazlo_ventas (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE, nombre TEXT, telefono TEXT, marca TEXT, modelo TEXT, anio INTEGER, km INTEGER, precio INTEGER, descripcion TEXT, modo TEXT, estado TEXT DEFAULT \'activo\', sesion TEXT, created INTEGER, updated INTEGER)');
    await run('CREATE TABLE IF NOT EXISTS hazlo_ofertas (id INTEGER PRIMARY KEY AUTOINCREMENT, venta_id INTEGER, tenant_id INTEGER, tenant_nombre TEXT, contacto_tel TEXT, monto INTEGER, nota TEXT, created INTEGER, UNIQUE(venta_id, tenant_id))');
    await run('CREATE TABLE IF NOT EXISTS hazlo_interes (id INTEGER PRIMARY KEY AUTOINCREMENT, venta_id INTEGER, sesion TEXT, created INTEGER)');
}
const numDe = (s) => { const t = norm(s).replace(/,/g, ''); const m = t.match(/(\d+(?:\.\d+)?)\s*(mil|k)?/); if (!m) return 0; let n = Number(m[1]); if (m[2]) n *= 1000; return Math.round(n); };
const RE_VENDER = /\b(vender|vendo|venta de mi|quiero vender|me compran|compran autos|rematar|remato)\b/i;
async function avisarVendedor(tel, texto) { try { const CV = require('../lib/seb/citas-vivas.js'); return await CV.enviarWA(tel, texto, 0); } catch (e) { return { ok: false, error: e.message }; } }
function turnoVenta(v, L, mensaje) {
    // v = estado en curso {paso, marca, modelo, anio, km, precio, nombre, telefono}. Devuelve { texto, venta } o { listo: v }
    const t = norm(mensaje);
    if (L.venta_marca && !v.marca) v.marca = L.venta_marca; if (L.venta_modelo && !v.modelo) v.modelo = L.venta_modelo; if (L.venta_anio > 1990 && !v.anio) v.anio = L.venta_anio;
    if (L.venta_km > 0 && !v.km) v.km = L.venta_km; if (L.venta_precio > 0 && !v.precio) v.precio = L.venta_precio;
    const y = (t.match(/\b(19[89]\d|20[0-3]\d)\b/) || [])[1]; if (y && !v.anio) v.anio = Number(y);
    if (v.paso === 'km' && !v.km) { const n = numDe(mensaje); if (n > 0) v.km = n; }
    if (v.paso === 'precio' && !v.precio) { const n = numDe(mensaje); if (n >= 10000) v.precio = n; }
    if (v.paso === 'nombre' && !v.nombre && !/\d{7,}/.test(mensaje)) v.nombre = mensaje.replace(/^(soy|me llamo|mi nombre es)\s+/i, '').trim().slice(0, 60);
    if (L.nombre && !v.nombre && v.paso === 'nombre') v.nombre = L.nombre;
    if (v.paso === 'telefono' || !v.telefono) { const d = mensaje.replace(/\D/g, ''); if (d.length >= 10 && v.paso === 'telefono') v.telefono = d.slice(-10); else if (L.telefono && v.paso === 'telefono') v.telefono = L.telefono.replace(/\D/g, '').slice(-10); }
    if (!v.marca || !v.modelo) { v.paso = 'auto'; return { texto: v.marca && !v.modelo ? `Va, ${v.marca}. ¿Qué modelo y de qué año es?` : 'Claro que sí. ¿Qué auto es? Dime marca, modelo y año (por ejemplo: Mazda 3 2019).', venta: v }; }
    if (!v.anio) { v.paso = 'auto'; return { texto: `¿De qué año es tu ${v.marca} ${v.modelo}?`, venta: v }; }
    if (!v.km) { v.paso = 'km'; return { texto: `¿Cuántos kilómetros tiene el ${v.marca} ${v.modelo} ${v.anio}?`, venta: v }; }
    if (!v.precio) { v.paso = 'precio'; return { texto: '¿En cuánto lo quieres vender?', venta: v }; }
    if (!v.nombre) { v.paso = 'nombre'; return { texto: 'Perfecto. ¿Cómo te llamas?', venta: v }; }
    if (!v.telefono) { v.paso = 'telefono'; return { texto: `Gracias, ${v.nombre}. ¿A qué WhatsApp te contactan? (10 dígitos)`, venta: v }; }
    return { listo: v };
}
const autoDe = v => `${v.marca} ${v.modelo} ${v.anio}`;
const opcionesTexto = v => `Listo, ${v.nombre}: ${autoDe(v)}, ${Number(v.km).toLocaleString('es-MX')} km, en ${fmt(v.precio)}. ¿Cómo le hacemos?\n1) Consignación con Fyradrive: un vendedor lo trabaja con seguimiento especializado y solo al venderse pagarías ${fmt(comisionRegla(v.precio))}.\n2) Dejarlo aquí en Hazlo: aparece cuando alguien busque un auto así y te aviso para que se pongan de acuerdo.\n3) Escuchar ofertas inmediatas: se lo paso a los lotes y te voy diciendo cuánto dan, a reserva de verlo.\nDime 1, 2 o 3.`;

const SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['intencion', 'marcas', 'origen', 'tipo', 'precio_min', 'precio_max', 'anio_min', 'transmision', 'lote', 'auto_id', 'nombre', 'telefono', 'cuando', 'respuesta', 'venta_marca', 'venta_modelo', 'venta_anio', 'venta_km', 'venta_precio'],
    properties: {
        intencion: { type: 'string', enum: ['mostrar', 'ver_auto', 'agendar', 'ubicacion', 'platicar', 'fuera', 'vender'] },
        venta_marca: { type: 'string' }, venta_modelo: { type: 'string' }, venta_anio: { type: 'number' }, venta_km: { type: 'number' }, venta_precio: { type: 'number' },
        marcas: { type: 'array', items: { type: 'string' } },
        origen: { type: 'string', enum: ['', 'japones', 'coreano', 'americano', 'aleman', 'europeo', 'ingles'] },
        tipo: { type: 'string', enum: ['', 'suv', 'sedan', 'pickup', 'hatchback', 'deportivo'] },
        precio_min: { type: 'number' }, precio_max: { type: 'number' }, anio_min: { type: 'number' },
        transmision: { type: 'string', enum: ['', 'automatica', 'manual'] },
        lote: { type: 'string' },
        auto_id: { type: 'number' },
        nombre: { type: 'string' }, telefono: { type: 'string' }, cuando: { type: 'string' },
        respuesta: { type: 'string' }
    }
};
function sistema(autos) {
    const lista = autos.map(a => `#${a.id} ${a.nombre} · ${fmt(a.precio)} · ${a.km ? a.km.toLocaleString('es-MX') + ' km' : ''} · ${a.tipo} · ${a.origen.join('/') || 'otro'}${a.lote ? ' · ' + a.lote : ''}`).join('\n');
    return `Eres HazloGPT, el asistente de Fyradrive (autos seminuevos en Monterrey). Lees lo que escribe un comprador y devuelves SOLO el JSON.
REGLAS:
- "intencion": mostrar = quiere ver autos (lista, filtro, "qué tienes", "japoneses", "SUV", "algo de 300 mil"); ver_auto = pregunta por UN auto concreto (pon su auto_id); agendar = quiere ir a verlo / prueba de manejo / cita (pon auto_id si lo menciona); ubicacion = pregunta dónde están, dónde ve el auto, dirección, mapa (pon auto_id si habla de un auto); platicar = saludo, duda general de cómo funciona Fyradrive, gracias; fuera = no tiene que ver con autos.
- Filtros solo cuando el comprador los dice: marcas (nombres tal cual), origen, tipo, precios en pesos (0 = sin límite), anio_min (0 = sin límite), transmision, lote (si nombra un lote/agencia del inventario, p. ej. "autos universales", "autos lozano"; '' si no).
- "respuesta": UNA frase corta y natural en español de México, tuteando, sin emojis, sin inventar datos ni precios. Eres un AGENTE que brinda opciones de distintos vendedores (particulares y lotes), no un solo lote: si vas a mostrar autos di algo como "Claro, mira lo que encontré en SUV:" (el sistema agrupa por vendedor y arma las tarjetas). Si es 'fuera' di amablemente que solo ayudas con autos.
- Para agendar: extrae nombre, telefono (10 dígitos) y cuando (día/hora) si los dice; deja '' lo que no diga. No confirmes tú la cita: el sistema pregunta lo que falte.
- vender = quiere VENDER su auto (o rematarlo / que se lo compren). Extrae de SU auto lo que diga: venta_marca, venta_modelo (sin el año), venta_anio, venta_km (kilómetros; "80 mil" = 80000), venta_precio (pesos; "250 mil" = 250000). Lo que no diga: '' o 0. El sistema pregunta lo que falte y le ofrece los caminos; tú no los expliques.
- Datos de Fyradrive: se paga de contado o con crédito bancario (HEY Banco); enganche desde 25% aprox; los autos se ven en Monterrey con cita.
INVENTARIO ACTIVO (id, nombre, precio, km, tipo, origen):
${lista}`;
}
async function leer(autos, historial, mensaje) {
    const apiKey = process.env.CLAUDE_API_KEY; if (!apiKey) throw new Error('sin CLAUDE_API_KEY');
    const user = (historial || []).slice(-8).map(h => (h.rol === 'user' ? 'Comprador: ' : 'HazloGPT: ') + String(h.texto || '').slice(0, 300)).join('\n') + '\nComprador: ' + String(mensaje).slice(0, 600);
    let data = null;
    for (let i = 0; i < 3; i++) {
        try {
            const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({ model: HAIKU, max_tokens: 400, system: [{ type: 'text', text: sistema(autos), cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema: SCHEMA } } }) });
            data = await r.json(); if (r.ok) break;
            if (r.status !== 429 && r.status < 500) throw new Error('anthropic ' + r.status);
            data = null;
        } catch (e) { if (i === 2) throw e; data = null; }
        await new Promise(res => setTimeout(res, 1000 * (i + 1)));
    }
    return JSON.parse(data.content[0].text);
}
function filtrar(autos, f) {
    let out = autos;
    const marcas = (f.marcas || []).map(norm).filter(Boolean);
    if (marcas.length) out = out.filter(a => marcas.some(m => norm(a.marca).startsWith(m) || m.startsWith(norm(a.marca)) || norm(a.modelo).includes(m)));
    if (f.origen) out = out.filter(a => a.origen.includes(f.origen));
    if (f.tipo) out = out.filter(a => a.tipo === f.tipo);
    if (f.precio_min > 0) out = out.filter(a => a.precio >= f.precio_min);
    if (f.precio_max > 0) out = out.filter(a => a.precio <= f.precio_max);
    if (f.anio_min > 0) out = out.filter(a => a.anio >= f.anio_min);
    if (f.transmision) out = out.filter(a => norm(a.transmision).startsWith(f.transmision === 'manual' ? 'manual' : 'auto'));
    if (f.lote) { const l = norm(f.lote).replace(/\s+/g, ' '); out = out.filter(a => norm(a.lote).includes(l) || l.includes(norm(a.lote)) && a.lote); }
    return out;
}
// HazloGPT no es "un mismo organismo": es un agente que brinda opciones de distintos vendedores. Agrupa: particulares primero, luego cada lote con dónde está.
const tituloCaso = s => String(s || '').toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
function agrupar(sel) {
    const part = sel.filter(a => !a.lote); const porLote = {}; for (const a of sel.filter(a => a.lote)) (porLote[a.lote] = porLote[a.lote] || []).push(a);
    const grupos = [];
    if (part.length) grupos.push({ titulo: 'Vendedores particulares', intro: (grupos.length ? 'También' : 'Mira, aquí') + ' te tengo ' + (part.length === 1 ? 'una opción' : 'unas opciones') + ' de vendedores particulares:', autos: part });
    for (const [lote, autos] of Object.entries(porLote)) { const nombreL = autos[0].lote_marca ? String(autos[0].lote_marca).replace(/\s+IA$/i, '') : tituloCaso(lote); const zona = autos[0].zona; grupos.push({ titulo: nombreL, intro: (grupos.length ? 'Y estas son' : 'Mira, estas son') + ' de lote, de ' + nombreL + (zona ? ', que está en ' + zona : '') + ':', autos }); }
    return grupos;
}
const hayFiltro = f => (f.marcas && f.marcas.length) || f.origen || f.tipo || f.precio_min > 0 || f.precio_max > 0 || f.anio_min > 0 || f.transmision || f.lote;
async function ensureTabla() { await run('CREATE TABLE IF NOT EXISTS hazlo_solicitudes (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, telefono TEXT, cuando TEXT, auto_id INTEGER, auto_nombre TEXT, sesion TEXT, created INTEGER)'); }

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store');
    const action = String((req.query && req.query.action) || (req.body && req.body.action) || '');
    try {
        const autos = await inventario();
        if (action === 'autos') return res.status(200).json({ ok: true, autos });
        // ── PÁGINA DEL VENDEDOR (hazlo.html?venta=<token>): su auto, el camino elegido, las ofertas de los lotes y quién quiso verlo ──
        if (action === 'venta') {
            await ensureVentas(); const tk = String((req.query && req.query.token) || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
            const v = (await query('SELECT * FROM hazlo_ventas WHERE token = ?', [tk]))[0]; if (!v) return res.status(404).json({ ok: false, error: 'No encontré esa venta.' });
            const ofertas = await query('SELECT o.tenant_id, o.tenant_nombre, o.contacto_tel, o.monto, o.created FROM hazlo_ofertas o WHERE o.venta_id = ? ORDER BY o.monto DESC', [v.id]);
            const interes = (await query('SELECT COUNT(*) n FROM hazlo_interes WHERE venta_id = ?', [v.id]))[0].n;
            const nom = String(v.nombre || '').split(' ')[0];
            return res.status(200).json({ ok: true, venta: { auto: `${v.marca} ${v.modelo} ${v.anio}`, km: v.km, precio: v.precio, modo: v.modo, nombre: v.nombre, estado: v.estado }, interes: Number(interes),
                ofertas: ofertas.map(o => ({ lote: o.tenant_nombre, monto: o.monto, cuando: o.created, wa: o.contacto_tel ? waLink(o.contacto_tel, `Hola, soy ${nom}. Vi su oferta de ${fmt(o.monto)} por mi ${v.marca} ${v.modelo} ${v.anio} en HazloGPT. ¿Cuándo lo pueden ver?`) : null })) });
        }
        if (action === 'chat' && req.method === 'POST') {
            const b = req.body || {}; const mensaje = String(b.mensaje || '').trim().slice(0, 600); if (!mensaje) return res.status(400).json({ ok: false, error: 'Escribe algo.' });
            // ── VENTA EN CURSO (la lleva el cliente en `venta`, el código la completa) ──
            const vPend = b.venta && typeof b.venta === 'object' ? b.venta : null;
            const Lv = await leer(autos, b.historial, mensaje);
            if (vPend || Lv.intencion === 'vender' || RE_VENDER.test(mensaje)) {
                const v = Object.assign({ paso: 'auto', marca: '', modelo: '', anio: 0, km: 0, precio: 0, nombre: '', telefono: '', modo: '' }, vPend || {});
                if (v.paso === 'modo') {
                    const m = norm(mensaje); const op = /\b1\b|consign|fyradrive|vendedor/.test(m) ? 'consignacion' : /\b2\b|aqui|aquí|hazlo|dejarlo|avis/.test(m) ? 'hazlo' : /\b3\b|oferta|lote|remat|inmediat/.test(m) ? 'remate' : '';
                    if (!op) return res.status(200).json({ ok: true, texto: 'Dime 1, 2 o 3 para saber cómo le hacemos.', autos: [], venta: v });
                    await ensureVentas(); const token = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6); const now = Date.now();
                    await run('INSERT INTO hazlo_ventas (token, nombre, telefono, marca, modelo, anio, km, precio, modo, estado, sesion, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [token, v.nombre, '521' + v.telefono, v.marca, v.modelo, Number(v.anio), Number(v.km), Number(v.precio), op, 'activo', String(b.sesion || ''), now, now]);
                    CACHE.t = 0;   // el surtido se recarga (modo 'hazlo' entra al instante)
                    const link = 'https://fyrachat.vercel.app/hazlo.html?venta=' + token; const a = autoDe(v);
                    if (op === 'consignacion') { avisarVendedor('5218120066355', `Consignación desde HazloGPT: ${v.nombre} · ${a} · ${Number(v.km).toLocaleString('es-MX')} km · pide ${fmt(v.precio)} · WhatsApp ${v.telefono}`).catch(() => {}); return res.status(200).json({ ok: true, texto: `Listo, ${v.nombre}. Tu ${a} queda con Fyradrive: un vendedor te contacta al ${v.telefono} para arrancar la consignación (pagas ${fmt(comisionRegla(v.precio))} solo cuando se venda). Si quieres adelantar, escríbeles por WhatsApp:`, autos: [], venta: null, wa: waLink(WA_BOT, `Hola, soy ${v.nombre}. Quiero consignar mi ${a} con Fyradrive (lo dejé en HazloGPT).`), wa_label: 'Escribir a Fyradrive' }); }
                    if (op === 'hazlo') return res.status(200).json({ ok: true, texto: `Listo, ${v.nombre}. Tu ${a} ya está aquí en Hazlo. Cuando alguien quiera verlo le doy tu WhatsApp y a ti te aviso al ${v.telefono} para que se pongan de acuerdo. Tu ficha: ${link}`, autos: [], venta: null });
                    return res.status(200).json({ ok: true, texto: `Listo, ${v.nombre}. Ya se lo pasé a los lotes: van a ver tu ${a} y ofertar a reserva de verlo. Aquí ves las ofertas conforme lleguen y desde ahí te pones en contacto con quien quieras: ${link}\nTambién te aviso al ${v.telefono} cuando entre una.`, autos: [], venta: null });
                }
                const r = turnoVenta(v, Lv, mensaje);
                if (r.venta) return res.status(200).json({ ok: true, texto: r.texto, autos: [], venta: r.venta });
                const vv = r.listo; vv.paso = 'modo';
                return res.status(200).json({ ok: true, texto: opcionesTexto(vv), autos: [], venta: vv });
            }
            const L = Lv;
            // ── AUTO DE UN VENDEDOR DE HAZLO: Hazlo solo conecta (click-to-chat), no agenda ni lo hace de Fyradrive ──
            const hzA = (L.auto_id ? autos.find(a => a.id === Number(L.auto_id) && a.hazlo) : null) || (b.cita && b.cita.auto_id ? autos.find(a => a.id === Number(b.cita.auto_id) && a.hazlo) : null);
            if (hzA && (L.intencion === 'agendar' || L.intencion === 'ver_auto' || L.intencion === 'ubicacion' || (b.cita && b.cita.auto_id))) {
                await ensureVentas(); const vid = hzA.id - HZ_BASE; await run('INSERT INTO hazlo_interes (venta_id, sesion, created) VALUES (?,?,?)', [vid, String(b.sesion || ''), Date.now()]).catch(() => {});
                avisarVendedor(hzA.vendedor_tel, `HazloGPT: alguien quiere ver tu ${hzA.nombre}. Le pasé tu WhatsApp para que se pongan de acuerdo.`).catch(() => {});
                const nomV = String(hzA.vendedor || '').split(' ')[0];
                return res.status(200).json({ ok: true, texto: `El ${hzA.nombre} (${fmt(hzA.precio)}${hzA.km ? ', ' + hzA.km.toLocaleString('es-MX') + ' km' : ''}) lo vende ${nomV} directamente. Te conecto por WhatsApp para que se pongan de acuerdo:`, autos: [hzA], cita: null, wa: waLink(hzA.vendedor_tel, `Hola ${nomV}, vi tu ${hzA.nombre} en HazloGPT y me interesa verlo. ¿Cuándo se puede?`), wa_label: 'Escribirle a ' + nomV });
            }
            const pend = b.cita && typeof b.cita === 'object' ? b.cita : null;   // cita en curso (la lleva el cliente, el código la completa)
            const porId = id => autos.find(a => a.id === Number(id)) || null;
            // ── CITA EN CURSO: cualquier mensaje mientras falta un dato se lee como ese dato ──
            if (pend || L.intencion === 'agendar') {
                const c = Object.assign({ nombre: '', telefono: '', cuando: '', auto_id: 0 }, pend || {});
                if (L.nombre) c.nombre = L.nombre; if (L.telefono) c.telefono = L.telefono.replace(/\D/g, '').slice(-10); if (L.cuando) c.cuando = L.cuando; if (L.auto_id && !c.auto_id) c.auto_id = L.auto_id;   // el botón de la tarjeta manda sobre la lectura
                if (pend && !L.nombre && !L.telefono && !L.cuando && L.intencion !== 'agendar') {
                    // respuesta suelta al dato que se pidió
                    if (!c.nombre && !/\d{7,}/.test(mensaje)) c.nombre = mensaje.replace(/^(soy|me llamo|mi nombre es)\s+/i, '').slice(0, 60);
                    else if (!c.telefono && /\d{10}/.test(mensaje.replace(/\D/g, ''))) c.telefono = mensaje.replace(/\D/g, '').slice(-10);
                    else if (!c.cuando) c.cuando = mensaje.slice(0, 80);
                }
                const auto = porId(c.auto_id);
                if (!auto && autos.length > 1 && !c.auto_id) return res.status(200).json({ ok: true, texto: 'Claro. ¿Cuál auto quieres ver? Elige uno y le damos a "Agendar cita".', autos: filtrar(autos, L).slice(0, 12), cita: c });
                if (!c.nombre) return res.status(200).json({ ok: true, texto: `Va, ${auto ? 'para el ' + auto.nombre : ''}. ¿Con quién tengo el gusto?`.replace(/\s+\./, '.'), autos: [], cita: c });
                if (!c.telefono || c.telefono.length !== 10) return res.status(200).json({ ok: true, texto: `Gracias, ${c.nombre}. ¿A qué WhatsApp te confirmamos? (10 dígitos)`, autos: [], cita: c });
                if (!c.cuando) return res.status(200).json({ ok: true, texto: '¿Qué día y a qué hora te acomoda pasar a verlo?', autos: [], cita: c });
                await ensureTabla();
                await run('INSERT INTO hazlo_solicitudes (nombre, telefono, cuando, auto_id, auto_nombre, sesion, created) VALUES (?,?,?,?,?,?,?)', [c.nombre, c.telefono, c.cuando, auto ? auto.id : null, auto ? auto.nombre : null, String(b.sesion || '').slice(0, 64), Date.now()]);
                const txt = encodeURIComponent(`Hola, soy ${c.nombre}. Quiero agendar cita para ver el ${auto ? auto.nombre : 'auto'} ${c.cuando}. ${auto ? auto.link : ''}`.trim());
                return res.status(200).json({ ok: true, texto: `Listo, ${c.nombre}: ${auto ? auto.nombre : 'tu visita'}, ${c.cuando}. Para dejarla confirmada mándanos ese mensaje por WhatsApp con el botón de abajo y ahí te decimos la ubicación.`, autos: auto ? [auto] : [], cita: null, wa: `https://wa.me/${WA_BOT}?text=${txt}` });
            }
            if (L.intencion === 'ubicacion') {
                const a = porId(L.auto_id) || (hayFiltro(L) ? filtrar(autos, L)[0] : null);
                const pts = a ? [a] : autos; const vistos = new Set(); const lineas = [];
                for (const x of pts) { const p = x.punto; if (!p) continue; const etiqueta = x.lote || 'Fyradrive'; const k = etiqueta + '|' + (p.direccion || p.mapa || p.nombre || ''); if (vistos.has(k)) continue; vistos.add(k); lineas.push(etiqueta + ': ' + [p.direccion || (p.nombre && norm(p.nombre) !== norm(etiqueta) ? p.nombre : null)].filter(Boolean).join(', ') + (p.mapa ? ' · ' + p.mapa : '')); if (lineas.length >= 4) break; }
                if (a && !lineas.length) return res.status(200).json({ ok: true, texto: `El ${a.nombre} se ve con cita en Monterrey. Agenda y te confirmamos la ubicación exacta por WhatsApp.`, autos: [a], cita: null });
                return res.status(200).json({ ok: true, texto: (a ? `El ${a.nombre} lo ves aquí:\n` : 'Nuestros puntos de venta en Monterrey:\n') + lineas.join('\n') + '\nSi quieres ir a manejarlo, agenda tu cita y te esperamos.', autos: a ? [a] : [], cita: null });
            }
            if (L.intencion === 'ver_auto') {
                const a = porId(L.auto_id) || filtrar(autos, L)[0] || null;
                if (a) return res.status(200).json({ ok: true, texto: `${a.nombre}: ${fmt(a.precio)}${a.km ? ', ' + a.km.toLocaleString('es-MX') + ' km' : ''}${a.transmision ? ', ' + a.transmision.toLowerCase() : ''}${a.color ? ', color ' + a.color : ''}. Ábrelo para ver todas las fotos o agenda cita para verlo en persona.`, autos: [a], cita: null });
            }
            if (L.intencion === 'mostrar' || L.intencion === 'ver_auto') {
                const sel = hayFiltro(L) ? filtrar(autos, L) : autos;
                if (!sel.length) return res.status(200).json({ ok: true, texto: 'Ahorita no tengo uno así entre mis vendedores. Esto es lo que sí hay:', autos: autos.slice(0, 12), grupos: agrupar(autos.slice(0, 12)), cita: null });
                return res.status(200).json({ ok: true, texto: L.respuesta || (hayFiltro(L) ? 'Claro, esto es lo que hay:' : `Tengo ${autos.length} opciones de varios vendedores:`), autos: sel, grupos: agrupar(sel), cita: null });
            }
            return res.status(200).json({ ok: true, texto: L.respuesta || 'Cuéntame qué auto buscas y te enseño lo que tenemos.', autos: [], cita: null });
        }
        return res.status(400).json({ ok: false, error: 'action inválida' });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'Se me fue la señal un segundo, ¿me lo repites?', detalle: String(e.message || e).slice(0, 200) });
    }
};
