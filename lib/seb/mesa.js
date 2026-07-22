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
const RE_DETALLES = /(detalles?|informaci[oó]n|info\b|ficha|caracter[ií]sticas|cu[eé]ntame m[aá]s|m[aá]s datos|todo del|compart[ei]|dame m[aá]s)/i;
const RE_FOTOS = /(fotos?|im[aá]genes|im[aá]gen|videos?|v[ií]deo)/i;
const RE_UBIC_AMPLIA = /(d[oó]nde|ubicaci[oó]n|ubicados|direcci[oó]n|domicilio|mapa|c[oó]mo llego)/i;
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

// ⚠️ LA MESA SE SUMA, NO SE REEMPLAZA (raíz de la corrupción: cada capa —aparador,
// mesa, acción— la escribía a su manera y se pisaban; un auto recién sentado
// desaparecía o entraban autos que nadie nombró). Solo SACAR reemplaza.
async function guardarMesa(tel, ej, mesa, activo, opts) {
    let final = Array.isArray(mesa) ? mesa.slice() : [];
    if (!(opts && opts.reemplazar)) {
        try {
            const prev = await query("SELECT estado_json FROM wa_conversations WHERE telefono=?", [tel]);
            let ejPrev = {}; try { ejPrev = JSON.parse((prev[0] && prev[0].estado_json) || '{}'); } catch (e) { }
            const prevMesa = Array.isArray(ejPrev.mesa) ? ejPrev.mesa.map(Number).filter(Boolean) : [];
            final = prevMesa.concat(final).filter((v, i, a) => a.indexOf(v) === i).slice(-3);
        } catch (e) { }
    }
    ej.mesa = final;
    const mesaAnt = mesa; mesa = final;
    const act = activo || (mesa.length ? mesa[mesa.length - 1] : null);
    // UPSERT: en chats nuevos la fila aún no existe (causa raíz caso Héctor: la mesa
    // se apagaba por completo en primer contacto y el auto nombrado se perdía)
    await run("UPDATE wa_conversations SET estado_json=?, auto_id_activo=?, updated_at=? WHERE telefono=?",
        [JSON.stringify(ej), act, Date.now(), tel]).catch(() => { });
    await run("INSERT INTO wa_conversations (telefono, estado, estado_json, auto_id_activo, updated_at) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM wa_conversations WHERE telefono=?)",
        [tel, 'mesa', JSON.stringify(ej), act, Date.now(), tel]).catch(() => { });
}

// ══ EL PAQUETE DEL AUTO — FUENTE ÚNICA de "abrir un auto" (owner 2026-07-21):
// disponible + FICHA REAL + TODAS sus fotos + dónde lo tenemos + gancho a la cita.
// Todo machote que abra un auto pasa por aquí (opener, mesa, elección, corrección).
async function paqueteAuto(row, { saludo, confirma, gancho } = {}) {
    const ap = require('./aparador.js');
    const segs = [];
    if (saludo) segs.push(saludo);
    segs.push(confirma || `Sí, claro — el ${row.nombre} está disponible 👍`);
    segs.push(await ap.descripcionDe(row));
    const fotosIdx = segs.length - 1;
    const p = await ap.puntoHablado(row.id);
    if (p) segs.push(`Lo tenemos en ${p}, para que lo veas cuando gustes`);
    segs.push(gancho || '¿Qué día te queda bien para venir a verlo y manejarlo? Te agendo de una vez');
    const fotos = await ap.fotosAuto(row.fyradrive_web_id, 12);   // TODAS, de jalón
    return { segmentos: segs, fotos: fotos.length ? fotos : null, fotos_after_index: fotosIdx };
}

// ══ DUDAS GENERALES (orden owner 2026-07-21): hay preguntas que NO son de un auto
// — "¿manejan crédito?", "¿qué tasa?", "¿qué requisitos piden?" — y tienen su propio
// carril (el machote del banco). La mesa jamás las secuestra ni las manda a escalar.
const RE_FORANEO_MSG = /(soy de|vengo de|estoy en|vivo en|radico en|me encuentro en|otra ciudad|otro estado|for[aá]neo|de fuera|fuera de (monterrey|mty))/i;
const RE_CREDITO_GENERAL = /((manejan|manejas|dan|tienen|trabajan con|aceptan|ofrecen|hay|hacen)[^?]{0,25}(cr[eé]dito|financ|meses|mensualidad))|((cr[eé]dito|financiamiento)[^?]{0,25}(manejan|tienen|hay|ofrecen|dan))|c[oó]mo (funciona|es|va) (el|lo del|lo de)? ?(cr[eé]dito|financ)|qu[eé] (banco|financiera)|(qu[eé]|cu[aá]l) (tasa|inter[eé]s)|(tasa|inter[eé]s)(es)? (manejan|tienen|es|son|cobran)|a cu[aá]ntos meses|plazos? (manejan|tienen|hay)/i;
async function dudaGeneral({ texto, nombre, clasif, convId, tel }) {
    try {
        const t = String(texto || '');
        if (!RE_CREDITO_GENERAL.test(t) && !RE_REQUISITOS.test(t)) return null;
        if (engancheDeTexto(t)) return null;                 // trae cifra → es cotización
        let autoCtx = null;
        if (tel) { try { const st = await cargarMesa(tel); autoCtx = st.activo || (st.mesa.length ? st.mesa[st.mesa.length - 1] : null); } catch (e) { } }
        const { responderCont } = require('./continuacion.js');
        const r = await responderCont({ texto: t, nombre, auto_id: autoCtx, intencion: 'cotizar_credito', conv_id: convId, clasif: clasif || null });
        if (r && Array.isArray(r.segmentos) && r.segmentos.length && !r.escalar && !r.silencio) {
            return { tipo: 'duda_general_credito', segmentos: r.segmentos, universo: r.universo || 'cotizacion' };
        }
        // respaldo determinista: los REQUISITOS son un machote del manual — jamás
        // deben terminar en escala por una falla de la capa de arriba
        if (/(requisit|papeler[ií]a|qu[eé] (documentos|papeles|necesito|necesitas|piden|ocupan))/i.test(t)) {
            const { REQUISITOS } = require('./continuacion.js');
            if (REQUISITOS) return { tipo: 'duda_general_credito', segmentos: [String(REQUISITOS).trim(), '¿Te los mando por aquí y arrancamos?'], universo: 'cotizacion' };
        }
        return null;
    } catch (e) { return null; }
}

const RE_AFIRMA = /^(s[ií]|sip|simon|claro|va+|dale|[oó]rale|por ?favor|porfa|porfis|sale|de una|obvio|ok|okay|oki|correcto|as[ií] es|adelante|si de favor|s[ií] de favor|s[ií] porfa|s[ií] por favor|me interesa)[\s.!👍🙏]*$/i;
function ofertaDeSegmentos(segs) {
    const t = String((segs || []).join(' ')).toLowerCase();
    if (/te mando (las )?fotos|mando fotos|fotos y la ficha/.test(t)) return 'fotos';
    if (/cotice|cotizo|ejercicio|c[oó]mo quedar[ií]a|corrida|n[uú]meros/.test(t)) return 'cotizar';
    if (/ficha completa|toda la info|m[aá]s informaci[oó]n/.test(t)) return 'detalles';
    return null;
}

// ══ LA ACCIÓN MANDA (orden owner 2026-07-21): si el mensaje que mete un auto trae
// una PETICIÓN concreta ("¿dónde tienes el audi?", "cotízame el mazda y el yaris",
// "fotos del honda"), se ejecuta ESA acción sobre ese auto — nada de abrir con la
// presentación completa y dejar la pregunta sin contestar.
// ⚠️ TODO con límites de palabra: "Cavalier" contiene "aval" y tumbaba la cotización
const RE_REQUISITOS = /(requisit|papeler[ií]a|\bdocumentos?\b|qu[eé] (necesito|necesitas|piden|papeles)|c[oó]mo (funciona|es el proceso|le hago)|\bproceso\b|\btr[aá]mites?\b|\bbur[oó]\b|\bcomprobantes?\b|\bingresos\b|\baval\b|enganche m[ií]nimo)/i;
// el ENGANCHE se lee del texto con CÓDIGO (no se depende de que la IA lo extraiga:
// "100,000 pesos" / "100 mil" / "90mil" / "100k" quedaban sin cotizar y escalaban)
function engancheDeTexto(t) {
    const s = String(t || '').toLowerCase().replace(/\$/g, ' ');
    let m = s.match(/(\d[\d.,]*)\s*(mil|k\b)/);
    if (m) { const v = Number(m[1].replace(/[.,]/g, '')) * (Number(m[1].replace(/[.,]/g, '')) < 1000 ? 1000 : 1); return v >= 5000 && v <= 2000000 ? v : null; }
    m = s.match(/(\d{2,3}[.,]\d{3})(?!\d)/);
    if (m) { const v = Number(m[1].replace(/[.,]/g, '')); return v >= 5000 && v <= 2000000 ? v : null; }
    m = s.match(/\b(\d{5,7})\b/);
    if (m) { const v = Number(m[1]); return v >= 5000 && v <= 2000000 ? v : null; }
    return null;
}

// "Ok, gracias" + petición real en la misma ráfaga: la cortesía se descarta para
// que la PETICIÓN mande (orden owner 2026-07-21, caso Miguel)
const RE_CORTESIA = /^\s*(ok(ay)?|va+|sale|perfecto|listo|excelente|de acuerdo|entiendo|muchas gracias|mil gracias|gracias|graciass?|thank you|👍|🙏|😊)[\s,.!👍🙏]*/i;
function sinCortesia(t) {
    let x = String(t || '');
    for (let i = 0; i < 3; i++) { const y = x.replace(RE_CORTESIA, ''); if (y === x) break; x = y; }
    return x.trim().length >= 3 ? x.trim() : String(t || '');
}
function detectarAccion(t0, clasif) {
    const t = sinCortesia(t0);
    const int = (clasif && clasif.intencion_principal) || '';
    // REQUISITOS / PAPELERÍA / PROCESO del crédito → NO es cotizar: lo contesta su
    // machote del banco (raíz del bug: la palabra "crédito" disparaba la cotización)
    if (RE_REQUISITOS.test(t)) return null;
    if (RE_FOTOS.test(t) || int === 'fotos_videos') return 'fotos';
    if (RE_UBIC_AMPLIA.test(t) || int === 'cita_ubicacion') return 'ubicacion';
    // cotizar = pide NÚMEROS de verdad (no "¿manejan crédito?" ni "¿qué requisitos?")
    if (/cot[ií]za|cotizar|cu[aá]nto (quedar[ií]a|sale|ser[ií]a|pagar[ií]a)|mensualidad|a \d{2} meses|de enganche|con \$?\d/i.test(t)) return 'cotizar';
    if (RE_PRECIO_FICHA.test(t) && !RE_NEGOCIA.test(t)) return 'precio';
    if (int === 'disponibilidad' || /sigue disponible|a[uú]n (lo|la) tienes|ya se vendi/i.test(t)) return 'disponibilidad';
    if (RE_DETALLES.test(t)) return 'detalles';
    return null;
}

function preguntaFamilia(cands, accion) {
    const lista = cands.map(x => x.nombre).join(' o ');
    if (accion === 'cotizar') return `¿De cuál te cotizo, ${lista}?`;
    if (accion === 'ubicacion') return `¿De cuál te paso la ubicación, ${lista}?`;
    if (accion === 'fotos') return `¿De cuál te mando fotos, ${lista}?`;
    if (accion === 'precio') return `¿De cuál te paso el precio, ${lista}?`;
    return `¿Cuál de estos? ${lista} 🤔`;
}

async function ejecutarAccionMesa({ rows, accion, clasif, texto, tel, ej, mesa }) {
    const ap = require('./aparador.js');
    if (!rows || !rows.length || !accion) return null;
    // los autos sobre los que se actúa quedan SIEMPRE en la mesa
    mesa = (Array.isArray(mesa) ? mesa : []).concat(rows.map(r => r.id)).filter((v, i, a) => a.indexOf(v) === i).slice(-3);
    const uno = rows.length === 1;
    if (accion === 'fotos') {
        let fs = [];
        for (const r of rows) fs = fs.concat(await ap.fotosAuto(r.fyradrive_web_id, uno ? 12 : 3));
        if (!fs.length) return null;
        return { tipo: 'mesa_accion_fotos', segmentos: [uno ? 'Van, ahí te las mando' : 'Van, ahí te van de los ' + (rows.length === 2 ? 'dos' : rows.length), '¿Te late venir a verlo y manejarlo? Te agendo de una vez'], fotos: fs.slice(0, 12), fotos_after_index: 0 };
    }
    if (accion === 'ubicacion') {
        const ubi = await ap.redactarUbicaciones(rows);
        const segs = ubi.segmentos.concat([ubi.mismo || uno ? '¿Qué día te queda bien para venir a verlo? Te agendo de una vez' : ubi.gancho]);
        const out = { tipo: 'mesa_accion_ubicacion', segmentos: segs };
        if (uno) { out.ubicacion_auto_id = rows[0].id; out.pin_after_index = 0; }   // + PIN
        return out;
    }
    if (accion === 'cotizar') {
        const eng = ((clasif && clasif.datos && clasif.datos.enganche) || engancheDeTexto(texto)) || null;
        if (!eng) {
            ej.mesa_pregunta = 'cotizar';
            ej.mesa_pregunta_autos = rows.map(r => r.id);
            await guardarMesa(tel, ej, mesa, rows[rows.length - 1].id);
            return { tipo: 'mesa_cotizar_pregunta', segmentos: [uno ? `Va, te corro los números del ${rows[0].nombre} — ¿con cuánto de enganche le hacemos?` : `Va, te corro los números de los ${rows.length === 2 ? 'dos' : rows.length} — ¿con cuánto de enganche le hacemos?`] };
        }
        return await cotizarMesa(rows, eng, (clasif && clasif.datos && clasif.datos.plazo_meses) || null);
    }
    if (accion === 'precio') {
        const segs = [];
        for (const r of rows) segs.push(ap.fichaBreve(r));
        segs.push(uno ? '¿Te late venir a verlo y manejarlo?' : '¿Cuál te late más?');
        return { tipo: 'mesa_accion_precio', segmentos: segs };
    }
    if (accion === 'disponibilidad') {
        // "¿el yaris 2022 lo tienes aún?" = pide el auto → confirma Y manda TODO
        if (uno) {
            const pkD = await paqueteAuto(rows[0], { confirma: 'Sí, sigue disponible 👍' });
            return { tipo: 'mesa_accion_disponibilidad', ...pkD };
        }
        return { tipo: 'mesa_accion_disponibilidad', segmentos: [`Sí, los ${rows.length === 2 ? 'dos' : rows.length} siguen disponibles 👍`, '¿Cuál te late ir a ver primero? Te agendo de una vez'] };
    }
    if (accion === 'detalles' && uno) {
        return { tipo: 'mesa_detalles', ...(await paqueteAuto(rows[0], { confirma: `Claro, te paso todo del ${rows[0].nombre}:` })) };
    }
    return null;
}

// ══ EL TURNO DE LA MESA — se llama DESPUÉS de entender() y ANTES del flujo
// normal (continuación/etapa3), en panel Y sandbox (fuente única).
// Regresa: {segmentos,...} = respuesta lista · {auto_id} = "corre el flujo normal
// en ESTE auto" · null = la mesa no aplica, flujo normal.
async function responderMesa({ tel, texto, clasif, convId }) {
    try {
        const t = sinCortesia(String(texto || ''));
        const { ej, mesa: mesa0, mesaExplicita, activo } = await cargarMesa(tel);
        let mesa = mesa0.slice();   // sin fila la mesa igual trabaja (guardarMesa hace upsert)
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
                    await guardarMesa(tel, ej, mesa, mesa.length ? mesa[mesa.length - 1] : null, { reemplazar: true });
                    const resto = mesa.map(id => autos.find(a => a.id === id)).filter(Boolean);
                    const segs = [`Va, descartamos el ${fuera.nombre} 👍`];
                    if (resto.length) segs.push(`Seguimos con ${resto.map(r => 'el ' + r.nombre).join(' y ')} — ¿te late venir a verlo${resto.length > 1 ? 's' : ''}?`);
                    else segs.push('¿Te muestro otras opciones que te acomoden?');
                    return { tipo: 'mesa_sacar', segmentos: segs };
                }
                await guardarMesa(tel, ej, mesa, mesa.length ? mesa[mesa.length - 1] : null, { reemplazar: true });
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
        // 0.4) EL "SÍ" A LO QUE SEB OFRECIÓ → se ejecuta esa acción
        if (RE_AFIRMA.test(t.trim()) && ej.oferta && mesa.length) {
            const accO = ej.oferta; delete ej.oferta;
            const rowsO = mesa.map(id => autos.find(a => a.id === id)).filter(Boolean);
            const objO = (activo && mesa.includes(activo)) ? rowsO.filter(r => r.id === activo) : rowsO;
            await guardarMesa(tel, ej, mesa, activo);
            const outO = await ejecutarAccionMesa({ rows: objO.length ? objO : rowsO, accion: accO, clasif, texto: t, tel, ej, mesa });
            if (outO) return outO;
        }

        // 0.5) PREGUNTA DE FAMILIA VIVA ("¿cuál Mazda?"): su respuesta se resuelve
        //      PRIMERO contra ESOS candidatos — "el mazda 3" ahí es único
        if (Array.isArray(ej.mesa_familia) && ej.mesa_familia.length) {
            const famItems = ej.mesa_familia.map((id, i) => { const a = autos.find(x => x.id === id); return a ? { n: i + 1, id: a.id, nombre: a.nombre, color: normz(a.color || '') } : null; }).filter(Boolean);
            const rFam = ap.resolverEleccion(t, famItems);
            if (rFam && rFam.auto) {
                const accPend = ej.mesa_familia_accion || null;
                const yaRes = Array.isArray(ej.mesa_familia_ya) ? ej.mesa_familia_ya : [];
                delete ej.mesa_familia; delete ej.mesa_familia_accion; delete ej.mesa_familia_ya;
                for (const id of yaRes.concat([rFam.auto.id])) if (!mesa.includes(id)) mesa.push(id);
                while (mesa.length > 3) mesa.shift();
                const rowF = autos.find(a => a.id === rFam.auto.id);
                await guardarMesa(tel, ej, mesa, rFam.auto.id);
                if (accPend) {
                    const rowsAcc = yaRes.concat([rFam.auto.id]).map(id => autos.find(a => a.id === id)).filter(Boolean);
                    const outAcc = await ejecutarAccionMesa({ rows: rowsAcc, accion: accPend, clasif, texto: t, tel, ej, mesa });
                    if (outAcc) return outAcc;
                }
                const pkF = await paqueteAuto(rowF, { confirma: `Sí, claro — el ${rowF.nombre} 👍` });
                return { tipo: 'mesa_entra_auto', ...pkF };
            }
        }

        // 1) RESOLUCIÓN PROPIA de nombre (hechos duros contra TODO el inventario —
        //    jamás depender del clasificador): único → se sienta y manda; FAMILIA
        //    ambigua ("mazda 2021" y hay dos) → primero contra la mesa, y si tampoco
        //    → SE PREGUNTA, jamás adivinar (caso owner: eligió la CX-5 en silencio).
        const itemsInv = autos.map(a => ({ n: 0, id: a.id, nombre: a.nombre, color: '' }));
        const rInv = ap.resolverEleccion(t, itemsInv);
        let familiaAmb = null;
        const clarosInv = (rInv && Array.isArray(rInv.claros)) ? rInv.claros.map(x => x.id) : [];
        if (rInv && rInv.auto && rInv.via === 'nombre' && !ap.esNegado(t, rInv.auto.nombre)) {
            if (!mesa.includes(rInv.auto.id)) { mesa.push(rInv.auto.id); while (mesa.length > 3) mesa.shift(); }
            recienSentado = !mesaExplicita.includes(rInv.auto.id);
            objetivo = rInv.auto.id;
        } else if (rInv && rInv.pregunta && rInv.via === 'nombre_ambiguo') {
            familiaAmb = rInv.pregunta;
            // ¿la mesa lo desempata? ("el mazda" con UN mazda en la mesa)
            const enMesa = familiaAmb.filter(x => mesa.includes(x.id));
            if (enMesa.length === 1) objetivo = enMesa[0].id;
        }
        // 1.1) la inferencia del clasificador solo vale si el texto la NOMBRA y no hay
        //      familia ambigua abierta (jamás dejar que la IA desempate una familia)
        const cl = Number((clasif && clasif.auto_id) || 0) || null;
        if (!objetivo && !familiaAmb && cl && autos.some(a => a.id === cl)) {
            const rowCl = autos.find(a => a.id === cl);
            if (nombradoEnTexto(t, rowCl.nombre) && !ap.esNegado(t, rowCl.nombre)) {
                if (!mesa.includes(cl)) { mesa.push(cl); while (mesa.length > 3) mesa.shift(); }
                recienSentado = !mesaExplicita.includes(cl);
                objetivo = cl;
            }
        }
        // 1.15) familia ambigua sin desempate → pregunta (y SE RECUERDA para que la
        //       respuesta resuelva contra estos candidatos), jamás adivinar
        if (!objetivo && familiaAmb) {
            ej.mesa_familia = familiaAmb.map(x => x.id);
            const accAmb = detectarAccion(t, clasif);
            if (accAmb) ej.mesa_familia_accion = accAmb;
            if (clarosInv.length) { ej.mesa_familia_ya = clarosInv; for (const id of clarosInv) if (!mesa.includes(id)) mesa.push(id); }
            await guardarMesa(tel, ej, mesa, activo);
            return { tipo: 'mesa_pregunta_cual', segmentos: [preguntaFamilia(familiaAmb, accAmb)] };
        }
        if (objetivo && ej.mesa_familia) delete ej.mesa_familia;
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
                    if (r && r.auto && ['nombre', 'anio', 'numero', 'color'].includes(r.via) && !nuevosMulti.includes(r.auto.id) && !ap.esNegado(f, r.auto.nombre)) nuevosMulti.push(r.auto.id);
                    else if (r && r.pregunta && r.via === 'nombre_ambiguo' && !preguntaAmb) preguntaAmb = r.pregunta;
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
                const accM = detectarAccion(t, clasif);
                if (accM) {
                    // pidió una ACCIÓN sobre varios y uno quedó ambiguo → se pregunta por el
                    // ambiguo recordando la acción y el ya resuelto; al contestar se ejecuta en AMBOS
                    ej.mesa_familia = preguntaAmb.map(x => x.id);
                    ej.mesa_familia_accion = accM;
                    ej.mesa_familia_ya = nuevosMulti.slice();
                    await guardarMesa(tel, ej, mesa, nuevosMulti[nuevosMulti.length - 1]);
                    return { tipo: 'mesa_pregunta_cual', segmentos: [preguntaFamilia(preguntaAmb, accM)] };
                }
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
                    const pkA = await paqueteAuto(r, { confirma: `Ah, va — el ${r.nombre} 👍` });
                    return { tipo: 'mesa_correccion_anio', ...pkA };
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
        if (!mesa.length) {
            // UBICACIÓN SIN AUTO EN JUEGO (caso Héctor): jamás contestar un punto
            // cualquiera — se pregunta de cuál auto (el punto es POR AUTO)
            if (RE_UBICACION.test(t) && !RE_FORANEO_MSG.test(t))
                return { tipo: 'mesa_ubicacion_sin_auto', segmentos: ['Claro — ¿de cuál auto te paso la ubicación? Cada uno está en su punto'] };
            return null;
        }
        const rows = mesa.map(id => autos.find(a => a.id === id)).filter(Boolean);
        if (!rows.length) return null;

        // 2) ¿a cuál se refiere? — hecho duro (nombre/año/color) contra LOS DE LA MESA
        if (!objetivo && rows.length >= 2) {
            const items = rows.map((r, i) => ({ n: i + 1, id: r.id, nombre: r.nombre, color: normz(r.color || '') }));
            const r = ap.resolverEleccion(t, items);
            if (r && r.auto) objetivo = r.auto.id;
        }
        // (regla del "singular" retirada por orden del owner 2026-07-21: si el
        //  trigger es GENERAL se ejecuta en TODOS los autos en foco; solo cuando
        //  señala uno —nombre, abreviación o año— se ejecuta en ese)
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
        if (pend === 'cotizar' && rows.length >= 1) {
            const eng = ((clasif && clasif.datos && clasif.datos.enganche) || engancheDeTexto(t)) || null;
            // sin cifra en la respuesta → se RE-PREGUNTA una vez nombrando el auto
            // (antes el turno se iba al flujo normal y contestaba cualquier otra cosa)
            if (!eng && !RE_REQUISITOS.test(t) && !RE_FOTOS.test(t) && !RE_UBIC_AMPLIA.test(t)) {
                const nReint = Number(ej.mesa_pregunta_reint || 0);
                if (nReint < 2) {
                    ej.mesa_pregunta_reint = nReint + 1;
                    const idsQ = Array.isArray(ej.mesa_pregunta_autos) ? ej.mesa_pregunta_autos : [];
                    const rowsQ = (idsQ.length ? idsQ.map(id => autos.find(a => a.id === id)).filter(Boolean) : rows);
                    await guardarMesa(tel, ej, mesa, rowsQ.length ? rowsQ[rowsQ.length - 1].id : mesa[mesa.length - 1]);
                    return { tipo: 'mesa_cotizar_pregunta', segmentos: [rowsQ.length === 1 ? `Va, del ${rowsQ[0].nombre} — ¿con cuánto de enganche le hacemos?` : `Va, de los ${rowsQ.length === 2 ? 'dos' : rowsQ.length} — ¿con cuánto de enganche le hacemos?`] };
                }
                delete ej.mesa_pregunta; delete ej.mesa_pregunta_autos; delete ej.mesa_pregunta_reint;
                await guardarMesa(tel, ej, mesa, mesa[mesa.length - 1]);
            }
            if (eng && !RE_REQUISITOS.test(t)) {
                // la pregunta era de UN auto en concreto → se cotiza ESE (todos solo si
                // la pregunta era general o él lo pide)
                const listaPrev = Array.isArray(ej.mesa_pregunta_autos) ? ej.mesa_pregunta_autos : null;
                const targetId = objetivo || Number(ej.mesa_pregunta_auto || 0) || null;
                let objsCot = listaPrev ? listaPrev.map(id => autos.find(a => a.id === id)).filter(Boolean) : (targetId ? rows.filter(r => r.id === targetId) : rows);
                delete ej.mesa_pregunta; delete ej.mesa_pregunta_auto; delete ej.mesa_pregunta_autos; delete ej.mesa_pregunta_reint;
                await guardarMesa(tel, ej, mesa, targetId || mesa[mesa.length - 1]);
                return await cotizarMesa(objsCot.length ? objsCot : rows, eng, (clasif && clasif.datos && clasif.datos.plazo_meses) || null);
            }
        }

        // 3.4) "MÁNDAME DETALLES / INFORMACIÓN" con auto en juego → PAQUETE COMPLETO
        //      (caso Héctor: contestaba un párrafo genérico de calidad, sin ficha ni fotos)
        if (RE_DETALLES.test(t) && (objetivo || rows.length === 1)) {
            const rD = rows.find(x => x.id === (objetivo || rows[0].id)) || rows[0];
            await guardarMesa(tel, ej, mesa, rD.id);
            const pkD = await paqueteAuto(rD, { confirma: `Claro, te paso todo del ${rD.nombre}:` });
            return { tipo: 'mesa_detalles', ...pkD };
        }

        // 3.5) NOMBRÓ UN AUTO NUEVO con sus letras (caso David/Dodge): ese auto ENTRA
        //      AL JUEGO ya — su universo se abre con el machote de foco (disponible +
        //      ficha + dónde lo tenemos + invitación). Si su mensaje trae además una
        //      herramienta (cotizar/fotos/ubicación), mejor se deja pasar al flujo
        //      normal para que la ejecute en ESTE auto.
        // ACCIÓN CONCRETA sobre el auto que acaba de entrar → se ejecuta ESA acción
        if (objetivo) {
            const accObj = detectarAccion(t, clasif);
            if (accObj && accObj !== 'detalles') {
                // TODOS los autos que nombró en ESTE mensaje ("cotízame el mazda y el yaris").
                // El escaneo por FRASES manda: un año dicho para UN auto ("el sentra 2023")
                // no debe tumbar al otro que también nombró ("el cavalier").
                const base = (nuevosMulti.length >= 2) ? nuevosMulti : clarosInv.concat([objetivo]);
                const idsAcc = base.filter((v, i, a) => a.indexOf(v) === i).slice(-3);
                for (const id of idsAcc) if (!mesa.includes(id)) mesa.push(id);
                while (mesa.length > 3) mesa.shift();
                const rowsAcc = idsAcc.map(id => autos.find(a => a.id === id)).filter(Boolean);
                if (rowsAcc.length) {
                    await guardarMesa(tel, ej, mesa, objetivo);
                    const outAcc = await ejecutarAccionMesa({ rows: rowsAcc, accion: accObj, clasif, texto: t, tel, ej, mesa });
                    if (outAcc) return outAcc;
                }
            }
        }
        if (recienSentado) {
            const r = rows.find(x => x.id === objetivo);
            if (r) {
                await guardarMesa(tel, ej, mesa, objetivo);
                // orden owner 2026-07-21: DESCRIPCIÓN + 2 fotos + punto hablado → A LA CITA
                const pkE = await paqueteAuto(r);
                return { tipo: 'mesa_entra_auto', ...pkE };
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
            if ((int === 'cita_ubicacion' || RE_UBICACION.test(t)) && !RE_FORANEO_MSG.test(t)) {
                // mismo punto → se redacta como UNO y la agenda va directa (orden owner)
                const ubi = await ap.redactarUbicaciones(rows);
                const segs = ubi.segmentos.concat([ubi.gancho]);
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
            if ((int === 'cotizar_credito' || engancheDeTexto(t)) && detectarAccion(t, clasif) === 'cotizar') {
                // con 3 en la mesa y sin decir cuál, se pregunta (jamás cotizar todo)
                if (rows.length >= 3) {
                    ej.mesa_familia = rows.map(r => r.id); ej.mesa_familia_accion = 'cotizar';
                    await guardarMesa(tel, ej, mesa, mesa[mesa.length - 1]);
                    return { tipo: 'mesa_pregunta_cual', segmentos: [preguntaFamilia(rows, 'cotizar')] };
                }
                const eng = (clasif && clasif.datos && clasif.datos.enganche) || null;
                if (!eng) {
                    ej.mesa_pregunta = 'cotizar';
                    ej.mesa_pregunta_autos = rows.map(r => r.id);
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
            const accMulti = detectarAccion(t, clasif);
            if (accMulti) {
                const outM = await ejecutarAccionMesa({ rows: nuevosRows, accion: accMulti, clasif, texto: t, tel, ej, mesa });
                if (outM) return outM;
            }
            const segs = ['¡Van! Te paso la info de los ' + (nuevosRows.length === 2 ? 'dos' : nuevosRows.length) + ':'];
            const fotosM = [];
            for (const r of nuevosRows) {
                segs.push(await ap.fichaExtensa(r));
                const pf = await ap.portadaDe(r.fyradrive_web_id); if (pf) fotosM.push(pf);
            }
            const fotosIdx = segs.length - 1;
            const ubi = await ap.redactarUbicaciones(nuevosRows);
            for (const su of ubi.segmentos) segs.push(su);
            segs.push(ubi.mismo ? ubi.gancho : '¿Cuál te late ir a ver primero? Te agendo de una vez');
            return { tipo: 'mesa_entra_multi', segmentos: segs, fotos: fotosM.length ? fotosM : null, fotos_after_index: fotosIdx };
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
        const items = autos.map(a => ({ n: 0, id: a.id, nombre: a.nombre, color: '' }));
        const ids = [];
        for (const f of frasesM) {
            const r = ap.resolverEleccion(f, items);
            if (r && r.auto && ['nombre', 'anio', 'numero', 'color'].includes(r.via) && !ids.includes(r.auto.id)) ids.push(r.auto.id);
        }
        // UN SOLO auto nombrado → paquete completo con saludo (causa raíz caso Héctor:
        // "Precio del Yaris 2022??" contestaba "¿de qué auto buscas información?")
        if (ids.length < 2) {
            const rSolo = ap.resolverEleccion(t, items);
            const { nombreReal: nrS, saludoHora: shS } = require('./opener.js');
            const nmS = nrS(nombre);
            const saludos = [`Qué tal${nmS ? ' ' + nmS : ''} ${shS()}!`, 'Mucho gusto, mi nombre es Sebastián Romero, para servirte'];
            if (rSolo && rSolo.auto && rSolo.via === 'nombre' && !ap.esNegado(t, rSolo.auto.nombre)) {
                const rowS = autos.find(a => a.id === rSolo.auto.id);
                const curS = await query("SELECT estado_json FROM wa_conversations WHERE telefono=?", [tel]);
                let ejS = {}; try { ejS = JSON.parse((curS[0] && curS[0].estado_json) || '{}'); } catch (e) { }
                ejS.interes = (Array.isArray(ejS.interes) ? ejS.interes : []).concat([rowS.id]).filter((v, i, a) => a.indexOf(v) === i);
                await guardarMesa(tel, ejS, [rowS.id], rowS.id);
                const pkS = await paqueteAuto(rowS, { confirma: `Claro que sí, te paso todo del ${rowS.nombre}:` });
                return { tipo: 'mesa_entra_auto', segmentos: saludos.concat(pkS.segmentos), fotos: pkS.fotos, fotos_after_index: (pkS.fotos_after_index != null ? pkS.fotos_after_index : 0) + saludos.length };
            }
            if (rSolo && rSolo.pregunta && rSolo.via === 'nombre_ambiguo') {
                const curA = await query("SELECT estado_json FROM wa_conversations WHERE telefono=?", [tel]);
                let ejA = {}; try { ejA = JSON.parse((curA[0] && curA[0].estado_json) || '{}'); } catch (e) { }
                ejA.mesa_familia = rSolo.pregunta.map(x => x.id);
                await guardarMesa(tel, ejA, [], null);
                return { tipo: 'mesa_pregunta_cual', segmentos: saludos.concat(['De esos tenemos estos — ¿cuál te interesa?\n' + rSolo.pregunta.map((x, i) => `${i + 1}) ${x.nombre}`).join('\n')]) };
            }
            return null;
        }
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
            segs.push(await ap.fichaExtensa(r));
            const pf = await ap.portadaDe(r.fyradrive_web_id); if (pf) fotosM.push(pf);
        }
        const fotosIdx = segs.length - 1;
        const ubi = await ap.redactarUbicaciones(rowsN);
        for (const su of ubi.segmentos) segs.push(su);
        segs.push(ubi.mismo ? ubi.gancho : '¿Cuál te late ir a ver primero? Te agendo de una vez');
        return { tipo: 'mesa_entra_multi', segmentos: segs, fotos: fotosM.length ? fotosM : null, fotos_after_index: fotosIdx };
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

// ══ INFO EN POSESIÓN (orden owner 2026-07-21): con el owner al volante, "mándame
// la información del X" ES herramienta (leer ficha) — se entrega con "Claro, te la
// comparto:" + descripción + 2 fotos, SIN un solo gancho (el cierre es del owner).
// Si nombra OTRO auto, ese se abre (entra a la mesa) — así de simple.
async function infoEnPosesion({ tel, texto }) {
    try {
        const t = String(texto || '');
        if (!/(informaci[oó]n|info\b|ficha|detalles|caracter[ií]sticas)/i.test(t)) return null;
        const ap = require('./aparador.js');
        const autos = await ap.inventarioActivo();
        let row = null;
        const items = autos.map(a => ({ n: 0, id: a.id, nombre: a.nombre, color: '' }));
        const r = ap.resolverEleccion(t, items);
        if (r && r.auto && r.via === 'nombre' && !ap.esNegado(t, r.auto.nombre)) row = autos.find(a => a.id === r.auto.id);
        // familia ambigua ("info del mazda 2021" y hay dos) → se pregunta, sin gancho
        // (y se RECUERDA para que "el mazda 3" de respuesta resuelva ahí)
        if (!row && r && r.pregunta && r.via === 'nombre_ambiguo') {
            try {
                const { ej, mesa } = await cargarMesa(tel);
                ej.mesa_familia = r.pregunta.map(x => x.id);
                await guardarMesa(tel, ej, mesa, null);
            } catch (e) { }
            return { tipo: 'posesion_info_pregunta', segmentos: ['¿Cuál de estos? ' + r.pregunta.map(x => x.nombre).join(' o ') + ' 🤔'], universo: 'info_auto' };
        }
        if (!row) {
            const cur = await query("SELECT auto_id_activo FROM wa_conversations WHERE telefono=?", [tel]);
            const act = cur.length ? (Number(cur[0].auto_id_activo) || null) : null;
            if (act) row = autos.find(a => a.id === act);
        }
        if (!row) return null;
        // el auto nombrado entra a la mesa (para que lo que siga hable de él)
        try {
            const { ej, mesa } = await cargarMesa(tel);
            const m2 = mesa.slice();
            if (!m2.includes(row.id)) { m2.push(row.id); while (m2.length > 3) m2.shift(); }
            await guardarMesa(tel, ej, m2, row.id);
        } catch (e) { }
        const segs = ['Claro, te la comparto:', await ap.descripcionDe(row)];
        const f2 = await ap.fotosAuto(row.fyradrive_web_id, 12);
        return { tipo: 'posesion_info', segmentos: segs, fotos: f2.length ? f2 : null, fotos_after_index: 1, universo: 'info_auto' };
    } catch (e) { return null; }
}

// ══ HERRAMIENTAS EN POSESIÓN (owner 2026-07-21): aunque el chat sea suyo, FOTOS,
// UBICACIÓN y FICHA deben salir siempre — son herramientas, no conversación.
async function herramientaEnPosesion({ tel, texto }) {
    try {
        const t = String(texto || '');
        const ap = require('./aparador.js');
        const pideFotos = RE_FOTOS.test(t);
        const pideUbic = RE_UBIC_AMPLIA.test(t);
        const pideInfo = RE_DETALLES.test(t);
        if (!pideFotos && !pideUbic && !pideInfo) return null;
        if (pideInfo && !pideFotos && !pideUbic) return await infoEnPosesion({ tel, texto });
        const autos = await ap.inventarioActivo();
        let row = null;
        const items = autos.map(a => ({ n: 0, id: a.id, nombre: a.nombre, color: '' }));
        const r = ap.resolverEleccion(t, items);
        if (r && r.auto && r.via === 'nombre') row = autos.find(a => a.id === r.auto.id);
        if (!row) {
            const cur = await query("SELECT auto_id_activo FROM wa_conversations WHERE telefono=?", [tel]);
            const act = cur.length ? (Number(cur[0].auto_id_activo) || null) : null;
            if (act) row = autos.find(a => a.id === act);
        }
        if (!row) return null;
        if (pideFotos) {
            const fs = await ap.fotosAuto(row.fyradrive_web_id, 12);
            if (!fs.length) return null;
            return { tipo: 'posesion_fotos', segmentos: ['Claro, te las comparto:'], fotos: fs, fotos_after_index: 0, universo: 'fotos' };
        }
        const p = await ap.puntoHablado(row.id);
        if (!p) return null;
        return { tipo: 'posesion_ubicacion', segmentos: [`Claro, estamos en ${p}`], ubicacion_auto_id: row.id, pin_after_index: 0, universo: 'ubicacion' };
    } catch (e) { return null; }
}

module.exports = { responderMesa, cargarMesa, guardarMesa, engancheDeTexto, dudaGeneral, ofertaDeSegmentos, sinCortesia, entradaMultiple, alinearAuto, nombradoEnTexto, infoEnPosesion, herramientaEnPosesion, paqueteAuto, detectarAccion, ejecutarAccionMesa, preguntaFamilia };
