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
// LA FICHA (orden owner 2026-07-16): esto es lo que palomea la ficha técnica.
// Aparte: precio, legal (adeudos + a su nombre), fotos, y contacto (nombre + tel + ciudad).
const REQUISITOS = ['marca', 'modelo', 'anio', 'duenos', 'factura', 'kilometraje'];
const MIN_FOTOS = 4;   // orden owner 2026-07-16: mínimo 4 fotos para que nazca

// ── 1a. ROUTER regex (mismo patrón que clasificador.js RE_VENDEDOR) ──
const RE_VENDEDOR = /(quiero vender|quisiera vender|vendo mi|vendo un|vender mi|para vender|pongo en venta|en venta mi|rematar mi|remato mi|consigna|me compran|ustedes compran|compran (autos|carros|coches|camionetas|vehiculos)|cuanto me (dan|ofrecen|pagan) por mi|valuar mi|valuacion de mi|cotizar mi (auto|carro|camioneta|coche)|traigo (un|mi) (auto|carro|camioneta) (a|para) vend|tengo (un|mi) (auto|carro|camioneta) (que|para) vend|subir mi (auto|carro|camioneta)|publicar mi (auto|carro|camioneta)|anunciar mi (auto|carro|camioneta))/i;

// ── 5. COMPUERTA doctrina: dinero/comisión/valuación = venta = del OWNER ──
// OJO (orden owner 2026-07-16): las preguntas de COSTO DE PUBLICAR (¿es gratis?,
// ¿tiene costo?, ¿cobran algo?) ya NO escalan — las contesta el machote de info
// ("no pagas nada por adelantado, solo comisión al venderse"). Lo que pregunta
// MONTOS (cuánto cobran, la comisión, valuación) sigue siendo del owner.
const RE_DINERO = /(cu[aá]nto me (dan|ofrecen|pagan)|comisi[oó]n|cu[aá]nto cobran|qu[eé] cobran|valuaci[oó]n|val[uú]en|val[uú]ame|cu[aá]nto vale)/i;

// ── 6b. "¿COMPRAN AUTOS?" (orden owner 2026-07-16, caso training): pregunta si le
// COMPRAMOS su auto directo → machote predefinido (no somos compradores: lo ayudamos
// a vender). Antes escalaba 💰 o se quedaba sin contestar junto a otra pregunta.
const RE_COMPRAN = /(compran (autos|carros|coches|camionetas|veh[ií]culos)|me lo compran|ustedes( me)?( lo)? compran|se lo (vendo|puedo vender) a ustedes|le puedo vender a ustedes|t[uú] me lo compras|lo compran de contado)/i;

// ── 6. TRIGGER DE INFORMACIÓN (orden owner 2026-07-16): "¿cómo funcionan?",
// "más información para vender mi auto"... → machote del owner, sin escalar.
// Igual que Seb: regex Paso 0; si no matchea pero el mensaje iba a caer al 🟡,
// Haiku confirma la INTENCIÓN (¿está pidiendo info del servicio?) antes de escalar.
const RE_INFO = /(c[oó]mo funciona[ns]?|c[oó]mo le hacen|c[oó]mo trabajan|c[oó]mo es el (proceso|rollo|tema|asunto)|en qu[eé] consiste|c[oó]mo est[aá] el (rollo|tema|asunto)|m[aá]s informaci[oó]n|informaci[oó]n para vender|dar(me)? informes|informes para vender|qu[eé] necesito para vender|c[oó]mo puedo vender|es gratis( publicar(lo)?)?\??|tiene alg[uú]n costo|cobran algo|cu[aá]nto sale publicar)/i;

async function clasificarPideInfoIA(texto) {
    const schema = {
        type: 'object',
        properties: {
            razon: { type: 'string', description: 'una línea: qué está pidiendo el mensaje' },
            pide_info: { type: 'boolean', description: 'true SOLO si pregunta cómo funciona el servicio de venta / qué necesita para vender / condiciones generales (respondible con el pitch general). false si es una duda específica (estado del auto, adeudos, legal, montos) o cualquier otra cosa.' }
        },
        required: ['razon', 'pide_info'], additionalProperties: false
    };
    return haiku('Clasificas mensajes de personas que quieren vender su auto usado a un marketplace (Monterrey). Responde SOLO el JSON.', schema, texto, 150);
}

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
        'Extraes datos de mensajes de una persona que quiere vender su auto usado (México). Extrae SOLO lo que diga el texto; no inventes. precio SIEMPRE en pesos completos ("249,900"→249900; "250 mil"→250000). kilometraje en km ("45 mil km"→45000). anio = 4 dígitos. transmision: "Automatica"|"Manual" si se menciona. duenos: cuántos dueños ha tenido ("único dueño"→"1"). factura: tipo de factura ("agencia", "refacturado", "endosada"...). adeudos: true si DICE que debe algo/tiene adeudo, false si dice que NO debe nada/sin adeudos, null si no lo menciona. a_su_nombre: true si dice que está a su nombre, false si dice que NO, null si no lo menciona. telefono_contacto: número de teléfono si da uno (solo dígitos). Si un campo no está: null. Responde SOLO el JSON.',
        { type: 'object', properties: {
            marca: { type: ['string', 'null'] }, modelo: { type: ['string', 'null'] },
            anio: { type: ['integer', 'null'] }, precio: { type: ['integer', 'null'] },
            kilometraje: { type: ['integer', 'null'] }, color: { type: ['string', 'null'] },
            transmision: { type: ['string', 'null'] }, duenos: { type: ['string', 'null'] },
            factura: { type: ['string', 'null'] },
            adeudos: { type: ['boolean', 'null'] }, a_su_nombre: { type: ['boolean', 'null'] },
            telefono_contacto: { type: ['string', 'null'] },
            nombre_vendedor: { type: ['string', 'null'], description: 'nombre de la PERSONA si se presenta' },
            ubicacion: { type: ['string', 'null'], description: 'ciudad donde vive (Monterrey, San Pedro, Escobedo, Apodaca, San Nicolás, Guadalupe...)' }
        }, required: ['marca', 'modelo', 'anio', 'precio', 'kilometraje', 'color', 'transmision', 'duenos', 'factura', 'adeudos', 'a_su_nombre', 'telefono_contacto', 'nombre_vendedor', 'ubicacion'], additionalProperties: false },
        texto, 400);
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

// PREGUNTAS DIRECTAS (orden owner 2026-07-16): nada de "me falta: X" — se pregunta
// el dato directo y se va palomeando. OJO booleanos: false ES un dato capturado
// (por eso se compara con == null, no con !valor).
function faltantes(s) {
    const d = s.datos || {};
    const f = [];
    if (!d.marca || !d.modelo || !d.anio) f.push('¿Qué auto es? (marca, modelo y año)');
    if (d.duenos == null) f.push('¿Cuántos dueños ha tenido?');
    if (!d.factura) f.push('¿Qué tipo de factura tiene?');
    if (d.kilometraje == null) f.push('¿Qué kilometraje tiene?');
    if (d.precio == null) f.push('¿A qué precio lo quieres vender?');
    if (d.adeudos == null) f.push('¿El auto tiene algún adeudo?');
    if (d.a_su_nombre == null) f.push('¿Está a tu nombre?');
    if ((s.fotos || []).length < MIN_FOTOS) f.push(`Mándame las fotos del auto (mínimo ${MIN_FOTOS}${(s.fotos || []).length ? ', llevo ' + s.fotos.length : ''})`);
    if (!d.nombre_vendedor) f.push('¿Cuál es tu nombre?');
    if (!d.telefono_contacto) f.push('¿Me compartes un número de contacto?');
    if (!d.ubicacion) f.push('¿En qué ciudad vives? (Monterrey, San Pedro, Escobedo, Apodaca, San Nicolás...)');
    return f;
}

// ── 4. PLANTILLAS fijas (cero IA — el owner las calibra; huecos entre ${}) ──
const P = {
    saludo: (n) => [
        `¡Hola${n ? ' ' + n : ''}! Soy Ignacio de Fyradrive 🟢 Aquí te vamos a ayudar a vender tu auto.`,
        `Para ayudarte a venderlo mándame:\n📋 Marca, modelo, año, cuántos dueños ha tenido, tipo de factura y kilometraje\n💵 A qué precio lo quieres vender\n🧾 Si tiene algún adeudo y si está a tu nombre\n📸 Fotos del auto (mínimo ${MIN_FOTOS})\n👤 Tu nombre, un número de contacto y en qué ciudad vives (Monterrey, San Pedro, Escobedo, Apodaca, San Nicolás...)`,
        `Mándamelo como te acomode y yo lo voy palomeando ✅`
    ],
    progreso: (s) => {
        const d = s.datos || {};
        const tengo = [];
        if (REQUISITOS.every(k => d[k] != null)) tengo.push(`✅ Ficha: ${d.marca} ${d.modelo} ${d.anio} — ${d.duenos} dueño(s) · factura ${d.factura} · ${Number(d.kilometraje).toLocaleString('es-MX')} km`);
        else if (d.marca || d.modelo) tengo.push(`✅ Anoté: ${[d.marca, d.modelo, d.anio].filter(Boolean).join(' ')}`);
        if (d.precio != null) tengo.push(`✅ Precio: $${Number(d.precio).toLocaleString('es-MX')}`);
        if (d.adeudos != null || d.a_su_nombre != null) tengo.push(`✅ Legal: ${[d.adeudos != null ? (d.adeudos ? 'con adeudo' : 'sin adeudos') : null, d.a_su_nombre != null ? (d.a_su_nombre ? 'a tu nombre' : 'no está a tu nombre') : null].filter(Boolean).join(' · ')}`);
        if ((s.fotos || []).length >= MIN_FOTOS) tengo.push(`✅ Fotos: ${s.fotos.length}`);
        if (d.nombre_vendedor) tengo.push(`✅ ${[d.nombre_vendedor, d.telefono_contacto, d.ubicacion].filter(Boolean).join(' · ')}`);
        const f = faltantes(s);
        const cuerpo = (tengo.length ? `Va quedando así:\n${tengo.join('\n')}` : '') +
            (f.length ? `${tengo.length ? '\n\n' : ''}${f.join('\n')}` : '');
        return [cuerpo];
    },
    completo: (s) => {
        const d = s.datos;
        return [
            `¡Listo! ✅ Ya tengo todo:\n\n🚘 ${d.marca} ${d.modelo} ${d.anio}\n💵 $${Number(d.precio).toLocaleString('es-MX')}\n🛣 ${Number(d.kilometraje).toLocaleString('es-MX')} km · ${d.duenos} dueño(s) · factura ${d.factura}\n🧾 ${d.adeudos ? 'Con adeudo' : 'Sin adeudos'} · ${d.a_su_nombre ? 'a tu nombre' : 'no está a tu nombre'}` +
            (d.color ? `\n🎨 ${d.color}` : '') +
            (d.transmision ? `\n⚙️ ${d.transmision}` : '') +
            `\n📸 ${s.fotos.length} fotos\n👤 ${d.nombre_vendedor} · 📞 ${d.telefono_contacto} · 📍 ${d.ubicacion}`,
            `Lo paso a revisión y en cuanto quede publicado en fyradrive.com te aviso por aquí mismo. 🤝`
        ];
    },
    enRevision: () => [`Tu auto ya está en revisión ✅ En cuanto quede publicado te aviso por aquí. Si quieres agregar o corregir algo, dime.`],
    // MACHOTE DE INFORMACIÓN — texto del owner tal cual (2026-07-16), cero IA
    comoFunciona: () => [
        `¡Qué tal! Claro, te explico — es muy simple:`,
        `Tú nos mandas todos los datos de tu auto, lo verificamos, y lo publicamos en fyradrive. Atendemos a cada interesado al instante, filtramos a los curiosos y te mandamos reporte cada semana de cómo va (si es que no se vende antes).`,
        `Tú no pagas nada por adelantado 👍 Solo cobramos comisión cuando tu auto ya se vendió.`,
        `Y vendemos más rápido que un particular porque le ofrecemos herramientas de compra y seguridad a tu comprador.`,
        `La cita para que vean el auto y la compra son en punto seguro que nosotros coordinamos más adelante ahí mismo con nosotros.`,
        `¿Te animas? Mándame las fotos, km y datos de tu auto y hoy mismo lo dejamos publicado ✅`,
        `Prácticamente tienes un agente personal con la misión de vender tu auto.`
    ],
    // MACHOTE "¿COMPRAN AUTOS?" — borrador (el owner calibra el texto)
    compranAutos: () => [
        `Nosotros no lo compramos directo — hacemos algo mejor por ti: te ayudamos a venderlo 🤝`,
        `Publicamos tu auto en fyradrive, atendemos a cada interesado al instante, filtramos a los curiosos y coordinamos la venta en punto seguro. Tú no pagas nada por adelantado 👍 solo cobramos comisión cuando tu auto ya se vendió.`,
        `¿Te animas? Mándame los datos y fotos de tu auto y hoy mismo lo dejamos publicado ✅`
    ]
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

    // ── Compuerta doctrina (antes del modelo) — ESCALA MUDA (orden owner 2026-07-16):
    // dinero = venta = del owner, y el vendedor NO recibe nada: silencio total en ese
    // turno; el owner contesta él con la cifra.
    if (RE_DINERO.test(texto)) {
        const m = String(texto).match(RE_DINERO)[0];
        traza.push(`[COMPUERTA 💰] "${m}" → ESCALA MUDA al owner (dinero = venta = del owner; el bot se calla)`);
        out.escala = { motivo: 'vendedor pregunta dinero/comisión/valuación' };
        out.avisoOwner = `💰 Vendedor ${telefono} pregunta dinero: «${String(texto).slice(0, 120)}» — contéstale tú`;
        out.segmentos = [];
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
    // OJO: se compara con == null porque false ES un dato capturado (adeudos/a_su_nombre)
    const x = await extraerFicha(texto);
    const nuevos = x ? Object.entries(x).filter(([k, v]) => v !== null && s.datos[k] == null) : [];
    nuevos.forEach(([k, v]) => s.datos[k] = v);
    // atajo determinista: "este mismo" como número de contacto = su WhatsApp —
    // solo ("este mismo") o dentro de frase con contexto de teléfono ("mi cel es este mismo")
    {
        const txtTel = String(texto || '').trim();
        const soloMismo = /^(este( mismo)?( n[uú]mero)?|a este( mismo)?( n[uú]mero)?|el mismo|al que me (escribes|est[aá]s escribiendo))[.!\s]*$/i.test(txtTel);
        const fraseMismo = /\b(este mismo|el mismo|al que me escribes|por aqu[ií] mismo|a este)\b/i.test(txtTel) && /(cel|tel[eé]fono|n[uú]mero|contacto|whats)/i.test(txtTel);
        if (s.datos.telefono_contacto == null && (soloMismo || fraseMismo)) {
            s.datos.telefono_contacto = String(telefono).replace(/\D/g, '');
            nuevos.push(['telefono_contacto', s.datos.telefono_contacto]);
            traza.push('[CÓDIGO] telefono_contacto = su WhatsApp ("este mismo")');
        }
    }
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
    let noEntendido = false, pideInfo = false, pideCompran = false;
    {
        const txt = String(texto || '').trim();
        const esFiller = RE_FILLER.test(txt);
        const tienePregunta = /\?/.test(txt);
        // la propia frase de vendedor ("quiero vender mi auto") NO es "no entendido":
        // es la puerta de entrada — el saludo/checklist la contesta
        const esFraseVendedor = RE_VENDEDOR.test(txt);
        // ── TRIGGER "¿COMPRAN AUTOS?" (antes que info: si vienen juntas, este machote
        // contesta las DOS — caso training: la segunda pregunta se quedaba muda)
        if (RE_COMPRAN.test(txt)) {
            pideCompran = true;
            traza.push(`[TRIGGER COMPRAN regex] "${txt.match(RE_COMPRAN)[0]}" → machote compranAutos`);
        } else if (RE_INFO.test(txt)) {
            // ── TRIGGER INFO (Paso 0, regex): "¿cómo funcionan?" → machote, sin escalar
            pideInfo = true;
            traza.push(`[TRIGGER INFO regex] "${txt.match(RE_INFO)[0]}" → machote del owner`);
        } else if (!esFiller && !(esFraseVendedor && !tienePregunta) && (tienePregunta || (!nuevos.length && txt.split(/\s+/).length >= 3))) {
            // iba a caer al 🟡 → Haiku confirma la INTENCIÓN primero (como Seb):
            // si "recae" a pedir info del servicio, machote; si no, escalada muda.
            const ci = await clasificarPideInfoIA(txt);
            if (ci && ci.pide_info) {
                pideInfo = true;
                traza.push(`[HAIKU intención] "${ci.razon}" → pide_info=true → machote del owner`);
            } else {
                noEntendido = true;
                traza.push('[COMPUERTA 🟡] no entendido' + (tienePregunta ? ' (trae pregunta)' : ' (sin dato extraíble)') + (ci ? ` — Haiku: "${ci.razon}"` : '') + ' → ESCALA MUDA al owner y el flujo SIGUE');
                const aviso = `🟡 Ignacio no entendió a ${telefono}: «${txt.slice(0, 140)}» — contéstale tú (yo sigo juntando la ficha)`;
                out.avisoOwner = out.avisoOwner ? out.avisoOwner + '\n' + aviso : aviso;
                out.escala = out.escala || { motivo: 'mensaje no entendido en recepción' };
            }
        }
    }

    const f = faltantes(s);
    const esPrimerTurno = out.despierta;
    if (!f.length) {
        s.estado = 'revision';
        traza.push('[PLANTILLA] completo → auto NACE EN REVISIÓN (falta el "va" del owner)');
        out.nacimiento = { datos: s.datos, fotos: s.fotos.length };
        out.avisoOwner = `🆕 Auto en revisión de ${telefono}: ${s.datos.marca} ${s.datos.modelo} ${s.datos.anio} — $${Number(s.datos.precio).toLocaleString('es-MX')} · ${Number(s.datos.kilometraje).toLocaleString('es-MX')} km · ${s.datos.duenos} dueño(s) · factura ${s.datos.factura} · ${s.datos.adeudos ? 'CON ADEUDO ⚠️' : 'sin adeudos'} · ${s.datos.a_su_nombre ? 'a su nombre' : 'NO a su nombre ⚠️'} · ${s.fotos.length} fotos · ${s.datos.nombre_vendedor} ${s.datos.telefono_contacto || ''} (${s.datos.ubicacion}) — responde PUBLÍCALO para activarlo`;
        out.segmentos = P.completo(s);
    } else if (esPrimerTurno) {
        traza.push('[PLANTILLA] saludo + requisitos');
        out.segmentos = P.saludo(s.datos.nombre_vendedor);
        if (nuevos.length) out.segmentos = out.segmentos.concat(P.progreso(s));
    } else {
        traza.push(`[PLANTILLA] progreso (faltan: ${f.join(', ')})`);
        out.segmentos = P.progreso(s);
    }
    // pidió INFO o "¿compran autos?" → machote del owner (sustituye al saludo: ES el
    // pitch); si ya hay algo capturado, el progreso va de pilón para seguir jalando
    if ((pideInfo || pideCompran) && f.length) {
        traza.push('[PLANTILLA] machote ' + (pideCompran ? 'compranAutos' : 'de información del owner'));
        out.segmentos = pideCompran ? P.compranAutos() : P.comoFunciona();
        if (Object.keys(s.datos).length || (s.fotos || []).length) out.segmentos = out.segmentos.concat(P.progreso(s));
    }
    // lo no entendido se escala MUDO (orden owner 2026-07-16): el vendedor no se
    // entera — solo sigue el checklist; el owner ya recibió el aviso 🟡 y contesta él.
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
        out.avisoOwner = `🆕 Auto en revisión de ${telefono}: ${s.datos.marca} ${s.datos.modelo} ${s.datos.anio} — $${Number(s.datos.precio).toLocaleString('es-MX')} · ${Number(s.datos.kilometraje).toLocaleString('es-MX')} km · ${s.datos.duenos} dueño(s) · factura ${s.datos.factura} · ${s.datos.adeudos ? 'CON ADEUDO ⚠️' : 'sin adeudos'} · ${s.datos.a_su_nombre ? 'a su nombre' : 'NO a su nombre ⚠️'} · ${s.fotos.length} fotos · ${s.datos.nombre_vendedor} ${s.datos.telefono_contacto || ''} (${s.datos.ubicacion}) — responde PUBLÍCALO para activarlo`;
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
            vendedor: { nombre: partes[0] || 'Vendedor', apellido: partes.slice(1).join(' ') || undefined, telefono: (d.telefono_contacto || telefono), direccion: d.ubicacion || undefined },
            autos: [{
                marca: d.marca, modelo: d.modelo, anio: d.anio, precio: d.precio,
                kilometraje: d.kilometraje || undefined, color: d.color || undefined,
                transmision: d.transmision || undefined,
                comentarios: [
                    d.duenos ? d.duenos + ' dueño(s)' : null,
                    d.factura ? 'Factura ' + d.factura : null,
                    d.adeudos === false ? 'Sin adeudos' : (d.adeudos === true ? 'Con adeudo' : null),
                    d.a_su_nombre === false ? 'No está a nombre del vendedor' : null
                ].filter(Boolean).join('. ') || undefined,
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
