// lib/seb/auto-boton.js — LA IA APRIETA LOS BOTONES (orden owner 2026-09-12, SOLO PRUEBAS# por ahora)
// "Haz de cuenta que en vez de yo picar botones solo la IA puede": llega el mensaje del comprador en un chat delegado y una
// IA chica decide, razonando la intención REAL (no palabras sueltas), si un humano habría apretado uno de los botones del chat:
//   info · fotos · ubicacion · cotizar (con enganche) · cita (SOLO con día+hora; sin horario → nada, orden owner 2026-09-12)
// y lo aprieta POR LA MISMA PUERTA que la UI (accion_v2 / cotizar_v2 / cita_v2 con K_PANEL): mismo texto, misma bitácora,
// misma idempotencia. Sin gancho, sin maquillaje, sin redactar: solo el botón. Lo que no es un botón → nada (el vendedor lo ve).
// CANDADOS DE CÓDIGO (antes y después de la IA, para no gastar tokens ni disparar de la nada):
//   · sin delegación o sin auto en foco → nada · saludos/gracias/ok → nada sin IA · confianza baja/media → nada
//   · misma acción en este chat en las últimas 6 h → nada (jamás doble por bug) · cotizar sin enganche → nada
//   · una sola acción por mensaje · todo queda en auto_boton_log (razón incluida) para que el owner audite.
const { query, run } = require('./db.js');

const HAIKU = 'claude-haiku-4-5';
const VENTANA_REPETIR_MS = 6 * 3600000;
const ACCIONES = ['info', 'fotos', 'ubicacion', 'cotizar', 'cita'];
const ETIQUETA = { info: 'Información', fotos: 'Fotos', ubicacion: 'Ubicación', cotizar: 'Cotizar', cita: 'Agendar cita' };

let listo = false;
async function ensure() {
    if (listo) return;
    await run(`CREATE TABLE IF NOT EXISTS auto_boton_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, chat_id INTEGER, msg_id TEXT,
        texto TEXT, intencion TEXT, confianza TEXT, razon TEXT, accion TEXT, resultado TEXT, detalle TEXT, ts INTEGER)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_abl_chat ON auto_boton_log(chat_id, ts)`);
    listo = true;
}

async function haiku(system, schema, content, maxTokens) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return null;
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: HAIKU, max_tokens: maxTokens || 300, system, messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema } } })
        });
        if (!r.ok) return null;
        const d = await r.json();
        return JSON.parse((d.content || []).find(b => b.type === 'text').text);
    } catch (e) { return null; }
}

// ── Compuerta 0 (sin IA): lo que jamás es un botón ──
const RE_NADA = /^\s*(hola|buen[oa]s?( d[ií]as| tardes| noches)?|gracias|muchas gracias|ok|okay|va|vale|sale|perfecto|listo|👍|👌|🙏|de acuerdo|entendido|ah ok|a+h+|s[ií]|no|claro)[\s!.]*$/i;

const SCHEMA = {
    type: 'object', properties: {
        razon: { type: 'string', description: 'una frase: qué quiere REALMENTE el comprador con este mensaje, viendo la conversación' },
        intencion: { type: 'string', enum: ['info', 'fotos', 'ubicacion', 'cotizar', 'cita', 'nada'] },
        confianza: { type: 'string', enum: ['alta', 'media', 'baja'], description: 'alta = un vendedor humano apretaría ese botón ahora sin dudar' },
        enganche: { type: ['integer', 'null'], description: 'pesos completos si el comprador dio enganche (en este mensaje o antes); null si no' },
        plazo_meses: { type: ['integer', 'null'], description: '36, 48 o 60 si lo dijo; null si no' },
        fecha_iso: { type: ['string', 'null'], description: 'YYYY-MM-DD si dio un día concreto para la cita; null si no' },
        hora: { type: ['string', 'null'], description: 'HH:MM (24 h) si dio hora concreta; null si no' },
        pide_de_nuevo: { type: 'boolean', description: 'true SOLO si el comprador pide EXPLÍCITAMENTE que se le vuelva a mandar algo que ya recibió ("mándame otra vez las fotos")' }
    }, required: ['razon', 'intencion', 'confianza', 'enganche', 'plazo_meses', 'fecha_iso', 'hora', 'pide_de_nuevo'], additionalProperties: false
};

function fechaMty() {
    const d = new Date(Date.now() - 6 * 3600000);   // Monterrey (UTC-6, sin horario de verano)
    const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    return { iso: d.toISOString().slice(0, 10), dia: dias[d.getUTCDay()], hora: String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') };
}

async function decidir({ texto, historial, auto, yaMandadas }) {
    const hoy = fechaMty();
    const system =
        'Eres el criterio de un VENDEDOR de autos usados en Monterrey que atiende compradores por WhatsApp. Tienes SOLO estos botones y decides si apretar UNO ahora, ' +
        'exactamente como lo haría el vendedor humano leyendo el mensaje nuevo con el contexto de la conversación:\n' +
        '· info = manda la ficha completa del auto (características, precio, estado, financiamiento). Apriétalo cuando pide información, detalles, características, precio, si sigue disponible con interés real.\n' +
        '· fotos = manda las fotos del auto. Cuando pide fotos, imágenes, verlo por dentro, color, más fotos.\n' +
        '· ubicacion = manda dónde está el auto (texto + pin). Cuando pregunta dónde está, dónde lo puede ver, dirección, zona, ubicación.\n' +
        '· cotizar = manda la tarjeta de mensualidad. SOLO si el comprador YA dio el enganche (en este mensaje o en uno anterior). Si pide crédito/mensualidades sin enganche → nada.\n' +
        '· cita = agenda la cita. SOLO si dio día concreto Y hora concreta (o se deducen sin duda: "mañana a las 5" = mañana 17:00). Si quiere verlo pero no dio día u hora → nada (el vendedor lo acuerda).\n' +
        '· nada = no apretar nada: saludos, gracias, dudas de dinero/negociación/descuento/trade-in, preguntas que un botón no contesta, comentarios, o cuando la acción YA se le mandó y no la vuelve a pedir explícitamente (si la pide de nuevo explícitamente: la acción con pide_de_nuevo=true).\n' +
        'REGLAS: primero escribe la razón (qué quiere de verdad). Una sola acción. No te guíes por palabras sueltas: "cotización" en "gracias por la cotización" es nada; "ya vi las fotos" es nada. ' +
        'confianza alta solo si un humano lo apretaría sin dudar; ante la duda, nada. Horas: "5" en contexto de ver un auto por la tarde = 17:00; "en la mañana" sin hora = sin hora. ' +
        'Hoy es ' + hoy.dia + ' ' + hoy.iso + ' ' + hoy.hora + ' (Monterrey).';
    const content = 'AUTO EN FOCO: ' + (auto ? (auto.nombre + (auto.precio ? ' · $' + Number(auto.precio).toLocaleString('es-MX') : '')) : 'ninguno') + '\n' +
        'YA MANDADO EN LAS ÚLTIMAS 6 H: ' + (yaMandadas.length ? yaMandadas.join(', ') : 'nada') + '\n' +
        'CONVERSACIÓN (últimos mensajes, el último es el NUEVO del comprador):\n' +
        historial.map(m => (m.quien === 'comprador' ? 'Comprador' : (m.quien === 'bot' ? 'Seb' : 'Vendedor')) + ': ' + String(m.texto || '').slice(0, 300).replace(/\n+/g, ' / ')).join('\n') +
        '\nNUEVO: ' + String(texto || '').slice(0, 500);
    const r = await haiku(system, SCHEMA, content, 300);
    if (!r || !ACCIONES.concat('nada').includes(r.intencion)) return { intencion: 'nada', confianza: 'baja', razon: r ? 'salida inválida' : 'sin IA disponible', enganche: null, plazo_meses: null, fecha_iso: null, hora: null, pide_de_nuevo: false };
    return r;
}

/** Corre el auto-botón para un mensaje entrante. `puerta(action, body)` = llamada a seb-panel por la puerta de la UI. */
async function correr({ tenant, chat, texto, msgId, puerta, rastro }) {
    await ensure();
    const tid = Number(tenant.id), cid = Number(chat.id);
    const log = async (o) => { try { await run('INSERT INTO auto_boton_log (tenant_id, chat_id, msg_id, texto, intencion, confianza, razon, accion, resultado, detalle, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [tid, cid, msgId || null, String(texto || '').slice(0, 500), o.intencion || null, o.confianza || null, o.razon || null, o.accion || null, o.resultado || null, o.detalle ? JSON.stringify(o.detalle).slice(0, 800) : null, Date.now()]); } catch (e) { } return o; };
    const t = String(texto || '').trim();
    if (!t) return log({ resultado: 'sin_texto' });
    if (RE_NADA.test(t)) return log({ intencion: 'nada', confianza: 'alta', razon: 'saludo/acuse (sin IA)', resultado: 'nada' });
    // delegación + auto en foco (sin auto, ningún botón tiene qué mandar)
    const dele = (await query('SELECT id, auto_id, auto_nombre FROM delegaciones WHERE chat_id = ? AND hasta IS NULL ORDER BY id DESC LIMIT 1', [cid]).catch(() => []))[0];
    if (!dele) return log({ resultado: 'sin_delegacion' });
    let auto = null;
    if (dele.auto_id) { const a = (await query('SELECT id, marca, modelo, anio, precio FROM inventario_autos WHERE id = ? OR fyradrive_web_id = ? LIMIT 1', [Number(dele.auto_id), Number(dele.auto_id)]).catch(() => []))[0]; auto = a ? { id: a.id, nombre: [a.marca, a.modelo, a.anio].filter(Boolean).join(' '), precio: a.precio } : { nombre: dele.auto_nombre || 'auto' }; }
    // historial corto + acciones ya mandadas (dedupe por código, no por IA)
    const hist = (await query('SELECT direccion, emisor, texto, ts FROM mensajes WHERE conversacion_id = ? ORDER BY ts DESC, id DESC LIMIT 9', [cid]).catch(() => [])).reverse()
        .map(m => ({ quien: m.direccion === 'in' ? 'comprador' : (m.emisor === 'dueno' ? 'vendedor' : 'bot'), texto: String(m.texto || '').replace(/^\[prueba\]\s?/, '') }));
    const desde = Date.now() - VENTANA_REPETIR_MS;
    const yaRows = await query("SELECT accion, MAX(ts) ts FROM auto_boton_log WHERE chat_id = ? AND resultado = 'ok' AND ts > ? GROUP BY accion", [cid, desde]).catch(() => []);
    const ya = yaRows.map(r => r.accion); const ultimaVez = {}; yaRows.forEach(r => { ultimaVez[r.accion] = Number(r.ts) || 0; });
    const d = await decidir({ texto: t, historial: hist, auto, yaMandadas: ya.map(a => ETIQUETA[a] || a) });
    const base = { intencion: d.intencion, confianza: d.confianza, razon: d.razon };
    if (d.intencion === 'nada') return log(Object.assign(base, { resultado: 'nada' }));
    if (d.confianza !== 'alta') return log(Object.assign(base, { resultado: 'confianza_' + d.confianza }));
    let accion = d.intencion;
    if (accion === 'cita' && !(/^\d{4}-\d{2}-\d{2}$/.test(String(d.fecha_iso || '')) && /^\d{1,2}:\d{2}$/.test(String(d.hora || '')))) return log(Object.assign(base, { accion, resultado: 'sin_horario' }));   // sin día+hora firme → nada
    if (accion === 'cotizar' && !(Number(d.enganche) > 0)) return log(Object.assign(base, { accion, resultado: 'sin_enganche' }));
    // REPETIR: solo si el comprador lo pide de nuevo explícitamente, y jamás dentro de 2 min (eso es bug, no petición)
    if (ya.includes(accion)) {
        const hace = Date.now() - (ultimaVez[accion] || 0);
        if (!d.pide_de_nuevo) return log(Object.assign(base, { accion, resultado: 'repetida_6h' }));
        if (hace < 2 * 60000) return log(Object.assign(base, { accion, resultado: 'repetida_2min' }));
    }
    // ── APRETAR EL BOTÓN por la misma puerta que la UI (idempotente por clave) ──
    const clave = 'auto:' + cid + ':' + accion + ':' + (msgId || Date.now());
    let r;
    try {
        if (accion === 'cotizar') r = await puerta('cotizar_v2', { chat_id: cid, enganche: Number(d.enganche), plazo: [36, 48, 60].includes(Number(d.plazo_meses)) ? Number(d.plazo_meses) : undefined, clave });
        else if (accion === 'cita') r = await puerta('cita_v2', { chat_id: cid, fecha_iso: d.fecha_iso, hora: String(d.hora).padStart(5, '0'), clave });
        else r = await puerta('accion_v2', { chat_id: cid, accion, clave });
    } catch (e) { r = { ok: false, error: e.message }; }
    const ok = !!(r && r.ok);
    if (rastro) { try { await rastro('🤖 Seb apretó ' + (ETIQUETA[accion] || accion) + (accion === 'cotizar' ? ' ($' + Number(d.enganche).toLocaleString('es-MX') + (d.plazo_meses ? ' · ' + d.plazo_meses + ' m' : '') + ')' : '') + (accion === 'cita' ? ' (' + d.fecha_iso + ' ' + d.hora + ')' : '') + (ok ? '' : ' — falló: ' + String(r && r.error || '')) + ' · ' + String(d.razon || '').slice(0, 140)); } catch (e) { } }
    return log(Object.assign(base, { accion, resultado: ok ? 'ok' : 'fallo', detalle: { enganche: d.enganche, plazo: d.plazo_meses, fecha_iso: d.fecha_iso, hora: d.hora, error: ok ? null : (r && r.error) || null } }));
}

module.exports = { correr, decidir, ACCIONES, ETIQUETA, VENTANA_REPETIR_MS };
