// lib/seb/ruteador.js — EL PERRO DE CAZA (orden owner 2026-07-21)
//
// El problema que mata: dispatch por regex/intención = parche por parche, y
// siempre hay una frase de más que agarra en curva ("tengo 100 de enganche,
// ¿qué similares tienes?" → cotizaba en vez de traer inventario).
//
// La arquitectura: Haiku es UN PERRO PARA INTERPRETAR — huele el mensaje (con
// la mesa y el historial en mano) y ELIGE herramientas (0 a 3, combinadas o
// no). JAMÁS redacta: el CÓDIGO ejecuta cada herramienta leyendo Turso y
// responde con los machotes del owner + UN gancho estratégico según el estado.
//
// LOS CANDADOS (por qué es incorruptible):
//   · la salida de Haiku es un formulario cerrado (enum de herramientas)
//   · toda herramienta desconocida se DESCARTA; cifras fuera de rango se anulan
//   · confianza baja o cero herramientas → null → la doctrina ESCALA (jamás
//     improvisa); citas/fechas/regateo NO son del perro — siguen su máquina
//   · los textos que salen son 100% machotes + datos releídos de la base

const { query, run } = require('./db.js');

const HAIKU = 'claude-haiku-4-5';
const normz = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

async function haiku(system, schema, content, maxTokens) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return null;
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
                model: HAIKU, max_tokens: maxTokens || 400, system,
                messages: [{ role: 'user', content }],
                output_config: { format: { type: 'json_schema', schema } }
            })
        });
        if (!r.ok) return null;
        const d = await r.json();
        return JSON.parse((d.content || []).find(b => b.type === 'text').text);
    } catch (e) { return null; }
}

const HERRAMIENTAS = ['traer_inventario', 'cotizar', 'descripcion', 'fotos', 'ubicacion', 'disponibilidad', 'dato_ficha'];
const CAMPOS_FICHA = ['carroceria', 'transmision', 'combustible', 'color', 'motor', 'kilometraje', 'anio', 'duenos', 'factura'];

const SCHEMA = {
    type: 'object',
    properties: {
        herramientas: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    tool: { type: 'string', enum: HERRAMIENTAS },
                    enganche: { type: ['integer', 'null'] },
                    presupuesto: { type: ['integer', 'null'] },
                    plazo_meses: { type: ['integer', 'null'] },
                    tipo: { type: ['string', 'null'] },
                    categoria: { type: ['string', 'null'] },
                    marca: { type: ['string', 'null'] },
                    anio_min: { type: ['integer', 'null'] },
                    anio_max: { type: ['integer', 'null'] },
                    similar_al_foco: { type: ['boolean', 'null'] },
                    economicos: { type: ['boolean', 'null'] },
                    campo: { type: ['string', 'null'] },
                    objetivo: { type: ['string', 'null'] }
                },
                required: ['tool', 'enganche', 'presupuesto', 'plazo_meses', 'tipo', 'categoria', 'marca', 'anio_min', 'anio_max', 'similar_al_foco', 'economicos', 'campo', 'objetivo'],
                additionalProperties: false
            }
        },
        confianza: { type: 'string', enum: ['alta', 'media', 'baja'] }
    },
    required: ['herramientas', 'confianza'],
    additionalProperties: false
};

const SYSTEM = `Eres el RUTEADOR de un vendedor de autos usados en Monterrey. Te dan el mensaje del comprador, los autos que trae en la mesa y el historial breve. Tu ÚNICO trabajo: elegir qué herramientas ejecutar (0 a 3, en orden). NO redactas nada.

HERRAMIENTAS:
- traer_inventario: pide ver autos del inventario — "qué similares tienes", "con ese enganche qué me alcanza", "algo más barato", "una pickup", "qué camionetas tienen", "qué más hay", "modelo a partir de 2022"/"2022 en adelante" (anio_min), "ando buscando una Tacoma", "no tienes un Audi 2024?". Params: enganche/presupuesto (pueden venir del HISTORIAL si dice "ese enganche" — y si antes dio presupuesto/año, esos criterios SIGUEN vivos: inclúyelos), **categoria**, marca, anio_min, anio_max, similar_al_foco (parecidos al auto que ya ve), economicos (pide lo más barato).
  · **categoria** es el filtro del inventario y vale exactamente uno de: sedan | pickup | suv | deportivo | utv. Dedúcela SIEMPRE que se pueda, incluso del modelo que nombre: "pickup/troca/camioneta de batea/Tacoma/Lobo/RAM/F-150" → pickup · "camioneta/SUV/familiar/CRV/Q5/X5/Suburban/Cherokee" → suv · "sedán/carro/auto compacto/Sentra/Jetta/Mazda 3" → sedan · "deportivo/Mustang/Camaro" → deportivo · "razer/UTV/Can-Am" → utv. Si de plano no hay señal de categoría, déjala null.
  · Si pide una MARCA o MODELO que quizá no tengamos ("un Audi 2024", "una Tacoma"), IGUAL manda traer_inventario con marca + año + categoría deducida: el código decide si hay o si ofrece alternativas.
- cotizar: quiere números/mensualidades DEL auto que ya ve (sin pedir otras opciones). Params: enganche, plazo_meses, objetivo (foco|todos).
- descripcion: pide la info/ficha del auto.
- fotos: pide fotos/video.
- ubicacion: pregunta dónde está/dónde verlo.
- disponibilidad: pregunta si sigue disponible.
- dato_ficha: pregunta UN dato concreto del auto — "¿es automático?", "¿es sedán?", "¿cuántos km?", "¿qué color?", "¿único dueño?", "¿factura?". Param campo.

REGLAS DE ORO:
- COMBINA cuando el mensaje pida varias cosas ("info y fotos" → descripcion + fotos; "tengo 100 mil de enganche, ¿qué similares tienes?" → traer_inventario con enganche=100000).
- "ese enganche"/"con eso" → busca la cifra en el historial.
- Si pregunta DÓNDE están/verlos, la herramienta es ubicacion — JAMÁS traer_inventario.
- NO SON TUYAS (herramientas: [] y sigue su máquina): fechas/horas/citas, regateo o descuentos ("¿en cuánto me lo dejas?"), apartar/pagar, garantías, papeles legales, quejas, "¿lo tienes a crédito?"/"¿aceptan financiamiento?" SIN cifras (su máquina trae el guion del banco), y todo lo que no encaje CLARO.
- Si dudas entre algo y nada → nada con confianza baja. Jamás inventes cifras que el comprador no dijo (el historial del comprador sí cuenta).`;

// ── candados de código sobre la salida del perro ──
function validar(out) {
    if (!out || !Array.isArray(out.herramientas)) return null;
    const okNum = (v, min, max) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max) ? Number(v) : null;
    const hs = out.herramientas
        .filter(h => h && HERRAMIENTAS.includes(h.tool))
        .slice(0, 3)
        .map(h => ({
            tool: h.tool,
            enganche: okNum(h.enganche, 5000, 2000000),
            presupuesto: okNum(h.presupuesto, 50000, 3000000),
            plazo_meses: okNum(h.plazo_meses, 6, 72),
            tipo: ['camioneta', 'sedan', 'hatchback'].includes(h.tipo) ? h.tipo : null,
            categoria: ['sedan', 'pickup', 'suv', 'deportivo', 'utv'].includes(normz(h.categoria || '')) ? normz(h.categoria) : null,
            marca: h.marca ? normz(h.marca).slice(0, 20) : null,
            anio_min: okNum(h.anio_min, 1990, 2030),
            anio_max: okNum(h.anio_max, 1990, 2030),
            similar_al_foco: h.similar_al_foco === true,
            economicos: h.economicos === true,
            campo: CAMPOS_FICHA.includes(h.campo) ? h.campo : null,
            objetivo: ['foco', 'todos'].includes(h.objetivo) ? h.objetivo : null
        }));
    if (!hs.length) return null;
    if (out.confianza === 'baja') return null;   // ante la duda → doctrina (escala)
    return hs;
}

// ── EJECUTAR: cada herramienta es código puro leyendo Turso + machotes ──
async function ejecutar({ tel, herramientas, mesaRows, ej, convId, texto }) {
    const ap = require('./aparador.js');
    const autos = await ap.inventarioActivo();
    const foco = mesaRows && mesaRows.length ? mesaRows[mesaRows.length - 1] : null;
    let segmentos = [], fotos = null, fotosIdx = null, tipoOut = [], escala = null, preguntaViva = null, preguntaTarget = null;
    let autosTocados = 0;   // cuántos autos tocó ESTA respuesta (el gancho cuenta esto, no la mesa)

    for (const h of herramientas) {
        const objs = (h.objetivo === 'todos' && mesaRows.length >= 2) ? mesaRows : (foco ? [foco] : []);
        autosTocados = Math.max(autosTocados, objs.length);

        if (h.tool === 'traer_inventario') {
            let lista = null, intro = null, ordenDado = true;
            // ¿pidió algo que NO tenemos ("una Hilux", "un Tesla")? → honesto + conversión
            const fueraP = ap.pedidoFueraDeInventario(String(texto || ''), autos);
            if (fueraP) {
                const altP = ap.puenteDeConversion({ marca: fueraP.marca, anio: fueraP.anio, categoria: fueraP.categoria, presupuesto: h.presupuesto || (h.enganche ? h.enganche * 6 : null), autos });
                if (altP.length) {
                    const aprP = await ap.armarAparador({ ancla: null, lista: altP, nFotos: 4, ordenDado: true, intro: `De ${fueraP.etiqueta} ahorita no tengo 🙏 pero mira lo que sí te puedo enseñar en ese mismo estilo:` });
                    if (aprP) {
                        await ap.guardarEstadoAparador(tel, aprP.aparador, null);
                        await run("UPDATE wa_conversations SET auto_id_activo=NULL, updated_at=? WHERE telefono=?", [Date.now(), tel]).catch(() => { });
                        segmentos = segmentos.concat(aprP.segmentos);
                        if (!fotos && aprP.fotos) { fotos = aprP.fotos; fotosIdx = segmentos.length - aprP.segmentos.length + (aprP.fotos_after_index || 0); }
                        tipoOut.push('puente');
                        continue;
                    }
                }
                return { tipo: 'perro_sin_match', segmentos: [`De ${fueraP.etiqueta} ahorita no tengo 🙏`], escalar_owner: true, escala_motivo: '💰 pide ' + fueraP.etiqueta + ' y no tenemos ni alternativa clara — lo ves tú' };
            }
            const crit = {};
            if (h.enganche) crit.enganche = h.enganche;
            if (h.presupuesto) crit.presupuesto = h.presupuesto;
            if (h.tipo) crit.tipo = h.tipo;
            if (h.categoria) crit.categoria = h.categoria;
            if (h.marca) crit.marca = h.marca;
            if (h.anio_min) crit.anio_min = h.anio_min;
            if (h.anio_max) crit.anio_max = h.anio_max;
            const hayCrit = Object.keys(crit).length > 0;
            const conPrecio = !!(h.enganche || h.presupuesto);
            if (h.economicos && !hayCrit) {
                lista = autos.filter(a => Number(a.precio || 0) > 0).sort((a, b) => Number(a.precio) - Number(b.precio)).slice(0, 5);
                intro = 'Va, estos son los más económicos que tenemos ahorita 🚗';
            } else if (hayCrit) {
                lista = ap.buscarInventario(crit, autos);
                if (h.similar_al_foco && foco) {
                    // similares al foco DENTRO de lo que cumple la necesidad
                    lista = lista.map(a => ({ a, s: ap.scoreSimilitud(foco, a) })).sort((x, y) => y.s - x.s).map(x => x.a);
                }
                lista = lista.filter(a => !foco || a.id !== foco.id);
                // SINTONÍA + CONTEO (orden owner): eco de su palabra y el número real
                intro = /(similar|parecid)/i.test(String(texto || ''))
                    ? 'Claro, de modelos similares también tenemos estos 🚗'
                    : ap.fraseConteo(h.categoria, lista.length, conPrecio);
                if (!lista.length) {
                    // ══ PUENTE DE CONVERSIÓN: de eso no hay, pero no se pierde la venta
                    const alt = ap.puenteDeConversion({ marca: h.marca, anio: h.anio_min || h.anio_max || null, categoria: h.categoria, presupuesto: crit.presupuesto || (crit.enganche ? crit.enganche * 6 : null), autos });
                    const cap = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
                    const pedido = [h.marca ? cap(h.marca) : null, h.anio_min || h.anio_max || null].filter(Boolean).join(' ')
                        || (h.categoria && ap.CATEGORIAS[h.categoria] ? ap.CATEGORIAS[h.categoria].plural : 'eso');
                    if (alt.length) {
                        lista = alt; ordenDado = true;
                        intro = `De ${pedido} ahorita no tengo 🙏 pero mira lo que sí te puedo enseñar en ese mismo estilo:`;
                        tipoOut.push('puente');
                    } else {
                        return { tipo: 'perro_sin_match', segmentos: [`De ${pedido} ahorita no tengo algo que te acomode 🙏`], escalar_owner: true, escala_motivo: '💰 busca ' + pedido + ' y no hay match ni alternativa clara — lo ves tú' };
                    }
                }
            } else if (h.similar_al_foco && foco) {
                lista = ap.similaresA(foco, autos, 7);
                intro = `Claro, parecidos al ${foco.nombre} tenemos estos 🚗`;
                if (!lista.length) { lista = autos.filter(a => a.id !== foco.id); intro = 'Claro, mira, también tenemos estas oportunidades 🚗'; ordenDado = false; }
            } else {
                lista = autos.filter(a => !foco || a.id !== foco.id);
                intro = 'Claro, mira, estas son buenas oportunidades 🚗';
                ordenDado = false;
            }
            const apr = await ap.armarAparador({ ancla: null, lista, intro, nFotos: 4, ordenDado });
            if (apr) {
                // aparador nuevo → la elección se re-arma (regla existente)
                await ap.guardarEstadoAparador(tel, apr.aparador, null);
                await run("UPDATE wa_conversations SET auto_id_activo=NULL, updated_at=? WHERE telefono=?", [Date.now(), tel]).catch(() => { });
                segmentos = segmentos.concat(apr.segmentos);
                if (!fotos && apr.fotos) { fotos = apr.fotos; fotosIdx = segmentos.length - apr.segmentos.length + (apr.fotos_after_index || 0); }
                tipoOut.push('inventario');
            }
        }

        else if (h.tool === 'cotizar') {
            if (!objs.length) continue;
            const eng = h.enganche;
            if (!eng) {
                segmentos.push(`Va, te corro los números — ¿con cuánto de enganche le hacemos?`);
                preguntaViva = 'cotizar'; tipoOut.push('cotizar_pregunta');
                // recordar DE QUÉ auto era la pregunta — la respuesta cotiza ESE, no todos
                if (objs.length === 1) preguntaTarget = objs[0].id;
            } else {
                const { cotizar } = require('./herramientas.js');
                for (const r of objs) {
                    const c = await cotizar({ auto_id: r.id, enganche: eng, plazo_meses: h.plazo_meses || undefined });
                    if (c && c.ok && c.placeholders && c.placeholders.cotizacion) segmentos.push(c.placeholders.cotizacion);
                }
                tipoOut.push('cotizacion');
            }
        }

        else if (h.tool === 'descripcion') {
            if (!objs.length) continue;
            for (const r of objs) segmentos.push(await ap.descripcionDe(r));
            tipoOut.push('descripcion');
        }

        else if (h.tool === 'fotos') {
            if (!objs.length) continue;
            if (objs.length >= 2 && h.objetivo === 'todos') {
                // pidió fotos de LOS DOS → 2 por auto, combinadas
                let fsAll = [];
                for (const r of objs) fsAll = fsAll.concat(await ap.fotosAuto(r.fyradrive_web_id, 2));
                if (fsAll.length) { segmentos.push('Van, ahí te van de los ' + (objs.length === 2 ? 'dos' : objs.length)); fotos = fsAll.slice(0, 6); fotosIdx = segmentos.length - 1; tipoOut.push('fotos'); }
            } else if (objs.length >= 2) {
                segmentos.push('Claro — ¿de cuál te mando fotos, ' + objs.map(r => 'el ' + r.nombre).join(' o ') + '?');
                preguntaViva = 'fotos'; tipoOut.push('fotos_pregunta');
            } else {
                const fs = await ap.fotosAuto(objs[0].fyradrive_web_id, 12);
                if (fs.length) { segmentos.push('Van, ahí te las mando'); fotos = fs; fotosIdx = segmentos.length - 1; tipoOut.push('fotos'); }
            }
        }

        else if (h.tool === 'ubicacion') {
            // con UN auto la ubicación NO es del perro: su máquina manda el paquete
            // completo (captura + pin + cita) — el perro solo la contesta en multi
            if (objs.length < 2) continue;
            for (const r of objs) {
                const p = await ap.puntoHablado(r.id);
                if (p) segmentos.push(objs.length > 1 ? `El ${r.nombre} lo tenemos en ${p}` : `Lo tenemos en ${p}, para que lo veas cuando gustes`);
            }
            tipoOut.push('ubicacion');
        }

        else if (h.tool === 'disponibilidad') {
            if (!objs.length) continue;
            segmentos.push(objs.length >= 2 ? `Sí, los ${objs.length === 2 ? 'dos' : objs.length} siguen disponibles 👍` : 'Sí, sigue disponible 👍');
            tipoOut.push('disponibilidad');
        }

        else if (h.tool === 'dato_ficha') {
            if (!objs.length || !h.campo) continue;
            for (const r of objs) {
                const linea = await datoFicha(r, h.campo);
                if (!linea) {
                    // dato que NO está en la base → jamás inventar → escala mudo
                    return { tipo: 'perro_dato_faltante', segmentos: null, escalar_owner: true, escala_motivo: `pregunta ${h.campo} del ${r.nombre} y no está en la ficha — lo ves tú` };
                }
                segmentos.push(objs.length > 1 ? `${r.nombre}: ${linea}` : linea);
            }
            tipoOut.push('dato_ficha');
        }
    }

    if (!segmentos.length) return null;
    // EL GANCHO (uno solo, del estado): si nada quedó preguntando, se jala a la cita.
    // Cuenta los autos que TOCÓ esta respuesta (red team r2 #6: "¿cuál de los 3?" con 1)
    const terminaPregunta = /\?\s*$/.test(segmentos[segmentos.length - 1]);
    if (!terminaPregunta) {
        segmentos.push(autosTocados >= 2 ? '¿Cuál te late ir a ver primero? Te agendo de una vez' : '¿Te late venir a verlo y manejarlo? Te agendo de una vez');
    }
    return { tipo: 'perro_' + (tipoOut.join('+') || 'mix'), segmentos, fotos, fotos_after_index: fotosIdx, pregunta_viva: preguntaViva, pregunta_target: preguntaTarget };
}

// dato concreto de la ficha — SOLO lo que la base sabe (nada de inventar)
async function datoFicha(r, campo) {
    let w = null;
    try {
        const q = await query('SELECT tipo_carroceria, transmision, tipo_combustible, color, motor, numero_duenos, factura_original, kilometraje, "año" AS anio FROM autos WHERE id=?', [Number(r.fyradrive_web_id || 0)]);
        w = q[0] || null;
    } catch (e) { }
    const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
    const val = (a, b) => (w && w[a]) || r[b || a] || null;
    if (campo === 'carroceria') { const v = val('tipo_carroceria'); return v ? `Es ${normz(v)} 👍` : null; }
    if (campo === 'transmision') { const v = val('transmision'); return v ? (/auto/i.test(v) ? 'Es automático 👍' : `Es ${normz(v)}`) : null; }
    if (campo === 'combustible') { const v = w && w.tipo_combustible; return v ? `Es a ${normz(v)}` : null; }
    if (campo === 'color') { const v = val('color'); return (v && normz(v) !== 'no especificado') ? `Es color ${normz(v)}` : null; }
    if (campo === 'motor') { const v = w && w.motor; return v ? `Motor ${v}` : null; }
    if (campo === 'kilometraje') { const v = val('kilometraje'); return v ? `Trae ${Number(v).toLocaleString('es-MX')} km` : null; }
    if (campo === 'anio') { const v = (w && w.anio) || r.anio; return v ? `Es ${v}` : null; }
    if (campo === 'duenos') { const v = w && w.numero_duenos; const m = { unico_dueno: 'Único dueño 👍', unico: 'Único dueño 👍', dos: 'Ha tenido 2 dueños', tres: 'Ha tenido 3 dueños' }[String(v || '')]; return m || null; }
    if (campo === 'factura') { const v = w && w.factura_original; return v ? (/si|s[ií]|original|agencia/i.test(String(v)) ? 'Factura original 👍' : String(cap(v)).slice(0, 60)) : null; }
    return null;
}

// ══ EL TURNO DEL PERRO — se llama cuando la mesa determinista no reconoció el
// mensaje (panel Y sandbox, fuente única). null = no es del perro → doctrina.
// señal de CITA/fecha/hora → el perro NO toca el mensaje (red team r2 #1: "fotos y
// agéndame el sábado a las 11" se comía la cita) — la máquina de citas manda
// buscar OTRO auto por transmisión ("¿tendrás estándar?") NO es del perro: el dato
// de transmisión de la base no es confiable para filtrar → escala al owner
const RE_BUSCA_TRANSMISION = /(est[aá]ndar|standar|manual|autom[aá]tic)[^?]{0,40}(tendr|tienes|tienen|hay|alguno|otro|manejan|consigues)|((tendr|tienes|tienen|hay|alguno|otro)[^?]{0,40}(est[aá]ndar|standar|manual))/i;
const RE_CITA_GUARD = /\b(agenda|agéndame|agendame|cita|el (lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|ma[ñn]ana|hoy (mismo|en la tarde|en la noche)|pasado ma[ñn]ana|a las? \d{1,2})\b/i;

async function rutear({ tel, texto, historial, convId }) {
    try {
        const t = String(texto || '').trim();
        if (!t || t.length > 600) return null;
        if (RE_CITA_GUARD.test(t)) return null;
        if (RE_BUSCA_TRANSMISION.test(t)) return null;   // → doctrina: escala al owner
        // la mesa del comprador (para que el perro sepa qué autos trae en juego)
        const cur = await query("SELECT estado_json, auto_id_activo FROM wa_conversations WHERE telefono=?", [tel]);
        let ej = {}; try { ej = JSON.parse((cur[0] && cur[0].estado_json) || '{}'); } catch (e) { }
        let mesa = Array.isArray(ej.mesa) ? ej.mesa.map(Number).filter(Boolean) : [];
        if (!mesa.length && cur[0] && cur[0].auto_id_activo) mesa = [Number(cur[0].auto_id_activo)];
        const ap = require('./aparador.js');
        const autos = await ap.inventarioActivo();
        const mesaRows = mesa.map(id => autos.find(a => a.id === id)).filter(Boolean);

        const contexto = [
            'MESA (autos que ya trae en juego): ' + (mesaRows.length ? mesaRows.map(r => r.nombre + ' $' + Number(r.precio || 0).toLocaleString('en-US')).join(' | ') : 'ninguno'),
            'HISTORIAL BREVE:\n' + String(historial || '').slice(-900),
            'MENSAJE DEL COMPRADOR:\n' + t
        ].join('\n\n');

        const out = await haiku(SYSTEM, SCHEMA, contexto, 400);
        const hs = validar(out);
        if (!hs) return null;
        const res = await ejecutar({ tel, herramientas: hs, mesaRows, ej, convId, texto: t });
        if (!res) return null;
        // CANDADO ANTI-ECO (red team r2 #1): si el perro va a repetir EXACTAMENTE lo
        // mismo que su respuesta anterior en este chat → no es la respuesta correcta
        // → null (el flujo sigue y la doctrina escala en vez de spamear)
        if (res.segmentos && res.segmentos.length) {
            const firma = normz(res.segmentos.join('|')).slice(0, 160);
            if (ej._perro_eco && ej._perro_eco.f === firma && (Date.now() - ej._perro_eco.ts) < 15 * 60000) return null;
            ej._perro_eco = { f: firma, ts: Date.now() };
            await run("UPDATE wa_conversations SET estado_json=?, updated_at=? WHERE telefono=?", [JSON.stringify(ej), Date.now(), tel]).catch(() => { });
        }
        // pregunta viva (¿de cuál fotos? / ¿cuánto enganche?) → misma memoria de la mesa
        if (res.pregunta_viva) {
            ej.mesa_pregunta = res.pregunta_viva;
            if (res.pregunta_target) ej.mesa_pregunta_auto = res.pregunta_target;
            await run("UPDATE wa_conversations SET estado_json=?, updated_at=? WHERE telefono=?", [JSON.stringify(ej), Date.now(), tel]).catch(() => { });
        }
        return res;
    } catch (e) { console.error('[perro]', e.message); return null; }
}

module.exports = { rutear, validar, datoFicha, HERRAMIENTAS };
