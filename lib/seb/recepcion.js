// lib/seb/recepcion.js — IGNACIO RECEPCIÓN (agente para VENDEDORES particulares)
//
// ══ PARIDAD (ley de la casa): este archivo es EL cerebro — el sandbox Y el
// WhatsApp real lo importan tal cual. Cambios aquí = cambian ambos.
//
// Arquitectura (workflow según Anthropic, NO agente autónomo):
//   1. ROUTER: regex + Haiku clasificador → intención "vendedor" despierta a Ignacio
//   2. MÁQUINA DE ESTADOS (puro código): tabla recepcion_sesiones con el checklist
//   3. NODOS IA (Haiku, salida json_schema forzada): extractor de ficha
//   4. RESPUESTAS: plantillas FIJAS con huecos — Ignacio JAMÁS improvisa (doctrina)
//   5. COMPUERTAS (puro código): dinero/comisión/valuación → ESCALA al owner
//   6. Checklist completo → el auto nace en REVISIÓN → el owner da el "va"
//
// Ignacio es RECEPCIONISTA, no vendedor ni negociador. Ante la duda → ESCALA.

const { query, run } = require('./db.js');

const HAIKU = 'claude-haiku-4-5';
const REQUISITOS = ['marca', 'modelo', 'anio', 'precio'];
const MIN_FOTOS = 4;   // orden owner 2026-07-16: mínimo 4 fotos para que nazca

// ── 1a. ROUTER regex (mismo patrón que clasificador.js RE_VENDEDOR) ──
const RE_VENDEDOR = /(quiero vender|quisiera vender|vendo mi|vendo un|vender mi|para vender|pongo en venta|en venta mi|rematar mi|remato mi|consigna|me compran|ustedes compran|compran (autos|carros|coches|camionetas|vehiculos)|cuanto me (dan|ofrecen|pagan) por mi|valuar mi|valuacion de mi|cotizar mi (auto|carro|camioneta|coche)|traigo (un|mi) (auto|carro|camioneta) (a|para) vend|tengo (un|mi) (auto|carro|camioneta) (que|para) vend|subir mi (auto|carro|camioneta)|publicar mi (auto|carro|camioneta)|anunciar mi (auto|carro|camioneta))/i;

// ── 5. COMPUERTA doctrina: dinero/comisión/valuación = venta = del OWNER ──
const RE_DINERO = /(cu[aá]nto me (dan|ofrecen|pagan)|comisi[oó]n|cu[aá]nto cobran|qu[eé] cobran|cobran algo|cobran por|valuaci[oó]n|val[uú]en|val[uú]ame|cu[aá]nto vale|me lo compran ustedes|ustedes lo compran|cu[aá]nto sale publicar|es gratis publicar|tiene alg[uú]n costo)/i;

function esVendedorTexto(texto) { return RE_VENDEDOR.test(String(texto || '')); }

// ── llamada Haiku con salida forzada (patrón de la casa: carga-lote/clasificador) ──
async function haiku(system, schema, texto, maxTokens) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return null;
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
                model: HAIKU, max_tokens: maxTokens || 300, system,
                messages: [{ role: 'user', content: String(texto).slice(0, 1500) }],
                output_config: { format: { type: 'json_schema', schema } }
            })
        });
        if (!r.ok) return null;
        const data = await r.json();
        const tb = (data.content || []).find(b => b.type === 'text');
        return JSON.parse(tb.text);
    } catch (e) { return null; }
}

// ── 1b. Clasificador IA (confirma vendedor cuando el regex no alcanza) ──
// PRIMERO describe (obliga a mirar antes de clasificar — lección del ojo de visión).
async function clasificarVendedorIA(texto) {
    return haiku(
        'Clasificas mensajes de WhatsApp de un marketplace de autos usados (México). PRIMERO explica qué quiere la persona, LUEGO clasifica. Comprador interesado en un auto NUESTRO = false. Persona que quiere vender/publicar/consignar SU PROPIO auto = true. Trade-in ("y de paso vendo el mío" dentro de una compra) = false. Responde SOLO el JSON.',
        { type: 'object', properties: {
            razon: { type: 'string', description: 'una frase: qué quiere la persona' },
            es_vendedor: { type: 'boolean' }
        }, required: ['razon', 'es_vendedor'], additionalProperties: false },
        texto, 150);
}

// ── 3. Extractor: saca TODO lo que traiga el mensaje (nunca re-preguntar) ──
async function extraerFicha(texto) {
    return haiku(
        'Extraes datos de mensajes de una persona que quiere vender su auto usado (México). Extrae SOLO lo que diga el texto; no inventes. precio SIEMPRE en pesos completos ("249,900"→249900; "250 mil"→250000). kilometraje en km ("45 mil km"→45000). anio = 4 dígitos. transmision: "Automatica"|"Manual" si se menciona. Si un campo no está: null. Responde SOLO el JSON.',
        { type: 'object', properties: {
            marca: { type: ['string', 'null'] }, modelo: { type: ['string', 'null'] },
            anio: { type: ['integer', 'null'] }, precio: { type: ['integer', 'null'] },
            kilometraje: { type: ['integer', 'null'] }, color: { type: ['string', 'null'] },
            transmision: { type: ['string', 'null'] }, duenos: { type: ['string', 'null'] },
            factura: { type: ['string', 'null'] },
            nombre_vendedor: { type: ['string', 'null'], description: 'nombre de la PERSONA si se presenta' },
            ubicacion: { type: ['string', 'null'], description: 'colonia/zona/ciudad donde se puede ver el auto' }
        }, required: ['marca', 'modelo', 'anio', 'precio', 'kilometraje', 'color', 'transmision', 'duenos', 'factura', 'nombre_vendedor', 'ubicacion'], additionalProperties: false },
        texto, 300);
}

// ── 2. Máquina de estados (tabla compartida sandbox↔real; tel de prueba por PREFIJO) ──
async function ensureRecepcion() {
    await run(`CREATE TABLE IF NOT EXISTS recepcion_sesiones (
        telefono TEXT PRIMARY KEY, estado TEXT, datos TEXT, fotos TEXT,
        created INTEGER, updated INTEGER)`);
}

async function sesionActiva(telefono) {
    await ensureRecepcion();
    const r = await query("SELECT * FROM recepcion_sesiones WHERE telefono=? AND estado IN ('recepcion','revision')", [telefono]);
    if (!r.length) return null;
    const s = r[0];
    try { s.datos = JSON.parse(s.datos || '{}'); } catch (e) { s.datos = {}; }
    try { s.fotos = JSON.parse(s.fotos || '[]'); } catch (e) { s.fotos = []; }
    return s;
}

async function guardarSesion(telefono, s) {
    await run(`INSERT INTO recepcion_sesiones (telefono, estado, datos, fotos, created, updated)
        VALUES (?,?,?,?,?,?) ON CONFLICT(telefono) DO UPDATE SET estado=excluded.estado, datos=excluded.datos, fotos=excluded.fotos, updated=excluded.updated`,
        [telefono, s.estado, JSON.stringify(s.datos), JSON.stringify(s.fotos), s.created || Date.now(), Date.now()]);
}

async function resetSesion(telefono) {
    await ensureRecepcion();
    await run("DELETE FROM recepcion_sesiones WHERE telefono=?", [telefono]);
}

function faltantes(s) {
    const f = [];
    const fx = REQUISITOS.filter(k => !s.datos[k]);
    if (fx.length) f.push('la ficha (' + fx.map(k => k === 'anio' ? 'año' : k).join(', ') + ')');
    if ((s.fotos || []).length < MIN_FOTOS) f.push(`fotos (mínimo ${MIN_FOTOS}, llevo ${(s.fotos || []).length})`);
    if (!s.datos.nombre_vendedor) f.push('tu nombre');
    if (!s.datos.ubicacion) f.push('la zona donde se puede ver');
    return f;
}

// ── 4. PLANTILLAS fijas (cero IA — el owner las calibra; huecos entre ${}) ──
const P = {
    saludo: (n) => [
        `¡Hola${n ? ' ' + n : ''}! Soy Ignacio de Fyradrive 🟢 Con gusto te ayudo a publicar tu auto.`,
        `Para darlo de alta necesito:\n📋 La ficha: marca, modelo, año y precio (si tienes km, color y transmisión, mejor)\n📸 Fotos del auto (mínimo ${MIN_FOTOS})\n📍 Tu nombre y en qué zona se puede ver`,
        `Mándamelo como te acomode y yo lo voy armando.`
    ],
    progreso: (s) => {
        const tengo = [];
        if (REQUISITOS.every(k => s.datos[k])) tengo.push(`✅ Ficha: ${s.datos.marca} ${s.datos.modelo} ${s.datos.anio} — $${Number(s.datos.precio).toLocaleString('es-MX')}` + (s.datos.kilometraje ? ` · ${Number(s.datos.kilometraje).toLocaleString('es-MX')} km` : ''));
        else if (s.datos.marca || s.datos.modelo) tengo.push(`✅ Anoté: ${[s.datos.marca, s.datos.modelo, s.datos.anio].filter(Boolean).join(' ')}`);
        if ((s.fotos || []).length >= MIN_FOTOS) tengo.push(`✅ Fotos: ${s.fotos.length}`);
        if (s.datos.nombre_vendedor) tengo.push(`✅ Nombre: ${s.datos.nombre_vendedor}`);
        if (s.datos.ubicacion) tengo.push(`✅ Zona: ${s.datos.ubicacion}`);
        const f = faltantes(s);
        const cuerpo = (tengo.length ? `Va quedando así:\n${tengo.join('\n')}` : '') +
            (f.length ? `${tengo.length ? '\n\n' : ''}Me falta: ${f.join(' · ')}` : '');
        return [cuerpo];
    },
    completo: (s) => [
        `¡Listo! ✅ Ya tengo todo:\n\n🚘 ${s.datos.marca} ${s.datos.modelo} ${s.datos.anio}\n💵 $${Number(s.datos.precio).toLocaleString('es-MX')}` +
        (s.datos.kilometraje ? `\n🛣 ${Number(s.datos.kilometraje).toLocaleString('es-MX')} km` : '') +
        (s.datos.color ? `\n🎨 ${s.datos.color}` : '') +
        (s.datos.transmision ? `\n⚙️ ${s.datos.transmision}` : '') +
        `\n📸 ${s.fotos.length} fotos\n👤 ${s.datos.nombre_vendedor} · 📍 ${s.datos.ubicacion}`,
        `Lo paso a revisión y en cuanto quede publicado en fyradrive.com te aviso por aquí mismo. 🤝`
    ],
    enRevision: () => [`Tu auto ya está en revisión ✅ En cuanto quede publicado te aviso por aquí. Si quieres agregar o corregir algo, dime.`],
    escala: () => [`Buena pregunta — eso te lo confirma directo mi compañero Sebastián, ahorita le paso tu chat para que te dé el detalle. Mientras, si me mandas la ficha y fotos voy adelantando la publicación. 👍`],
    noEntendi: () => [`Esa se la paso a mi compañero Sebastián para que te la confirme bien, ahorita te responde por aquí 👍`]
};

// ══ ORQUESTADOR: un mensaje del vendedor pasa por el workflow completo ══
// Devuelve: { despierta, activo, segmentos[], traza[], avisoOwner, escala, nacimiento, checklist }
async function procesarMensaje({ telefono, texto }) {
    const traza = [];
    const out = { despierta: false, activo: false, segmentos: [], traza, avisoOwner: null, escala: null, nacimiento: null, checklist: null };
    if (process.env.IGNACIO_RECEPCION === '0') { traza.push('[INTERRUPTOR] IGNACIO_RECEPCION=0 — apagado global'); return out; }

    let s = await sesionActiva(telefono);

    // ── Sin sesión: ¿despierta Ignacio? (router regex → clasificador IA) ──
    if (!s) {
        const rx = esVendedorTexto(texto);
        traza.push(rx ? `[ROUTER regex] match: "${String(texto).match(RE_VENDEDOR)[0]}"` : '[ROUTER regex] sin match → decide Haiku');
        let despierta = rx;
        if (!rx) {
            const c = await clasificarVendedorIA(texto);
            traza.push(c ? `[HAIKU clasificador] "${c.razon}" → es_vendedor=${c.es_vendedor}` : '[HAIKU clasificador] sin respuesta (fail-closed: NO despierta)');
            despierta = !!(c && c.es_vendedor);
        } else {
            const c = await clasificarVendedorIA(texto);
            if (c && !c.es_vendedor) { traza.push(`[HAIKU clasificador] contradice al regex ("${c.razon}") → NO despierta (doble candado)`); despierta = false; }
            else traza.push('[HAIKU clasificador] confirma vendedor ✓');
        }
        if (!despierta) return out;
        s = { estado: 'recepcion', datos: {}, fotos: [], created: Date.now() };
        traza.push('[ESTADO] sesión de recepción ABIERTA');
        out.despierta = true;
        out.avisoOwner = `🟢 Ignacio despertó con ${telefono} — quiere vender su auto`;
    }
    out.activo = true;

    // ── Compuerta doctrina (antes del modelo) ──
    if (RE_DINERO.test(texto)) {
        const m = String(texto).match(RE_DINERO)[0];
        traza.push(`[COMPUERTA 💰] "${m}" → ESCALA al owner (dinero = venta = del owner)`);
        out.escala = { motivo: 'vendedor pregunta dinero/comisión/valuación' };
        out.avisoOwner = `💰 Vendedor ${telefono} pregunta dinero: «${String(texto).slice(0, 120)}» — contéstale tú`;
        out.segmentos = P.escala();
        await guardarSesion(telefono, s);
        out.checklist = { datos: s.datos, fotos: s.fotos.length, faltan: faltantes(s) };
        return out;
    }

    // ── Ya en revisión: acuse simple ──
    if (s.estado === 'revision') {
        // aun en revisión el extractor corre: puede estar corrigiendo un dato
        const x = await extraerFicha(texto);
        const nuevos = x ? Object.entries(x).filter(([k, v]) => v !== null && s.datos[k] !== v) : [];
        if (nuevos.length) {
            nuevos.forEach(([k, v]) => s.datos[k] = v);
            traza.push(`[HAIKU extractor] corrección en revisión: ${nuevos.map(([k, v]) => k + '=' + v).join(', ')}`);
            await guardarSesion(telefono, s);
            out.avisoOwner = `✏️ Vendedor ${telefono} corrigió datos en revisión: ${nuevos.map(([k, v]) => k + '=' + v).join(', ')}`;
        } else traza.push('[ESTADO] en revisión — sin datos nuevos');
        out.segmentos = P.enRevision();
        out.checklist = { datos: s.datos, fotos: s.fotos.length, faltan: [] };
        return out;
    }

    // ── Extraer + fusionar al checklist (por CÓDIGO; jamás re-preguntar) ──
    const x = await extraerFicha(texto);
    const nuevos = x ? Object.entries(x).filter(([k, v]) => v !== null && !s.datos[k]) : [];
    nuevos.forEach(([k, v]) => s.datos[k] = v);
    traza.push(x
        ? (nuevos.length ? `[HAIKU extractor] capturó: ${nuevos.map(([k, v]) => k + '=' + v).join(', ')}` : '[HAIKU extractor] nada nuevo que extraer')
        : '[HAIKU extractor] sin respuesta — turno sin extracción');
    traza.push('[ESTADO] fusión al checklist por código');

    // ── COMPUERTA 🟡 LO QUE NO SE ENTIENDE, ESCALA — ANTES de seguir (orden owner
    // 2026-07-16, misma clave que con Seb). PERO aquí el flujo NO se detiene: la
    // palabra del owner NO pausa ni da posesión en recepción — la meta es CAPTAR
    // la ficha para que el auto NAZCA. Determinista: mensaje sin dato extraíble
    // que no es relleno de flujo (ok/gracias/ahí van las fotos...), o con pregunta
    // que Ignacio no puede contestar → aviso al owner + "te lo confirma Sebastián",
    // e Ignacio SIGUE con su checklist en la misma ráfaga. Ante la duda → escala.
    // relleno COMPUESTO ("ok ahorita te mando las fotos") = repetición de piezas de flujo
    const FILLER_PIEZA = '(ok(ay)?|va+|vale|listo|s[ií]+|claro( que s[ií])?|perfecto|gracias+|de acuerdo|buen[oa]s?( d[ií]as| tardes| noches)?|hola+|qu[eé] tal|ahorita|al rato|ya voy|un momento|espera(me)?|dame (chance|un momento)|ya|te (las? )?(mando|env[ií]o|paso)|las? (mando|env[ií]o|paso)|(mando|env[ií]o|paso) (las )?fotos|las fotos|fotos|son (esas|todas)|es[oa]s? son( todas)?|aqu[ií] (van|est[aá]n)|qu[eé] m[aá]s( te mando)?|algo m[aá]s|as[ií] (est[aá] bien|o m[aá]s)|est[aá] bien|sale|arre)';
    const RE_FILLER = new RegExp('^(?:' + FILLER_PIEZA + '[,.!?\\s]*)+$', 'i');
    let noEntendido = false;
    {
        const txt = String(texto || '').trim();
        const esFiller = RE_FILLER.test(txt);
        const tienePregunta = /\?/.test(txt);
        // la propia frase de vendedor ("quiero vender mi auto") NO es "no entendido":
        // es la puerta de entrada — el saludo/checklist la contesta
        const esFraseVendedor = RE_VENDEDOR.test(txt);
        if (!esFiller && !(esFraseVendedor && !tienePregunta) && (tienePregunta || (!nuevos.length && txt.split(/\s+/).length >= 3))) {
            noEntendido = true;
            traza.push('[COMPUERTA 🟡] no entendido' + (tienePregunta ? ' (trae pregunta)' : ' (sin dato extraíble)') + ' → ESCALA al owner y el flujo SIGUE (aquí tu palabra no pausa nada)');
            const aviso = `🟡 Ignacio no entendió a ${telefono}: «${txt.slice(0, 140)}» — contéstale tú (yo sigo juntando la ficha)`;
            out.avisoOwner = out.avisoOwner ? out.avisoOwner + '\n' + aviso : aviso;
            out.escala = out.escala || { motivo: 'mensaje no entendido en recepción' };
        }
    }

    const f = faltantes(s);
    const esPrimerTurno = out.despierta;
    if (!f.length) {
        s.estado = 'revision';
        traza.push('[PLANTILLA] completo → auto NACE EN REVISIÓN (falta el "va" del owner)');
        out.nacimiento = { datos: s.datos, fotos: s.fotos.length };
        out.avisoOwner = `🆕 Auto en revisión de ${telefono}: ${s.datos.marca} ${s.datos.modelo} ${s.datos.anio} — $${Number(s.datos.precio).toLocaleString('es-MX')} · ${s.fotos.length} fotos — responde PUBLÍCALO para activarlo`;
        out.segmentos = P.completo(s);
    } else if (esPrimerTurno) {
        traza.push('[PLANTILLA] saludo + requisitos');
        out.segmentos = P.saludo(s.datos.nombre_vendedor);
        if (nuevos.length) out.segmentos = out.segmentos.concat(P.progreso(s));
    } else {
        traza.push(`[PLANTILLA] progreso (faltan: ${f.join(', ')})`);
        out.segmentos = P.progreso(s);
    }
    // lo no entendido: "te lo confirma Sebastián" — y el checklist sigue en la misma ráfaga
    if (noEntendido) {
        out.segmentos = esPrimerTurno
            ? out.segmentos.slice(0, 3).concat(P.noEntendi(), out.segmentos.slice(3))
            : P.noEntendi().concat(out.segmentos);
    }
    await guardarSesion(telefono, s);
    out.checklist = { datos: s.datos, fotos: s.fotos.length, faltan: f };
    return out;
}

// ══ Fotos: entran por el puente (pool FIFO) o simuladas en sandbox ══
async function agregarFotos({ telefono, urls }) {
    const traza = [];
    const out = { activo: false, segmentos: [], traza, avisoOwner: null, escala: null, nacimiento: null, checklist: null };
    const s = await sesionActiva(telefono);
    if (!s) { traza.push('[ESTADO] sin sesión de recepción — fotos ignoradas (flujo normal)'); return out; }
    out.activo = true;
    if (s.estado === 'revision') { traza.push('[ESTADO] ya en revisión — fotos extra anotadas'); }
    s.fotos = (s.fotos || []).concat(urls || []);
    traza.push(`[PUENTE] ${(urls || []).length} foto(s) → pool de la sesión (total ${s.fotos.length})`);
    traza.push('[OJO DE VISIÓN] al nacer: Haiku visión ordena y elige portada diagonal (mismo ojo de carga-lote)');
    const f = faltantes(s);
    if (!f.length && s.estado !== 'revision') {
        s.estado = 'revision';
        traza.push('[PLANTILLA] completo → auto NACE EN REVISIÓN');
        out.nacimiento = { datos: s.datos, fotos: s.fotos.length };
        out.avisoOwner = `🆕 Auto en revisión de ${telefono}: ${s.datos.marca} ${s.datos.modelo} ${s.datos.anio} — $${Number(s.datos.precio).toLocaleString('es-MX')} · ${s.fotos.length} fotos — responde PUBLÍCALO para activarlo`;
        out.segmentos = P.completo(s);
    } else if (s.estado === 'revision') {
        out.segmentos = P.enRevision();
    } else {
        traza.push(`[PLANTILLA] progreso (faltan: ${f.join(', ')})`);
        out.segmentos = P.progreso(s);
    }
    await guardarSesion(telefono, s);
    out.checklist = { datos: s.datos, fotos: s.fotos.length, faltan: faltantes(s) };
    return out;
}

// ══ NACIMIENTO REAL (2026-07-16): sesión en 'revision' → el owner responde
// "PUBLÍCALO" → se publica en fyradrive.com como PARTICULAR (plantilla oscura,
// UID, Sales Brain) reusando el motor de la carga (ordenarFotos + publish-batch).
const WEB_PUB = 'https://www.fyradrive.com';
const OWNER_RECEPCION = '5218120066355';

async function publicarSesion(telefono) {
    const s = await sesionActiva(telefono);
    if (!s || s.estado !== 'revision') return { ok: false, error: 'sin sesión en revisión para ' + telefono };
    let fotos = s.fotos || [];
    try { const { ordenarFotos } = require('./carga-lote.js'); fotos = await ordenarFotos(fotos); } catch (e) { }
    const d = s.datos || {};
    const partes = String(d.nombre_vendedor || '').trim().split(/\s+/);
    const resp = await fetch(WEB_PUB + '/api/agency/publish-batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            tipo: 'particular', key: 'fyra-bridge-v2-2026',
            vendedor: { nombre: partes[0] || 'Vendedor', apellido: partes.slice(1).join(' ') || undefined, telefono: telefono, direccion: d.ubicacion || undefined },
            autos: [{
                marca: d.marca, modelo: d.modelo, anio: d.anio, precio: d.precio,
                kilometraje: d.kilometraje || undefined, color: d.color || undefined,
                transmision: d.transmision || undefined,
                comentarios: [d.duenos, d.factura].filter(Boolean).join('. ') || undefined,
                photos: fotos.map((u, i) => ({ url: u, isPrincipal: i === 0 }))
            }]
        })
    });
    const rj = await resp.json().catch(() => ({}));
    const okPub = resp.ok && rj && rj.ok !== false && rj.created && rj.created.length;
    if (!okPub) {
        const err = (rj.errors && rj.errors[0] && rj.errors[0].error) || rj.error || ('web ' + resp.status);
        return { ok: false, error: String(err).slice(0, 200), sesion: s };
    }
    await run("UPDATE recepcion_sesiones SET estado='publicada', updated=? WHERE telefono=?", [Date.now(), telefono]);
    return { ok: true, auto: rj.created[0], sesion: s };
}

// Publica la sesión EN REVISIÓN más reciente (para el "PUBLÍCALO" del owner).
async function publicarPendiente() {
    await ensureRecepcion();
    const r = await query("SELECT telefono FROM recepcion_sesiones WHERE estado='revision' ORDER BY updated DESC LIMIT 1");
    if (!r.length) return { ok: false, error: 'no hay autos en revisión' };
    return publicarSesion(r[0].telefono);
}

module.exports = { procesarMensaje, agregarFotos, sesionActiva, resetSesion, esVendedorTexto, RE_DINERO, ensureRecepcion, publicarSesion, publicarPendiente, OWNER_RECEPCION };
