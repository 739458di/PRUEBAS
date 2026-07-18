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
// (auditoría #11 2026-07-17: "cuánto ME cobran", "cuánto me van a cobrar", "qué
// tanto cobran", "cuánto cobrarían" esquivaban el regex → ampliado)
const RE_DINERO = /(cu[aá]nto (me )?(dan|ofrecen|pagan)|comisi[oó]n|cu[aá]nto (me )?(van a )?cobra(n|r[ií]an|r)?|qu[eé] (me )?cobran|qu[eé] tanto (cobran|me cobran)|valuaci[oó]n|val[uú]en|val[uú]ame|cu[aá]nto vale)/i;

// La LÍNEA de la ráfaga que disparó un trigger — JAMÁS citar la ráfaga entera
// (auditoría/caso Kia: el aviso citaba la ficha completa + la pregunta y parecía
// que Ignacio no había entendido nada). Se cita solo lo que importa.
function lineaDe(txt, re) {
    for (const l of String(txt || '').split(/\n+/)) if (re.test(l)) return l.trim().slice(0, 120);
    return String(txt || '').trim().slice(0, 120);
}
// Para el 🟡 genérico: la línea con "?" (la duda), si no la última línea
function lineaDuda(txt) {
    const lineas = String(txt || '').split(/\n+/).map(l => l.trim()).filter(Boolean);
    return (lineas.find(l => l.includes('?')) || lineas[lineas.length - 1] || '').slice(0, 140);
}
// Señal de CORRECCIÓN explícita ("no, son 95 mil", "perdón, me equivoqué")
const RE_CORRECCION = /(no,? (es|son|era)|me equivoqu[eé]|perd[oó]n|una disculpa|corrijo|error m[ií]o|mejor dicho|quise decir|est[aá] mal|no era)/i;

// ── 6b. "¿COMPRAN AUTOS?" (orden owner 2026-07-16, caso training): pregunta si le
// COMPRAMOS su auto directo → machote predefinido (no somos compradores: lo ayudamos
// a vender). Antes escalaba 💰 o se quedaba sin contestar junto a otra pregunta.
const RE_COMPRAN = /(compran (autos|carros|coches|camionetas|veh[ií]culos)|me lo compran|ustedes( me)?( lo)? compran|se lo (vendo|puedo vender) a ustedes|le puedo vender a ustedes|t[uú] me lo compras|lo compran de contado)/i;

// ── 6c. "¿DÓNDE SE UBICAN?" (bug sandbox 2026-07-16: caía al juez y contestaba
// otra cosa) → llave determinista con los hechos de la casa.
const RE_UBICAN = /(d[oó]nde (se ubican|est[aá]n( ubicados)?|los (encuentro|ubico)|queda[n]?|es la cita)|ubicaci[oó]n de ustedes|cu[aá]l es su (direcci[oó]n|ubicaci[oó]n)|tienen (local|oficina|sucursal|lote|agencia f[ií]sica)|d[oó]nde ser[ií]a la (cita|venta))/i;

// ── 6d. DATOS DE FICHA como INICIADOR (orden owner 2026-07-16): un primer contacto
// que abre con km/factura/dueños es un vendedor mandando su ficha — despierta a
// Ignacio (el doble candado Haiku confirma; comprador no abre así).
// (auditoría #16: "88 mil kilómetros" y "80000 kms" no matcheaban → ampliado)
const RE_FICHA_SENAL = /(\d[\d.,]*\s*(mil\s*)?(km|kms|kil[oó]metros?)\b|kilometraje|factura( de)? (agencia|original|endosada)|[uú]nico dueño|\d+\s*dueñ[oa]s?)/i;

// Señal SUAVE de venta para el rescate Haiku en primer contacto (auditoría #9:
// "me gustaría que me ayudaran a vender el coche de mi papá" no matcheaba el
// regex duro y el clasificador IA era código muerto — la compuerta lo mataba antes)
const RE_VENTA_SUAVE = /(vend|venta|consign|publicar|subir|anunciar|rematar)/i;

// ── 6e. DUEÑO CONOCIDO que vuelve por OTRO auto ("te subo otro carro") ──
const RE_OTRO_AUTO = /(otro (auto|carro|coche|camioneta|veh[ií]culo)|subir otro|vender otro|publicar otro|te (mando|paso|subo) otro|el segundo (auto|carro)|uno m[aá]s)/i;

// ── 6. TRIGGER DE INFORMACIÓN (orden owner 2026-07-16): "¿cómo funcionan?",
// "más información para vender mi auto"... → machote del owner, sin escalar.
// Igual que Seb: regex Paso 0; si no matchea pero el mensaje iba a caer al 🟡,
// Haiku confirma la INTENCIÓN (¿está pidiendo info del servicio?) antes de escalar.
const RE_INFO = /(c[oó]mo funciona[ns]?|c[oó]mo le hacen|c[oó]mo trabajan|c[oó]mo es el (proceso|rollo|tema|asunto)|en qu[eé] consiste|c[oó]mo est[aá] el (rollo|tema|asunto)|m[aá]s informaci[oó]n|informaci[oó]n para vender|dar(me)? informes|informes para vender|qu[eé] necesito para vender|c[oó]mo puedo vender|es gratis( publicar(lo)?)?\??|tiene alg[uú]n costo|cobran algo|cu[aá]nto sale publicar)/i;

// ══ EL JUEZ (SS4 de la escalera, sellado 2026-07-16) — último peldaño antes de
// escalar. IA que ELIGE (machote / responder / escalar), jamás divaga: si responde,
// SOLO puede usar los HECHOS del skill + el historial de ESTE chat, y un CANDADO de
// código revisa lo que salió. Sesgado a escalar: ante la duda, muda al owner.
// Haiku (ahorrativo) — solo corre en el ~% chico de mensajes que nadie reclamó.
const SKILL_HECHOS = `- Publicamos el auto en fyradrive.com y lo ayudamos a vender (NO lo compramos directo)
- No paga nada por adelantado; hay una comisión SOLO cuando el auto ya se vendió (el monto lo confirma Sebastián, tú no lo sabes)
- Atendemos a los interesados al instante, filtramos curiosos, y le mandamos reporte semanal de cómo va
- Las citas para ver el auto y la compra son en punto seguro que nosotros coordinamos
- Para publicar necesitamos: ficha (marca, modelo, año, dueños, tipo de factura, km), el precio al que lo quiere vender, si tiene adeudos y si está a su nombre, mínimo 4 fotos, su nombre, un teléfono y su ciudad
- El auto sigue siendo suyo todo el tiempo y él decide a quién venderle
- Trabajamos Monterrey y su área metropolitana`;

async function juezRecepcion(texto, historial) {
    return haiku(
        'Eres el juez de Ignacio (recepción de VENDEDORES de autos de Fyradrive, Monterrey). Decide cómo tratar ÚNICAMENTE el MENSAJE ACTUAL del vendedor — el HISTORIAL es solo contexto de fondo: JAMÁS contestes preguntas viejas del historial (ya fueron contestadas), y si el mensaje actual no trae una pregunta nueva clara y contestable, elige "escalar". Acciones: "machote_info" = el MENSAJE pregunta cómo funciona el servicio en general → se le manda el pitch. "machote_compran" = el MENSAJE pregunta si le COMPRAMOS su auto directo (solo si lo pregunta AHORA, no si lo preguntó antes). "responder" = SOLO si la duda DEL MENSAJE se contesta CON SEGURIDAD usando ÚNICAMENTE los HECHOS (respuesta de 1-2 frases que responde EXACTAMENTE lo que el mensaje pregunta; tono amable y profesional — cercano pero sobrio, sin "compa"/"carnal"; JAMÁS inventes cifras, montos, porcentajes, plazos garantizados ni políticas que no estén en los hechos). "escalar" = CUALQUIER otra cosa: temas legales delicados, negociación, montos, UBICACIÓN (dónde estamos/dónde sería la cita — eso lo contesta Sebastián), casos particulares del auto, o si la respuesta no está clarita en los hechos. Regla de oro: ante la MÍNIMA duda → escalar. Responde SOLO el JSON.',
        { type: 'object', properties: {
            razon: { type: 'string', description: 'una línea: qué busca / qué pregunta' },
            accion: { type: 'string', enum: ['machote_info', 'machote_compran', 'responder', 'escalar'] },
            respuesta: { type: ['string', 'null'], description: 'SOLO si accion=responder: la respuesta breve; si no, null' }
        }, required: ['razon', 'accion', 'respuesta'], additionalProperties: false },
        'HECHOS (lo único que sabes):\n' + SKILL_HECHOS + '\n\nHISTORIAL RECIENTE DE ESTE CHAT:\n' + (historial || '(sin historial)') + '\n\nMENSAJE DEL VENDEDOR:\n"' + String(texto).slice(-400) + '"',
        400);
}

// El CANDADO del juez (código, no IA): corto, sin cifras, sin promesas — o no sale.
function candadoJuez(r) {
    if (!r || typeof r !== 'string') return false;
    if (r.length > 320) return false;
    if (/\$\s?\d|\d+\s*%|por ?ciento|garantiz|te aseguro|prometo|m[aá]ximo \d|en \d+ (d[ií]as|semanas)/i.test(r)) return false;
    // auditoría #19: montos y plazos EN LETRA también se bloquean
    if (/(cien(to)?s?|doscient|trescient|cuatrocient|quinient|seiscient|setecient|ochocient|novecient|mil(es)?) (de )?pesos|medio mill[oó]n|un mill[oó]n|en (un|una|dos|tres) (d[ií]as?|semanas?|mes(es)?)/i.test(r)) return false;
    return true;
}

const normx = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

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
        'Extraes datos de mensajes de una persona que quiere vender su auto usado (México). Extrae SOLO lo que diga el texto; no inventes. precio SIEMPRE en pesos completos ("249,900"→249900; "250 mil"→250000; "lo dejo en 240"→240000). kilometraje en km ("45 mil km"→45000). anio = 4 dígitos. transmision: "Automatica"|"Manual" si se menciona. duenos: cuántos dueños ha tenido ("único dueño"→"1"). factura: tipo de factura ("agencia", "refacturado", "endosada"...). adeudos: true si DICE que debe algo/tiene adeudo, false si dice que NO debe nada/sin adeudos, null si no lo menciona. a_su_nombre: true si dice que está a su nombre, false si dice que NO, null si no lo menciona. telefono_contacto: número de teléfono si da uno (solo dígitos). Si un campo no está: null. Responde SOLO el JSON.',
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

// ══ DUEÑO CONOCIDO (orden owner 2026-07-17): UN dueño, VARIOS autos (ilimitados).
// Al publicar un auto se guarda su identidad (nombre/tel/ciudad) — la próxima vez
// Ignacio NO se presenta ni re-pregunta sus datos: solo varía el auto. Las citas
// y el pricing ya agrupan por dueño en la web (vendedor por teléfono).
async function ensureDuenos() {
    await run(`CREATE TABLE IF NOT EXISTS recepcion_duenos (
        telefono TEXT PRIMARY KEY, nombre TEXT, telefono_contacto TEXT, ciudad TEXT,
        autos INTEGER DEFAULT 0, updated INTEGER)`);
}
async function registrarDueno(telefono, d) {
    await ensureDuenos();
    await run(`INSERT INTO recepcion_duenos (telefono, nombre, telefono_contacto, ciudad, autos, updated) VALUES (?,?,?,?,1,?)
        ON CONFLICT(telefono) DO UPDATE SET nombre=COALESCE(excluded.nombre, recepcion_duenos.nombre),
        telefono_contacto=COALESCE(excluded.telefono_contacto, recepcion_duenos.telefono_contacto),
        ciudad=COALESCE(excluded.ciudad, recepcion_duenos.ciudad), autos=recepcion_duenos.autos+1, updated=excluded.updated`,
        [telefono, (d && d.nombre_vendedor) || null, (d && d.telefono_contacto) || null, (d && d.ubicacion) || null, Date.now()]);
}
async function duenoConocido(telefono) {
    await ensureDuenos();
    const r = await query("SELECT * FROM recepcion_duenos WHERE telefono=?", [telefono]);
    return r.length ? r[0] : null;
}
async function olvidarDueno(telefono) {
    await ensureDuenos();
    await run("DELETE FROM recepcion_duenos WHERE telefono=?", [telefono]);
}
// precarga la identidad fija del dueño en una sesión nueva
function precargarDueno(s, dc, traza) {
    if (!dc) return false;
    if (dc.nombre) s.datos.nombre_vendedor = dc.nombre;
    if (dc.telefono_contacto) s.datos.telefono_contacto = dc.telefono_contacto;
    if (dc.ciudad) s.datos.ubicacion = dc.ciudad;
    s.datos._conocido = 1;
    s.datos._confirmado = 1;   // dueño conocido = vendedor confirmado, sin escape
    traza.push(`[DUEÑO CONOCIDO 🔁] ${dc.nombre || 'dueño'} ya tiene ${dc.autos} auto(s) — identidad precargada, Ignacio no se re-presenta`);
    return true;
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

// ══ CANDADO DE TURNO (auditoría #8: dos burbujas rápidas → dos requests
// concurrentes → doble sesión, doble saludo, fotos pisadas). Un solo turno de
// Ignacio por teléfono a la vez; el segundo ESPERA su turno (y al entrar re-lee
// la libreta fresca, con la ráfaga ya actualizada). Candado viejo (20s+) = muerto.
async function tomarTurno(telefono, esperar) {
    await run("CREATE TABLE IF NOT EXISTS recepcion_turnos (telefono TEXT PRIMARY KEY, ts INTEGER)").catch(() => { });
    for (let i = 0; i < (esperar ? 5 : 1); i++) {
        const now = Date.now();
        const r = await query("SELECT ts FROM recepcion_turnos WHERE telefono=?", [telefono]).catch(() => []);
        if (!r.length || now - Number(r[0].ts) > 20000) {
            await run("INSERT INTO recepcion_turnos (telefono, ts) VALUES (?,?) ON CONFLICT(telefono) DO UPDATE SET ts=excluded.ts", [telefono, now]).catch(() => { });
            return true;
        }
        if (esperar) await new Promise(res => setTimeout(res, 1200));
    }
    return false;
}
async function soltarTurno(telefono) {
    await run("DELETE FROM recepcion_turnos WHERE telefono=?", [telefono]).catch(() => { });
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
    // UN AUTO A LA VEZ (parqueo del segundo) y GANCHO del reanudador
    unoPorUno: (nuevo, s) => {
        const actual = [s.datos.marca, s.datos.modelo, s.datos.anio].filter(Boolean).join(' ');
        return [`¡Va! Con gusto te publico los dos 🙌 Vamos uno por uno para no revolverlos — terminamos ${actual ? 'el ' + actual : 'este'} y enseguida damos de alta ${nuevo === 'tu otro auto' ? nuevo : 'el ' + nuevo} 👍`];
    },
    gancho: () => [`¡Va! 👍 Quedamos como te comentó Sebastián — seguimos:`],
    // DUEÑO CONOCIDO — sin presentación ni datos personales: puro auto
    saludoConocido: (n) => [
        `¡Qué tal${n ? ' ' + String(n).split(/\s+/)[0] : ''}! 🙌 Vamos con el siguiente auto.`,
        `Mándame:\n📋 Marca, modelo, año, cuántos dueños ha tenido, tipo de factura y kilometraje\n💵 A qué precio lo quieres vender\n🧾 Si tiene algún adeudo y si está a tu nombre\n📸 Fotos del auto (mínimo ${MIN_FOTOS})`,
        `Tus datos ya los tengo ✅ — puro dato del auto.`
    ],
    fotosIniciadorConocido: (n) => [
        `¡Qué tal${n ? ' ' + String(n).split(/\s+/)[0] : ''}! 🙌 Recibí las fotos — ¿me subes otro auto?`,
        `Mándame:\n📋 Marca, modelo, año, cuántos dueños ha tenido, tipo de factura y kilometraje\n💵 A qué precio lo quieres vender\n🧾 Si tiene algún adeudo y si está a tu nombre`
    ],
    // APROBADO/PUBLICADO — mensaje al vendedor (FUENTE ÚNICA: vida real y sandbox)
    publicado: () => [
        `¡Felicidades! 🎉 Tu auto ya está aprobado y publicado en fyradrive.com ✅`,
        `De aquí en adelante yo soy tu agente personal con la misión de vender tu auto: atiendo a cada interesado al instante, filtro a los curiosos y te aviso por aquí cuando haya cita o algo importante. 🤝`
    ],
    // FOTOS COMO INICIADOR (orden owner 2026-07-16): primer contacto con fotos
    fotosIniciador: () => [
        `¡Qué tal! Soy Ignacio de Fyradrive 🟢 Recibí las fotos de tu auto — ¿lo traes para VENDERLO con nosotros?`,
        `Si es así, va — aquí te ayudamos a venderlo. Mándame:\n📋 Marca, modelo, año, cuántos dueños ha tenido, tipo de factura y kilometraje\n💵 A qué precio lo quieres vender\n🧾 Si tiene algún adeudo y si está a tu nombre\n👤 Tu nombre, un número de contacto y en qué ciudad vives`
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
// ══ LA ESCALERA SELLADA (orden owner 2026-07-16) — cada mensaje baja solo hasta
// donde debe: 1) llaves exactas (💰 muda) → 2) machotes por regex (info/compran)
// → 3) extractor+checklist → 4) EL JUEZ (IA elige o responde CON candado) → escala
// muda + REANUDADOR. historial y ultimoManualTs los pasa el caller (panel real /
// sandbox); sin ellos el juez trabaja solo con hechos y el gancho no dispara.
async function procesarMensaje({ telefono, texto, historial, ultimoManualTs }) {
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
        // ¿DUEÑO CONOCIDO? → identidad precargada, saludo sin presentación
        const dc = await duenoConocido(telefono).catch(() => null);
        if (precargarDueno(s, dc, traza)) {
            out.avisoOwner = `🔁 ${dc.nombre || telefono} (dueño conocido, ${dc.autos} auto(s)) quiere subir OTRO auto`;
        } else {
            out.avisoOwner = `🟢 Ignacio despertó con ${telefono} — quiere vender su auto`;
        }
    }
    out.activo = true;

    // ── ESCAPE del iniciador por fotos — corre UNA sola vez (el PRIMER texto tras
    // las fotos): si revela COMPRADOR (mandó captura de un anuncio) → sesión cerrada,
    // flujo normal (Seb). Confirmado el vendedor una vez, jamás se re-evalúa.
    if (!out.despierta && s.estado === 'recepcion' && (s.fotos || []).length && s.datos.marca == null && s.datos.precio == null && !s.datos._confirmado) {
        // auditoría #2: el regex de confirmación DEBE ser mensaje completo anclado —
        // "SIgue disponible?" matcheaba ^s[ií]+ y confirmaba a un COMPRADOR como vendedor
        const esConfirm = esVendedorTexto(texto) || /^(s[ií]+|ok(ay)?|va|claro|sim[oó]n|as[ií] es|correcto|exacto|aj[aá])[\s.,!]*$/i.test(String(texto).trim());
        if (esConfirm) {
            s.datos._confirmado = 1;
            traza.push('[ESCAPE] el texto confirma vendedor → la sesión queda en firme');
        } else {
            const c0 = await clasificarVendedorIA(texto);
            if (c0 && !c0.es_vendedor) {
                await resetSesion(telefono);
                traza.push(`[ESCAPE 🚪] sesión nacida de fotos pero el texto es de COMPRADOR ("${c0.razon}") → sesión cerrada, flujo normal`);
                out.activo = false;
                out.motivo = 'era comprador (fotos de anuncio)';
                return out;
            }
            s.datos._confirmado = 1;
            traza.push('[ESCAPE] Haiku confirma vendedor → la sesión queda en firme');
        }
    }

    // ── Compuerta 💰 (auditoría #1: el early-return de dinero se comía la FICHA del
    // mismo burst y como no salía respuesta, la ráfaga viva re-disparaba el aviso en
    // cada mensaje siguiente). Ahora: se MARCA aquí (dineroMudo), el extractor SÍ
    // corre, el aviso cita SOLO la línea de dinero, se DEDUPLICA por línea, y al
    // final del turno el bot se calla (silencio total al vendedor, orden owner).
    let dineroMudo = false;
    if (RE_DINERO.test(texto)) {
        const lineaDin = lineaDe(texto, RE_DINERO);
        dineroMudo = true;
        if (s.datos._esc_din !== lineaDin) {
            traza.push(`[COMPUERTA 💰] "${lineaDin}" → ESCALA MUDA al owner (el bot se calla; la ficha del burst SÍ se captura)`);
            out.escala = { motivo: 'vendedor pregunta dinero/comisión/valuación' };
            out.avisoOwner = `💰 Vendedor ${telefono} pregunta dinero: «${lineaDin}» — contéstale tú`;
            s.datos._escala_ts = Date.now();   // paréntesis abierto → el reanudador lo cierra
            s.datos._esc_din = lineaDin;       // dedup: la misma pregunta no re-avisa por ráfaga viva
        } else {
            traza.push('[COMPUERTA 💰] misma pregunta de dinero ya escalada (ráfaga viva) → sin aviso duplicado');
        }
    }

    // ── Ya en revisión (auditoría #3/#15): las preguntas TAMBIÉN se atienden aquí,
    // y un SEGUNDO auto ya no sobrescribe la ficha revisada.
    if (s.estado === 'revision') {
        const avisar = (a) => { out.avisoOwner = out.avisoOwner ? out.avisoOwner + '\n' + a : a; };
        if (dineroMudo) {   // aviso 💰 ya quedó arriba → silencio y fuera
            await guardarSesion(telefono, s);
            out.segmentos = [];
            out.checklist = { datos: s.datos, fotos: s.fotos.length, faltan: [] };
            return out;
        }
        if (RE_UBICAN.test(texto)) {
            avisar(`🟡 Vendedor ${telefono} (auto en revisión) pregunta UBICACIÓN: «${lineaDe(texto, RE_UBICAN)}» — contéstale tú`);
            out.escala = { motivo: 'vendedor pregunta ubicación (en revisión)' };
            s.datos._escala_ts = Date.now();
            await guardarSesion(telefono, s);
            out.segmentos = [];
            out.checklist = { datos: s.datos, fotos: s.fotos.length, faltan: [] };
            return out;
        }
        if (RE_COMPRAN.test(texto) || RE_INFO.test(texto)) {
            out.segmentos = RE_COMPRAN.test(texto) ? P.compranAutos() : P.comoFunciona();
            out.checklist = { datos: s.datos, fotos: s.fotos.length, faltan: [] };
            return out;
        }
        const x = await extraerFicha(texto);
        if (x) {
            // ¿menciona OTRO auto? (marca/modelo distinto) → JAMÁS sobrescribir la revisada
            const cambioMarcaR = x.marca && s.datos.marca && normx(x.marca) !== normx(s.datos.marca);
            const mAr = normx(x.modelo || ''), mBr = normx(s.datos.modelo || '');
            const cambioModeloR = mAr && mBr && !mAr.includes(mBr) && !mBr.includes(mAr);
            if ((cambioMarcaR || cambioModeloR) && !RE_CORRECCION.test(texto)) {
                const nuevoR = [x.marca, x.modelo, x.anio].filter(Boolean).join(' ') || 'otro auto';
                s.datos._pendientes = (s.datos._pendientes || []).concat([String(texto).slice(0, 500)]);
                traza.push(`[PARQUEO 🅿️ en revisión] mencionó "${nuevoR}" → parqueado; la ficha revisada NO se toca`);
                avisar(`🅿️ Vendedor ${telefono} (auto en revisión) trae OTRO auto: «${String(texto).slice(0, 100)}» — se parqueó para después del publícalo`);
                await guardarSesion(telefono, s);
                out.segmentos = P.unoPorUno(nuevoR, s).concat(P.enRevision());
                out.checklist = { datos: s.datos, fotos: s.fotos.length, faltan: [] };
                return out;
            }
            // corrección de datos (escalares; marca/modelo solo con señal de corrección)
            const permitidos = RE_CORRECCION.test(texto)
                ? ['marca', 'modelo', 'anio', 'precio', 'kilometraje', 'color', 'transmision', 'duenos', 'factura', 'adeudos', 'a_su_nombre', 'nombre_vendedor', 'telefono_contacto', 'ubicacion']
                : ['precio', 'kilometraje', 'color', 'transmision', 'duenos', 'factura', 'adeudos', 'a_su_nombre', 'telefono_contacto', 'ubicacion'];
            const nuevos = Object.entries(x).filter(([k, v]) => v !== null && permitidos.includes(k) && s.datos[k] !== v);
            if (nuevos.length) {
                nuevos.forEach(([k, v]) => s.datos[k] = v);
                traza.push(`[HAIKU extractor] corrección en revisión: ${nuevos.map(([k, v]) => k + '=' + v).join(', ')}`);
                await guardarSesion(telefono, s);
                avisar(`✏️ Vendedor ${telefono} corrigió datos en revisión: ${nuevos.map(([k, v]) => k + '=' + v).join(', ')}`);
            } else traza.push('[ESTADO] en revisión — sin datos nuevos');
        }
        out.segmentos = P.enRevision();
        out.checklist = { datos: s.datos, fotos: s.fotos.length, faltan: [] };
        return out;
    }

    // ── Extraer + fusionar al checklist (por CÓDIGO; jamás re-preguntar) ──
    // OJO: se compara con == null porque false ES un dato capturado (adeudos/a_su_nombre)
    const x = await extraerFicha(texto);

    // ══ UN AUTO A LA VEZ (orden owner 2026-07-16): "tmb tengo un mazda" a media
    // ficha → NO se revuelve con el actual: se PARQUEA y arranca solo cuando el
    // actual ya se publicó. Cambio de auto SIN señal de "otro" = ambiguo
    // (¿corrección o segundo auto?) → escala muda, el owner decide.
    let segundoAuto = null;
    if (x) {
        // auditoría #18: "lo dejo en 240" (mexicanismo) → 240,000; precio absurdo → fuera
        if (x.precio != null && x.precio < 10000) {
            if (x.precio >= 50) { traza.push(`[CÓDIGO] precio ${x.precio} → ${x.precio * 1000} (mexicanismo "en ${x.precio}")`); x.precio = x.precio * 1000; }
            else { traza.push(`[CÓDIGO] precio ${x.precio} inverosímil → descartado (se re-pregunta)`); x.precio = null; }
        }
        const cambioMarca = x.marca && s.datos.marca && normx(x.marca) !== normx(s.datos.marca);
        const mA = normx(x.modelo || ''), mB = normx(s.datos.modelo || '');
        const cambioModelo = mA && mB && !mA.includes(mB) && !mB.includes(mA);
        if (cambioMarca || cambioModelo) {
            if (RE_CORRECCION.test(texto)) {
                // auditoría #4: "no, es otro modelo: es el Sport" = CORRECCIÓN, no segundo auto
                ['marca', 'modelo', 'anio'].forEach(k => { if (x[k] != null) s.datos[k] = x[k]; });
                traza.push(`[CORRECCIÓN ✏️] el vendedor corrigió el auto → ${[s.datos.marca, s.datos.modelo, s.datos.anio].filter(Boolean).join(' ')}`);
                const avisoC = `✏️ Vendedor ${telefono} corrigió el auto: ahora es ${[s.datos.marca, s.datos.modelo, s.datos.anio].filter(Boolean).join(' ')}`;
                out.avisoOwner = out.avisoOwner ? out.avisoOwner + '\n' + avisoC : avisoC;
                ['marca', 'modelo', 'anio'].forEach(k => { x[k] = null; });
            } else {
                // señal de SEGUNDO auto: exige "otro AUTO/carro" o "también tengo" — no "otro" pelón
                const senal2 = /(tambi[eé]n tengo|tmb tengo|adem[aá]s tengo|aparte tengo|otr[oa] (auto|carro|coche|camioneta|troca|veh[ií]culo)|el segundo (auto|carro)|2do (auto|carro)|dos (autos|carros)|luego te (paso|mando) (el|la|otro)|uno m[aá]s)/i.test(String(texto));
                if (senal2) {
                    segundoAuto = [x.marca, x.modelo, x.anio].filter(Boolean).join(' ') || 'tu otro auto';
                    s.datos._pendientes = (s.datos._pendientes || []).concat([String(texto).slice(0, 500)]);
                    traza.push(`[PARQUEO 🅿️] segundo auto ("${segundoAuto}") → uno a la vez; arranca al publicarse el actual`);
                } else {
                    traza.push('[COMPUERTA 🟡] cambió de auto a media ficha SIN señal clara → escala muda (¿corrección o segundo auto?)');
                    const aviso = `🟡 Vendedor ${telefono} mencionó OTRO auto a media ficha: «${String(texto).slice(0, 120)}» — revisa tú (¿corrección o segundo auto?)`;
                    out.avisoOwner = out.avisoOwner ? out.avisoOwner + '\n' + aviso : aviso;
                    out.escala = out.escala || { motivo: 'posible cambio de auto a media ficha' };
                    s.datos._escala_ts = Date.now();
                }
                // los campos del auto nuevo NO entran a la ficha actual
                ['marca', 'modelo', 'anio', 'precio', 'kilometraje', 'color', 'transmision', 'duenos', 'factura'].forEach(k => { x[k] = null; });
            }
        }
    }

    const nuevos = x ? Object.entries(x).filter(([k, v]) => v !== null && s.datos[k] == null) : [];
    nuevos.forEach(([k, v]) => s.datos[k] = v);
    if (x) {
        // auditoría #5: corrección EXPLÍCITA de un dato ya capturado ("perdón, son 95 mil km")
        if (RE_CORRECCION.test(texto)) {
            const corr = ['marca', 'modelo', 'precio', 'kilometraje', 'anio', 'duenos', 'factura', 'color', 'transmision', 'adeudos', 'a_su_nombre']
                .filter(k => x[k] != null && s.datos[k] != null && s.datos[k] !== x[k]);
            if (corr.length) {
                corr.forEach(k => s.datos[k] = x[k]);
                traza.push(`[CORRECCIÓN ✏️] ${corr.map(k => k + '=' + x[k]).join(', ')}`);
                const avisoX = `✏️ Vendedor ${telefono} corrigió: ${corr.map(k => k + '=' + x[k]).join(', ')}`;
                out.avisoOwner = out.avisoOwner ? out.avisoOwner + '\n' + avisoX : avisoX;
            }
        }
        // auditoría #14: los datos de CONTACTO más frescos ganan (dueño conocido con
        // teléfono/ciudad nuevos para ESTE auto)
        ['nombre_vendedor', 'telefono_contacto', 'ubicacion'].forEach(k => {
            if (x[k] != null && s.datos[k] != null && normx(String(x[k])) !== normx(String(s.datos[k]))) {
                traza.push(`[CONTACTO ✏️] ${k}: ${s.datos[k]} → ${x[k]} (lo más fresco gana)`);
                s.datos[k] = x[k];
            }
        });
    }
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
    // (auditoría #17: relleno de LOGÍSTICA con tiempo — "te mando las fotos mañana",
    // "saliendo del trabajo" — también es filler, no 🟡)
    const FILLER_PIEZA = '(ok(ay)?|va+|vale|listo|s[ií]+|claro( que s[ií])?|perfecto|gracias+|de acuerdo|buen[oa]s?( d[ií]as| tardes| noches)?|hola+|qu[eé] tal|ahorita|al rato|al ratito|ya voy|un momento|espera(me)?|dame (chance|un momento)|ya|te (las? )?(mando|env[ií]o|paso)|las? (mando|env[ií]o|paso)|(mando|env[ií]o|paso) (las )?fotos|las fotos|fotos|son (esas|todas)|es[oa]s? son( todas)?|aqu[ií] (van|est[aá]n)|qu[eé] m[aá]s( te mando)?|algo m[aá]s|as[ií] (est[aá] bien|o m[aá]s)|est[aá] bien|sale|arre|ma[ñn]ana|hoy en la noche|en la (noche|tarde|ma[ñn]ana)|m[aá]s tarde|saliendo( del (trabajo|jale))?|llegando( a (mi )?casa)?|en un rat(o|ito)|luego)';
    const RE_FILLER = new RegExp('^(?:' + FILLER_PIEZA + '[,.!?\\s]*)+$', 'i');
    let noEntendido = false, pideInfo = false, pideCompran = false, respuestaJuez = null;
    {
        const txt = String(texto || '').trim();
        const esFiller = RE_FILLER.test(txt);
        const tienePregunta = /\?/.test(txt);
        // la propia frase de vendedor ("quiero vender mi auto" / "te subo otro carro")
        // NO es "no entendido": es la puerta de entrada — el saludo/checklist la contesta
        const esFraseVendedor = RE_VENDEDOR.test(txt) || RE_OTRO_AUTO.test(txt);
        // ── TRIGGERS NO-EXCLUYENTES (auditoría #12: "¿compran autos? ¿dónde se
        // ubican?" — antes ganaba uno y la otra pregunta moría sin aviso). Cada
        // trigger dispara lo suyo; las citas van por LÍNEA, no por ráfaga entera.
        if (RE_COMPRAN.test(txt)) {
            pideCompran = true;
            traza.push(`[TRIGGER COMPRAN regex] "${txt.match(RE_COMPRAN)[0]}" → machote compranAutos`);
        }
        if (RE_UBICAN.test(txt)) {
            // "¿dónde se ubican?" → ESCALA MUDA determinista (la ubicación la contesta el owner)
            traza.push(`[TRIGGER UBICAN regex] "${txt.match(RE_UBICAN)[0]}" → ESCALA MUDA (ubicación = del owner)`);
            const avisoU = `🟡 Vendedor ${telefono} pregunta UBICACIÓN: «${lineaDe(txt, RE_UBICAN)}» — contéstale tú (yo sigo juntando la ficha)`;
            out.avisoOwner = out.avisoOwner ? out.avisoOwner + '\n' + avisoU : avisoU;
            out.escala = out.escala || { motivo: 'vendedor pregunta ubicación' };
            s.datos._escala_ts = Date.now();
        }
        if (!pideCompran && RE_INFO.test(txt)) {
            // ── TRIGGER INFO (el machote de compran ya contiene el pitch → colapsan)
            pideInfo = true;
            traza.push(`[TRIGGER INFO regex] "${txt.match(RE_INFO)[0]}" → machote del owner`);
        }
        const algunTrigger = pideCompran || pideInfo || dineroMudo || /🟡 Vendedor .+ UBICACIÓN/.test(String(out.avisoOwner || ''));
        if (!algunTrigger && !esFiller && !(esFraseVendedor && !tienePregunta) && (tienePregunta || (!nuevos.length && txt.split(/\s+/).length >= 3))) {
            // ── EL JUEZ (SS4): nadie reclamó el mensaje → ¿se contesta BIEN con los
            // HECHOS + el historial de ESTE chat? La IA ELIGE (machote/responder/
            // escalar); si responde, el CANDADO de código revisa. Duda → muda.
            const j = await juezRecepcion(txt, historial);
            if (j && j.accion === 'machote_compran') {
                pideCompran = true;
                traza.push(`[JUEZ] "${j.razon}" → machote compranAutos`);
            } else if (j && j.accion === 'machote_info') {
                pideInfo = true;
                traza.push(`[JUEZ] "${j.razon}" → machote de información`);
            } else if (j && j.accion === 'responder' && candadoJuez(j.respuesta)) {
                respuestaJuez = j.respuesta;
                traza.push(`[JUEZ ✓] "${j.razon}" → responde con los hechos del skill (candado pasado)`);
            } else {
                noEntendido = true;
                const porque = j ? (j.accion === 'responder' ? 'el CANDADO rechazó su borrador' : `"${j.razon}"`) : 'juez sin respuesta (fail-closed)';
                traza.push(`[COMPUERTA 🟡] ${porque} → ESCALA MUDA al owner y el flujo SIGUE`);
                const aviso = `🟡 Ignacio no entendió a ${telefono}: «${lineaDuda(txt)}» — contéstale tú (yo sigo juntando la ficha)`;
                out.avisoOwner = out.avisoOwner ? out.avisoOwner + '\n' + aviso : aviso;
                out.escala = out.escala || { motivo: 'mensaje no entendido en recepción' };
                s.datos._escala_ts = Date.now();
            }
        }
    }

    const f = faltantes(s);
    const esPrimerTurno = out.despierta;
    if (!f.length) {
        s.estado = 'revision';
        traza.push('[PLANTILLA] completo → auto NACE EN REVISIÓN (falta el "va" del owner)');
        out.nacimiento = { datos: s.datos, fotos: s.fotos.length };
        // auditoría #6: CONCATENAR — el aviso de nacimiento no debe pisar un 🟡/💰 del mismo turno
        const avisoN = `🆕 Auto en revisión de ${telefono}: ${s.datos.marca} ${s.datos.modelo} ${s.datos.anio} — $${Number(s.datos.precio).toLocaleString('es-MX')} · ${Number(s.datos.kilometraje).toLocaleString('es-MX')} km · ${s.datos.duenos} dueño(s) · factura ${s.datos.factura} · ${s.datos.adeudos ? 'CON ADEUDO ⚠️' : 'sin adeudos'} · ${s.datos.a_su_nombre ? 'a su nombre' : 'NO a su nombre ⚠️'} · ${s.fotos.length} fotos · ${s.datos.nombre_vendedor} ${s.datos.telefono_contacto || ''} (${s.datos.ubicacion}) — responde PUBLÍCALO para activarlo`;
        out.avisoOwner = out.avisoOwner ? out.avisoOwner + '\n' + avisoN : avisoN;
        out.segmentos = P.completo(s);
    } else if (esPrimerTurno) {
        traza.push('[PLANTILLA] ' + (s.datos._conocido ? 'saludo de dueño conocido (sin presentación)' : 'saludo + requisitos'));
        out.segmentos = s.datos._conocido ? P.saludoConocido(s.datos.nombre_vendedor) : P.saludo(s.datos.nombre_vendedor);
        if (nuevos.length) out.segmentos = out.segmentos.concat(P.progreso(s));
    } else {
        traza.push(`[PLANTILLA] progreso (faltan: ${f.join(', ')})`);
        out.segmentos = P.progreso(s);
    }
    // pidió INFO o "¿compran autos?" → machote del owner (sustituye al saludo: ES el
    // pitch); si ya hay algo capturado, el progreso va de pilón para seguir jalando
    const hayAlgo = ['marca', 'modelo', 'anio', 'precio', 'kilometraje', 'duenos', 'factura', 'adeudos', 'a_su_nombre', 'nombre_vendedor', 'telefono_contacto', 'ubicacion'].some(k => s.datos[k] != null) || (s.fotos || []).length > 0;
    if ((pideInfo || pideCompran) && f.length) {
        traza.push('[PLANTILLA] machote ' + (pideCompran ? 'compranAutos' : 'de información del owner'));
        out.segmentos = pideCompran ? P.compranAutos() : P.comoFunciona();
        if (hayAlgo) out.segmentos = out.segmentos.concat(P.progreso(s));
    }
    // respuesta del JUEZ (SS4): va al frente; el riel (checklist) sigue atrás
    if (respuestaJuez) out.segmentos = [respuestaJuez].concat(out.segmentos);
    // PARQUEO: acuse de "uno a la vez" al frente
    if (segundoAuto) out.segmentos = P.unoPorUno(segundoAuto, s).concat(out.segmentos);
    // ══ REANUDADOR 🔄: había paréntesis abierto (escalada), el owner YA contestó
    // manual, y este turno no necesita su voz → gancho y el riel sigue.
    if (s.datos._escala_ts && ultimoManualTs && Number(ultimoManualTs) > Number(s.datos._escala_ts) && !noEntendido) {
        out.segmentos = P.gancho().concat(out.segmentos);
        traza.push('[REANUDADOR 🔄] el owner ya contestó manual → gancho + paréntesis cerrado');
        s.datos._escala_ts = null;
    }
    // lo no entendido se escala MUDO (orden owner 2026-07-16): el vendedor no se
    // entera — solo sigue el checklist; el owner ya recibió el aviso 🟡 y contesta él.
    // ── DINERO = SILENCIO TOTAL al final (orden owner): la ficha del burst ya se
    // capturó arriba; el vendedor no recibe nada este turno, el owner contesta la cifra.
    if (dineroMudo) {
        out.segmentos = [];
        traza.push('[COMPUERTA 💰] silencio total al vendedor (la ficha del burst quedó capturada)');
    }
    await guardarSesion(telefono, s);
    out.checklist = { datos: s.datos, fotos: s.fotos.length, faltan: f };
    return out;
}

// ══ Fotos: entran por el puente (pool FIFO) o simuladas en sandbox ══
async function agregarFotos({ telefono, urls }) {
    const traza = [];
    const out = { activo: false, segmentos: [], traza, avisoOwner: null, escala: null, nacimiento: null, checklist: null };
    // auditoría #8: candado — dos lotes de fotos concurrentes se pisaban el pool
    const turnoOk = await tomarTurno(telefono, true).catch(() => true);
    try {
    let s = await sesionActiva(telefono);
    if (!s) {
        // ══ FOTOS COMO INICIADOR (orden owner 2026-07-16): primer contacto con
        // fotos del auto → Ignacio DESPIERTA a confirmar la venta. Si el texto que
        // sigue revela comprador (captura de anuncio), el ESCAPE cierra la sesión.
        s = { estado: 'recepcion', datos: {}, fotos: (urls || []).map(String), created: Date.now() };
        const dcF = await duenoConocido(telefono).catch(() => null);
        const conocidoF = precargarDueno(s, dcF, traza);
        await guardarSesion(telefono, s);
        traza.push(`[FOTOS INICIADOR 📸] sin sesión + ${(urls || []).length} foto(s) → Ignacio despierta` + (conocidoF ? ' (dueño conocido)' : ' a confirmar venta'));
        out.activo = true;
        out.despierta = true;
        out.avisoOwner = conocidoF
            ? `🔁 ${dcF.nombre || telefono} (dueño conocido, ${dcF.autos} auto(s)) mandó fotos de OTRO auto`
            : `🟢 Ignacio despertó con ${telefono} — mandó fotos de un auto (¿vendedor?)`;
        out.segmentos = conocidoF ? P.fotosIniciadorConocido(s.datos.nombre_vendedor) : P.fotosIniciador();
        out.checklist = { datos: s.datos, fotos: s.fotos.length, faltan: faltantes(s) };
        return out;
    }
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
        const avisoNF = `🆕 Auto en revisión de ${telefono}: ${s.datos.marca} ${s.datos.modelo} ${s.datos.anio} — $${Number(s.datos.precio).toLocaleString('es-MX')} · ${Number(s.datos.kilometraje).toLocaleString('es-MX')} km · ${s.datos.duenos} dueño(s) · factura ${s.datos.factura} · ${s.datos.adeudos ? 'CON ADEUDO ⚠️' : 'sin adeudos'} · ${s.datos.a_su_nombre ? 'a su nombre' : 'NO a su nombre ⚠️'} · ${s.fotos.length} fotos · ${s.datos.nombre_vendedor} ${s.datos.telefono_contacto || ''} (${s.datos.ubicacion}) — responde PUBLÍCALO para activarlo`;
        out.avisoOwner = out.avisoOwner ? out.avisoOwner + '\n' + avisoNF : avisoNF;
        out.segmentos = P.completo(s);
    } else {
        // auditoría #23 (paridad): a media captura las fotos NO contestan nada en
        // NINGÚN mundo (silencio anti-spam; el texto del vendedor es el que avanza
        // el checklist). La traza queda para el sandbox.
        traza.push(s.estado === 'revision' ? '[ESTADO] fotos extra en revisión — silencio' : `[ESTADO] fotos acumuladas (${s.fotos.length}/${MIN_FOTOS}) — silencio anti-spam`);
        out.segmentos = [];
    }
    await guardarSesion(telefono, s);
    out.checklist = { datos: s.datos, fotos: s.fotos.length, faltan: faltantes(s) };
    return out;
    } finally { if (turnoOk) await soltarTurno(telefono).catch(() => { }); }
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
    // DUEÑO CONOCIDO: su identidad queda de base — el siguiente auto ya no la pregunta
    try { await registrarDueno(telefono, s.datos || {}); } catch (e) { }
    // UN AUTO A LA VEZ: ¿quedó un auto parqueado? → arranca su sesión de una vez
    let siguiente = null;
    try { siguiente = await arrancarPendiente(telefono, s); } catch (e) { console.error('[recepcion pendiente]', e.message); }
    return { ok: true, auto: rj.created[0], sesion: s, siguiente };
}

// ── Arranca el siguiente auto PARQUEADO del mismo vendedor (uno a la vez):
// nueva sesión con lo que su mensaje parqueado ya traía + el contacto heredado.
async function arrancarPendiente(telefono, s) {
    const pend = (s.datos && s.datos._pendientes) || [];
    if (!pend.length) return null;
    let datosP = {};
    try {
        const x = await extraerFicha(pend[0]);
        if (x) Object.entries(x).forEach(([k, v]) => { if (v !== null) datosP[k] = v; });
    } catch (e) { }
    // mismo vendedor: nombre, teléfono y ciudad se heredan (no se re-preguntan)
    ['nombre_vendedor', 'telefono_contacto', 'ubicacion'].forEach(k => { if (datosP[k] == null && s.datos[k] != null) datosP[k] = s.datos[k]; });
    datosP._pendientes = pend.slice(1);
    const s2 = { estado: 'recepcion', datos: datosP, fotos: [], created: Date.now() };
    await guardarSesion(telefono, s2);
    const nombreP = [datosP.marca, datosP.modelo, datosP.anio].filter(Boolean).join(' ') || 'tu otro auto';
    return { segmentos: [`Ahora sí, vamos con ${nombreP} 🙌`].concat(P.progreso(s2)) };
}

// Publica la sesión EN REVISIÓN para el "PUBLÍCALO" del owner.
// auditoría #7 (LEY DEL TIMBRE — paquete con código): con VARIOS autos en revisión,
// "publícalo" pelón ya NO adivina por updated (podía publicar el de OTRO vendedor
// sin revisar): pide el código (últimos dígitos del tel). Con hint → match único.
async function publicarPendiente(hint) {
    await ensureRecepcion();
    const rs = await query("SELECT telefono, datos FROM recepcion_sesiones WHERE estado='revision' ORDER BY updated DESC");
    if (!rs.length) return { ok: false, error: 'no hay autos en revisión' };
    const etiqueta = (row) => {
        let d = {}; try { d = JSON.parse(row.datos || '{}'); } catch (e) { }
        return `${[d.marca, d.modelo, d.anio].filter(Boolean).join(' ') || 'auto'} (…${String(row.telefono).slice(-4)})`;
    };
    if (hint) {
        const h = String(hint).replace(/\D/g, '');
        const m = rs.filter(r => String(r.telefono).endsWith(h));
        if (m.length === 1) return publicarSesion(m[0].telefono);
        return { ok: false, error: 'código no encontrado entre los autos en revisión', opciones: rs.map(etiqueta) };
    }
    if (rs.length === 1) return publicarSesion(rs[0].telefono);
    return { ok: false, error: 'hay ' + rs.length + ' autos en revisión — dime cuál', opciones: rs.map(etiqueta), multiple: true };
}

// ══ EL TURNO COMPLETO — FUENTE ÚNICA (orden owner 2026-07-16: "que el sandbox
// sea de la misma fuente, solo deployeado en sandbox"). TODO lo que era del
// caller (leer la libreta, armar la ráfaga, el historial, el último manual del
// owner, la compuerta de despertar) vive AQUÍ. El panel real y el sandbox llaman
// ESTA función; lo único que cambia es el teléfono. Cero fórmulas duplicadas:
// si esto cambia, cambia en los dos mundos a la vez, por construcción.
async function turnoIgnacio({ telefono, convId, desdeTs }) {
    if (!convId) {
        const cv = await query("SELECT id FROM conversaciones WHERE channel_thread_id=? LIMIT 1", ['whatsapp:' + telefono]);
        if (!cv.length) return { activo: false, motivo: 'sin conversación' };
        convId = cv[0].id;
    }
    // ── CANDADO DE TURNO (auditoría #8): un turno a la vez por teléfono; el segundo
    // ESPERA y al entrar re-lee la libreta fresca (la ráfaga ya trae ambos mensajes).
    const turnoOk = await tomarTurno(telefono, true).catch(() => true);
    if (!turnoOk) return { activo: false, motivo: 'otro turno en proceso — la ráfaga lo recoge' };
    try {
        const mr = await query("SELECT direccion, texto, ts, ai_generated FROM mensajes WHERE conversacion_id=? ORDER BY ts ASC, id ASC", [convId]);
        let mensajes = mr.map(m => ({ mensaje: m.texto || '', direccion: m.direccion, ts: Number(m.ts), ai: Number(m.ai_generated) || 0 }));
        if (desdeTs) mensajes = mensajes.filter(m => m.ts >= Number(desdeTs));   // respeta el reinicio de pruebas
        // auditoría #22: el placeholder de fotos del sandbox no contamina la ráfaga
        mensajes = mensajes.filter(m => !/^📸 \[\d+ fotos?\]$/.test(String(m.mensaje).trim()));
        const entrantes = mensajes.filter(m => m.direccion === 'in');
        if (!entrantes.length) return { activo: false, motivo: 'sin entrantes' };
        // la RÁFAGA: todo lo entrante desde nuestra última salida (burbujas conpegadas juntas)
        let lastOutIdx = -1, bursts = 0, prevDir = null;
        mensajes.forEach((m, i) => { if (m.direccion === 'out') { if (prevDir !== 'out') bursts++; lastOutIdx = i; } prevDir = m.direccion; });
        const ins = (lastOutIdx >= 0 ? mensajes.slice(lastOutIdx + 1) : mensajes).filter(m => m.direccion === 'in');
        const rafaga = ins.map(m => m.mensaje).join('\n') || entrantes[entrantes.length - 1].mensaje;
        // COMPUERTA de despertar (misma en ambos mundos): sesión viva; frase FUERTE de
        // vendedor en cualquier momento (auditoría #20: un ex-comprador SÍ puede volverse
        // vendedor); primer contacto con datos de ficha o señal SUAVE de venta (el doble
        // candado Haiku de procesarMensaje decide — auditoría #9: antes era código muerto);
        // o DUEÑO CONOCIDO que vuelve ("te subo otro carro").
        const s = await sesionActiva(telefono);
        if (!s) {
            const abreFuerte = esVendedorTexto(rafaga);
            const abrePrimero = bursts === 0 && (RE_FICHA_SENAL.test(rafaga) || RE_VENTA_SUAVE.test(rafaga));
            let abreConocido = false;
            if (!abreFuerte && !abrePrimero) {
                const dcG = await duenoConocido(telefono).catch(() => null);
                abreConocido = !!(dcG && (RE_FICHA_SENAL.test(rafaga) || RE_OTRO_AUTO.test(rafaga)));
            }
            if (!abreFuerte && !abrePrimero && !abreConocido) return { activo: false, motivo: 'no es primer contacto de vendedor ni hay sesión' };
        }
        const manuales = mensajes.filter(m => m.direccion === 'out' && !m.ai);
        const ultimoManualTs = manuales.length ? Number(manuales[manuales.length - 1].ts) : null;
        const historial = mensajes.slice(-8).map(h => (h.direccion === 'in' ? 'VENDEDOR: ' : 'NOSOTROS: ') + String(h.mensaje || '').slice(0, 150)).join('\n');
        return await procesarMensaje({ telefono, texto: rafaga, historial, ultimoManualTs });
    } finally { if (turnoOk) await soltarTurno(telefono).catch(() => { }); }
}

// ── APROBACIÓN SIMULADA (sandbox): tu "aprobar" del fyradmin — MISMA esencia que
// el publícalo real (revisión→publicada + mensaje de agente personal + arranca el
// parqueado), solo que SIN publicar en la web. La vida real usa publicarSesion,
// que publica de verdad y manda LA MISMA plantilla (P.publicado — fuente única).
async function aprobarSesionSimulada(telefono) {
    const s = await sesionActiva(telefono);
    if (!s || s.estado !== 'revision') return { ok: false, error: 'no hay auto en revisión' };
    await run("UPDATE recepcion_sesiones SET estado='publicada', updated=? WHERE telefono=?", [Date.now(), telefono]);
    try { await registrarDueno(telefono, s.datos || {}); } catch (e) { }
    let siguiente = null;
    try { siguiente = await arrancarPendiente(telefono, s); } catch (e) { }
    return { ok: true, sesion: s, segmentos: P.publicado(), siguiente };
}

module.exports = { procesarMensaje, agregarFotos, sesionActiva, resetSesion, esVendedorTexto, RE_DINERO, ensureRecepcion, publicarSesion, publicarPendiente, OWNER_RECEPCION, juezRecepcion, candadoJuez, arrancarPendiente, turnoIgnacio, aprobarSesionSimulada, plantillaPublicado: () => P.publicado(), duenoConocido, registrarDueno, olvidarDueno };
