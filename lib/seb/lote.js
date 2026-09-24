'use strict';
/* CEREBRO DE LOTE (orden owner 2026-09-24): "cada universo/tenant es uno solo".
 * En un universo de lote (tenant ≠ 0), mientras el chat NO tiene auto en foco, NO corre el cerebro de Fyradrive:
 *   1) si el comprador nombra un auto del catálogo del lote → ese es el foco y se abre sobre él (ficha por la misma puerta que el botón Info);
 *   2) si quiere comprar pero no dice cuál → se le pregunta QUÉ está buscando;
 *   3) su respuesta funciona como FILTRO sobre el inventario del lote (japoneses, camioneta, presupuesto, marca, año, automático):
 *      1 resultado → foco; 2-4 → lista numerada y "¿cuál?"; más → los 4 primeros y pide afinar; 0 → honesto y escala al lote;
 *   4) el comprador elige (número o nombre) → foco.
 * Identidad: en lotes JAMÁS se dice "Sebastián Romero" ni "Fyradrive": se habla como "el asistente de <marca del lote>".
 * Determinista primero (regex + catálogo); Haiku con JSON forzado solo para interpretar criterios que el regex no entiende. */
const { query } = require('./db.js');
const U = require('./universo.js');
const HAIKU = 'claude-haiku-4-5-20251001';

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9$ .,-]+/g, ' ').replace(/\s+/g, ' ').trim();
const fmt = n => '$' + Number(n || 0).toLocaleString('es-MX');
const GENERICOS = new Set(['auto', 'autos', 'carro', 'coche', 'camioneta', 'pickup', 'pick', 'sedan', 'suv', 'sport', 'line', 'plus', 'gt', 'ls', 'lt', 'xl', 'se', 'sl', 'sr', 'lx', 'ex', 'gl', 'premium', 'advance', 'sense', 'exclusive', 'limited', 'touring', 'edition', 'turbo', 'aut', 'std', 'the', 'grand', 'sport', 'cabina', 'doble', 'pro']);
const ORIGEN = {
    japones: ['nissan', 'toyota', 'honda', 'mazda', 'mitsubishi', 'suzuki', 'subaru', 'infiniti', 'acura', 'lexus', 'isuzu'],
    coreano: ['kia', 'hyundai', 'genesis'],
    americano: ['chevrolet', 'ford', 'gmc', 'dodge', 'ram', 'jeep', 'chrysler', 'buick', 'cadillac', 'lincoln', 'tesla'],
    aleman: ['volkswagen', 'vw', 'bmw', 'mercedes', 'mercedes-benz', 'audi', 'porsche', 'mini', 'smart'],
    europeo: ['seat', 'peugeot', 'renault', 'fiat', 'volvo', 'alfa romeo', 'cupra', 'skoda', 'citroen', 'land rover', 'jaguar', 'mini', 'volkswagen', 'bmw', 'mercedes', 'audi', 'porsche']
};
const TIPO_MODELO = {
    pickup: /\b(hilux|tacoma|np300|frontier|ranger|silverado|cheyenne|sierra|ram\b|l200|f-?150|lobo|tundra|colorado|ridgeline|maverick|amarok|saveiro)\b/,
    suv: /\b(cx-?[3-9]|cx-?30|cx-?50|rav ?4|tucson|sportage|kicks|x-?trail|xtrail|tiguan|equinox|trax|hr-?v|cr-?v|seltos|blazer|encore|xt[4-6]|captiva|tracker|tahoe|suburban|explorer|escape|bronco|edge|expedition|highlander|4runner|land cruiser|rogue|murano|pathfinder|armada|juke|creta|santa fe|sorento|nino|soul|q[3578]|x[1-7]|gl[abcse]|glk|ml|wrangler|cherokee|compass|renegade|forester|outback|crosstrek|rx|nx|ux|pilot|passport|taos|t-?cross|nivus|kona|venue|palisade|telluride|carnival|outlander|montero|eclipse cross|asx|vitara|jimny|s-?cross|traverse|acadia|terrain|yukon|durango|journey|grand cherokee)\b/,
    hatchback: /\b(march|swift|i10|i20|spark|onix hb|hb|hatch|mazda ?2 hb|aveo hb|ibiza|polo|golf|fiesta|yaris hb|fit|rio hb|picanto|leon|pulse|sandero|beat)\b/,
    deportivo: /\b(mustang|camaro|challenger|gti|mx-?5|miata|86|brz|supra|civic type|corvette|370z|z\b)\b/,
    sedan: /\b(sentra|versa|jetta|civic|corolla|vento|city|accord|camry|mazda ?3|mazda ?6|altima|cavalier|aveo|onix|rio|forte|elantra|accent|k3|k5|optima|sonata|cruze|malibu|fusion|focus|passat|virtus|a3|a4|a6|serie 3|serie 5|clase [ace]|c 200|a 200|es\b|is\b|yaris sedan|attitude|logan|ateca|toledo|cordoba)\b/
};
function origenDe(marca) { const m = norm(marca); const out = []; for (const [o, ms] of Object.entries(ORIGEN)) if (ms.some(x => m === x || m.startsWith(x))) out.push(o); return out; }
function tipoDe(a) {
    const c = norm(a.tipo_carroceria || '');
    if (/pick ?up|pickup|camioneta de carga/.test(c)) return 'pickup'; if (/suv|crossover|camioneta/.test(c)) return 'suv'; if (/hatch/.test(c)) return 'hatchback'; if (/sedan|sedán/.test(c)) return 'sedan'; if (/deportivo|coupe|convertible/.test(c)) return 'deportivo';
    const m = norm(a.marca + ' ' + a.modelo); for (const [t, re] of Object.entries(TIPO_MODELO)) if (re.test(m)) return t; return '';
}
function marcaCorta(t) { return String((t && t.config && t.config.marca) || (t && t.marca) || (t && t.nombre) || 'el lote').replace(/\s+IA$/i, '').trim(); }
/** PUERTA DE SALIDA (identidad): en lotes nada de Sebastián Romero / Fyradrive / "soy Seb". */
function identidad(texto, t) {
    if (!t || Number(t.id) === 0) return texto;
    const m = marcaCorta(t); let s = String(texto || '');
    s = s.replace(/Mucho gusto, mi nombre es Sebasti[aá]n Romero(, para servirte)?/g, 'Soy el asistente de ' + m).replace(/\b[Ss]oy Seb(asti[aá]n( Romero)?)? de Fyradrive\b/g, 'soy el asistente de ' + m);
    s = s.replace(/mi nombre es Sebasti[aá]n Romero/gi, 'soy el asistente de ' + m).replace(/soy Sebasti[aá]n Romero/gi, 'soy el asistente de ' + m).replace(/Sebasti[aá]n Romero/g, 'el asistente de ' + m);
    s = s.replace(/\bsoy Seb\b/gi, 'soy el asistente de ' + m).replace(/\bFyradrive\b(?!\.com)/gi, m);
    return s;
}
/** Catálogo del lote enriquecido para filtrar (km, transmisión, carrocería vienen de inventario_autos). */
async function enriquecer(catalogo) {
    const ids = (catalogo || []).map(a => Number(a.id)).filter(Boolean); if (!ids.length) return [];
    const rows = await query('SELECT id, kilometraje, transmision, tipo_carroceria, color FROM inventario_autos WHERE id IN (' + ids.map(() => '?').join(',') + ')', ids).catch(() => []);
    const by = new Map(rows.map(r => [Number(r.id), r]));
    return catalogo.map(a => { const r = by.get(Number(a.id)) || {}; const x = Object.assign({}, a, { km: Number(r.kilometraje) || null, transmision: r.transmision || '', tipo_carroceria: r.tipo_carroceria || '', color: r.color || '' }); x.origen = origenDe(x.marca); x.tipo = tipoDe(x); x.nombre = [x.marca, x.modelo, x.anio].filter(Boolean).join(' '); return x; });
}
/** ¿El texto nombra un auto del catálogo? { foco } si es UNO claro; { marcas:[...] } si solo nombró marca(s)/familias con varios. */
function matchCatalogo(texto, cat) {
    const t = ' ' + norm(texto) + ' '; if (!t.trim()) return { foco: null, marcas: [] };
    const anio = (t.match(/\b(20[0-3]\d|19[89]\d)\b/) || [])[1];
    let hits = [];
    for (const a of cat) {
        const tSin = t.replace(/-/g, ''); const modToks = norm(a.modelo).split(' ').filter(w => w.length >= 2 && !GENERICOS.has(w));
        const modHit = modToks.find(w => { const ws = w.replace(/-/g, ''); return (w.length >= 3 && (t.includes(' ' + w + ' ') || tSin.includes(' ' + ws + ' '))) || (w.length >= 4 && (t.includes(w) || tSin.includes(ws))); });
        if (modHit) hits.push({ a, fuerza: 2 + (anio && String(a.anio) === anio ? 1 : 0) });
    }
    if (hits.length) {
        const max = Math.max(...hits.map(h => h.fuerza)); hits = hits.filter(h => h.fuerza === max);
        const distintos = [...new Set(hits.map(h => h.a.nombre))];
        if (hits.length === 1 || distintos.length === 1) return { foco: hits[0].a, marcas: [] };
        return { foco: null, marcas: [], varios: hits.map(h => h.a) };
    }
    const marcas = [...new Set(cat.map(a => norm(a.marca)))].filter(m => m.length >= 3 && t.includes(' ' + m + ' '));
    return { foco: null, marcas };
}
/** Criterios deterministas del texto. */
function parseCriterios(texto, cat) {
    const t = norm(texto); const f = { marcas: [], origen: '', tipo: '', precio_min: 0, precio_max: 0, anio_min: 0, transmision: '' };
    for (const o of Object.keys(ORIGEN)) { const re = { japones: /japon/, coreano: /corean/, americano: /american|gringo/, aleman: /aleman/, europeo: /europe/ }[o]; if (re && re.test(t)) { f.origen = o; break; } }
    if (/\b(pick ?up|pickup|troca|de carga|doble cabina)\b/.test(t)) f.tipo = 'pickup'; else if (/\b(camioneta|suv|crossover|familiar)\b/.test(t)) f.tipo = 'suv'; else if (/\b(hatch|hatchback)\b/.test(t)) f.tipo = 'hatchback'; else if (/\b(sedan|sedán)\b/.test(t)) f.tipo = 'sedan'; else if (/\b(deportivo|coupe)\b/.test(t)) f.tipo = 'deportivo';
    f.marcas = [...new Set(cat.map(a => norm(a.marca)))].filter(m => m.length >= 3 && new RegExp('\\b' + m.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b').test(t));
    const num = s => { const m = String(s).replace(/[,.]/g, ''); let n = Number(m); if (!n) return 0; if (/mil|k\b/.test(s) && n < 10000) n = n * 1000; if (n < 2000 && !/mil|k\b/.test(s)) n = n * 1000; return n; };
    const mMax = t.match(/(?:menos de|hasta|maximo|máximo|no mas de|no más de|tope|presupuesto de|de unos|como)\s*\$?\s*([\d.,]+\s*(?:mil|k)?)/); if (mMax) f.precio_max = num(mMax[1]);
    const mEntre = t.match(/entre\s*\$?\s*([\d.,]+\s*(?:mil|k)?)\s*y\s*\$?\s*([\d.,]+\s*(?:mil|k)?)/); if (mEntre) { f.precio_min = num(mEntre[1]); f.precio_max = num(mEntre[2]); }
    const mMin = t.match(/(?:mas de|más de|arriba de|desde)\s*\$?\s*([\d.,]+\s*(?:mil|k)?)/); if (mMin && !mEntre) f.precio_min = num(mMin[1]);
    if (!f.precio_max && /\b(barato|economico|económico|accesible)\b/.test(t)) { const ps = cat.map(a => Number(a.precio) || 0).filter(Boolean).sort((a, b) => a - b); if (ps.length) f.precio_max = ps[Math.floor((ps.length - 1) / 2)]; }
    const mAnio = t.match(/\b(20[0-3]\d)\b\s*(en adelante|para arriba|o mas|o más|pa arriba)?/); if (mAnio && (mAnio[2] || /del|desde|a partir/.test(t))) f.anio_min = Number(mAnio[1]);
    if (/\b(automatic[oa]|automático|automatica)\b/.test(t)) f.transmision = 'automatica'; else if (/\b(estandar|estándar|manual)\b/.test(t)) f.transmision = 'manual';
    return f;
}
const hayCriterio = f => !!((f.marcas && f.marcas.length) || f.origen || f.tipo || f.precio_min > 0 || f.precio_max > 0 || f.anio_min > 0 || f.transmision);
function filtrar(cat, f) {
    let out = cat;
    if (f.marcas && f.marcas.length) out = out.filter(a => f.marcas.some(m => norm(a.marca) === m || norm(a.marca).startsWith(m)));
    if (f.origen) out = out.filter(a => a.origen.includes(f.origen));
    if (f.tipo) out = out.filter(a => a.tipo === f.tipo);
    if (f.precio_min > 0) out = out.filter(a => Number(a.precio) >= f.precio_min);
    if (f.precio_max > 0) out = out.filter(a => Number(a.precio) <= f.precio_max);
    if (f.anio_min > 0) out = out.filter(a => Number(a.anio) >= f.anio_min);
    if (f.transmision) out = out.filter(a => !a.transmision || norm(a.transmision).startsWith(f.transmision === 'manual' ? 'manual' : 'auto') || (f.transmision === 'manual' && /estandar/.test(norm(a.transmision))));
    return out;
}
/** Haiku SOLO para interpretar criterios que el regex no entendió. Salida forzada. */
async function interpretarIA(texto, cat) {
    const apiKey = process.env.CLAUDE_API_KEY; if (!apiKey) return null;
    const schema = { type: 'object', additionalProperties: false, required: ['descripcion', 'sin_criterio', 'marcas', 'origen', 'tipo', 'precio_min', 'precio_max', 'anio_min', 'transmision'], properties: { descripcion: { type: 'string' }, sin_criterio: { type: 'boolean' }, marcas: { type: 'array', items: { type: 'string' } }, origen: { type: 'string', enum: ['', 'japones', 'coreano', 'americano', 'aleman', 'europeo'] }, tipo: { type: 'string', enum: ['', 'suv', 'sedan', 'pickup', 'hatchback', 'deportivo'] }, precio_min: { type: 'number' }, precio_max: { type: 'number' }, anio_min: { type: 'number' }, transmision: { type: 'string', enum: ['', 'automatica', 'manual'] } } };
    const marcas = [...new Set(cat.map(a => a.marca))].join(', ');
    const sys = 'Lees lo que un comprador contesta cuando un lote de autos le preguntó "¿qué estás buscando?". Devuelve SOLO el JSON. "descripcion": qué pide en 10 palabras. Filtros solo si los dice (marcas tal cual, origen, tipo, precios en pesos con 0 = sin límite, anio_min, transmision). "sin_criterio": true si no dice ningún criterio de auto (saludo, otra cosa, pregunta general). Marcas del lote: ' + marcas + '.';
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: HAIKU, max_tokens: 300, system: sys, messages: [{ role: 'user', content: String(texto).slice(0, 500) }], output_config: { format: { type: 'json_schema', schema } } }), signal: AbortSignal.timeout(12000) });
        const d = await r.json(); if (!r.ok) return null; return JSON.parse(d.content[0].text);
    } catch (e) { return null; }
}
const lista = cars => cars.map((a, i) => (i + 1) + ') ' + a.nombre + ' · ' + fmt(a.precio) + (a.km ? ' · ' + a.km.toLocaleString('es-MX') + ' km' : '')).join('\n');
const ORDINAL = { primero: 1, primera: 1, uno: 1, segundo: 2, segunda: 2, dos: 2, tercero: 3, tercera: 3, tres: 3, cuarto: 4, cuarta: 4, cuatro: 4 };
function eleccion(texto, opciones) {
    const t = norm(texto); let n = 0; const m = t.match(/\b([1-4])\b/); if (m) n = Number(m[1]); else for (const [w, k] of Object.entries(ORDINAL)) if (new RegExp('\\b(el |la )?' + w + '\\b').test(t)) { n = k; break; }
    return n && opciones[n - 1] ? opciones[n - 1] : null;
}
async function leerLote(t, tel) { try { const e = await U.leerEstado(Number(t.id), tel); return { ej: e.ej || {}, lote: (e.ej && e.ej.lote) || {} }; } catch (e) { return { ej: {}, lote: {} }; } }
async function guardarLote(t, tel, ej, lote) { ej.lote = Object.assign({}, lote, { ts: Date.now() }); try { await U.guardarEstado(Number(t.id), tel, { estado_json: ej }); } catch (e) { } }
const esAgenda = texto => /\b(cita|verlo|verla|ir a ver|pasar a ver|visita|visitar|manejarlo|probarlo|ma[ñn]ana|hoy|pasado ma[ñn]ana|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|a las \d|\d\s*(am|pm|hrs)|en la tarde|en la ma[ñn]ana|a qu[eé] hora|horario)\b/i.test(String(texto || ''));

/** TURNO del lote sin foco. Devuelve { segmentos, foco, escalar, motivo }. */
async function turno({ tenant, chat, texto, catalogo }) {
    const m = marcaCorta(tenant); const tel = String(chat.telefono); const cat = await enriquecer(catalogo);
    const { ej, lote } = await leerLote(tenant, tel);
    if (!cat.length) return { segmentos: [], foco: null, escalar: true, motivo: 'lote_sin_autos' };
    // 4) eligió de la lista
    if (lote.fase === 'opciones' && Array.isArray(lote.opciones) && lote.opciones.length) {
        const ops = lote.opciones.map(id => cat.find(a => Number(a.id) === Number(id))).filter(Boolean);
        const el = eleccion(texto, ops); if (el) { await guardarLote(tenant, tel, ej, { fase: 'foco' }); return { segmentos: [], foco: el, escalar: false, motivo: 'eligio_opcion' }; }
    }
    // 1) nombró un auto del catálogo
    const nom = matchCatalogo(texto, cat);
    if (nom.foco) { await guardarLote(tenant, tel, ej, { fase: 'foco' }); return { segmentos: [], foco: nom.foco, escalar: false, motivo: 'nombro_auto' }; }
    // 2) todavía no le hemos preguntado → pregunta
    if (!lote.fase) { await guardarLote(tenant, tel, ej, { fase: 'pregunta', intentos: 0 }); return { segmentos: ['Hola, soy el asistente de ' + m + '. Claro que sí, ¿qué estás buscando? Dime marca, tipo de auto o presupuesto y te digo qué tenemos.'], foco: null, escalar: false, motivo: 'pregunta_busqueda' }; }
    // 3) su respuesta = filtro sobre el inventario del lote
    let f = parseCriterios(texto, cat); let via = 'regex';
    if (nom.varios && nom.varios.length) { f = { marcas: [], origen: '', tipo: '', precio_min: 0, precio_max: 0, anio_min: 0, transmision: '', ids: nom.varios.map(a => Number(a.id)) }; via = 'familia'; }
    if (!hayCriterio(f) && !f.ids) { const ia = await interpretarIA(texto, cat); if (ia && !ia.sin_criterio) { f = { marcas: (ia.marcas || []).map(norm), origen: ia.origen || '', tipo: ia.tipo || '', precio_min: Number(ia.precio_min) || 0, precio_max: Number(ia.precio_max) || 0, anio_min: Number(ia.anio_min) || 0, transmision: ia.transmision || '' }; via = 'ia'; } }
    if (!hayCriterio(f) && !f.ids) {
        const intentos = Number(lote.intentos || 0) + 1;
        if (intentos >= 2) { await guardarLote(tenant, tel, ej, { fase: 'pregunta', intentos }); return { segmentos: [], foco: null, escalar: true, motivo: 'sin_criterio_x2' }; }
        await guardarLote(tenant, tel, ej, { fase: 'pregunta', intentos });
        return { segmentos: ['Para ayudarte bien: ¿buscas alguna marca, un tipo de auto (sedán, camioneta, pickup) o tienes un presupuesto en mente?'], foco: null, escalar: false, motivo: 'repregunta' };
    }
    const sel = (f.ids ? cat.filter(a => f.ids.includes(Number(a.id))) : filtrar(cat, f)).slice().sort((a, b) => Number(a.precio) - Number(b.precio));
    if (!sel.length) { await guardarLote(tenant, tel, ej, { fase: 'pregunta', intentos: 0 }); return { segmentos: ['Por ahora no tengo eso en ' + m + '. Te paso con una persona del lote para que te diga si nos llega algo así.'], foco: null, escalar: true, motivo: 'sin_resultados:' + via }; }
    if (sel.length === 1) { await guardarLote(tenant, tel, ej, { fase: 'foco' }); return { segmentos: ['Tengo justo uno así: ' + sel[0].nombre + ' · ' + fmt(sel[0].precio) + '. Te paso la ficha.'], foco: sel[0], escalar: false, motivo: 'unico:' + via }; }
    const top = sel.slice(0, 4);
    await guardarLote(tenant, tel, ej, { fase: 'opciones', opciones: top.map(a => Number(a.id)), intentos: 0 });
    const cola = sel.length > 4 ? '\nY tengo ' + (sel.length - 4) + ' más. Si me dices marca o presupuesto te afino.' : '';
    return { segmentos: ['Esto es lo que tengo en ' + m + ':\n' + lista(top) + cola, '¿Cuál te interesa? Dime el número.'], foco: null, escalar: false, motivo: 'opciones:' + sel.length + ':' + via };
}
/** CITA: ¿queda claro de qué auto es? Si el chat ya tuvo ≥2 autos en foco y el mensaje no nombra ninguno → hay que preguntar. */
async function autosDelChat(chatId) {
    const r = await query('SELECT auto_id, MIN(id) primero FROM delegaciones WHERE chat_id = ? AND auto_id IS NOT NULL GROUP BY auto_id ORDER BY primero ASC', [Number(chatId)]).catch(() => []);   // en el orden en que el comprador los fue viendo
    return r.map(x => Number(x.auto_id)).filter(Boolean);
}
module.exports = { eleccion, marcaCorta, identidad, enriquecer, matchCatalogo, parseCriterios, filtrar, turno, esAgenda, autosDelChat, leerLote, guardarLote, fmt };
