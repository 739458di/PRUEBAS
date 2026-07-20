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

async function armarAparador({ ancla, lista, saludoNombre, intro }) {
    // orden: ancla primero; después "mejores oportunidades" = las que MÁS compradores
    // han jalado (sb_convs_count) y las más nuevas — determinista, de la base
    const pool = (lista || []).slice().sort((x, y) => (Number(y.sb_convs_count || 0) - Number(x.sb_convs_count || 0)) || (Number(y.created_at || 0) - Number(x.created_at || 0)));
    const sel = [];
    if (ancla) sel.push(ancla);
    for (const a of pool) { if (sel.length >= 6) break; if (!sel.some(s => s.id === a.id)) sel.push(a); }
    if (!sel.length) return null;
    const conFoto = sel.slice(0, 2), enTexto = sel.slice(2);
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
    // nombre: tokens contra SOLO los del aparador
    const cands = [];
    for (const it of aparador) {
        const toks = normz(it.nombre).split(/\s+/).filter(w => (w.length >= 3 || /[a-z]\d|\d[a-z]/.test(w)) && !/^\d+$/.test(w));
        const hits = toks.filter(tok => t.includes(tok)).length;
        const anioTx = (t.match(/\b(19|20)\d{2}\b/) || [])[0];
        if (anioTx && !normz(it.nombre).includes(anioTx)) continue;
        if (hits) cands.push({ it, hits });
    }
    if (cands.length) {
        const top = Math.max(...cands.map(c => c.hits));
        const tops = cands.filter(c => c.hits === top).map(c => c.it);
        if (tops.length === 1) return { auto: tops[0], via: 'nombre' };
        if (tops.length > 1) return { pregunta: tops.slice(0, 3), via: 'nombre_ambiguo' };
    }
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

// ══ RELACIONADOS — SOLO si lo piden explícito ══
const RE_RELACIONADOS = /(algo m[aá]s|otras? opcion|qu[eé] m[aá]s (tienes|hay|manejan)|algo (parecido|similar)|otras? alternativ|otros? (autos|carros|modelos)|ens[eé][ñn]ame (m[aá]s|otros)|no me convence.*otr|m[aá]s (autos|carros|opciones))/i;

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
        const el = resolverEleccion(texto, ej.aparador);
        if (!el) return null;
        if (el.pregunta) return { tipo: 'aparador_pregunta', segmentos: ['¿Cuál de estos? ' + el.pregunta.map(x => x.nombre).join(' o ') + ' 🤔'] };
        const auto = el.auto;
        const autosA = await inventarioActivo();
        const row = autosA.find(a => a.id === auto.id);
        const dudas = (ej.dudas_pendientes || []);
        ej.foco = { id: auto.id, nombre: auto.nombre, via: el.via, ts: Date.now() };
        ej.interes = (ej.interes || []).filter(x => x !== auto.id).concat([auto.id]);
        delete ej.aparador; delete ej.dudas_pendientes;
        await run("UPDATE wa_conversations SET estado_json=?, auto_id_activo=?, updated_at=? WHERE telefono=?", [JSON.stringify(ej), auto.id, Date.now(), tel]);
        let segmentos = [`¡El ${auto.nombre}! 👍`];
        if (row) segmentos.push(fichaBreve(row));
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
        if (!extra.fotos) segmentos.push('¿Te mando las fotos y la ficha completa, o te la cotizo de una vez?');
        return { tipo: 'aparador_foco', segmentos, ...extra };
    } catch (e) { console.error('[eleccion aparador]', e.message); return null; }
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
        const apr = await armarAparador({
            ancla, lista: autosAp, saludoNombre: nm,
            intro: ancla
                ? `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}! ¿Te refieres a este? 👇 Y de una vez te enseño otras buenas:`
                : `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}! Mira, estos son los que más están jalando ahorita 🚗`
        });
        if (!apr) return null;
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
        else { lista = autosAp; intro = `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}! De eso exacto ahorita no tengo, pero mira estas oportunidades 🚗`; }
    } else {
        const { linkDe } = require('./ad-espia.js');
        const urlAd = linkDe(adCtx || '') || linkDe(String(textosIn || ''));
        if (!urlAd) return null;
        ancla = (await identificarAncla(urlAd, autosAp)).ancla;
        lista = autosAp;
        if (ancla) intro = `Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}! ¿Te refieres a este? 👇 Y de una vez te enseño otras buenas:`;
    }
    const apr = await armarAparador({ ancla, lista, saludoNombre: nm, intro });
    if (!apr) return null;
    await guardarEstadoAparador(tel, apr.aparador, duda || null);
    return { tipo: 'opener_aparador', segmentos: apr.segmentos, fotos: apr.fotos, fotos_after_index: apr.fotos_after_index };
}

module.exports = { espiarVision, identificarAncla, parsearCriterio, buscarInventario, armarAparador, resolverEleccion, autosRelacionados, RE_RELACIONADOS, inventarioActivo, portadaDe, fichaBreve, guardarEstadoAparador, intentarEleccionAparador, arranqueCarrusel };
