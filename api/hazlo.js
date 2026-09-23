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
        return { id: w, nombre: nombre(r), marca: r.marca, modelo: r.modelo, anio: Number(r.anio) || null, precio: Number(r.precio) || null, km: Number(r.kilometraje) || null, color: r.color && !/no espec/i.test(r.color) ? r.color : null, transmision: r.transmision || null, tipo: tipoDe(r), origen: origenDe(r), foto: fs[0] || null, fotos: fs.slice(0, 12), link: 'https://www.fyradrive.com/car/' + w, lote: r.agencia_nombre || null, punto: puntos[Number(r.id)] || null };
    }).filter(a => a.foto);
    CACHE = { t: Date.now(), autos };
    return autos;
}

const SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['intencion', 'marcas', 'origen', 'tipo', 'precio_min', 'precio_max', 'anio_min', 'transmision', 'auto_id', 'nombre', 'telefono', 'cuando', 'respuesta'],
    properties: {
        intencion: { type: 'string', enum: ['mostrar', 'ver_auto', 'agendar', 'ubicacion', 'platicar', 'fuera'] },
        marcas: { type: 'array', items: { type: 'string' } },
        origen: { type: 'string', enum: ['', 'japones', 'coreano', 'americano', 'aleman', 'europeo', 'ingles'] },
        tipo: { type: 'string', enum: ['', 'suv', 'sedan', 'pickup', 'hatchback', 'deportivo'] },
        precio_min: { type: 'number' }, precio_max: { type: 'number' }, anio_min: { type: 'number' },
        transmision: { type: 'string', enum: ['', 'automatica', 'manual'] },
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
- Filtros solo cuando el comprador los dice: marcas (nombres tal cual), origen, tipo, precios en pesos (0 = sin límite), anio_min (0 = sin límite), transmision.
- "respuesta": UNA frase corta y natural en español de México, tuteando, sin emojis, sin inventar datos ni precios; si vas a mostrar autos di algo como "Esto es lo que tenemos en SUV:" (las tarjetas las arma el sistema). Si es 'fuera' di amablemente que solo ayudas con los autos de Fyradrive.
- Para agendar: extrae nombre, telefono (10 dígitos) y cuando (día/hora) si los dice; deja '' lo que no diga. No confirmes tú la cita: el sistema pregunta lo que falte.
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
    return out;
}
const hayFiltro = f => (f.marcas && f.marcas.length) || f.origen || f.tipo || f.precio_min > 0 || f.precio_max > 0 || f.anio_min > 0 || f.transmision;
async function ensureTabla() { await run('CREATE TABLE IF NOT EXISTS hazlo_solicitudes (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, telefono TEXT, cuando TEXT, auto_id INTEGER, auto_nombre TEXT, sesion TEXT, created INTEGER)'); }

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store');
    const action = String((req.query && req.query.action) || (req.body && req.body.action) || '');
    try {
        const autos = await inventario();
        if (action === 'autos') return res.status(200).json({ ok: true, autos });
        if (action === 'chat' && req.method === 'POST') {
            const b = req.body || {}; const mensaje = String(b.mensaje || '').trim().slice(0, 600); if (!mensaje) return res.status(400).json({ ok: false, error: 'Escribe algo.' });
            const pend = b.cita && typeof b.cita === 'object' ? b.cita : null;   // cita en curso (la lleva el cliente, el código la completa)
            const L = await leer(autos, b.historial, mensaje);
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
                for (const x of pts) { const p = x.punto; if (!p) continue; const k = (p.nombre || '') + '|' + (p.direccion || ''); if (vistos.has(k)) continue; vistos.add(k); lineas.push((x.lote || p.nombre || 'Punto de venta') + ': ' + [p.nombre && p.nombre !== x.lote ? p.nombre : null, p.direccion].filter(Boolean).join(', ') + (p.mapa ? ' · ' + p.mapa : '')); if (lineas.length >= 4) break; }
                if (a && !lineas.length) return res.status(200).json({ ok: true, texto: `El ${a.nombre} se ve con cita en Monterrey. Agenda y te confirmamos la ubicación exacta por WhatsApp.`, autos: [a], cita: null });
                return res.status(200).json({ ok: true, texto: (a ? `El ${a.nombre} lo ves aquí:\n` : 'Nuestros puntos de venta en Monterrey:\n') + lineas.join('\n') + '\nSi quieres ir a manejarlo, agenda tu cita y te esperamos.', autos: a ? [a] : [], cita: null });
            }
            if (L.intencion === 'ver_auto') {
                const a = porId(L.auto_id) || filtrar(autos, L)[0] || null;
                if (a) return res.status(200).json({ ok: true, texto: `${a.nombre}: ${fmt(a.precio)}${a.km ? ', ' + a.km.toLocaleString('es-MX') + ' km' : ''}${a.transmision ? ', ' + a.transmision.toLowerCase() : ''}${a.color ? ', color ' + a.color : ''}. Ábrelo para ver todas las fotos o agenda cita para verlo en persona.`, autos: [a], cita: null });
            }
            if (L.intencion === 'mostrar' || L.intencion === 'ver_auto') {
                const sel = hayFiltro(L) ? filtrar(autos, L) : autos;
                if (!sel.length) return res.status(200).json({ ok: true, texto: 'Ahorita no tenemos uno así en inventario. Esto es lo que sí tenemos:', autos: autos.slice(0, 12), cita: null });
                return res.status(200).json({ ok: true, texto: L.respuesta || (hayFiltro(L) ? 'Esto es lo que tenemos:' : `Tenemos ${autos.length} autos disponibles:`), autos: sel, cita: null });
            }
            return res.status(200).json({ ok: true, texto: L.respuesta || 'Cuéntame qué auto buscas y te enseño lo que tenemos.', autos: [], cita: null });
        }
        return res.status(400).json({ ok: false, error: 'action inválida' });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'Se me fue la señal un segundo, ¿me lo repites?', detalle: String(e.message || e).slice(0, 200) });
    }
};
