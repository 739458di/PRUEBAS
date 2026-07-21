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
// SACAR de la mesa ("ya no quiero el dodge") — solo con el auto NOMBRADO; un "ya no
// me interesa" pelón NO es sacar, es un lead enfriándose y eso lo ve el owner.
const RE_SACAR = /(ya no (me interesa|quiero|lo quiero)|desc[aá]rta(me|lo|la)?|qu[ií]ta(me|lo|la)?|olv[ií]da(te|lo|la)? (el|la|del)|mejor no (el|la)|deja fuera)/i;

async function cargarMesa(tel) {
    const cur = await query("SELECT estado_json, auto_id_activo FROM wa_conversations WHERE telefono=?", [tel]);
    let ej = {}; try { ej = JSON.parse((cur[0] && cur[0].estado_json) || '{}'); } catch (e) { }
    const mesaExplicita = Array.isArray(ej.mesa) ? ej.mesa.map(Number).filter(Boolean) : [];
    let mesa = mesaExplicita.slice();
    // compat: chats de antes de la mesa — el auto activo es la mesa de 1
    if (!mesa.length && cur[0] && cur[0].auto_id_activo) mesa = [Number(cur[0].auto_id_activo)];
    const activo = cur[0] ? (Number(cur[0].auto_id_activo) || null) : null;
    return { existe: cur.length > 0, ej, mesa, mesaExplicita, activo };
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
        const { existe, ej, mesa: mesa0, mesaExplicita, activo } = await cargarMesa(tel);
        if (!existe) return null;
        let mesa = mesa0.slice();
        const ap = require('./aparador.js');
        const autos = await ap.inventarioActivo();

        // 0) SACAR de la mesa ("ya no quiero el dodge") — DETERMINISTA, sin IA: la
        //    frase de descarte se cruza directo contra los NOMBRES de la mesa (el
        //    loop: meter y sacar libres). Descarte pelón sin nombre → flujo normal
        //    (lead enfriándose = lo ve el owner, no lo decide el bot).
        const mSacar = t.match(RE_SACAR);
        if (mSacar && mesa.length) {
            // la FRASE del descarte: del "ya no quiero" al siguiente punto/coma — el
            // auto a sacar debe estar nombrado AHÍ, no en cualquier parte del mensaje
            // (red team #1: "ya no quiero el Tacoma. del Audi cotízame" sacaba el Audi)
            const desde = mSacar.index || 0;
            const corte = t.slice(desde).search(/[.,;\n]/);
            const clausula = t.slice(desde, corte >= 0 ? desde + corte : desde + 60);
            const rowsAll = mesa.map(id => autos.find(a => a.id === id)).filter(Boolean);
            const nombrados = rowsAll.filter(r => nombradoEnTexto(clausula, r.nombre));
            if (nombrados.length === 1) {
                const fuera = nombrados[0];
                mesa = mesa.filter(x => x !== fuera.id);
                ej.interes = (Array.isArray(ej.interes) ? ej.interes : []).filter(x => x !== fuera.id);
                // ¿el mensaje traía MÁS que el descarte? → la mesa sigue procesando el
                // resto (p. ej. la cotización del otro auto) — la respuesta confirma sola
                const restoTxt = (t.slice(0, desde) + t.slice(desde + clausula.length)).replace(/[^a-zA-Z0-9áéíóúñ]/g, '');
                if (restoTxt.length < 12) {
                    await guardarMesa(tel, ej, mesa, mesa.length ? mesa[mesa.length - 1] : null);
                    const resto = mesa.map(id => autos.find(a => a.id === id)).filter(Boolean);
                    const segs = [`Va, descartamos el ${fuera.nombre} 👍`];
                    if (resto.length) segs.push(`Seguimos con ${resto.map(r => 'el ' + r.nombre).join(' y ')} — ¿te late venir a verlo${resto.length > 1 ? 's' : ''}?`);
                    else segs.push('¿Te muestro otras opciones que te acomoden?');
                    return { tipo: 'mesa_sacar', segmentos: segs };
                }
                await guardarMesa(tel, ej, mesa, mesa.length ? mesa[mesa.length - 1] : null);
                // sigue el turno con la mesa ya sin ese auto
            }
        }

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
            if (nombrado && !ap.esNegado(t, rowCl.nombre)) {
                if (!mesa.includes(cl)) { mesa.push(cl); while (mesa.length > 3) mesa.shift(); }
                recienSentado = !mesaExplicita.includes(cl);
                objetivo = cl;
            }
        }
        // ¿Nombró VARIOS con sus letras? (red team #3: "el Tacoma y el Audi Q3, ¿dónde
        // se ubican?") — cada pedazo se resuelve contra TODO el inventario; todos los
        // resueltos se sientan (máx 3). Con 2+ nuevos, el objetivo se suelta: lo que
        // pida aplica a TODOS.
        let nuevosMulti = [], preguntaAmb = null;
        {
            const frasesM = t.split(/\s*(?:,|\by\b|\btambi[eé]n\b)\s*/i).map(s => s.trim()).filter(s => s.length >= 3);
            if (frasesM.length > 1) {
                const items = autos.map(a => ({ n: 0, id: a.id, nombre: a.nombre, color: '' }));
                for (const f of frasesM) {
                    const r = ap.resolverEleccion(f, items);
                    if (r && r.auto && !nuevosMulti.includes(r.auto.id) && !ap.esNegado(f, r.auto.nombre)) nuevosMulti.push(r.auto.id);
                    else if (r && r.pregunta && !preguntaAmb) preguntaAmb = r.pregunta;
                }
                if (nuevosMulti.length >= 2) {
                    for (const id of nuevosMulti) if (!mesa.includes(id)) mesa.push(id);
                    while (mesa.length > 3) mesa.shift();
                    objetivo = null; recienSentado = false;
                }
            }
            // red team r2 #3: nombró una FAMILIA ambigua ("el Sentra" y hay dos) sin que
            // nada más la resolviera → se pregunta cuál, jamás inventario random
            if (!nuevosMulti.length && !objetivo && preguntaAmb) {
                return { tipo: 'mesa_pregunta_cual', segmentos: ['¿Cuál de estos? ' + preguntaAmb.map(x => x.nombre).join(' o ') + ' 🤔'] };
            }
            // compradores-reales #8 ("info del yaris y del honda"): lo RESUELTO se
            // atiende YA y por la familia ambigua se pregunta — nada se cae en silencio
            if (nuevosMulti.length >= 1 && preguntaAmb) {
                for (const id of nuevosMulti) if (!mesa.includes(id)) mesa.push(id);
                while (mesa.length > 3) mesa.shift();
                await guardarMesa(tel, ej, mesa, nuevosMulti[nuevosMulti.length - 1]);
                const rowsR = nuevosMulti.map(id => autos.find(a => a.id === id)).filter(Boolean);
                const segsC = []; const fotosC = [];
                for (const r of rowsR) {
                    const p = await ap.puntoHablado(r.id);
                    segsC.push(ap.fichaBreve(r) + (p ? '\nLo tenemos en ' + p : ''));
                    const pf = await ap.portadaDe(r.fyradrive_web_id); if (pf) fotosC.push(pf);
                }
                segsC.push('¿Y de esos cuál te interesa, ' + preguntaAmb.map(x => x.nombre).join(' o ') + '?');
                return { tipo: 'mesa_multi_y_pregunta', segmentos: segsC, fotos: fotosC.length ? fotosC : null, fotos_after_index: segsC.length - 2 };
            }
        }

        // ══ LA CITA MANDA (compradores-reales #4): si el mensaje trae día/hora/cita,
        // la mesa NO intercepta — la máquina de citas es la dueña de ese momento.
        if (/\b(agenda|ag[eé]ndame|cita|el (lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|ma[ñn]ana|pasado ma[ñn]ana|a las? \d{1,2}|en la (tarde|noche|ma[ñn]ana))\b/i.test(t)) {
            if (JSON.stringify(mesa) !== JSON.stringify(mesa0)) await guardarMesa(tel, ej, mesa, objetivo || mesa[mesa.length - 1]);
            return objetivo ? { auto_id: objetivo } : null;
        }

        // ══ CORRECCIÓN DE AÑO (compradores-reales #7): "Correction es 2021" con un
        // foco puesto → mismo modelo del otro año, si existe: cambia el foco con su
        // machote; varios → pregunta; ninguno → flujo normal (escala, jamás inventar).
        {
            const anioTx = Number((t.match(/\b(19|20)\d{2}\b/) || [])[0] || 0);
            const esCorr = t.trim().length < 45 && anioTx && /(correc|corrijo|perd[oó]n|equivoqu|mejor el|es el|es de)/i.test(t);
            const focoC = mesa.length === 1 ? autos.find(a => a.id === mesa[0]) : null;
            if (esCorr && focoC && Number(focoC.anio) !== anioTx && !objetivo) {
                const tokModelo = normz(String(focoC.modelo || '')).split(/\s+/)[0] || '';
                const familia = autos.filter(a => normz(a.marca) === normz(focoC.marca) && normz(String(a.modelo || '')).split(/\s+/)[0] === tokModelo && Number(a.anio) === anioTx);
                if (familia.length === 1) {
                    const r = familia[0];
                    mesa = [r.id];
                    ej.interes = (Array.isArray(ej.interes) ? ej.interes : []).filter(x => x !== r.id).concat([r.id]);
                    await guardarMesa(tel, ej, mesa, r.id);
                    const segsA = [`Ah, va — el ${r.nombre} 👍`, await ap.descripcionDe(r)];
                    const pA = await ap.puntoHablado(r.id);
                    if (pA) segsA.push(`Lo tenemos en ${pA}, para que lo veas cuando gustes`);
                    segsA.push('¿Qué día te queda bien para venir a verlo y manejarlo? Te agendo de una vez');
                    const f2A = await ap.fotosAuto(r.fyradrive_web_id, 2);
                    return { tipo: 'mesa_correccion_anio', segmentos: segsA, fotos: f2A.length ? f2A : null, fotos_after_index: 1 };
                }
                if (familia.length > 1) {
                    return { tipo: 'mesa_pregunta_cual', segmentos: ['¿Cuál de estos? ' + familia.slice(0, 4).map(x => x.nombre).join(' o ') + ' 🤔'] };
                }
            }
        }
        // red team r2 #4: GEMELOS (dos altas casi idénticas) — jamás elegir en silencio
        if (recienSentado && objetivo) {
            const rowG = autos.find(a => a.id === objetivo);
            const gem = rowG ? ap.gemelosDe(rowG, autos) : [];
            if (gem.length) {
                mesa = mesa.filter(x => x !== objetivo);   // no se sienta hasta aclarar
                await guardarMesa(tel, ej, mesa, mesa.length ? mesa[mesa.length - 1] : null);
                const lista = [rowG].concat(gem);
                return { tipo: 'mesa_gemelos', segmentos: ['Tenemos dos así, nada más cambia el precio:\n' + lista.map((x, i) => `${i + 1}) ${ap.fichaBreve(x)}`).join('\n'), '¿Cuál de los dos te interesa?'] };
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
        // 2.5) SINGULAR con 2+ en mesa ("¿dónde LO tienes?"): habla de UNO — el último
        //      que tocó (el activo), no de todos (caso owner 2026-07-21: pidió info del
        //      Sentra y el "¿dónde lo tienes?" le contestó también el Mazda viejo)
        if (!objetivo && rows.length >= 2 && activo && mesa.includes(activo)
            && /\b(lo|la)\s+(tienes|tienen|puedo ver|quiero ver|veo|manejo)\b|\bel auto\b|\bd[oó]nde est[aá]\b/i.test(t)
            && !/\b(los dos|ambos|cada uno|de todos|se ubican|est[aá]n)\b/i.test(t)) {
            objetivo = activo;
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
                // orden owner 2026-07-21: DESCRIPCIÓN + 2 fotos + punto hablado → A LA CITA
                const segs = [`Sí, claro — el ${r.nombre} está disponible 👍`, await ap.descripcionDe(r)];
                const p = await ap.puntoHablado(r.id);
                if (p) segs.push(`Lo tenemos en ${p}, para que lo veas cuando gustes`);
                segs.push('¿Qué día te queda bien para venir a verlo y manejarlo? Te agendo de una vez');
                const f2 = await ap.fotosAuto(r.fyradrive_web_id, 2);
                return { tipo: 'mesa_entra_auto', segmentos: segs, fotos: f2.length ? f2 : null, fotos_after_index: 1 };
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
                if (/\b(los dos|ambos|de cada uno|de todos)\b/i.test(t)) {
                    // pidió fotos de LOS DOS → 2 por auto, combinadas
                    let fsAll = [];
                    for (const r of rows) fsAll = fsAll.concat(await ap.fotosAuto(r.fyradrive_web_id, 2));
                    if (fsAll.length) {
                        await guardarMesa(tel, ej, mesa, mesa[mesa.length - 1]);
                        return { tipo: 'mesa_fotos_ambos', segmentos: ['Van, ahí te van de los ' + (rows.length === 2 ? 'dos' : rows.length), '¿Cuál te late ir a ver primero? Te agendo de una vez'], fotos: fsAll.slice(0, 6), fotos_after_index: 0 };
                    }
                }
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

        // 5.5) Sentó VARIOS de golpe y nada más los nombró → machote de entrada
        //      múltiple: ficha + portada + punto de cada uno → a la cita
        if (nuevosMulti.length >= 2) {
            await guardarMesa(tel, ej, mesa, mesa[mesa.length - 1]);
            const nuevosRows = nuevosMulti.map(id => autos.find(a => a.id === id)).filter(Boolean);
            const segs = ['¡Van! Te paso la info de los ' + (nuevosRows.length === 2 ? 'dos' : nuevosRows.length) + ':'];
            const fotosM = [];
            for (const r of nuevosRows) {
                const p = await ap.puntoHablado(r.id);
                segs.push(ap.fichaBreve(r) + (p ? '\nLo tenemos en ' + p : ''));
                const pf = await ap.portadaDe(r.fyradrive_web_id); if (pf) fotosM.push(pf);
            }
            segs.push('¿Cuál te late ir a ver primero? Te agendo de una vez');
            return { tipo: 'mesa_entra_multi', segmentos: segs, fotos: fotosM.length ? fotosM : null, fotos_after_index: segs.length - 2 };
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
        // el cierre cuenta las TARJETAS que salieron, no la mesa (red team r2 #6)
        const n = segs.length;
        segs.push(n >= 2 ? `¿Cuál de ${n === 2 ? 'las dos' : 'las ' + n} te late más? Te late venir a verlos?` : '¿Cómo la ves? ¿Te late venir a verlo y manejarlo?');
        return { tipo: 'mesa_cotizaciones', segmentos: segs };
    } catch (e) { return null; }
}

// ══ ENTRADA MÚLTIPLE EN PRIMER CONTACTO (red team #3): abre nombrando 2-3 autos
// con sus letras ("me interesan el tacoma y el audi q3") → todos a la mesa desde
// el saludo, con ficha + portada + punto de cada uno → a la cita.
async function entradaMultiple({ tel, texto, nombre }) {
    try {
        const t = String(texto || '');
        const ap = require('./aparador.js');
        const autos = await ap.inventarioActivo();
        const frasesM = t.split(/\s*(?:,|\by\b|\btambi[eé]n\b)\s*/i).map(s => s.trim()).filter(s => s.length >= 3);
        if (frasesM.length < 2) return null;
        const items = autos.map(a => ({ n: 0, id: a.id, nombre: a.nombre, color: '' }));
        const ids = [];
        for (const f of frasesM) {
            const r = ap.resolverEleccion(f, items);
            if (r && r.auto && !ids.includes(r.auto.id)) ids.push(r.auto.id);
        }
        if (ids.length < 2) return null;
        const mesa = ids.slice(0, 3);
        const cur = await query("SELECT estado_json FROM wa_conversations WHERE telefono=?", [tel]);
        let ej = {}; try { ej = JSON.parse((cur[0] && cur[0].estado_json) || '{}'); } catch (e) { }
        ej.interes = (Array.isArray(ej.interes) ? ej.interes : []).concat(mesa).filter((v, i, a) => a.indexOf(v) === i);
        if (cur.length) await guardarMesa(tel, ej, mesa, mesa[mesa.length - 1]);
        else { ej.mesa = mesa; await run("INSERT INTO wa_conversations (telefono, estado, estado_json, auto_id_activo, updated_at) VALUES (?,?,?,?,?)", [tel, 'mesa', JSON.stringify(ej), mesa[mesa.length - 1], Date.now()]).catch(() => { }); }
        const { nombreReal, saludoHora } = require('./opener.js');
        const nm = nombreReal(nombre);
        const rowsN = mesa.map(id => autos.find(a => a.id === id)).filter(Boolean);
        const segs = [`Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}!`, 'Mucho gusto, mi nombre es Sebastián Romero, para servirte', '¡Van! Te paso la info de los ' + (rowsN.length === 2 ? 'dos' : rowsN.length) + ':'];
        const fotosM = [];
        for (const r of rowsN) {
            const p = await ap.puntoHablado(r.id);
            segs.push(ap.fichaBreve(r) + (p ? '\nLo tenemos en ' + p : ''));
            const pf = await ap.portadaDe(r.fyradrive_web_id); if (pf) fotosM.push(pf);
        }
        segs.push('¿Cuál te late ir a ver primero? Te agendo de una vez');
        return { tipo: 'mesa_entra_multi', segmentos: segs, fotos: fotosM.length ? fotosM : null, fotos_after_index: segs.length - 2 };
    } catch (e) { console.error('[mesa multi opener]', e.message); return null; }
}

// ══ ALINEAR EL AUTO ACTIVO (fix raíz compradores-reales #1-#4): la IA infiere un
// auto en CADA turno (del historial, de la lista mostrada, de la nada) — si esa
// inferencia se vuelve estado, el foco DERIVA y la cita sale del auto equivocado.
// LEY: el estado GUARDADO manda; la inferencia solo manda si el comprador NOMBRÓ
// el auto con sus letras en este mensaje (y no negado).
async function alinearAuto({ tel, texto, clasif }) {
    try {
        const cur = await query("SELECT auto_id_activo FROM wa_conversations WHERE telefono=?", [tel]);
        const stored = cur.length ? (Number(cur[0].auto_id_activo) || null) : null;
        const cl = Number((clasif && clasif.auto_id) || 0) || null;
        if (!cl) return stored;
        const ap = require('./aparador.js');
        const autos = await ap.inventarioActivo();
        const row = autos.find(a => a.id === cl);
        if (row && nombradoEnTexto(String(texto || ''), row.nombre) && !ap.esNegado(String(texto || ''), row.nombre)) return cl;
        return stored || cl;
    } catch (e) { return (clasif && clasif.auto_id) || null; }
}

module.exports = { responderMesa, cargarMesa, entradaMultiple, alinearAuto, nombradoEnTexto };
