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
    if (/camioneta|suv|troca|pick ?up/.test(t)) out.tipo = 'camioneta';
    if (/sed[aá]n|sedan/.test(t)) out.tipo = 'sedan';
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
    if (h.tipo) o.tipo = normz(h.tipo);
    if (h.marca) o.marca = normz(h.marca);
    return Object.keys(o).length ? o : null;
}

function buscarInventario(criterio, autos) {
    let res = autos.slice();
    // enganche ≈ 15-20% → presupuesto máximo aproximado (regla de código, conservadora)
    const tope = criterio.presupuesto || (criterio.enganche ? criterio.enganche * 6 : null);
    if (tope) res = res.filter(a => Number(a.precio || 0) > 0 && Number(a.precio) <= tope);
    if (criterio.tipo === 'camioneta') res = res.filter(a => /suv|camioneta|pick/i.test(String(a.tipo_carroceria || '')) || /expedition|bronco|trx|mojave|sorento|teramont|cx-5|sienna|x5|gle|q5|cherokee|lobo|f-150/i.test(normz(a.nombre)));
    else if (criterio.tipo) res = res.filter(a => normz(String(a.tipo_carroceria || '')).includes(criterio.tipo));
    if (criterio.marca) res = res.filter(a => normz(a.nombre).includes(criterio.marca));
    res.sort((x, y) => Number(x.precio || 0) - Number(y.precio || 0));
    return res;
}

// ══ EL APARADOR: 2 con portada + hasta 4 en texto + invitación (datos de Turso) ══
const fmt = n => '$' + Number(n || 0).toLocaleString('es-MX');
const fkm = n => n ? Number(n).toLocaleString('es-MX') + ' km' : '';
function fichaBreve(a) { return `${a.nombre} — ${fmt(a.precio)}${a.kilometraje ? ' · ' + fkm(a.kilometraje) : ''}`; }

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
    // nombre: tokens contra SOLO los del aparador
    const cands = [];
    for (const it of aparador) {
        const toks = normz(it.nombre).split(/\s+/).filter(w => (w.length >= 3 || /[a-z]\d|\d[a-z]/.test(w)) && !/^\d+$/.test(w));
        const matched = toks.filter(tok => t.includes(tok));
        if (anioTx && !normz(it.nombre).includes(anioTx)) continue;
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
            if (ambiguos.length > 1) return { pregunta: ambiguos.slice(0, 3).map(c => c.it), via: 'nombre_ambiguo', claros: claros.map(c => c.it) };
            return { pregunta: tops.slice(0, 3).map(c => c.it), via: 'nombre_ambiguo' };
        }
    }
    // año que empata a varios y nada más lo desempató → pregunta entre ESOS
    if (anioTx && porAnio.length > 1) return { pregunta: porAnio.slice(0, 3), via: 'anio_ambiguo' };
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
function scoreSimilitud(ancla, a) {
    const pb = Number(ancla.precio || 0), pa = Number(a.precio || 0);
    if (!pb || !pa) return 0;
    const dp = Math.abs(pa - pb) / pb;
    if (dp > 0.35) return 0;                          // fuera de la cartera → fuera
    let s = 40 * (1 - dp / 0.35);
    const cb = normz(ancla.tipo_carroceria || ''), ca = normz(a.tipo_carroceria || '');
    if (cb && cb === ca) s += 30;
    if (ancla.anio && a.anio) {
        const da = Math.abs(Number(a.anio) - Number(ancla.anio));
        if (da <= 4) s += 20 * (1 - da / 4);
    }
    if (normz(a.marca || '') && normz(a.marca || '') === normz(ancla.marca || '')) s += 10;
    return s;
}
const UMBRAL_SIMILITUD = 45;
function similaresA(ancla, autos, max) {
    return autos.filter(a => a.id !== ancla.id)
        .map(a => ({ a, s: scoreSimilitud(ancla, a) }))
        .filter(x => x.s >= UMBRAL_SIMILITUD)
        .sort((x, y) => y.s - x.s)
        .slice(0, max || 7).map(x => x.a);
}

// ══ RELACIONADOS — SOLO si lo piden explícito ══
const RE_RELACIONADOS = /(algo m[aá]s|otras? opcion|qu[eé] m[aá]s (tienes|hay|manejan)|algo (parecido|similar)|otras? alternativ|otros? (autos|carros|modelos)|ens[eé][ñn]ame (m[aá]s|otros)|no me convence.*otr|m[aá]s (autos|carros|opciones)|m[aá]s similares|otros? similares|similares? a|parecid[oa]s? a)/i;

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

// ── el punto del auto, HABLADO ("Lo tenemos en …") — punto_envio por auto CRM ──
async function puntoHablado(autoId) {
    try {
        const r = await query("SELECT name FROM punto_envio WHERE auto_id=? LIMIT 1", [Number(autoId)]);
        if (r.length && r[0].name) return String(r[0].name).trim();
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
                if (r && r.auto && !multi.some(x => x.id === r.auto.id)) multi.push(r.auto);
                else if (r && r.pregunta) { multi = null; break; }
            }
        }
        if (multi && multi.length >= 2) {
            const autosM = await inventarioActivo();
            const segs = ['¡Van! Te paso la info de los ' + (multi.length === 2 ? 'dos' : multi.length) + ':'];
            const fotosM = [];
            for (const m of multi) {
                const rowM = autosM.find(a => a.id === m.id);
                const lugM = await puntoHablado(m.id);
                segs.push((rowM ? fichaBreve(rowM) : m.nombre) + (lugM ? '\nLo tenemos en ' + lugM : ''));
                if (rowM) { const pf = await portadaDe(rowM.fyradrive_web_id); if (pf) fotosM.push(pf); }
            }
            segs.push('¿Cuál te late ir a ver primero? Te agendo de una vez');
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
            const f2 = await fotosAuto(row && row.fyradrive_web_id, 2);
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
            intro = 'Va, con eso que me dices estas te van 🚗';
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
        // MACHOTE del owner 2026-07-20 (SIN emojis): saludo + presentación de siempre +
        // "¿cuál de los del anuncio te interesa?" + las opciones (el ancla del ojo va en 1)
        apr.segmentos = [
            `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}!`,
            'Mucho gusto, mi nombre es Sebastián Romero, para servirte',
            'Sí claro, ¿cuál de los del anuncio te interesa?\n' + apr.segmentos[1]
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
        if (filtradas.length) { lista = filtradas; intro = `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}! Con eso que me dices, estas te van 🚗`; }
        else {
            // NECESIDAD sin match → honesto y ESCALA (fórmula owner 2026-07-20:
            // jamás rellenar con autos fuera de la necesidad)
            return { tipo: 'aparador_sin_match', segmentos: [`Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}! Fíjate que con eso exacto ahorita no tengo algo que te acomode 🙏`], escalar_owner: true, escala_motivo: '💰 busca con criterio y no hay match en inventario — lo ves tú' };
        }
    } else {
        const { linkDe } = require('./ad-espia.js');
        const urlAd = linkDe(adCtx || '') || linkDe(String(textosIn || ''));
        if (!urlAd) return null;
        ancla = (await identificarAncla(urlAd, autosAp)).ancla;
        lista = ancla ? similaresA(ancla, autosAp, 7) : autosAp;
        intro = '__machote_anuncio__';
    }
    const apr = await armarAparador({ ancla, lista, saludoNombre: nm, intro: intro === '__machote_anuncio__' ? null : intro, max: ancla ? 8 : 6, nFotos: 4, ordenDado: !!ancla });
    if (!apr) return null;
    if (intro === '__machote_anuncio__') {
        // viene del ANUNCIO → mismo machote del owner (sin emojis)
        apr.segmentos = [
            `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}!`,
            'Mucho gusto, mi nombre es Sebastián Romero, para servirte',
            'Sí claro, ¿cuál de los del anuncio te interesa?\n' + apr.segmentos[1]
        ];
        apr.fotos_after_index = 2;
    }
    await guardarEstadoAparador(tel, apr.aparador, duda || null);
    return { tipo: 'opener_aparador', segmentos: apr.segmentos, fotos: apr.fotos, fotos_after_index: apr.fotos_after_index };
}

module.exports = { espiarVision, identificarAncla, parsearCriterio, buscarInventario, armarAparador, resolverEleccion, autosRelacionados, RE_RELACIONADOS, RE_NECESIDAD, RE_BARATO, inventarioActivo, portadaDe, fichaBreve, descripcionDe, fotosAuto, puntoHablado, guardarEstadoAparador, intentarEleccionAparador, arranqueCarrusel, opcionesEnFlujo, scoreSimilitud, similaresA };
