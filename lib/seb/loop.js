// lib/seb/loop.js
// EL CEREBRO: el loop de herramientas de Seb (magia de IA #2).
//
//   expediente → Sonnet razona → pide tools → el CÓDIGO las ejecuta →
//   Sonnet redacta con {{huecos}} → validador rellena/rechaza →
//   borrador listo (o escalar a humano).
//
// El modelo razona; el código actúa. Sonnet JAMÁS toca Turso ni escribe cifras.
// Stateless: no escribe nada — devuelve el borrador y el estado nuevo;
// quien lo llama (el orquestador, Paso 6) decide encolar y persistir.

const { NUCLEO } = require('./nucleo.js');
const { armarExpediente } = require('./expediente.js');
const H = require('./herramientas.js');
const { validarYRellenar, juntarPlaceholders } = require('./validador.js');

const SONNET = 'claude-sonnet-4-6';
const MAX_VUELTAS = 4;

// Tools DECLARADAS al modelo (solo nombre/params — el código ejecuta)
const TOOLS_DECL = [
    {
        name: 'ubicacion',
        description: 'Punto de venta del auto con link de Google Maps. Úsala cuando el comprador pregunte dónde ver el auto o pidas confirmar cita con ubicación.',
        input_schema: { type: 'object', properties: { auto_id: { type: 'integer' } }, required: ['auto_id'] }
    },
    {
        name: 'autos_activos',
        description: 'Lista completa del inventario activo (id, nombre, precio). Úsala para ofrecer alternativas o cuando el comprador no sabe qué auto quiere.',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'info_auto',
        description: 'Ficha de OTRO auto del inventario (si el comprador cambia de auto). Devuelve huecos {{precio}}, {{kilometraje}}, {{auto_nombre}} del nuevo auto.',
        input_schema: { type: 'object', properties: { auto_id: { type: 'integer' } }, required: ['auto_id'] }
    },
    {
        name: 'enganche_minimo',
        description: 'El enganche MÍNIMO requerido para financiar un auto (según su año, reglas HEY Banco). Úsala cuando el comprador pregunte "¿cuánto de enganche?" / "¿cuál es el mínimo?" ANTES de darte una cantidad. Devuelve el hueco {{enganche_minimo}} (monto + %) — dilo tal cual; NUNCA digas "tú decides" ni "no hay mínimo". NO sirve para cotizar: para eso usa cotizar con el enganche que el comprador elija.',
        input_schema: { type: 'object', properties: { auto_id: { type: 'integer' } }, required: ['auto_id'] }
    },
    {
        name: 'cotizar',
        description: 'Cotización de financiamiento con HEY Banco. Úsala SOLO cuando el comprador pida un plan de crédito/financiamiento/mensualidad Y ya te haya dado su ENGANCHE (y el plazo en meses si lo dijo). Devuelve la tarjeta formal en el hueco {{cotizacion}} — respóndela tal cual. Si NO te dio enganche, NO la llames: pregúntaselo primero (o usa enganche_minimo si pregunta el mínimo).',
        input_schema: { type: 'object', properties: { auto_id: { type: 'integer' }, enganche: { type: 'number', description: 'enganche en pesos que dio el comprador' }, plazo_meses: { type: 'integer', description: 'plazo en meses si el comprador lo dijo (opcional)' } }, required: ['auto_id', 'enganche'] }
    }
];
const TOOL_IMPL = { ubicacion: H.ubicacion, autos_activos: H.autos_activos, info_auto: H.info_auto, cotizar: H.cotizar, enganche_minimo: H.enganche_minimo };

async function llamarSonnet(messages, system) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');
    let data = null;
    for (let intento = 0; intento < 3; intento++) {
        try {
            const r = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({
                    model: SONNET,
                    max_tokens: 500,
                    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
                    tools: TOOLS_DECL,
                    messages
                })
            });
            data = await r.json();
            if (r.ok) return data;
            if (r.status !== 429 && r.status < 500) throw new Error('anthropic ' + r.status + ': ' + JSON.stringify(data).slice(0, 200));
            data = null;
        } catch (e) { if (intento === 2) throw e; data = null; }
        await new Promise(res => setTimeout(res, intento === 0 ? 1000 : 3000));
    }
    throw new Error('anthropic sin respuesta tras 3 intentos');
}

// Entrada principal del cerebro.
// Devuelve { ok, borrador, escalar, motivo, tools_usadas, estado_nuevo, usage }
async function pensar({ telefono, mensaje, clasificacion, estado }) {
    const tools_usadas = [];
    let usage = { in: 0, out: 0 };

    // Escalado directo desde la clasificación (vendedor, queja, humano)
    if (clasificacion.escalar) {
        return { ok: false, escalar: true, motivo: 'clasificador: ' + clasificacion.intencion_principal, borrador: null, tools_usadas, estado_nuevo: estado || {}, usage };
    }

    // Pre-fetch de la ficha del auto activo (capa del expediente)
    const autoId = clasificacion.auto_id || (estado && estado.auto_id_activo) || null;
    let ficha = null;
    if (autoId) {
        ficha = await H.info_auto({ auto_id: autoId });
        if (ficha.ok) tools_usadas.push({ tool: 'info_auto', input: { auto_id: autoId }, resultado: ficha.datos });
    }

    const expediente = await armarExpediente({ telefono, mensaje, clasificacion, fichaAuto: ficha, estado });
    const resultadosTools = ficha && ficha.ok ? [ficha] : [];
    const messages = [{ role: 'user', content: expediente }];

    // EL LOOP: Sonnet pide → código ejecuta → Sonnet sigue
    let textoFinal = null;
    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
        const resp = await llamarSonnet(messages, NUCLEO);
        usage.in += resp.usage?.input_tokens || 0;
        usage.out += resp.usage?.output_tokens || 0;

        const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');
        if (toolUses.length === 0) {
            textoFinal = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
            break;
        }
        messages.push({ role: 'assistant', content: resp.content });
        const resultados = [];
        for (const tu of toolUses) {
            const impl = TOOL_IMPL[tu.name];
            let out;
            try { out = impl ? await impl(tu.input || {}) : { ok: false, error: 'tool_desconocida' }; }
            catch (e) { out = { ok: false, error: e.message }; }
            tools_usadas.push({ tool: tu.name, input: tu.input, resultado: out.ok ? out.datos : { error: out.error } });
            if (out.ok || out.placeholders) resultadosTools.push(out);
            resultados.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out.ok ? out.datos : { error: out.error, escalar: out.escalar || false }) });
        }
        messages.push({ role: 'user', content: resultados });
    }

    if (!textoFinal) {
        return { ok: false, escalar: true, motivo: 'sin_respuesta_tras_' + MAX_VUELTAS + '_vueltas', borrador: null, tools_usadas, estado_nuevo: estado || {}, usage };
    }

    // ¿Sonnet decidió escalar?
    const esc = textoFinal.match(/<<\s*ESCALAR:\s*([^>]+)>>/i);
    if (esc) {
        return { ok: false, escalar: true, motivo: esc[1].trim(), borrador: null, tools_usadas, estado_nuevo: estado || {}, usage };
    }

    // VALIDAR + RELLENAR (1 reintento con feedback; si falla de nuevo → humano)
    const placeholders = juntarPlaceholders(resultadosTools);
    let v = validarYRellenar(textoFinal, placeholders);
    if (!v.ok) {
        messages.push({ role: 'assistant', content: textoFinal });
        messages.push({ role: 'user', content: `Tu borrador fue RECHAZADO por el validador (${v.motivo}: ${v.detalle}). Reescríbelo corrigiendo eso. Recuerda: cifras SOLO con huecos {{...}} disponibles; corto; una pregunta.` });
        const retry = await llamarSonnet(messages, NUCLEO);
        usage.in += retry.usage?.input_tokens || 0;
        usage.out += retry.usage?.output_tokens || 0;
        const textoRetry = (retry.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        v = validarYRellenar(textoRetry, placeholders);
        if (!v.ok) {
            return { ok: false, escalar: true, motivo: 'validador_rechazo_doble: ' + v.motivo, borrador: null, tools_usadas, estado_nuevo: estado || {}, usage };
        }
    }

    // Estado nuevo (lo persiste el orquestador): auto activo + pregunta pendiente + datos
    const estado_nuevo = Object.assign({}, estado || {});
    if (autoId) estado_nuevo.auto_id_activo = autoId;
    // La pregunta pendiente se RENUEVA cada turno: si este borrador no pregunta
    // nada, se limpia (la anterior ya fue contestada o quedó obsoleta).
    delete estado_nuevo.pregunta_pendiente;
    const preguntas = v.texto_final.match(/[^.!?\n]*\?/g);
    if (preguntas && preguntas.length) estado_nuevo.pregunta_pendiente = preguntas[preguntas.length - 1].trim();
    for (const [k, val] of Object.entries(clasificacion.datos || {})) {
        if (val !== null && val !== undefined) estado_nuevo[k] = val;
    }

    return { ok: true, borrador: v.texto_final, escalar: false, motivo: null, tools_usadas, estado_nuevo, usage };
}

module.exports = { pensar, TOOLS_DECL };
