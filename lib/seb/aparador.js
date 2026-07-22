// lib/seb/aparador.js — ARRANQUE DE CARRUSEL + AUTO EN FOCO (orden owner 2026-07-20)
//
// El principio (prompt del owner): Haiku entiende, el CÓDIGO decide y ejecuta
// leyendo Turso — Haiku jamás inventa datos: autos, precios y km salen de la base.
//
// Piezas (todas deterministas salvo los dos ojos Haiku, con salida forzada):
//   espiarVision(url)        → abre el link del anuncio como lo haría el owner:
//                              og:description (texto de la tarjeta) + og:image
//                              bajada en bytes y entregada a Haiku VISIÓN (la
//                              referencia directa la bloquea robots.txt de FB).
//                              Cacheado por URL en ad_espia (columna vision).
//   identificarAncla(...)    → cruza TEXTO + VISIÓN contra el inventario. Solo
//                              si las señales no se contradicen hay ancla (lección
//                              Daniel: jamás afirmar la portada).
//   armarAparador(...)       → 2 portadas con ficha breve + hasta 4 en texto +
//                              invitación a elegir. Datos 100% de Turso.
//   parsearCriterio(texto)   → "algo de 70 mil de enganche"/"una camioneta" →
//                              filtro (Haiku schema chico + validación de código).
//   resolverEleccion(...)    → SOLO contra los autos del aparador mostrado:
//                              número / nombre / color. Único o pregunta.
//   autosRelacionados(...)   → SOLO si lo piden explícito. Filtro duro 0.85–1.20x
//                              precio; ranking carrocería+50, año±3+20, precio+15,
//                              marca+15; hasta 5.

const { query, run } = require('./db.js');

const HAIKU = 'claude-haiku-4-5';
const UA_FB = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const normz = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

async function haiku(system, schema, content, maxTokens) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return null;
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
                model: HAIKU, max_tokens: maxTokens || 300, system,
                messages: [{ role: 'user', content }],
                output_config: { format: { type: 'json_schema', schema } }
            })
        });
        if (!r.ok) return null;
        const d = await r.json();
        return JSON.parse((d.content || []).find(b => b.type === 'text').text);
    } catch (e) { return null; }
}

// ── inventario activo con su nombre armado (helper compartido) ──
async function inventarioActivo() {
    const rows = await query("SELECT id, fyradrive_web_id, marca, modelo, version, anio, precio, kilometraje, color, tipo_carroceria, sb_convs_count, created_at FROM inventario_autos WHERE estado='activo'");
    return rows.map(a => ({ ...a, nombre: [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' ') }));
}

// ── portada (foto principal) por auto — imagenes_autos vía fyradrive_web_id ──
async function portadaDe(webId) {
    if (!webId) return null;
    const r = await query("SELECT url_imagen FROM imagenes_autos WHERE auto_id=? ORDER BY es_principal DESC, orden_imagen ASC LIMIT 1", [webId]).catch(() => []);
    return r.length ? r[0].url_imagen : null;
}

// ══ EL OJO: abre el link del anuncio y lo entiende (texto + visión) ══
async function espiarVision(url) {
    await run("CREATE TABLE IF NOT EXISTS ad_espia (url TEXT PRIMARY KEY, texto TEXT, created INTEGER)").catch(() => { });
    try { await run("ALTER TABLE ad_espia ADD COLUMN vision TEXT"); } catch (e) { }
    const cached = await query("SELECT texto, vision, created FROM ad_espia WHERE url=?", [url]).catch(() => []);
    if (cached.length && cached[0].vision) {
        try { return { texto: cached[0].texto || null, vision: JSON.parse(cached[0].vision) }; } catch (e) { }
    }
    let texto = cached.length ? (cached[0].texto || null) : null, vision = null, imgUrl = null;
    try {
        const r = await fetch(url, { headers: { 'User-Agent': UA_FB, 'Accept': 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(9000) });
        const html = (await r.text()).slice(0, 600000);
        const og = p => {
            const m = html.match(new RegExp('<meta[^>]+(?:property|name)="' + p + '"[^>]+content="([^"]*)"'))
                || html.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="' + p + '"'));
            return m ? m[1].replace(/&amp;/g, '&').replace(/&#(\d+);/g, (x, n) => String.fromCharCode(Number(n))).trim() : null;
        };
        const tit = og('og:title'), desc = og('og:description');
        const partes = [tit, desc].filter(x => x && !/^(facebook|instagram|log in|iniciar sesi)/i.test(x));
        if (partes.length) texto = partes.join(' | ');
        imgUrl = og('og:image');
    } catch (e) { }
    // VISIÓN: bajar los bytes (puro acarreo — la referencia directa la bloquea FB) → Haiku
    if (imgUrl) {
        try {
            const ir = await fetch(imgUrl, { headers: { 'User-Agent': UA_FB }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
            if (ir.ok) {
                const mime = (ir.headers.get('content-type') || 'image/jpeg').split(';')[0];
                const b64 = Buffer.from(await ir.arrayBuffer()).toString('base64');
                if (b64.length > 2000) {
                    vision = await haiku(
                        'Identificas autos en fotos de anuncios. PRIMERO describe qué ves, LUEGO identifica. Si la imagen no trae auto (logo, genérico), todo null. Responde SOLO el JSON.',
                        { type: 'object', properties: { descripcion: { type: 'string' }, marca: { type: ['string', 'null'] }, modelo: { type: ['string', 'null'] }, anio: { type: ['integer', 'null'] }, color: { type: ['string', 'null'] } }, required: ['descripcion', 'marca', 'modelo', 'anio', 'color'], additionalProperties: false },
                        [{ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } }, { type: 'text', text: 'Identifica el auto del anuncio (marca, modelo, año aproximado, color). Si la imagen trae texto con datos, úsalo.' }],
                        250);
                }
            }
        } catch (e) { }
    }
    await run("INSERT INTO ad_espia (url, texto, vision, created) VALUES (?,?,?,?) ON CONFLICT(url) DO UPDATE SET texto=COALESCE(excluded.texto, ad_espia.texto), vision=excluded.vision, created=excluded.created",
        [url, texto || '', vision ? JSON.stringify(vision) : null, Date.now()]).catch(() => { });
    return { texto, vision };
}

// match de una señal {marca, modelo, anio} contra inventario — único o nada
function matchSenal(sen, autos) {
    if (!sen || (!sen.marca && !sen.modelo)) return null;
    const t = normz([sen.marca, sen.modelo].filter(Boolean).join(' '));
    const cands = [];
    for (const a of autos) {
        const toks = normz(a.nombre).split(/\s+/).filter(w => (w.length >= 3 || /[a-z]\d|\d[a-z]/.test(w)) && !/^\d+$/.test(w));
        const hits = toks.filter(tok => t.includes(tok)).length;
        if (!hits) continue;
        if (sen.anio && a.anio && Math.abs(Number(a.anio) - Number(sen.anio)) > 1) continue;   // visión aproxima el año → ±1
        cands.push({ a, hits });
    }
    if (!cands.length) return null;
    // LA MARCA MANDA (caso Mazda vs Accord Touring): si la señal empieza con una
    // marca, los candidatos de ESA marca eliminan a los demás antes del desempate
    const marcaTok = t.split(/\s+/)[0];
    const conMarca = marcaTok && marcaTok.length >= 3 ? cands.filter(c => normz(c.a.marca || '') === marcaTok || normz(c.a.nombre).split(/\s+/)[0] === marcaTok) : [];
    const posibles = conMarca.length ? conMarca : cands;
    const top = Math.max(...posibles.map(c => c.hits));
    const tops = posibles.filter(c => c.hits === top).map(c => c.a);
    return tops.length === 1 ? tops[0] : null;
}

// texto de tarjeta og ("Fyradrive | Mazda 3 i Touring 2018 $220,000") → señal.
// La tarjeta es el SEGMENTO con año o precio — no el primero ciego (el og:title
// suele ser la marca "Fyradrive" y rompía la señal).
function senalDeTexto(texto) {
    if (!texto) return null;
    const partes = String(texto).split('|').map(s => s.trim()).filter(Boolean);
    const linea = partes.find(p => /\b(19|20)\d{2}\b/.test(p) || /\$\s?\d/.test(p));
    if (!linea) return null;
    const anio = (linea.match(/\b(19|20)\d{2}\b/) || [])[0];
    return { marca: linea, modelo: null, anio: anio ? Number(anio) : null };
}

// ══ EL ANCLA: cruza texto + visión contra inventario; contradicción = sin ancla ══
async function identificarAncla(urlAd, autos) {
    if (!urlAd) return { ancla: null, via: 'sin_link' };
    const esp = await espiarVision(urlAd);
    const mTxt = matchSenal(senalDeTexto(esp.texto), autos);
    const mVis = esp.vision ? matchSenal(esp.vision, autos) : null;
    if (mTxt && mVis) {
        if (mTxt.id === mVis.id) return { ancla: mTxt, via: 'texto+vision' };
        return { ancla: null, via: 'contradiccion', candidatos: [mTxt, mVis] };   // jamás afirmar
    }
    if (mTxt) return { ancla: mTxt, via: 'texto' };
    if (mVis) return { ancla: mVis, via: 'vision' };
    return { ancla: null, via: 'sin_senal' };
}

// ══ CRITERIO: "algo de 70 mil de enganche", "una camioneta" → filtro ══
async function parsearCriterio(texto) {
    // Paso 0 determinista: señales claras sin IA
    const t = normz(texto);
    const out = {};
    const mEng = t.match(/(\d[\d.,]*)\s*(mil)?\s*(de\s*)?enganche/);
    if (mEng) { let v = Number(mEng[1].replace(/[.,]/g, '')); if (mEng[2] || v < 1000) v *= 1000; out.enganche = v; }
    // CATEGORÍA (filtro del Sales Brain) — la pickup manda sobre "camioneta"
    if (/pick ?up|troca|de batea|doble cabina/.test(t)) out.categoria = 'pickup';
    else if (/camioneta|suv|familiar|todo terreno/.test(t)) out.categoria = 'suv';
    else if (/deportivo|coupe|coup[eé]/.test(t)) out.categoria = 'deportivo';
    else if (/sed[aá]n|compacto|autom[oó]vil chico/.test(t)) out.categoria = 'sedan';
    else if (/razer|utv|can-?am/.test(t)) out.categoria = 'utv';
    if (/hatchback/.test(t)) out.tipo = 'hatchback';
    const mPres = t.match(/(?:de|hasta|menos de|m[aá]ximo|un presupuesto de)\s*(\d[\d.,]*)\s*(mil)?(?!\s*(km|kil[oó]))/);
    if (!out.enganche && mPres) { let v = Number(mPres[1].replace(/[.,]/g, '')); if (mPres[2] || v < 1000) v *= 1000; if (v >= 50000) out.presupuesto = v; }
    if (Object.keys(out).length) return out;
    // ¿trae criterio que el regex no cachó? Haiku con schema chico (solo si suena a búsqueda)
    if (!/busco|quisiera|algo|econ[oó]mic|barat|que tengan|recomien/.test(t)) return null;
    const h = await haiku(
        'Extraes el CRITERIO de búsqueda de un comprador de autos usados (México). Solo lo que diga: no inventes. enganche/presupuesto en pesos completos. tipo: camioneta|sedan|hatchback|null. Responde SOLO el JSON.',
        { type: 'object', properties: { enganche: { type: ['integer', 'null'] }, presupuesto: { type: ['integer', 'null'] }, tipo: { type: ['string', 'null'] }, marca: { type: ['string', 'null'] } }, required: ['enganche', 'presupuesto', 'tipo', 'marca'], additionalProperties: false },
        String(texto).slice(0, 300), 150);
    if (!h) return null;
    const o = {};
    if (h.enganche && h.enganche >= 5000) o.enganche = h.enganche;
    if (h.presupuesto && h.presupuesto >= 50000) o.presupuesto = h.presupuesto;
    if (h.tipo) {
        const tn = normz(h.tipo);
        o.categoria = tn === 'camioneta' ? 'suv' : (['sedan', 'pickup', 'suv', 'deportivo'].includes(tn) ? tn : null);
        if (!o.categoria) { delete o.categoria; o.tipo = tn; }
    }
    if (h.marca) o.marca = normz(h.marca);
    return Object.keys(o).length ? o : null;
}

function buscarInventario(criterio, autos) {
    let res = autos.slice();
    // enganche ≈ 15-20% → presupuesto máximo aproximado (regla de código, conservadora)
    const tope = criterio.presupuesto || (criterio.enganche ? criterio.enganche * 6 : null);
    // tope INCLUSIVO con margen chico (orden owner: "menos de 250" DEBE incluir los de
    // $250,000 exactos — Attitude 2024/Yaris 2022 — y como principales)
    if (tope) res = res.filter(a => Number(a.precio || 0) > 0 && Number(a.precio) <= tope * 1.015);
    // CATEGORÍA = filtro duro del Sales Brain (sedan | pickup | suv | deportivo | utv)
    const cat = criterio.categoria || (criterio.tipo === 'camioneta' ? 'suv' : criterio.tipo);
    if (cat === 'suv') res = res.filter(a => ['suv', 'pickup'].includes(categoriaDe(a)));   // "camioneta" abarca ambas
    else if (cat === 'pickup') res = res.filter(a => categoriaDe(a) === 'pickup');
    else if (cat) res = res.filter(a => categoriaDe(a) === cat);
    if (criterio.marca) res = res.filter(a => normz(a.nombre).includes(criterio.marca));
    // año pedido = filtro DURO (compradores-reales #5: "modelo a partir de 2022")
    if (criterio.anio_min) res = res.filter(a => Number(a.anio || 0) >= Number(criterio.anio_min));
    if (criterio.anio_max) res = res.filter(a => Number(a.anio || 0) > 0 && Number(a.anio) <= Number(criterio.anio_max));
    // con TOPE de presupuesto los PRINCIPALES son los más cercanos al presupuesto
    // (el mejor auto que le alcanza); sin tope, del más barato al más caro
    if (tope) res.sort((x, y) => Number(y.precio || 0) - Number(x.precio || 0));
    else res.sort((x, y) => Number(x.precio || 0) - Number(y.precio || 0));
    return res;
}

// ── LA FRASE CON CONTEO (orden owner): "de pickups tenemos estas dos" / "tenemos
// 8 sedanes, estos son los que más jalan" — natural, con el número real ──
const NUM_ES = { 1: 'una', 2: 'dos', 3: 'tres', 4: 'cuatro', 5: 'cinco', 6: 'seis', 7: 'siete', 8: 'ocho', 9: 'nueve', 10: 'diez' };
function fraseConteo(categoria, n, conPrecio, nombre) {
    const C = CATEGORIAS[categoria];
    const nm = nombre ? ' ' + nombre : '';
    if (!C) return conPrecio ? `Va${nm}, con eso que me dices estas te van 🚗` : `Claro${nm}, mira, estas son buenas oportunidades 🚗`;
    if (n === 1) return conPrecio ? `Va${nm}, con eso que me dices ${C.un === 'esta' ? 'esta' : 'este'} es ${C.un === 'esta' ? 'la que' : 'el que'} te acomoda:` : `De ${C.plural} ahorita tengo ${C.un === 'esta' ? 'esta' : 'este'}:`;
    if (n <= 3) return conPrecio ? `Va${nm}, con eso que me dices ${C.art} ${NUM_ES[n]} te van:` : `De ${C.plural} tenemos ${C.art} ${NUM_ES[n]}:`;
    if (conPrecio) return `Va${nm}, con eso que me dices ${C.art} ${C.plural} te van:`;
    return `Tenemos ${n} ${C.plural} ahorita, ${C.art} son ${C.det} que más están jalando:`;
}

// ── el encabezado de una lista de familia: si pidió un AÑO que no tenemos, se dice
// honesto ANTES de enseñar lo que sí hay (owner 2026-07-21) ──
function introFamilia(texto, cands) {
    const anio = (String(texto || '').match(/\b(19|20)\d{2}\b/) || [])[0];
    if (anio && !cands.some(c => String(c.nombre || '').includes(anio))) {
        const marca = cands.length ? String(cands[0].nombre || '').split(/\s+/)[0] : '';
        return `De ${marca} ${anio} ahorita no tengo 🙏 pero mira ${cands.length === 1 ? 'el que' : 'los que'} sí tenemos:`;
    }
    return 'Claro, de esos tenemos estos disponibles:';
}

// ── ¿pidió una marca/modelo que NO tenemos? (owner 2026-07-21: "ando buscando una
// Hilux / un Tesla" → jamás enseñar la lista genérica como si nada: se dice honesto
// y se convierte con lo que sí hay) ──
const MARCAS_CONOCIDAS = /\b(toyota|honda|nissan|mazda|chevrolet|ford|dodge|ram|jeep|volkswagen|vw|audi|bmw|mercedes|kia|hyundai|mitsubishi|renault|peugeot|seat|suzuki|subaru|fiat|tesla|porsche|lexus|volvo|acura|infiniti|mini|jac|chirey|byd|mg\b|gwm|haval|changan|omoda|jetour|baic|hummer|cadillac|lincoln|buick|gmc|land rover|jaguar|alfa)\b/;
const MODELOS_CONOCIDOS = /\b(hilux|ranger|frontier|np ?300|amarok|corolla|jetta|versa|march|aveo|spark|beat|kwid|sandero|logan|civic|accord|altima|camry|elantra|sonata|rio|forte|polo|virtus|taos|nivus|model [3ysx]|cybertruck|cr-?v|rav ?4|tucson|kicks|swift|vitara|ignis)\b/;
function categoriaTexto(texto) {
    const t = normz(texto);
    if (RE_UTV.test(t)) return 'utv';
    if (RE_PICKUP.test(t)) return 'pickup';
    if (RE_SUV.test(t)) return 'suv';
    if (RE_DEPORTIVO.test(t)) return 'deportivo';
    if (/pick ?up|troca|de batea/.test(t)) return 'pickup';
    if (/camioneta|suv|familiar/.test(t)) return 'suv';
    if (/sed[aá]n|compacto/.test(t)) return 'sedan';
    return null;
}
function pedidoFueraDeInventario(texto, autos) {
    const t = normz(texto);
    const tokens = [];
    const mMarca = t.match(MARCAS_CONOCIDAS); if (mMarca) tokens.push(mMarca[0].trim());
    const mModelo = t.match(MODELOS_CONOCIDOS); if (mModelo) tokens.push(mModelo[0].trim());
    if (!tokens.length) return null;
    // si CUALQUIER token pedido sí existe en inventario → no es puente (flujo normal)
    for (const tk of tokens) if (autos.some(a => normz(a.nombre).includes(tk))) return null;
    const anio = Number((t.match(/\b(19|20)\d{2}\b/) || [])[0]) || null;
    const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
    return { marca: tokens[0], anio, categoria: categoriaTexto(t), etiqueta: tokens.map(cap).join(' ') + (anio ? ' ' + anio : '') };
}

// ══ EL PUENTE DE CONVERSIÓN (orden owner 2026-07-21): "ando buscando un Audi 2024"
// y no tenemos → NO se pierde la venta ni se miente: se dice honesto que de ESO no
// hay, y se le enseña lo que SÍ tenemos en su mismo mundo. La regla: misma
// CATEGORÍA (+35), AÑO cercano ±2 (+30), premium↔premium (+20), dentro de su
// presupuesto (+15). Umbral 40 — si nada llega, no se rellena: se escala.
function puenteDeConversion({ marca, anio, categoria, presupuesto, autos }) {
    const mk = normz(marca || '');
    const premiumPedido = mk && MARCAS_PREMIUM.test(mk);
    const cands = autos.slice();
    const score = a => {
        let s = 20;                                            // base: es de nuestro inventario
        // MISMA MARCA, otro año = el mejor puente ("de Audi 2024 no, pero mira el A5 2025")
        if (mk && normz(a.nombre).includes(mk)) s += 25;
        if (categoria && categoriaDe(a) === categoria) s += 35;
        else if (categoria) s -= 20;
        if (anio && a.anio) {
            const d = Math.abs(Number(a.anio) - Number(anio));
            s += d <= 2 ? 30 * (1 - d / 3) : -10;
        }
        const premiumAuto = MARCAS_PREMIUM.test(normz(a.marca || ''));
        if (premiumPedido) s += premiumAuto ? 20 : -25;         // Audi ↔ Mercedes, no ↔ Onix
        else if (premiumAuto) s -= 5;
        if (presupuesto && Number(a.precio || 0) > 0) s += Number(a.precio) <= presupuesto ? 15 : -30;
        s += Math.min(5, Number(a.sb_convs_count || 0));
        return s;
    };
    return cands.map(a => ({ a, s: score(a) })).filter(x => x.s >= 40).sort((x, y) => y.s - x.s).slice(0, 4).map(x => x.a);
}

// ══ EL APARADOR: 2 con portada + hasta 4 en texto + invitación (datos de Turso) ══
const fmt = n => '$' + Number(n || 0).toLocaleString('es-MX');
const fkm = n => n ? Number(n).toLocaleString('es-MX') + ' km' : '';
function fichaBreve(a) { return `${a.nombre} — ${fmt(a.precio)}${a.kilometraje ? ' · ' + fkm(a.kilometraje) : ''}`; }

// ── UBICACIONES AGRUPADAS (orden owner 2026-07-21): mismo punto → se redacta como
// UNO ("Los dos los tenemos en X") y la agenda va DIRECTA; puntos distintos → una
// línea por auto y se pregunta cuál le queda mejor ──
async function redactarUbicaciones(rows) {
    const conPunto = [];
    for (const r of rows) conPunto.push({ r, p: await puntoHablado(r.id) });
    const puntos = [...new Set(conPunto.map(x => x.p).filter(Boolean))];
    if (puntos.length === 1 && conPunto.every(x => x.p)) {
        return {
            mismo: true,
            segmentos: [rows.length === 1 ? `Lo tenemos en ${puntos[0]}, para que lo veas cuando gustes` : `Los ${rows.length === 2 ? 'dos' : rows.length} los tenemos en ${puntos[0]}`],
            gancho: '¿Qué día te queda bien para venir? Los ves ahí mismo y ya decides'
        };
    }
    return {
        mismo: false,
        segmentos: conPunto.map(x => `El ${x.r.nombre} lo tenemos en ${x.p || 'nuestro punto de venta'}`),
        gancho: '¿Cuál te queda mejor para ir a verlo?'
    };
}

// ── LA DESCRIPCIÓN del auto (orden owner 2026-07-21: al asumir el auto se manda
// su descripción) — mismos datos que la ficha del Sales Brain, compacta para WA ──
async function descripcionDe(auto) {
    let w = null;
    try {
        const r = await query('SELECT kilometraje, tipo_combustible, transmision, color, motor, numero_duenos, factura_original FROM autos WHERE id=?', [Number(auto.fyradrive_web_id || auto.web_id || 0)]);
        w = r[0] || null;
    } catch (e) { }
    const fmtDuenos = d => ({ unico_dueno: 'Único dueño', unico: 'Único dueño', dos: '2 dueños', tres: '3 dueños' }[String(d || '')] || null);
    const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
    const L = [`🚗 ${auto.nombre}`];
    if (auto.precio) L.push(`💰 ${fmt(auto.precio)}`);
    L.push('✅ Verificado — inspección mecánica y legal');
    const car = [];
    const km = (w && w.kilometraje) || auto.kilometraje;
    if (km) car.push(`🔵 ${Number(km).toLocaleString('es-MX')} km`);
    const tr = (w && w.transmision) || auto.transmision;
    const comb = w && w.tipo_combustible;
    if (tr || comb) car.push('🔵 ' + [tr, comb].filter(Boolean).map(cap).join(' · '));
    const col = (w && w.color) || auto.color;
    if (col && normz(col) !== 'no especificado') car.push(`🔵 Color ${cap(col)}`);
    if (w && fmtDuenos(w.numero_duenos)) car.push('🔵 ' + fmtDuenos(w.numero_duenos));
    if (w && w.factura_original && /si|s[ií]|original|agencia/i.test(String(w.factura_original))) car.push('🔵 Factura original');
    if (car.length) { L.push(''); L.push('CARACTERÍSTICAS'); car.forEach(x => L.push(x)); }
    return L.join('\n');
}

// ── FICHA EXTENSA (orden owner 2026-07-21: "la info más extensita — km, dueños,
// factura, motor") — una línea rica por auto para los machotes de varios autos ──
async function fichaExtensa(a) {
    let w = null;
    try {
        const r = await query('SELECT kilometraje, transmision, numero_duenos, factura_original, motor FROM autos WHERE id=?', [Number(a.fyradrive_web_id || 0)]);
        w = r[0] || null;
    } catch (e) { }
    const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
    const detalles = [];
    const km = (w && w.kilometraje) || a.kilometraje;
    if (km) detalles.push(Number(km).toLocaleString('es-MX') + ' km');
    const tr = (w && w.transmision) || a.transmision;
    if (tr && !/no especificado|n\/?a|sin especificar/i.test(String(tr))) detalles.push(cap(String(tr)));
    const du = w && ({ unico_dueno: 'Único dueño', unico: 'Único dueño', dos: '2 dueños', tres: '3 dueños' }[String(w.numero_duenos || '')]);
    if (du) detalles.push(du);
    if (w && w.factura_original && /si|s[ií]|original|agencia/i.test(String(w.factura_original))) detalles.push('Factura original');
    if (w && w.motor && !/no especificado|n\/?a|sin especificar|^-$/i.test(String(w.motor).trim())) detalles.push('Motor ' + String(w.motor).slice(0, 20));
    return `${a.nombre} — ${fmt(a.precio)}` + (detalles.length ? '\n' + detalles.join(' · ') : '');
}

// ── N fotos del auto (imagenes_autos por web_id; principal primero) ──
async function fotosAuto(webId, n) {
    if (!webId) return [];
    const r = await query('SELECT url_imagen FROM imagenes_autos WHERE auto_id=? ORDER BY es_principal DESC, orden_imagen ASC LIMIT ' + Number(n || 2), [Number(webId)]).catch(() => []);
    return r.map(x => x.url_imagen).filter(Boolean);
}

async function armarAparador({ ancla, lista, saludoNombre, intro, max, nFotos, ordenDado }) {
    // orden: ancla primero; después la lista — si viene YA ordenada (similitud/precio)
    // se respeta (ordenDado); si no, "mejores oportunidades" (sb_convs_count + nuevas)
    const pool = ordenDado ? (lista || []).slice() : (lista || []).slice().sort((x, y) => (Number(y.sb_convs_count || 0) - Number(x.sb_convs_count || 0)) || (Number(y.created_at || 0) - Number(x.created_at || 0)));
    const sel = [];
    if (ancla) sel.push(ancla);
    for (const a of pool) { if (sel.length >= (max || 6)) break; if (!sel.some(s => s.id === a.id)) sel.push(a); }
    if (!sel.length) return null;
    const conFoto = sel.slice(0, nFotos || 2), enTexto = sel.slice(2);
    const fotos = [];
    for (const a of conFoto) { const p = await portadaDe(a.fyradrive_web_id); if (p) fotos.push(p); }
    const lineas = sel.map((a, i) => `${i + 1}) ${fichaBreve(a)}`);
    const segmentos = [];
    segmentos.push(intro || `¡Qué tal${saludoNombre ? ' ' + saludoNombre : ''}! Estos son los que más están jalando ahorita 🚗`);
    segmentos.push(lineas.join('\n'));
    segmentos.push('¿Cuál te late para mandarte todo a detalle?');
    return {
        segmentos, fotos: fotos.length ? fotos : null, fotos_after_index: 0,
        aparador: sel.map((a, i) => ({ n: i + 1, id: a.id, web_id: a.fyradrive_web_id, nombre: a.nombre, color: normz(a.color || '') }))
    };
}

// ══ LA ELECCIÓN: SOLO contra el aparador mostrado — número, nombre o color ══
function resolverEleccion(texto, aparador, ancla) {
    const t = normz(texto);
    if (!Array.isArray(aparador) || !aparador.length) return null;
    // número ("2", "el 2", "la 3", "opcion 2")
    const mNum = t.match(/(?:^|\b(?:el|la|opci[oó]n|n[uú]mero)\s*)([1-6])\b/);
    if (mNum) { const it = aparador.find(x => x.n === Number(mNum[1])); if (it) return { auto: it, via: 'numero' }; }
    // "ese"/"el primero" con ancla mostrada
    if (/^(ese|esa|este|esta|el primero|la primera)[.!\s]*$/.test(t) && aparador[0]) return { auto: aparador[0], via: 'primero' };
    // AÑO como hecho duro (caso owner 2026-07-20: contestó "2018" a la pregunta):
    // si el año que dijo solo vive en UN auto de lo mostrado, ese es.
    const anioTx = (t.match(/\b(19|20)\d{2}\b/) || [])[0];
    const porAnio = anioTx ? aparador.filter(x => normz(x.nombre).includes(anioTx)) : [];
    if (anioTx && porAnio.length === 1) return { auto: porAnio[0], via: 'anio' };
    // nombre: tokens contra SOLO los del aparador. Los números CORTOS de modelo
    // ("Mazda 3", "Mazda 2") SÍ cuentan — como palabra completa (\b3\b), para que
    // "el mazda 3" distinga del CX-5 sin que un "2021" dispare falsos
    const cands = [];
    for (const it of aparador) {
        const toks = normz(it.nombre).split(/\s+/).filter(w => ((w.length >= 3 || /[a-z]\d|\d[a-z]/.test(w)) && !/^\d+$/.test(w)) || /^\d{1,2}$/.test(w));
        const matched = toks.filter(tok => /^\d{1,2}$/.test(tok) ? new RegExp('\\b' + tok + '\\b').test(t) : t.includes(tok));
        if (anioTx && !normz(it.nombre).includes(anioTx)) continue;
        // un número suelto NO basta ("tesla model 3" no es "Mazda 3"): exige que al
        // menos un token de LETRAS del nombre también aparezca
        if (!matched.some(x => !/^\d{1,2}$/.test(x))) continue;
        if (matched.length) cands.push({ it, hits: matched.length, matched });
    }
    if (cands.length) {
        const top = Math.max(...cands.map(c => c.hits));
        const tops = cands.filter(c => c.hits === top);
        if (tops.length === 1) return { auto: tops[0].it, via: 'nombre' };
        if (tops.length > 1) {
            // La pregunta SOLO entre los que de verdad están empatados (orden owner
            // 2026-07-20, caso "Yaris y mazda"): los que comparten token entre sí son la
            // familia ambigua; el que matcheó por token propio YA se entendió y jamás
            // entra a la pregunta (queda como interés aparte).
            const comparte = c => tops.some(o => o !== c && o.matched.some(tok => c.matched.includes(tok)));
            const ambiguos = tops.filter(comparte), claros = tops.filter(c => !comparte(c));
            if (ambiguos.length > 1) return { pregunta: ambiguos.slice(0, 4).map(c => c.it), via: 'nombre_ambiguo', claros: claros.map(c => c.it) };
            return { pregunta: tops.slice(0, 4).map(c => c.it), via: 'nombre_ambiguo' };
        }
    }
    // año que empata a varios y nada más lo desempató → pregunta entre ESOS
    if (anioTx && porAnio.length > 1) return { pregunta: porAnio.slice(0, 4), via: 'anio_ambiguo' };
    // color ("el rojo") contra los colores del aparador
    const COLORES = ['rojo', 'roja', 'blanco', 'blanca', 'negro', 'negra', 'gris', 'plata', 'azul', 'verde', 'cafe', 'beige', 'arena', 'vino'];
    const col = COLORES.find(c => new RegExp('\\b(el|la)?\\s*' + c + '\\b').test(t));
    if (col) {
        const base = col.replace(/a$/, 'o');
        const m = aparador.filter(x => x.color && (x.color.includes(col) || x.color.includes(base)));
        if (m.length === 1) return { auto: m[0], via: 'color' };
        if (m.length > 1) return { pregunta: m.slice(0, 3), via: 'color_ambiguo' };
    }
    return null;
}

// ══ LA FÓRMULA DE SIMILITUD (owner 2026-07-21): "niveles de similitud en la decisión".
// El instinto formulizado: la CARTERA manda (precio, hasta 40 pts), luego la INTENCIÓN
// (carrocería, 30), el AÑO (hasta 20) y la MARCA (10). CORTE DE CALIDAD: si un auto no
// llega al umbral, NI SE MANDA ("si a partir del 4to ya no son similares, ni los mandes").
// la CARROCERÍA REAL del auto: el campo de la base, y si viene vacío se deduce del
// modelo (el instinto del owner: "el City Touring va con el Yaris" — ambos sedán
// comercial aunque la ficha no lo diga)
// ══ CATEGORÍA DEL AUTO (orden owner 2026-07-21) — filtros del Sales Brain.
// ⚠️ EL MODELO MANDA, el campo tipo_carroceria es SOLO respaldo: la base viene
// sucia (Tahoe y Suburban 2020 marcadas "pickup", Wrangler "sedan", Can-Am
// "sedan", 18 autos vacíos). Un Tacoma jamás debe salir en "sedanes".
const RE_UTV = /(can-?am|maverick x3|rzr|razer|polaris|side by side)/;
const RE_PICKUP = /(tacoma|tundra|hilux|ranger|lobo|f-?150|f-?250|f-?350|silverado|cheyenne|colorado|s-?10|\bram\b|bighorn|\btrx\b|frontier|np ?300|titan|l ?200|oroch|amarok|gladiator|mojave|ridgeline|canyon|sierra|d-?max|bt-?50|saveiro|montana|ford maverick)/;
const RE_SUV = /(suburban|tahoe|yukon|escalade|navigator|expedition|explorer|edge|escape|bronco|equinox|traverse|blazer|trax|tracker|captiva|cr-?v|hr-?v|pilot|passport|odyssey|rav ?4|4runner|highlander|sequoia|land cruiser|prado|sienna|c-?hr|corolla cross|venza|cx-?[3579]0?|tucson|santa fe|creta|kona|palisade|sportage|sorento|seltos|carnival|kicks|x-?trail|murano|pathfinder|armada|patrol|qashqai|juke|rogue|cherokee|wrangler|compass|renegade|durango|journey|tiguan|teramont|touareg|t-?cross|taos|nivus|q[2-8]\b|x[1-7]\b|gl[abces]\b|macan|cayenne|countryman|outlander|montero|eclipse cross|asx|forester|outback|crosstrek|duster|captur|koleos|stepway|ecosport|territory|terrain|acadia|encore|trailblazer)/;
const RE_DEPORTIVO = /(mustang|camaro|challenger|corvette|supra|gt-?r\b|370z|350z|\bbrz\b|gr ?86|miata|mx-?5|boxster|cayman|\b911\b|amg gt|\bm[2-5]\b|type r|\bgti\b|golf r|\bsti\b|\bwrx\b|abarth|veloster|rs[3-7]\b)/;
const CATEGORIAS = {
    sedan: { plural: 'sedanes', art: 'estos', un: 'este', det: 'los' },
    pickup: { plural: 'pickups', art: 'estas', un: 'esta', det: 'las' },
    suv: { plural: 'camionetas', art: 'estas', un: 'esta', det: 'las' },
    deportivo: { plural: 'deportivos', art: 'estos', un: 'este', det: 'los' },
    utv: { plural: 'UTVs', art: 'estos', un: 'este', det: 'los' }
};
function categoriaDe(a) {
    const n = normz(a.nombre || [a.marca, a.modelo, a.version].filter(Boolean).join(' '));
    if (RE_UTV.test(n)) return 'utv';
    if (RE_PICKUP.test(n)) return 'pickup';
    if (RE_SUV.test(n)) return 'suv';
    if (RE_DEPORTIVO.test(n)) return 'deportivo';
    const c = normz(a.tipo_carroceria || '');            // respaldo, solo si el modelo no dijo
    if (/pick/.test(c)) return 'pickup';
    if (/suv|camioneta/.test(c)) return 'suv';
    if (/sedan|hatch|coupe|berlina/.test(c)) return 'sedan';
    return 'sedan';                                       // todo nuestro inventario son autos
}
// para la similitud: sedán vs camioneta/pickup (compat con la fórmula anterior)
function carroceriaDe(a) {
    const cat = categoriaDe(a);
    return (cat === 'pickup' || cat === 'suv') ? 'camioneta' : (cat === 'utv' ? 'utv' : 'sedan');
}
// marcas premium — para el PUENTE DE CONVERSIÓN (Audi ↔ Mercedes/BMW, no ↔ Onix)
const MARCAS_PREMIUM = /(audi|bmw|mercedes|lexus|porsche|jaguar|land rover|range rover|volvo|infiniti|acura|mini|tesla|alfa|cadillac|lincoln|genesis|maserati)/;

// JERARQUÍA (orden owner 2026-07-21): 1º CATEGORÍA (filtro duro: pickup con
// pickups, sedán con sedanes) · 2º PRECIO · 3º AÑO · 4º MARCA.
function scoreSimilitud(ancla, a) {
    if (categoriaDe(a) !== categoriaDe(ancla)) return 0;   // la categoría MANDA
    const pb = Number(ancla.precio || 0), pa = Number(a.precio || 0);
    if (!pb || !pa) return 0;
    const dp = Math.abs(pa - pb) / pb;
    if (dp > 0.35) return 0;                               // fuera de la cartera → fuera
    let s = 55 * (1 - dp / 0.35);                          // precio
    if (ancla.anio && a.anio) {
        const da = Math.abs(Number(a.anio) - Number(ancla.anio));
        if (da <= 4) s += 30 * (1 - da / 4);               // año
    }
    if (normz(a.marca || '') && normz(a.marca || '') === normz(ancla.marca || '')) s += 15;   // marca
    return s;
}
const UMBRAL_SIMILITUD = 45;
function similaresA(ancla, autos, max) {
    const cat = categoriaDe(ancla);
    const mismos = autos.filter(a => a.id !== ancla.id && categoriaDe(a) === cat);
    const buenos = mismos.map(a => ({ a, s: scoreSimilitud(ancla, a) }))
        .filter(x => x.s >= UMBRAL_SIMILITUD).sort((x, y) => y.s - x.s).map(x => x.a);
    if (buenos.length >= 3) return buenos.slice(0, max || 7);
    // se completa SIEMPRE con la misma categoría, por cercanía de precio (jerarquía)
    const resto = mismos.filter(a => !buenos.includes(a))
        .sort((x, y) => Math.abs(Number(x.precio || 0) - Number(ancla.precio || 0)) - Math.abs(Number(y.precio || 0) - Number(ancla.precio || 0)));
    return buenos.concat(resto).slice(0, max || 7);
}

// ══ RELACIONADOS — SOLO si lo piden explícito ══
const RE_RELACIONADOS = /(algo m[aá]s|otras? opcion|qu[eé] m[aá]s (tienes|hay|manejan)|algo (parecido|similar)|otras? alternativ|otros? (autos|carros|modelos)|ens[eé][ñn]ame (m[aá]s|otros)|no me convence.*otr|m[aá]s (autos|carros|opciones)|m[aá]s similares|otros? similares|similares? a|parecid[oa]s? a|m[aá]s unidades|otras? unidades|tienen m[aá]s|tienes m[aá]s|hay m[aá]s)/i;

function autosRelacionados(foco, autos) {
    const base = Number(foco.precio || 0);
    if (!base) return [];
    const cands = autos.filter(a => a.id !== foco.id && Number(a.precio || 0) >= base * 0.85 && Number(a.precio || 0) <= base * 1.20);
    const score = a => {
        let s = 0;
        if (normz(a.tipo_carroceria || '') && normz(a.tipo_carroceria || '') === normz(foco.tipo_carroceria || '')) s += 50;
        if (a.anio && foco.anio && Math.abs(Number(a.anio) - Number(foco.anio)) <= 3) s += 20;
        s += 15 * (1 - Math.abs(Number(a.precio) - base) / (base * 0.20));
        if (normz(a.marca || '') === normz(foco.marca || '')) s += 15;
        return s;
    };
    return cands.map(a => ({ a, s: score(a) })).sort((x, y) => y.s - x.s).slice(0, 5).map(x => x.a);
}

// ══ ESTADO DEL APARADOR (wa_conversations.estado_json) — FUENTE ÚNICA ══
async function guardarEstadoAparador(tel, aparador, duda) {
    try {
        const cur = await query("SELECT estado_json FROM wa_conversations WHERE telefono=?", [tel]);
        let ej = {}; try { ej = JSON.parse((cur[0] && cur[0].estado_json) || '{}'); } catch (e) { }
        if (aparador) ej.aparador = aparador;
        if (duda) ej.dudas_pendientes = (ej.dudas_pendientes || []).concat([duda]).slice(-3);
        if (cur.length) await run("UPDATE wa_conversations SET estado_json=?, updated_at=? WHERE telefono=?", [JSON.stringify(ej), Date.now(), tel]);
        else await run("INSERT INTO wa_conversations (telefono, estado, estado_json, updated_at) VALUES (?,?,?,?)", [tel, 'aparador', JSON.stringify(ej), Date.now()]);
    } catch (e) { console.error('[estado aparador]', e.message); }
}

// ── ¿el auto está NEGADO en el texto? ("NO me interesa el Mustang…") — red team r2 #2:
// la mención con negación pegada NO es interés; jamás sentar ni pitchear ese auto ──
function esNegado(texto, nombre) {
    const t = normz(texto);
    const toks = normz(nombre).split(/\s+/).filter(w => (w.length >= 3 || /[a-z]\d|\d[a-z]/.test(w)) && !/^\d+$/.test(w));
    for (const tok of toks) {
        const i = t.indexOf(tok);
        if (i < 0) continue;
        const antes = t.slice(Math.max(0, i - 35), i);
        if (/(no me interesa|no quiero|ya no quiero|ya no me interesa|excepto|menos|descarta|sin)\s+(el|la|un|una|ese|esa)?\s*$/.test(antes)) return true;
    }
    return false;
}

// ── GEMELOS: dos altas casi idénticas (mismo nombre sin espacios, mismo año) —
// red team r2 #4 (dos "Mercedes C200 2025" con precios distintos): jamás elegir
// uno en silencio — se desambigua con precios ──
function gemelosDe(row, autos) {
    const llave = a => normz(a.nombre).replace(/\s+/g, '');
    const k = llave(row);
    return autos.filter(a => a.id !== row.id && llave(a) === k);
}

// ── el punto del auto, HABLADO ("Lo tenemos en …") — punto_envio por auto CRM ──
async function puntoHablado(autoId) {
    try {
        const r = await query("SELECT name FROM punto_envio WHERE auto_id=? LIMIT 1", [Number(autoId)]);
        if (r.length && r[0].name) return String(r[0].name).trim();
        // MISMA FUENTE que datosPunto (continuacion.js): respaldo en el propio auto —
        // así el texto hablado y el pin jamás dicen cosas distintas
        const inv = await query("SELECT puntos_venta FROM inventario_autos WHERE id=?", [Number(autoId)]);
        if (inv.length) { const p = JSON.parse(inv[0].puntos_venta || '[]'); if (p[0] && p[0].name) return String(p[0].name).trim(); }
    } catch (e) { }
    return null;
}

// ══ LA ELECCIÓN (FUENTE ÚNICA — panel real y sandbox): el FOCO solo se ancla con
// HECHO DURO contra LO MOSTRADO; anclado → confirmación en voz alta + duda guardada
// contestada con el auto ya en la mano + auto_id_activo → el flujo normal sigue.
async function intentarEleccionAparador(tel, texto, convId) {
    try {
        const cur = await query("SELECT estado_json, auto_id_activo FROM wa_conversations WHERE telefono=?", [tel]);
        if (!cur.length) return null;
        let ej = {}; try { ej = JSON.parse(cur[0].estado_json || '{}'); } catch (e) { }
        if (!Array.isArray(ej.aparador) || !ej.aparador.length || cur[0].auto_id_activo) return null;
        if (RE_RELACIONADOS.test(texto)) {
            const autosA = await inventarioActivo();
            const vistos = new Set(ej.aparador.map(x => x.id));
            const resto = autosA.filter(a => !vistos.has(a.id));
            const apr2 = await armarAparador({ ancla: null, lista: resto, intro: 'Claro, también tenemos estas 🚗' });
            if (apr2) {
                ej.aparador = ej.aparador.concat(apr2.aparador.map((x, i) => ({ ...x, n: ej.aparador.length + i + 1 })));
                apr2.segmentos[1] = ej.aparador.slice(-apr2.aparador.length).map(x => `${x.n}) ${x.nombre}`).join('\n');
                await run("UPDATE wa_conversations SET estado_json=?, updated_at=? WHERE telefono=?", [JSON.stringify(ej), Date.now(), tel]);
                return { tipo: 'aparador_mas', segmentos: apr2.segmentos, fotos: apr2.fotos, fotos_after_index: apr2.fotos_after_index };
            }
            return null;
        }
        // Si ya le preguntamos "¿cuál de estos?", su respuesta se resuelve PRIMERO contra
        // ESOS candidatos (caso owner 2026-07-20: "2018" basta para desempatar dos Mazda).
        const base = (Array.isArray(ej.pregunta) && ej.pregunta.length)
            ? (ej.aparador.filter(x => ej.pregunta.includes(x.id)).length ? ej.aparador.filter(x => ej.pregunta.includes(x.id)) : ej.aparador)
            : ej.aparador;
        // ══ ¿MENCIONA VARIOS? (orden owner 2026-07-20: "chevrolet y mazda 2018" → se
        // atienden AMBOS, no se le obliga a escoger): el texto se parte por "y"/comas y
        // cada pedazo se resuelve solo — el año se queda con su pedazo ("mazda 2018").
        // Si algún pedazo queda ambiguo → flujo clásico de pregunta (solo los empatados).
        const frases = String(texto).split(/\s*(?:,|\by\b|\btambi[eé]n\b)\s*/i).map(s => s.trim()).filter(s => s.length >= 2);
        let multi = [];
        if (frases.length > 1) {
            for (const f of frases) {
                const r = resolverEleccion(f, base);
                if (r && r.auto && ['nombre', 'anio', 'numero', 'color'].includes(r.via) && !multi.some(x => x.id === r.auto.id)) multi.push(r.auto);
                else if (r && r.pregunta) { multi = null; break; }
            }
        }
        if (multi && multi.length >= 2) {
            try { const mmF = require('./mesa.js'); multi = multi.filter(m => mmF.nombradoEnTexto(texto, m.nombre)); } catch (e) { }
            if (multi.length < 2) multi = null;
        }
        if (multi && multi.length >= 2) {
            const autosM = await inventarioActivo();
            // LA ACCIÓN MANDA también al elegir VARIOS ("cotízame el cavalier y el sentra")
            try {
                const mm = require('./mesa.js');
                const accM = ej.pregunta_accion || mm.detectarAccion(texto, null);
                delete ej.pregunta_accion;
                const multiReal = multi.filter(m => mm.nombradoEnTexto(texto, m.nombre));
                if (accM && accM !== 'detalles' && multiReal.length >= 2) {
                    const previa = Array.isArray(ej.mesa) ? ej.mesa : [];
                    const idsM = previa.concat(multiReal.map(m => m.id)).filter((v, i, a) => a.indexOf(v) === i).slice(-3);
                    ej.mesa = idsM; ej.foco = { id: multiReal[0].id, nombre: multiReal[0].nombre, via: 'multi', ts: Date.now() };
                    ej.interes = (ej.interes || []).concat(idsM).filter((v, i, a) => a.indexOf(v) === i);
                    delete ej.aparador; delete ej.pregunta;
                    await mm.guardarMesa(tel, ej, idsM, idsM[idsM.length - 1]);
                    const rowsM = multiReal.map(m => autosM.find(a => a.id === m.id)).filter(Boolean);
                    const outM = await mm.ejecutarAccionMesa({ rows: rowsM, accion: accM, clasif: null, texto, tel, ej, mesa: idsM });
                    if (outM) return outM;
                }
            } catch (e) { }
            const segs = ['¡Van! Te paso la info de los ' + (multi.length === 2 ? 'dos' : multi.length) + ':'];
            const fotosM = [];
            const rowsM = multi.map(m => autosM.find(a => a.id === m.id)).filter(Boolean);
            for (const rowM of rowsM) {
                segs.push(await fichaExtensa(rowM));
                const pf = await portadaDe(rowM.fyradrive_web_id); if (pf) fotosM.push(pf);
            }
            const ubiM = await redactarUbicaciones(rowsM);
            for (const su of ubiM.segmentos) segs.push(su);
            segs.push(ubiM.mismo ? ubiM.gancho : '¿Cuál te late ir a ver primero? Te agendo de una vez');
            ej.foco = { id: multi[0].id, nombre: multi[0].nombre, via: 'multi', ts: Date.now() };
            ej.mesa = multi.map(m => m.id);   // LA MESA: estos autos quedan EN JUEGO
            ej.interes = (ej.interes || []).filter(v => !multi.some(m => m.id === v)).concat(multi.map(m => m.id));
            delete ej.aparador; delete ej.dudas_pendientes; delete ej.pregunta;
            await run("UPDATE wa_conversations SET estado_json=?, auto_id_activo=?, updated_at=? WHERE telefono=?", [JSON.stringify(ej), multi[0].id, Date.now(), tel]);
            return { tipo: 'aparador_foco_multi', segmentos: segs, fotos: fotosM.length ? fotosM : null, fotos_after_index: segs.length - 2 };
        }
        let el = resolverEleccion(texto, base);
        if (!el && base !== ej.aparador) el = resolverEleccion(texto, ej.aparador);
        if (!el) return null;
        if (el.pregunta) {
            ej.pregunta = el.pregunta.map(x => x.id);
            try {
                const mm = require('./mesa.js');
                const accQ = mm.detectarAccion(texto, null);
                if (accQ) ej.pregunta_accion = accQ;
                if (el.claros && el.claros.length) ej.pregunta_ya = el.claros.map(x => x.id);
                // LIBRETA ÚNICA de preguntas pendientes: la MESA también debe poder
                // resolverla (el aparador se apaga cuando ya hay auto activo y la
                // respuesta "el 2018" se quedaba sin dueño → escalaba)
                ej.mesa_familia = el.pregunta.map(x => x.id);
                if (accQ) ej.mesa_familia_accion = accQ;
                if (el.claros && el.claros.length) ej.mesa_familia_ya = el.claros.map(x => x.id);
                await run("UPDATE wa_conversations SET estado_json=?, updated_at=? WHERE telefono=?", [JSON.stringify(ej), Date.now(), tel]);
                return { tipo: 'aparador_pregunta', segmentos: [mm.preguntaFamilia(el.pregunta, accQ)] };
            } catch (e) { }
            // el que se entendió solo (p. ej. "Yaris" único) queda como interés — no estorba la pregunta
            if (el.claros && el.claros.length) ej.interes = (ej.interes || []).concat(el.claros.map(x => x.id)).filter((v, i, a) => a.indexOf(v) === i);
            await run("UPDATE wa_conversations SET estado_json=?, updated_at=? WHERE telefono=?", [JSON.stringify(ej), Date.now(), tel]);
            return { tipo: 'aparador_pregunta', segmentos: ['¿Cuál de estos? ' + el.pregunta.map(x => x.nombre).join(' o ') + ' 🤔'] };
        }
        const auto = el.auto;
        const autosA = await inventarioActivo();
        const row = autosA.find(a => a.id === auto.id);
        const dudas = (ej.dudas_pendientes || []);
        ej.foco = { id: auto.id, nombre: auto.nombre, via: el.via, ts: Date.now() };
        ej.mesa = [auto.id];   // LA MESA: un solo auto en juego → flujo individual
        ej.interes = (ej.interes || []).filter(x => x !== auto.id).concat([auto.id]);
        delete ej.aparador; delete ej.dudas_pendientes; delete ej.pregunta;
        await run("UPDATE wa_conversations SET estado_json=?, auto_id_activo=?, updated_at=? WHERE telefono=?", [JSON.stringify(ej), auto.id, Date.now(), tel]);
        // LA ACCIÓN MANDA (owner 2026-07-21): si venía pidiendo algo concreto
        // ("¿dónde tienes el audi?" → "el 2015"), se ejecuta ESO, no la presentación
        try {
            const mm = require('./mesa.js');
            const accPend = ej.pregunta_accion || mm.detectarAccion(texto, null);
            delete ej.pregunta_accion;
            const yaRes = Array.isArray(ej.pregunta_ya) ? ej.pregunta_ya : [];
            delete ej.pregunta_ya;
            if (accPend && accPend !== 'detalles') {
                const mesaIds = yaRes.concat([auto.id]).filter((v, i, a) => a.indexOf(v) === i).slice(-3);
                ej.mesa = mesaIds;
                await mm.guardarMesa(tel, ej, mesaIds, auto.id);
                const rowsAcc = mesaIds.map(id => autosA.find(a => a.id === id)).filter(Boolean);
                const outAcc = await mm.ejecutarAccionMesa({ rows: rowsAcc, accion: accPend, clasif: null, texto, tel, ej, mesa: mesaIds });
                if (outAcc) return outAcc;
            }
        } catch (e) { }
        let segmentos = [`¡El ${auto.nombre}! 👍`];
        // orden owner 2026-07-21: al asumir el auto → DESCRIPCIÓN + 2 fotos + punto hablado + cita
        segmentos.push(row ? await descripcionDe(row) : fichaBreve(auto));
        // dónde lo tenemos, HABLADO (orden owner 2026-07-20) — el pin va cuando lo pida
        const lugF = await puntoHablado(auto.id);
        if (lugF) segmentos.push('Lo tenemos en ' + lugF + ', para que lo veas cuando gustes');
        let extra = {};
        if (dudas.length) {
            try {
                const { responderEtapa3 } = require('./etapa3.js');
                const e3d = await responderEtapa3({ texto: dudas[0], auto_id: auto.id, conv_id: convId, clasif: null });
                if (e3d && e3d.segmentos && e3d.segmentos.length && !e3d.escalar) {
                    segmentos.push('Y sobre lo que preguntabas:');
                    segmentos = segmentos.concat(e3d.segmentos);
                    if (e3d.fotos) extra = { fotos: e3d.fotos, fotos_after_index: segmentos.length - e3d.segmentos.length + (e3d.fotos_after_index || 0) };
                } else if (e3d && e3d.escalar) {
                    extra = { escalar_owner: true, escala_motivo: 'duda previa del aparador: ' + (e3d.motivo || dudas[0].slice(0, 80)), escala_ultimo: dudas[0] };
                }
            } catch (e) { }
        }
        if (!extra.fotos) {
            const f2 = await fotosAuto(row && row.fyradrive_web_id, 12);
            if (f2.length) { extra.fotos = f2; extra.fotos_after_index = 1; }
            segmentos.push('¿Qué día te queda bien para venir a verlo y manejarlo? Te agendo de una vez');
        }
        return { tipo: 'aparador_foco', segmentos, ...extra };
    } catch (e) { console.error('[eleccion aparador]', e.message); return null; }
}

// ══ OPCIONES EN FLUJO (FUENTE ÚNICA — panel real y sandbox, orden owner 2026-07-20):
// a media conversación (con o sin foco), LA FÓRMULA es:
//   · "¿qué más opciones tienen?" → RELACIONADOS = acorde a su INTERÉS (parecidos
//     al auto en foco: banda de precio 0.85–1.20x + carrocería/año/marca)
//   · una NECESIDAD ("ando buscando abajo de X de enganche") → filtro DURO:
//     ÚNICAMENTE los autos que cumplen; si ninguno cumple, se dice honesto y ESCALA
//     (jamás rellenar con autos fuera de la necesidad)
// Al mostrar aparador nuevo, el foco se suelta (auto_id_activo=NULL) para que la
// elección se re-arme; el auto que traía queda como interés.
const RE_NECESIDAD = /(busco|buscando|ando viendo|abajo de|debajo de|que no pase de|no m[aá]s de|presupuesto|m[aá]s barat|m[aá]s econ[oó]mic|algo (m[aá]s )?(barat|econ[oó]mic))/i;
// "¿cuál es su carro más barato?" / "algo económico" → traer los ECONÓMICOS (owner 2026-07-21:
// se identifica la necesidad y se subsana trayendo del inventario)
const RE_BARATO = /(m[aá]s|mas)\s+(barat|econ[oó]mic)|algo\s+(m[aá]s\s+)?(barat|econ[oó]mic)|(barat[oa]s?|econ[oó]mic[oa]s?)\s+(tienes|tengan|hay)/i;
async function opcionesEnFlujo({ tel, texto }) {
    try {
        const pideMas = RE_RELACIONADOS.test(texto);
        const hayNecesidad = RE_NECESIDAD.test(texto);
        const esBarato = RE_BARATO.test(texto);
        if (!pideMas && !hayNecesidad && !esBarato) return null;
        // red team r2 #5: si el texto NOMBRA autos del inventario con sus letras (sin
        // negarlos), LOS NOMBRADOS MANDAN — la vitrina no los pisa con un filtro
        try {
            const invN = await inventarioActivo();
            const itemsN = invN.map(a => ({ n: 0, id: a.id, nombre: a.nombre, color: '' }));
            for (const f of String(texto).split(/\s*(?:,|\by\b|\btambi[eé]n\b)\s*/i)) {
                if (f.trim().length < 3) continue;
                const rN = resolverEleccion(f, itemsN);
                if (rN && rN.auto && !esNegado(f, rN.auto.nombre)) return null;
            }
        } catch (e) { }
        const crit = (hayNecesidad || pideMas) ? await parsearCriterio(texto) : null;
        if (!crit && !pideMas && !esBarato) return null;
        const cur = await query("SELECT estado_json, auto_id_activo FROM wa_conversations WHERE telefono=?", [tel]);
        let ej = {}; try { ej = JSON.parse((cur[0] && cur[0].estado_json) || '{}'); } catch (e) { }
        const autos = await inventarioActivo();
        const focoId = Number((cur[0] && cur[0].auto_id_activo) || (ej.foco && ej.foco.id) || 0) || null;
        const interes = Array.isArray(ej.interes) ? ej.interes : [];
        let lista = null, intro = null, tipo = null, listaOrdenada = false;
        if (crit) {
            // NECESIDAD → filtro duro: únicamente los que cumplen
            const filtradas = buscarInventario(crit, autos).filter(a => a.id !== focoId);
            if (!filtradas.length) {
                const resumen = [crit.enganche ? 'enganche $' + Number(crit.enganche).toLocaleString('es-MX') : '', crit.presupuesto ? 'presupuesto $' + Number(crit.presupuesto).toLocaleString('es-MX') : '', crit.tipo || '', crit.marca || ''].filter(Boolean).join(' · ');
                return { tipo: 'aparador_sin_match', segmentos: ['Fíjate que con eso exacto ahorita no tengo algo que te acomode 🙏'], escalar_owner: true, escala_motivo: '💰 busca ' + (resumen || 'algo') + ' y no hay match en inventario — lo ves tú' };
            }
            lista = filtradas; tipo = 'aparador_filtrado'; listaOrdenada = true;
            intro = fraseConteo(crit.categoria, filtradas.length, !!(crit.enganche || crit.presupuesto));
        } else if (esBarato && !pideMas) {
            // NECESIDAD "económico" → los más baratos del inventario, del menor al mayor
            lista = autos.filter(a => Number(a.precio || 0) > 0).sort((a, b) => Number(a.precio) - Number(b.precio)).slice(0, 5);
            if (!lista.length) return null;
            tipo = 'aparador_economicos'; listaOrdenada = true;
            intro = 'Va, estos son los más económicos que tenemos ahorita 🚗';
        } else {
            // OPCIONES → acorde a su interés: la FÓRMULA DE SIMILITUD contra el foco
            // (corte de calidad incluido); sin foco → oportunidades
            const focoRow = focoId ? autos.find(a => a.id === focoId) : null;
            if (focoRow) {
                lista = similaresA(focoRow, autos, 7).filter(a => !interes.includes(a.id));
                intro = `Claro, parecidos al ${focoRow.nombre} tenemos estos 🚗`;
                listaOrdenada = true;
            }
            if (!lista || !lista.length) {
                lista = autos.filter(a => a.id !== focoId && !interes.includes(a.id));
                intro = 'Claro, mira, también tenemos estas oportunidades 🚗';
                listaOrdenada = false;
            }
            if (!lista.length) return null;
            tipo = 'aparador_relacionados';
        }
        const apr = await armarAparador({ ancla: null, lista, intro, nFotos: 4, ordenDado: listaOrdenada });
        if (!apr) return null;
        // aparador nuevo → el foco se suelta y queda como interés; elección re-armada
        if (focoId) ej.interes = interes.filter(v => v !== focoId).concat([focoId]);
        delete ej.foco; delete ej.pregunta; delete ej.mesa;
        ej.aparador = apr.aparador;
        if (cur.length) await run("UPDATE wa_conversations SET estado_json=?, auto_id_activo=NULL, updated_at=? WHERE telefono=?", [JSON.stringify(ej), Date.now(), tel]);
        else await run("INSERT INTO wa_conversations (telefono, estado, estado_json, updated_at) VALUES (?,?,?,?)", [tel, 'aparador', JSON.stringify(ej), Date.now()]);
        return { tipo, segmentos: apr.segmentos, fotos: apr.fotos, fotos_after_index: apr.fotos_after_index };
    } catch (e) { console.error('[opciones en flujo]', e.message); return null; }
}

// ══ EL ARRANQUE (FUENTE ÚNICA — panel real y sandbox): Puerta 2 (clic genérico →
// ancla-hipótesis del ojo) y Puerta 3 (criterio → buscar_inventario). Regresa null
// si este turno no es de aparador (→ el caller sigue su flujo clásico).
async function arranqueCarrusel({ tel, textoRaw, textoFamilia, adCtx, textosIn, nombre, esClick, duda }) {
    const { nombreReal, saludoHora } = require('./opener.js');
    const nm = nombreReal(nombre);
    const autosAp = await inventarioActivo();
    if (esClick) {
        const { esClickGenerico } = require('./clasificador.js');
        if (!esClickGenerico(textoRaw)) return null;
        // red team #4: si en el clic NOMBRÓ autos del inventario con sus letras, NO es
        // clic genérico — su flujo normal (nombrado/mesa) los atiende, no el aparador
        try {
            const itemsInv = autosAp.map(a => ({ n: 0, id: a.id, nombre: a.nombre, color: '' }));
            const rNom = resolverEleccion(String(textoRaw || ''), itemsInv);
            if (rNom && (rNom.auto || rNom.pregunta)) return null;
        } catch (e) { }
        // ¿pidió algo que NO tenemos ("una Hilux", "un Tesla")? → honesto + conversión,
        // jamás la lista genérica como si no hubiera preguntado
        const fueraC = pedidoFueraDeInventario(String(textoRaw || ''), autosAp);
        if (fueraC) {
            const altC = puenteDeConversion({ marca: fueraC.marca, anio: fueraC.anio, categoria: fueraC.categoria, presupuesto: null, autos: autosAp });
            if (altC.length) {
                const aprC = await armarAparador({ ancla: null, lista: altC, nFotos: 4, ordenDado: true, intro: `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}! De ${fueraC.etiqueta} ahorita no tengo 🙏 pero mira lo que sí te puedo enseñar en ese mismo estilo:` });
                if (aprC) {
                    await guardarEstadoAparador(tel, aprC.aparador, null);
                    return { tipo: 'opener_puente', segmentos: aprC.segmentos, fotos: aprC.fotos, fotos_after_index: aprC.fotos_after_index };
                }
            }
            return { tipo: 'opener_sin_match', segmentos: [`Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}! De ${fueraC.etiqueta} ahorita no tengo 🙏`], escalar_owner: true, escala_motivo: '💰 pide ' + fueraC.etiqueta + ' y no tenemos ni alternativa clara — lo ves tú' };
        }
        let ancla = null;
        const { linkDe } = require('./ad-espia.js');
        const urlAd = linkDe(adCtx || '') || linkDe(String(textosIn || textoRaw || ''));
        if (urlAd) ancla = (await identificarAncla(urlAd, autosAp)).ancla;
        // FÓRMULA owner 2026-07-21: con ancla → ella de PRINCIPAL + los 7 más similares
        // (corte de calidad: lo no-similar ni se manda); sin ancla → mejores oportunidades.
        // Referral: 4 portadas de autos diferentes.
        const listaAp = ancla ? similaresA(ancla, autosAp, 7) : autosAp;
        const apr = await armarAparador({ ancla, lista: listaAp, saludoNombre: nm, max: ancla ? 8 : 6, nFotos: 4, ordenDado: !!ancla });
        if (!apr) return null;
        // MACHOTE del owner 2026-07-21 (SIN emojis): saludo + presentación + LA INFO
        // primero, las FOTOS en medio, y la pregunta de interés AL FINAL
        apr.segmentos = [
            `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}!`,
            'Mucho gusto, mi nombre es Sebastián Romero, para servirte',
            'Sí claro, te paso lo que tenemos del anuncio:\n' + apr.segmentos[1],
            '¿Cuál te late de estos? Y si andabas buscando otro dime cuál, tenemos más 👍'
        ];
        apr.fotos_after_index = 2;
        await guardarEstadoAparador(tel, apr.aparador, null);
        return { tipo: 'opener_aparador', segmentos: apr.segmentos, fotos: apr.fotos, fotos_after_index: apr.fotos_after_index };
    }
    // Puerta 3 (fallback sin auto): criterio → filtradas; sin criterio pero con
    // link de anuncio → ancla-hipótesis; sin nada → null (pregunta clásica).
    const crit = await parsearCriterio(textoFamilia);
    let lista = null, ancla = null, intro = null;
    if (crit) {
        const filtradas = buscarInventario(crit, autosAp);
        if (filtradas.length) {
            lista = filtradas;
            intro = `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}! ` + fraseConteo(crit.categoria, filtradas.length, !!(crit.enganche || crit.presupuesto));
        } else {
            // PUENTE DE CONVERSIÓN: de eso no hay, pero se le enseña su mismo mundo
            const alt = puenteDeConversion({ marca: crit.marca, anio: crit.anio_min || crit.anio_max || null, categoria: crit.categoria, presupuesto: crit.presupuesto || (crit.enganche ? crit.enganche * 6 : null), autos: autosAp });
            const capF = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
            const pedidoF = [crit.marca ? capF(crit.marca) : null, crit.anio_min || crit.anio_max || null].filter(Boolean).join(' ')
                || (crit.categoria && CATEGORIAS[crit.categoria] ? CATEGORIAS[crit.categoria].plural : 'eso');
            if (alt.length) { lista = alt; intro = `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}! De ${pedidoF} ahorita no tengo 🙏 pero mira lo que sí te puedo enseñar en ese mismo estilo:`; }
            else return { tipo: 'aparador_sin_match', segmentos: [`Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}! De ${pedidoF} ahorita no tengo algo que te acomode 🙏`], escalar_owner: true, escala_motivo: '💰 busca ' + pedidoF + ' y no hay match ni alternativa — lo ves tú' };
        }
    } else {
        // ¿pidió algo que NO tenemos? → honesto + conversión, antes que el genérico
        const fueraF = pedidoFueraDeInventario(String(textoFamilia || textoRaw || ''), autosAp);
        if (fueraF) {
            const altF = puenteDeConversion({ marca: fueraF.marca, anio: fueraF.anio, categoria: fueraF.categoria, presupuesto: null, autos: autosAp });
            if (altF.length) { lista = altF; intro = `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}! De ${fueraF.etiqueta} ahorita no tengo 🙏 pero mira lo que sí te puedo enseñar en ese mismo estilo:`; }
            else return { tipo: 'aparador_sin_match', segmentos: [`Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}! De ${fueraF.etiqueta} ahorita no tengo 🙏`], escalar_owner: true, escala_motivo: '💰 pide ' + fueraF.etiqueta + ' y no tenemos — lo ves tú' };
            const aprF = await armarAparador({ ancla: null, lista, intro, nFotos: 4, ordenDado: true });
            if (aprF) { await guardarEstadoAparador(tel, aprF.aparador, duda || null); return { tipo: 'opener_puente', segmentos: aprF.segmentos, fotos: aprF.fotos, fotos_after_index: aprF.fotos_after_index }; }
        }
        const { linkDe } = require('./ad-espia.js');
        const urlAd = linkDe(adCtx || '') || linkDe(String(textosIn || ''));
        if (!urlAd) return null;
        ancla = (await identificarAncla(urlAd, autosAp)).ancla;
        lista = ancla ? similaresA(ancla, autosAp, 7) : autosAp;
        intro = '__machote_anuncio__';
    }
    const apr = await armarAparador({ ancla, lista, saludoNombre: nm, intro: intro === '__machote_anuncio__' ? null : intro, max: ancla ? 8 : 6, nFotos: 4, ordenDado: !!ancla || !!crit });
    if (!apr) return null;
    if (intro === '__machote_anuncio__') {
        // viene del ANUNCIO → mismo machote del owner (info → fotos → pregunta)
        apr.segmentos = [
            `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}!`,
            'Mucho gusto, mi nombre es Sebastián Romero, para servirte',
            'Sí claro, te paso lo que tenemos del anuncio:\n' + apr.segmentos[1],
            '¿Cuál te late de estos? Y si andabas buscando otro dime cuál, tenemos más 👍'
        ];
        apr.fotos_after_index = 2;
    }
    await guardarEstadoAparador(tel, apr.aparador, duda || null);
    return { tipo: 'opener_aparador', segmentos: apr.segmentos, fotos: apr.fotos, fotos_after_index: apr.fotos_after_index };
}

module.exports = { espiarVision, identificarAncla, parsearCriterio, buscarInventario, armarAparador, resolverEleccion, autosRelacionados, RE_RELACIONADOS, RE_NECESIDAD, RE_BARATO, inventarioActivo, portadaDe, fichaBreve, fichaExtensa, descripcionDe, fotosAuto, puntoHablado, redactarUbicaciones, introFamilia, pedidoFueraDeInventario, categoriaTexto, carroceriaDe, categoriaDe, CATEGORIAS, fraseConteo, puenteDeConversion, MARCAS_PREMIUM, esNegado, gemelosDe, guardarEstadoAparador, intentarEleccionAparador, arranqueCarrusel, opcionesEnFlujo, scoreSimilitud, similaresA };
