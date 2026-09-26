// ══ SEB AGENTE (orden owner 2026-09-27: "una IA vendedora que vive con la única verdad de MI sistema") ══
// Un turno = un bloque de mensajes del comprador. El agente lee el EXPEDIENTE del chat (auto, dueño, lo ya enviado, la cita, lo pendiente de Mario)
// y decide qué hacer con las HERRAMIENTAS del sistema (las mismas puertas que los botones de FyraChat). Redacta natural, pero:
//   · las cifras / fechas / direcciones solo pueden venir de herramientas, del expediente o del propio comprador (candado de salida);
//   · lo que no está en su lista blanca lo escala a Mario (que es agregador: Seb sigue con lo demás);
//   · la negociación de la cita la lleva el coordinador de citas (el agente no agenda por su cuenta).
const { query } = require('./db.js');
const H = require('./herramientas.js');
const MODELO = process.env.AGENTE_MODELO || 'claude-opus-5-5';
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const fmt = n => '$' + Number(n || 0).toLocaleString('es-MX');

const TOOLS = [
    { name: 'ficha_auto', description: 'Lee los datos reales de un auto del catálogo: precio, año, kilometraje, color, transmisión, carrocería, disponibilidad y sus reglas de crédito (banco, enganche mínimo, plazos). Úsala antes de afirmar cualquier dato del auto.', input_schema: { type: 'object', properties: { auto_id: { type: 'integer' } }, required: ['auto_id'] } },
    { name: 'enganche_minimo', description: 'El enganche mínimo real del auto según su año (reglas del banco). Úsala si preguntan el mínimo o "con cuánto sale".', input_schema: { type: 'object', properties: { auto_id: { type: 'integer' } }, required: ['auto_id'] } },
    { name: 'buscar_autos', description: 'Busca en el catálogo de ESTE lote (no inventes autos). Úsala si el comprador pide otras opciones o menciona otro auto.', input_schema: { type: 'object', properties: { texto: { type: 'string', description: 'marca, modelo, tipo o presupuesto que pidió' } }, required: ['texto'] } },
    { name: 'mandar_cotizacion', description: 'Manda la tarjeta de cotización oficial (la calcula el sistema con las reglas del banco). Si no dio enganche, manda los planes. Si dio menos del mínimo, la tarjeta cotiza con el mínimo y lo aclara.', input_schema: { type: 'object', properties: { auto_id: { type: 'integer' }, enganche: { type: 'number', description: 'enganche en PESOS que ÉL dijo' }, enganche_pct: { type: 'number', description: 'porcentaje que ÉL dijo' }, plazo_meses: { type: 'integer' } }, required: ['auto_id'] } },
    { name: 'mandar_fotos', description: 'Manda las fotos del auto.', input_schema: { type: 'object', properties: { auto_id: { type: 'integer' } }, required: ['auto_id'] } },
    { name: 'mandar_ubicacion', description: 'Manda el paquete de ubicación del auto (captura + pin).', input_schema: { type: 'object', properties: { auto_id: { type: 'integer' } }, required: ['auto_id'] } },
    { name: 'mandar_ficha', description: 'Manda la ficha completa del auto.', input_schema: { type: 'object', properties: { auto_id: { type: 'integer' } }, required: ['auto_id'] } },
    { name: 'mandar_requisitos', description: 'Manda la lista oficial de requisitos para el crédito.', input_schema: { type: 'object', properties: {} } },
    { name: 'cambiar_auto', description: 'Cambia el auto de la conversación a otro del catálogo (cuando el comprador claramente pasa a interesarse por otro).', input_schema: { type: 'object', properties: { auto_id: { type: 'integer' } }, required: ['auto_id'] } },
    { name: 'escalar', description: 'Pásale a Mario (el vendedor humano) lo que NO te toca. Mario contesta esa parte; tú puedes seguir contestando lo demás del mensaje.', input_schema: { type: 'object', properties: { motivo: { type: 'string', description: 'qué necesita Mario, en una frase' } }, required: ['motivo'] } },
];

function sistema(ctx) {
    const tres = ctx.tres;
    return [
        'Eres Seb, ' + (ctx.asistente ? 'el asistente virtual de ' + ctx.asistente + ' (vendedor de ' + ctx.lote + ')' : 'el asistente de ' + ctx.lote) + ', en WhatsApp, en Monterrey. Vendes autos seminuevos con las reglas de ESTE negocio. Eres un vendedor atento, sobrio y eficaz: contestas TODO lo que pregunta el comprador en su bloque de mensajes, en pocas burbujas, y lo llevas con naturalidad a ver y manejar el auto.',
        '',
        'CÓMO TRABAJAS',
        '1. Lee el EXPEDIENTE y el BLOQUE NUEVO completo (pueden ser varios mensajes: contéstalos juntos, como una sola plática).',
        '2. Decide qué hacer con tus herramientas. Las herramientas "mandar_*" envían archivos oficiales DESPUÉS de tu texto, en el orden en que las llames.',
        '3. Tu texto final es lo que dices tú: corto (1 a 3 burbujas separadas por "||"), como WhatsApp de vendedor mexicano: sin emojis de más, sin listas largas, sin repetir lo que ya se le mandó.',
        '',
        'LA ÚNICA VERDAD (candado — si lo rompes, tu mensaje no sale)',
        '· JAMÁS escribas un precio, mensualidad, enganche, kilometraje, fecha, hora, dirección o dato del auto que no venga de una herramienta, del expediente o del propio comprador. Si no lo sabes, léelo con ficha_auto o no lo digas.',
        '· Los datos del auto son del auto en foco (o del que diga el comprador y encuentres con buscar_autos). Nunca mezcles autos.',
        '· No prometas nada que no esté en tu lista blanca.',
        '',
        'LISTA BLANCA (lo único que haces tú)',
        '· Contestar dudas con los datos reales del auto (ficha_auto).',
        '· Mandar fotos, ubicación, ficha, requisitos y la cotización oficial.',
        '· Decir el enganche mínimo real (enganche_minimo). Las reglas cambian por año: nunca asumas un porcentaje.',
        '· Invitar a ver y manejar el auto, y pedir día y hora. Cuando el comprador dé día y hora, NO confirmes la cita: di que lo confirmas' + (tres ? ' con quien tiene el auto' : '') + ' y el sistema de citas se encarga.',
        '· Si dice que lo va a pensar, que revisa sus horarios o que avisa: "va, sin presión" y deja la puerta abierta.',
        '',
        'ESCALA A MARIO (herramienta escalar) — y NO lo contestes tú',
        '· Negociar precio, descuentos, "¿es lo menos?", ofertas con número, tomar un auto a cuenta.',
        '· Pagos, apartar, depósitos, enganche ya listo para firmar, papeles para comprar (comprador caliente).',
        '· Garantía, adeudos, factura/legales que no estén en la ficha, historia de choques.',
        '· Su situación personal de crédito (buró, "no me alcanza") o quejas/molestia.',
        '· "Quiero hablar con Mario / una persona" o cualquier cosa de la que no estés seguro.',
        '· Al escalar, si el mensaje traía otras dudas que sí son tuyas, contéstalas. Sobre lo escalado, al comprador solo le dices, si hace falta, que ' + (ctx.asistente || 'el vendedor') + ' le escribe en un momento.',
        '',
        'CÓMO SUENAS',
        '· Nada de "¿en qué más te ayudo?" ni saludos repetidos. Si solo saluda o agradece y ya se le había hablado, no contestes (texto vacío).',
        '· Un solo gancho a la cita por respuesta, y no lo repitas si ya se lo pediste en el último mensaje de Seb o si ya hay cita.',
        '· Si ya se le mandó la cotización / fotos / ubicación, no la vuelvas a mandar salvo que la pida o cambie el enganche/plazo.',
        tres ? '· Este lote coordina la cita entre 3: el comprador, el dueño del auto (' + (ctx.duenoTipo === 'lote' ? 'un lote' : 'un particular') + ') y ' + (ctx.asistente || 'el vendedor') + '. El que tiene el auto es "quien tiene el auto" o "el dueño".' : '· La cita es directamente con el lote.',
    ].join('\n');
}

async function expediente(ctx) {
    const L = [];
    L.push('LOTE: ' + ctx.lote + (ctx.tres ? ' · citas de 3 partes' : ' · venta directa del lote'));
    if (ctx.foco) {
        const fa = await H.info_auto({ auto_id: ctx.foco.id }).catch(() => null); const R = H.reglasFin((fa && fa.datos && fa.datos.anio) || 2020);
        L.push('AUTO EN FOCO: id ' + ctx.foco.id + ' · ' + ((fa && fa.placeholders.auto_nombre) || ctx.foco.nombre) + ' · precio ' + ((fa && fa.placeholders.precio) || fmt(ctx.foco.precio)) + (fa && fa.placeholders.kilometraje ? ' · ' + fa.placeholders.kilometraje : '') + (fa && fa.datos && fa.datos.disponible === false ? ' · ⚠️ YA NO DISPONIBLE' : '') + ' · crédito con ' + R.banco + ' (enganche mínimo ' + R.minPct + '%, hasta ' + R.plazoMax + ' meses)');
        if (ctx.tres) L.push('DUEÑO DEL AUTO: ' + (ctx.duenoTipo === 'lote' ? 'un lote' : 'un particular'));
    } else L.push('AUTO EN FOCO: ninguno (pregúntale qué busca o usa buscar_autos)');
    const e = ctx.est || {};
    L.push('YA SE LE MANDÓ: ' + ([e.ya_cotizado && 'cotización', e.fotos_enviadas && 'fotos', e.pin_enviado && 'ubicación'].filter(Boolean).join(', ') || 'nada todavía'));
    L.push('CITA: ' + (ctx.cita || 'ninguna'));
    if (ctx.pendienteMario) L.push('PENDIENTE DE MARIO (no lo contestes tú): ' + ctx.pendienteMario);
    if (ctx.obligatorio) L.push('⚠️ OBLIGATORIO: este bloque trae algo que escala (' + ctx.obligatorio + '). Llama escalar con eso; contesta solo lo demás.');
    L.push('', 'CONVERSACIÓN (lo último):'); for (const m of ctx.historial) L.push(m.quien + ': ' + String(m.texto || '').replace(/\n+/g, ' / ').slice(0, 300));
    L.push('', 'BLOQUE NUEVO DEL COMPRADOR:'); for (const b of ctx.bloque) L.push('· ' + String(b).slice(0, 500));
    return L.join('\n');
}

// candado de salida: todo número del texto debe existir en lo permitido (herramientas + expediente + comprador)
function verificar(texto, permitido) {
    const P = norm(permitido).replace(/[,\s]/g, '');
    const nums = (String(texto).match(/\d[\d,.:]*\d|\d/g) || []).map(x => x.replace(/[,]/g, '').replace(/\.$/, ''));
    const malos = nums.filter(n => n.length >= 2 && !P.includes(n.replace(/:00$/, '')));
    const promete = /(te confirmo tu cita|tu cita (qued[oó]|est[aá]) confirmad|cita confirmada|queda agendad|te aparto|te lo aparto|te hago (un )?descuento|te lo dejo en)/i.test(texto);
    return { ok: !malos.length && !promete, malos, promete };
}

async function llamar(system, messages) {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODELO, max_tokens: 4000, output_config: { effort: 'low' }, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], tools: TOOLS, messages }) });
    if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + (await r.text()).slice(0, 160));
    return r.json();
}

/**
 * Corre un turno. deps (del panel, ya atados al universo y al chat):
 *   ejecutar(accion, datos) → {status,out} (misma puerta que los botones) · mandarTexto(t) · nota(t) · escalar(motivo) · ponerFoco(inv) · catalogo() · focoDe()
 */
async function turno(ctx, deps) {
    const exp = await expediente(ctx);
    const system = sistema(ctx);
    const messages = [{ role: 'user', content: exp }];
    let permitido = exp; const envios = []; let escalo = null; let final = '';
    for (let paso = 0; paso < 6; paso++) {
        const j = await llamar(system, messages);
        if (j.stop_reason === 'refusal') { escalo = escalo || 'el agente no quiso contestar'; break; }
        messages.push({ role: 'assistant', content: j.content });
        const usos = (j.content || []).filter(b => b.type === 'tool_use');
        final = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        if (!usos.length) break;
        const resultados = [];
        for (const u of usos) {
            const a = u.input || {}; let out = null;
            try {
                if (u.name === 'ficha_auto') { const r = await H.info_auto({ auto_id: a.auto_id }); const R = r.ok ? H.reglasFin(r.datos.anio) : null; out = r.ok ? Object.assign({}, r.placeholders, r.datos, { credito: R && { banco: R.banco, enganche_minimo_pct: R.minPct, plazo_max_meses: R.plazoMax } }) : { error: r.error }; }
                else if (u.name === 'enganche_minimo') { const r = await H.enganche_minimo({ auto_id: a.auto_id }); out = r.ok ? { enganche_minimo: r.placeholders.enganche_minimo, plazo_max_meses: r.datos.plazo_max_meses } : { error: r.error }; }
                else if (u.name === 'buscar_autos') { const cat = await deps.catalogo(); const q = norm(a.texto).split(/\s+/).filter(w => w.length >= 3); const hits = cat.filter(x => { const nn = norm([x.marca, x.modelo, x.anio].join(' ')); return !q.length || q.some(w => nn.includes(w)); }).slice(0, 6); out = { autos: (hits.length ? hits : cat.slice(0, 6)).map(x => ({ auto_id: Number(x.id), nombre: [x.marca, x.modelo, x.anio].filter(Boolean).join(' '), precio: fmt(x.precio) })), exacto: !!hits.length }; }
                else if (u.name === 'cambiar_auto') { const cat = await deps.catalogo(); const inv = cat.find(x => Number(x.id) === Number(a.auto_id)); if (inv) { await deps.ponerFoco(inv); ctx.foco = { id: inv.id, nombre: [inv.marca, inv.modelo, inv.anio].join(' '), precio: inv.precio }; out = { ok: true, auto: ctx.foco.nombre }; } else out = { error: 'ese auto no es de este lote' }; }
                else if (u.name === 'escalar') { escalo = String(a.motivo || 'necesita a Mario'); out = { ok: true, nota: 'Mario ya fue avisado; tú contesta solo lo demás' }; }
                else if (u.name === 'mandar_requisitos') { envios.push({ tipo: 'requisitos' }); out = { ok: true, se_manda_despues_de_tu_texto: 'requisitos' }; }
                else if (/^mandar_/.test(u.name)) {
                    const cat = await deps.catalogo(); if (!cat.some(x => Number(x.id) === Number(a.auto_id))) out = { error: 'ese auto no es de este lote' };
                    else { envios.push({ tipo: u.name.replace('mandar_', ''), datos: a }); out = { ok: true, se_manda_despues_de_tu_texto: u.name.replace('mandar_', '') }; }
                }
                else out = { error: 'herramienta desconocida' };
            } catch (e) { out = { error: e.message }; }
            permitido += '\n' + JSON.stringify(out);
            resultados.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
        }
        messages.push({ role: 'user', content: resultados });
    }
    // ── candado y salida ──
    const v = verificar(final, permitido + '\n' + ctx.bloque.join(' '));
    const burbujas = v.ok ? final.split('||').map(x => x.trim()).filter(Boolean) : [];
    if (!v.ok) { await deps.nota('🧯 Seb agente: la respuesta traía ' + (v.promete ? 'una promesa fuera de reglas' : 'datos no verificados (' + v.malos.join(', ') + ')') + ' — no salió'); escalo = escalo || ('mi respuesta traía un dato no verificado para: "' + ctx.bloque.join(' / ').slice(0, 80) + '"'); }
    for (const b of burbujas.slice(0, 3)) await deps.mandarTexto(b);
    const hechos = [];
    for (const e of envios) {
        try {
            if (e.tipo === 'requisitos') { await deps.mandarTexto(REQUISITOS); hechos.push('requisitos'); continue; }
            const acc = { cotizacion: 'cotizar', fotos: 'fotos', ubicacion: 'ubicacion', ficha: 'info' }[e.tipo]; if (!acc) continue;
            const datos = { auto_id: e.datos.auto_id }; if (acc === 'cotizar') { let eng = Number(e.datos.enganche) || 0; if (!eng && e.datos.enganche_pct) { const f = await H.info_auto({ auto_id: e.datos.auto_id }); const pr = Number(String((f.placeholders || {}).precio || '').replace(/\D/g, '')); if (pr) eng = Math.round(pr * Number(e.datos.enganche_pct) / 100); } if (eng) datos.enganche = eng; if (e.datos.plazo_meses) datos.plazo_meses = e.datos.plazo_meses; }
            const r = await deps.ejecutar(acc, datos); if (r && r.out && r.out.ok !== false) hechos.push(e.tipo); else if (acc === 'cotizar' && !datos.enganche) { const p = await H.planes({ auto_id: e.datos.auto_id }); if (p.ok) { await deps.mandarTexto(p.placeholders.planes); hechos.push('planes'); } }
        } catch (err) { }
    }
    if (escalo) await deps.escalar(escalo);
    await deps.nota('🤖 Seb agente · ' + (burbujas.length ? burbujas.length + ' burbuja(s)' : 'sin texto') + (hechos.length ? ' · mandó ' + hechos.join(', ') : '') + (escalo ? ' · 🔔 a Mario: ' + escalo.slice(0, 80) : ''));
    return { ok: true, burbujas, hechos, escalo };
}

const REQUISITOS = 'Estos son los requisitos:\n- identificación oficial vigente\n- comprobante de domicilio\n- 3 meses de nóminas o estados de cuenta\n- RFC\n- teléfono de casa\n- Celular\n- Tiempo viviendo en el domicilio\n- Soltero o casado, en caso de ser casado, nombre del cónyuge\n- correo electrónico\n- nombre de la empresa, dirección y teléfono\n- Tiempo trabajando en la empresa\n- 4 referencias: 2 familiares que no vivan contigo (nombre y teléfono) y 2 amistades (nombre y teléfono)';

module.exports = { turno, verificar, TOOLS, MODELO };
