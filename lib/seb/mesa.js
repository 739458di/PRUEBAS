// lib/seb/mesa.js — LA MESA DE JUEGO (orden owner 2026-07-21)
//
// Una mesa con MÁXIMO 3 sillas. Solo el comprador sienta autos en ella:
//   (a) nombrándolos con sus letras — contra TODO el inventario activo, estén o
//       no en el carrusel enviado (caso David/Dodge Attitude), o
//   (b) eligiendo del aparador (eso lo escribe aparador.js en ej.mesa).
//
// Con la mesa puesta, TODO es determinista:
//   · pide algo DE UNO (nombre/año/color contra los de la mesa) → se ejecuta en ESE
//   · pregunta GENERAL (precio, ubicación, disponibilidad, cotizar) → se contesta
//     para CADA UNO de la mesa, etiquetado
//   · algo de uno SIN decir cuál (fotos con 2+ en mesa) → se pregunta "¿de cuál?"
//   · 1 solo en mesa → el flujo individual sigue intacto (solo se arregla el
//     "precio total" pelón: leer ficha es lista blanca, no negociación)
//
// El bot JAMÁS sienta autos solo — por eso no se revuelve.

const { query, run } = require('./db.js');

const normz = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// "precio total / cuánto cuesta" = LEER FICHA (lista blanca). Con palabras de
// regateo NO aplica — eso es momento de gol y escala como siempre.
const RE_PRECIO_FICHA = /(precio total|cu[aá]nto (cuesta|sale|vale|est[aá]|es|cobran)|qu[eé] precio|en cu[aá]nto (est[aá]|lo (dan|tienen))|^precios?\??$)/i;
const RE_NEGOCIA = /(menos|descuento|rebaja|mejor precio|lo dejas|[uú]ltimo precio|negocia)/i;
const RE_UBICACION = /(d[oó]nde (est[aá]n|se ubican|los (veo|puedo ver))|ubicaci[oó]n|ubicados|d[oó]nde se ubica)/i;

async function cargarMesa(tel) {
    const cur = await query("SELECT estado_json, auto_id_activo FROM wa_conversations WHERE telefono=?", [tel]);
    let ej = {}; try { ej = JSON.parse((cur[0] && cur[0].estado_json) || '{}'); } catch (e) { }
    const mesaExplicita = Array.isArray(ej.mesa) ? ej.mesa.map(Number).filter(Boolean) : [];
    let mesa = mesaExplicita.slice();
    // compat: chats de antes de la mesa — el auto activo es la mesa de 1
    if (!mesa.length && cur[0] && cur[0].auto_id_activo) mesa = [Number(cur[0].auto_id_activo)];
    return { existe: cur.length > 0, ej, mesa, mesaExplicita };
}

// ¿el comprador nombró este auto CON SUS LETRAS en este mensaje? (marca/modelo/versión)
function nombradoEnTexto(texto, nombre) {
    const t = normz(texto);
    const toks = normz(nombre).split(/\s+/).filter(w => (w.length >= 3 || /[a-z]\d|\d[a-z]/.test(w)) && !/^\d+$/.test(w));
    return toks.some(tok => t.includes(tok));
}

async function guardarMesa(tel, ej, mesa, activo) {
    ej.mesa = mesa;
    await run("UPDATE wa_conversations SET estado_json=?, auto_id_activo=?, updated_at=? WHERE telefono=?",
        [JSON.stringify(ej), activo || (mesa.length ? mesa[mesa.length - 1] : null), Date.now(), tel]).catch(() => { });
}

// ══ EL TURNO DE LA MESA — se llama DESPUÉS de entender() y ANTES del flujo
// normal (continuación/etapa3), en panel Y sandbox (fuente única).
// Regresa: {segmentos,...} = respuesta lista · {auto_id} = "corre el flujo normal
// en ESTE auto" · null = la mesa no aplica, flujo normal.
async function responderMesa({ tel, texto, clasif, convId }) {
    try {
        const t = String(texto || '');
        const { existe, ej, mesa: mesa0, mesaExplicita } = await cargarMesa(tel);
        if (!existe) return null;
        let mesa = mesa0.slice();
        const ap = require('./aparador.js');
        const autos = await ap.inventarioActivo();

        // 1) SENTAR por nombre explícito (caso David): el clasificador resolvió un
        //    auto del inventario que no está en la mesa → se sienta (máx 3, se van
        //    quedando los más recientes) y es el objetivo de este turno.
        //    "Recién sentado" exige que lo haya NOMBRADO con sus letras en ESTE
        //    mensaje (no que la IA lo infiera del historial) y que no esté ya en
        //    la mesa explícita.
        let objetivo = null, recienSentado = false;
        const cl = Number((clasif && clasif.auto_id) || 0) || null;
        if (cl && autos.some(a => a.id === cl)) {
            const rowCl = autos.find(a => a.id === cl);
            const nombrado = nombradoEnTexto(t, rowCl.nombre);
            // solo lo NOMBRADO con sus letras sienta y manda; una inferencia de la IA
            // (sacada del historial) no fuerza objetivo — las preguntas generales con
            // 2+ en mesa se contestan para TODOS
            if (nombrado) {
                if (!mesa.includes(cl)) { mesa.push(cl); while (mesa.length > 3) mesa.shift(); }
                recienSentado = !mesaExplicita.includes(cl);
                objetivo = cl;
            }
        }
        if (!mesa.length) return null;
        const rows = mesa.map(id => autos.find(a => a.id === id)).filter(Boolean);
        if (!rows.length) return null;

        // 2) ¿a cuál se refiere? — hecho duro (nombre/año/color) contra LOS DE LA MESA
        if (!objetivo && rows.length >= 2) {
            const items = rows.map((r, i) => ({ n: i + 1, id: r.id, nombre: r.nombre, color: normz(r.color || '') }));
            const r = ap.resolverEleccion(t, items);
            if (r && r.auto) objetivo = r.auto.id;
        }
        if (!objetivo && rows.length === 1) objetivo = rows[0].id;
        const objs = objetivo ? rows.filter(r => r.id === objetivo) : rows;

        // 3) PREGUNTA PENDIENTE de la mesa ("¿de cuál te mando fotos?" / "¿con cuánto
        //    de enganche?") — la respuesta se ejecuta directo, sin re-preguntar.
        const pend = ej.mesa_pregunta || null;
        if (pend === 'fotos' && objetivo && rows.length >= 2) {
            delete ej.mesa_pregunta;
            await guardarMesa(tel, ej, mesa, objetivo);
            try {
                const { responderEtapa3 } = require('./etapa3.js');
                const e3 = await responderEtapa3({ texto: 'me mandas las fotos porfavor', auto_id: objetivo, conv_id: convId, clasif: null });
                if (e3 && e3.segmentos && e3.segmentos.length && !e3.escalar) {
                    return { tipo: 'mesa_fotos', segmentos: e3.segmentos, fotos: e3.fotos || null, fotos_after_index: (e3.fotos_after_index != null ? e3.fotos_after_index : null) };
                }
            } catch (e) { }
            return { auto_id: objetivo };
        }
        if (pend === 'cotizar' && rows.length >= 2) {
            const eng = (clasif && clasif.datos && clasif.datos.enganche) || null;
            if (eng) {
                delete ej.mesa_pregunta;
                await guardarMesa(tel, ej, mesa, mesa[mesa.length - 1]);
                return await cotizarMesa(rows, eng, (clasif && clasif.datos && clasif.datos.plazo_meses) || null);
            }
        }

        // 3.5) NOMBRÓ UN AUTO NUEVO con sus letras (caso David/Dodge): ese auto ENTRA
        //      AL JUEGO ya — su universo se abre con el machote de foco (disponible +
        //      ficha + dónde lo tenemos + invitación). Si su mensaje trae además una
        //      herramienta (cotizar/fotos/ubicación), mejor se deja pasar al flujo
        //      normal para que la ejecute en ESTE auto.
        const intR = (clasif && clasif.intencion_principal) || '';
        if (recienSentado && ['', 'otro', 'info_inicial', 'disponibilidad'].includes(intR) && !RE_PRECIO_FICHA.test(t)) {
            const r = rows.find(x => x.id === objetivo);
            if (r) {
                await guardarMesa(tel, ej, mesa, objetivo);
                const segs = [`Sí, claro — el ${r.nombre} está disponible 👍`, ap.fichaBreve(r)];
                const p = await ap.puntoHablado(r.id);
                if (p) segs.push(`Lo tenemos en ${p}, para que lo veas cuando gustes`);
                segs.push('¿Te late venir a verlo y manejarlo? O si prefieres te mando las fotos y la ficha completa');
                return { tipo: 'mesa_entra_auto', segmentos: segs };
            }
        }

        // 4) PRECIO = leer ficha (lista blanca) — jala con 1, 2 o 3 en mesa.
        //    Con regateo NO: eso escala como siempre (momento de gol).
        if (RE_PRECIO_FICHA.test(t) && !RE_NEGOCIA.test(t)) {
            await guardarMesa(tel, ej, mesa, objetivo || mesa[mesa.length - 1]);
            const segs = objs.map(r => ap.fichaBreve(r));
            segs.push(objs.length === 1 ? '¿Te late venir a verlo y manejarlo?' : '¿Cuál de los dos te late más?');
            return { tipo: 'mesa_precio', segmentos: segs };
        }

        // 5) MESA DE 2-3 SIN objetivo → lo general se contesta PARA TODOS; lo que
        //    es de uno solo, se pregunta. (Con objetivo → flujo normal en ese auto.)
        const int = (clasif && clasif.intencion_principal) || '';
        if (rows.length >= 2 && !objetivo) {
            if (int === 'cita_ubicacion' || RE_UBICACION.test(t)) {
                const segs = [];
                for (const r of rows) {
                    const p = await ap.puntoHablado(r.id);
                    segs.push(`El ${r.nombre} lo tenemos en ${p || 'nuestro punto de venta'}`);
                }
                segs.push('¿Cuál te queda mejor para ir a verlo?');
                await guardarMesa(tel, ej, mesa, mesa[mesa.length - 1]);
                return { tipo: 'mesa_ubicaciones', segmentos: segs };
            }
            if (int === 'disponibilidad') {
                await guardarMesa(tel, ej, mesa, mesa[mesa.length - 1]);
                return { tipo: 'mesa_disponibilidad', segmentos: [`Sí, los ${rows.length === 2 ? 'dos' : rows.length} siguen disponibles 👍`, '¿Te late venir a verlos?'] };
            }
            if (int === 'fotos_videos') {
                ej.mesa_pregunta = 'fotos';
                await guardarMesa(tel, ej, mesa, mesa[mesa.length - 1]);
                return { tipo: 'mesa_fotos_pregunta', segmentos: ['Claro — ¿de cuál te mando fotos, ' + rows.map(r => 'el ' + r.nombre).join(' o ') + '?'] };
            }
            if (int === 'cotizar_credito') {
                const eng = (clasif && clasif.datos && clasif.datos.enganche) || null;
                if (!eng) {
                    ej.mesa_pregunta = 'cotizar';
                    await guardarMesa(tel, ej, mesa, mesa[mesa.length - 1]);
                    return { tipo: 'mesa_cotizar_pregunta', segmentos: [`Va, te corro los números de los ${rows.length === 2 ? 'dos' : rows.length} — ¿con cuánto de enganche le hacemos?`] };
                }
                await guardarMesa(tel, ej, mesa, mesa[mesa.length - 1]);
                return await cotizarMesa(rows, eng, (clasif && clasif.datos && clasif.datos.plazo_meses) || null);
            }
        }

        // 6) hay objetivo (o mesa de 1) → el flujo normal corre en ESE auto
        if (objetivo) {
            await guardarMesa(tel, ej, mesa, objetivo);
            return { auto_id: objetivo };
        }
        // mesa cambió (se sentó alguien) pero nada que interceptar → persistir y seguir
        if (JSON.stringify(mesa) !== JSON.stringify(mesa0)) await guardarMesa(tel, ej, mesa, mesa[mesa.length - 1]);
        return null;
    } catch (e) { console.error('[mesa]', e.message); return null; }
}

// "le cotizas los dos" — la MISMA herramienta cotizar() por cada auto de la mesa
async function cotizarMesa(rows, enganche, plazo) {
    try {
        const { cotizar } = require('./herramientas.js');
        const segs = [];
        for (const r of rows) {
            const c = await cotizar({ auto_id: r.id, enganche, plazo_meses: plazo || undefined });
            if (c && c.ok && c.placeholders && c.placeholders.cotizacion) segs.push(c.placeholders.cotizacion);
        }
        if (!segs.length) return null;
        segs.push(`¿Cuál de los ${rows.length === 2 ? 'dos' : rows.length} te late más? Te late venir a verlos?`);
        return { tipo: 'mesa_cotizaciones', segmentos: segs };
    } catch (e) { return null; }
}

module.exports = { responderMesa, cargarMesa };
