// lib/seb/clasificador.js
// La magia de IA #1: entender el mensaje entrante.
//
// DOS pasos, el primero sin IA:
//   1. resolverAutoDeterminista(): si el mensaje trae el bloque del anuncio
//      ("[DESC: 🏳️BMW 530iA ... 💵 $395,000") o menciona marca/modelo, el
//      auto se resuelve con CÓDIGO (Paso 0: cubre ~66% de los casos).
//   2. clasificar(): Haiku devuelve un JSON-llave con salida estructurada
//      (json_schema forzado — no puede devolver otra cosa). El JSON es un
//      DATO que indexa caminos ya escritos; en runtime jamás se genera código.
//
// La clase "continuacion" existe porque el 55% del tráfico real son
// respuestas a preguntas de Seb, no intenciones nuevas (hallazgo Paso 0).

const { query } = require('./db.js');

const HAIKU = 'claude-haiku-4-5';

const INTENCIONES = [
    'info_inicial',        // primer contacto / "más información del..."
    'disponibilidad',      // ¿sigue disponible?
    'estado_auto',         // dueños, factura, km, detalles, fallas
    'cotizar_credito',     // crédito, mensualidad, enganche, banco
    'cita_ubicacion',      // verlo, dónde, cuándo, agendar
    'precio_negociacion',  // ¿cuánto menos?, oferta, rebaja
    'fotos_videos',        // pide fotos o videos
    'continuacion',        // responde/afirma/da un dato a una pregunta de Seb
    'vendedor',            // quiere VENDERnos su auto (remate, comisión, trade-in) → escalar
    'fuera_alcance',       // cripto, envíos internacionales, quejas, cosas raras → escalar
    'otro'
];

const SCHEMA = {
    type: 'object',
    properties: {
        intencion_principal: { type: 'string', enum: INTENCIONES },
        intenciones: { type: 'array', items: { type: 'string', enum: INTENCIONES } },
        auto_id: { type: ['integer', 'null'], description: 'id del auto del inventario, o null si no se puede resolver' },
        datos: {
            type: 'object',
            description: 'datos concretos extraídos del mensaje',
            properties: {
                enganche: { type: ['number', 'null'] },
                plazo_meses: { type: ['integer', 'null'] },
                fecha: { type: ['string', 'null'], description: 'ej. "mañana", "sábado", "2026-06-15"' },
                hora: { type: ['string', 'null'], description: 'ej. "18:00", "6pm"' },
                confirmacion: { type: ['boolean', 'null'], description: 'true=acepta/afirma, false=rechaza, null=no aplica' },
                nombre: { type: ['string', 'null'] }
            },
            required: ['enganche', 'plazo_meses', 'fecha', 'hora', 'confirmacion', 'nombre'],
            additionalProperties: false
        },
        confianza: { type: 'string', enum: ['alta', 'baja'] },
        escalar: { type: 'boolean' }
    },
    required: ['intencion_principal', 'intenciones', 'auto_id', 'datos', 'confianza', 'escalar'],
    additionalProperties: false
};

// ======================================================================
// PASO DETERMINÍSTICO: resolver el auto sin IA
// ======================================================================
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Devuelve { auto_id, via } o null. `autos` = lista con {id, nombre, anio, precio, codigo_corto}.
// REGLA DURA (aprendida de falso positivo real: "MINI Cooper 2017" del anuncio
// matcheaba el "Mini Cooper S 2013" del inventario): si el anuncio trae AÑO o
// PRECIO, deben cuadrar con el auto candidato. Si no cuadran → null honesto
// (Seb pregunta o pivotea; nunca habla del auto equivocado).
function resolverAutoDeterminista(texto, autos) {
    const t = norm(texto);

    // 1) Bloque del anuncio: "[DESC: 🏳️BMW 530iA Sport Line 2019 💵 $395,000..."
    const descMatch = String(texto).match(/\[DESC:([^\]]*)/i);
    const zona = descMatch ? norm(descMatch[1]) : t;

    // Señales duras del anuncio: año y precio
    const yearMatch = zona.match(/\b(19|20)\d{2}\b/);
    const adYear = yearMatch ? Number(yearMatch[0]) : null;
    const priceMatch = zona.match(/\$\s?([\d.,]{4,})/);
    const adPrice = priceMatch ? Number(priceMatch[1].replace(/[.,]/g, '')) : null;

    // Tokens "inequívocos": aparecen en UN solo auto del inventario
    // (permite matchear "el jimny" con 1 palabra; "mercedes" con 3 autos, no)
    const tokenCount = {};
    for (const a of autos) {
        const seen = new Set(norm(a.nombre).split(/\s+/).filter(w => w.length >= 4 && !/^\d+$/.test(w)));
        for (const w of seen) tokenCount[w] = (tokenCount[w] || 0) + 1;
    }

    // 2) Matching por marca+modelo, vetado por año/precio
    let best = null;
    for (const a of autos) {
        const tokens = norm(a.nombre).split(/\s+/).filter(w => w.length >= 3 && !/^\d+$/.test(w));
        let score = 0, unico = false;
        for (const tok of tokens) if (zona.includes(tok)) {
            score++;
            if (tok.length >= 4 && tokenCount[tok] === 1) unico = true;
        }
        if (score < 2 && !unico) continue;
        // veto por año: si el anuncio dice año y difiere → no es este auto
        if (adYear && a.anio && Number(a.anio) !== adYear) continue;
        // veto por precio: si el anuncio trae precio y difiere >8% → no es este auto
        if (adPrice && a.precio && Math.abs(adPrice - Number(a.precio)) / Number(a.precio) > 0.08) continue;
        if (!best || score > best.score) best = { auto_id: a.id, score };
    }
    if (best) return { auto_id: best.auto_id, via: descMatch ? 'desc_anuncio' : 'mencion_texto' };

    // 3) Código corto del auto (si el anuncio lo trae)
    for (const a of autos) {
        if (a.codigo_corto && t.includes(norm(a.codigo_corto))) {
            return { auto_id: a.id, via: 'codigo_corto' };
        }
    }
    return null;
}

// ======================================================================
// LA LLAMADA A HAIKU (salida estructurada forzada)
// ======================================================================
async function clasificar({ mensaje, historial = [], autos, estado = {}, autoResuelto = null }) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

    const menuAutos = autos.map(a => `${a.id}: ${a.nombre}`).join('\n');
    const histTxt = historial.slice(-8).map(h => (h.direccion === 'in' ? 'COMPRADOR: ' : 'SEB: ') + h.mensaje).join('\n');
    const pendiente = estado.pregunta_pendiente ? `\nPREGUNTA PENDIENTE DE SEB: ${estado.pregunta_pendiente}` : '';
    const autoHint = autoResuelto ? `\nAUTO YA RESUELTO POR CÓDIGO: ${autoResuelto.auto_id} (no lo cambies salvo que el mensaje mencione OTRO auto explícitamente)` : '';

    const system = `Eres el clasificador de mensajes de compradores de autos de Fyradrive (Monterrey).
Tu única salida es el JSON del schema. Reglas:
- "continuacion" = el mensaje RESPONDE o afirma algo a la última pregunta de Seb (ej: "sí", "60", "a mi nombre", "hoy a las 6"). SOLO aplica si hay historial con un mensaje previo de SEB; sin historial NUNCA es continuacion. Si el mensaje trae una petición nueva (ej. "¿puedo ir a verlo mañana?"), la intención nueva gana sobre continuacion.
- Extrae datos concretos cuando existan (enganche "60 mil" → 60000; horas; fechas; confirmación sí/no).
- ENGANCHE: puede haberlo dicho el COMPRADOR o el propio SEB (cualquiera cuenta). Si AMBOS dieron uno distinto, gana SIEMPRE el del COMPRADOR (su palabra es la última); si solo lo dijo SEB, usa el de SEB. Pon ese valor en datos.enganche. Si nadie ha dado enganche, datos.enganche=null.
- Un número suelto que responde a "¿a cuántos meses?"/"¿a qué plazo?" es plazo_meses, NO enganche (ej: "60" tras esa pregunta = 60 meses).
- auto_id: SOLO un id del menú. null si no se puede saber.
- IMPORTANTE: si el comprador pregunta por un auto que NO está en el menú (anuncio viejo, auto ya vendido, otro modelo), NO es fuera_alcance: clasifica la intención normal (info_inicial, disponibilidad, etc.) con auto_id=null y escalar=false. Seb le ofrecerá alternativas.
- "fuera_alcance" SOLO para temas ajenos a COMPRAR un auto: cripto, envíos fuera de México, empleo, spam... y VENDEDORES (quiere vender/consignar su auto, pregunta comisiones por vender) — esos sí escalar=true (los atiende otra área).
- OJO trade-in: "¿tomas a cuenta mi auto?" / "doy mi auto a cambio" = un COMPRADOR dando su auto como parte de pago → precio_negociacion, NO es vendedor, escalar=false.
- Si pide hablar con una persona/agente/humano → "otro" + escalar=true.
- escalar=true únicamente si: es vendedor, queja seria, tema legal raro, o pide humano explícitamente. Preguntar por un auto (aunque no esté en menú) NUNCA escala.
- confianza "baja" si dudas entre intenciones o el mensaje es ambiguo.
- Clasificas por significado, no por palabras ("estoy en otro estado" = foráneo/ubicación del comprador, NO estado_auto).`;

    const user = `MENU DE AUTOS ACTIVOS:\n${menuAutos}\n\nHISTORIAL RECIENTE:\n${histTxt || '(sin historial)'}${pendiente}${autoHint}\n\nMENSAJE A CLASIFICAR:\n"${mensaje}"`;

    // Llamada con retry (red intermitente, 429, 5xx). 3 intentos, backoff 1s/3s.
    let data = null;
    for (let intento = 0; intento < 3; intento++) {
        try {
            const r = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: HAIKU,
                    max_tokens: 500,
                    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
                    messages: [{ role: 'user', content: user }],
                    output_config: { format: { type: 'json_schema', schema: SCHEMA } }
                })
            });
            data = await r.json();
            if (r.ok) break;
            // 4xx (excepto 429) no se reintenta: es error de request
            if (r.status !== 429 && r.status < 500) {
                throw new Error('anthropic ' + r.status + ': ' + JSON.stringify(data).slice(0, 200));
            }
            data = null;
        } catch (e) {
            if (intento === 2) throw e; // último intento: propagar (el caller escala a humano)
            data = null;
        }
        await new Promise(res => setTimeout(res, intento === 0 ? 1000 : 3000));
    }
    if (!data) throw new Error('anthropic sin respuesta tras 3 intentos');

    const text = (data.content || []).find(b => b.type === 'text');
    const out = JSON.parse(text.text);

    // ===== NORMALIZADOR DETERMINÍSTICO (red de seguridad, P2) =====
    // El schema del API puede no aplicarse duro (se observó "vendedor" fuera
    // del enum en eval). El código garantiza salida limpia SIEMPRE:
    const normInt = (i) => {
        if (INTENCIONES.includes(i)) return i;
        if (i === 'vendedor' || i === 'consigna' || i === 'venta_propia') return 'fuera_alcance';
        return 'otro';
    };
    const rawPrincipal = out.intencion_principal;
    out.intencion_principal = normInt(rawPrincipal);
    if (!INTENCIONES.includes(rawPrincipal)) {
        out.confianza = 'baja';
        if (out.intencion_principal === 'fuera_alcance') out.escalar = true;
    }
    out.intenciones = Array.isArray(out.intenciones) ? out.intenciones.map(normInt) : [out.intencion_principal];
    // REGLA DURA: sin mensaje previo de Seb NO puede haber "continuacion".
    // (El LLM a veces lo ignora; el código lo garantiza.)
    // Una pregunta_pendiente en el estado también cuenta como "Seb habló antes".
    const haySebAntes = (historial || []).some(h => h.direccion === 'out') || !!(estado && estado.pregunta_pendiente);
    if (out.intencion_principal === 'continuacion' && !haySebAntes) {
        out.intencion_principal = out.intenciones.find(i => i !== 'continuacion') || 'otro';
        out.confianza = 'baja';
    }
    out.escalar = out.escalar === true;
    out.confianza = out.confianza === 'alta' ? 'alta' : 'baja';
    if (out.auto_id != null && !autos.some(a => a.id === Number(out.auto_id))) out.auto_id = null; // id inventado → null
    out.datos = (out.datos && typeof out.datos === 'object') ? out.datos : {};

    // El auto determinístico manda si Haiku no propuso otro distinto explícito
    if (autoResuelto && (out.auto_id == null)) out.auto_id = autoResuelto.auto_id;
    out._usage = data.usage;
    return out;
}

// ======================================================================
// ENTRADA ÚNICA: resuelve auto (código) → clasifica (Haiku)
// ======================================================================
async function entender({ mensaje, historial, estado, autos = null }) {
    if (!autos) {
        const rows = await query(
            "SELECT id, marca, modelo, version, anio, precio, codigo_corto FROM inventario_autos WHERE estado='activo' ORDER BY marca"
        );
        autos = rows.map(a => ({
            id: a.id,
            nombre: [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' '),
            anio: a.anio, precio: a.precio,
            codigo_corto: a.codigo_corto || null
        }));
    }
    const autoResuelto = resolverAutoDeterminista(mensaje, autos);
    const clasificacion = await clasificar({ mensaje, historial, autos, estado: estado || {}, autoResuelto });
    return { ...clasificacion, auto_via: autoResuelto ? autoResuelto.via : (clasificacion.auto_id ? 'haiku' : null) };
}

module.exports = { entender, clasificar, resolverAutoDeterminista, INTENCIONES, SCHEMA };
