// lib/seb/gobernador.js
// EL GOBERNADOR — el "portero" único por el que pasa TODA ráfaga de etapa 3 antes de
// salir (bancos, cita, cotización, copiloto y automático: un solo punto, todos los
// carriles). Tecnifica el instinto de venta del owner (análisis conv #591 Jorge/Tacoma):
// los bancos deciden QUÉ contestar; el gobernador decide CUÁNDO empujar y cuándo callar.
//
// Reglas (todas deterministas, cero IA):
//  R1 DEDUP      — jamás repetir una línea sustanciosa ya enviada (ni dentro de la misma
//                  ráfaga). #591: "en menos de 2 horas te dicen si apruebas" salió idéntica
//                  dos veces — delata máquina.
//  R2 UN GANCHO  — máximo UN CTA por ráfaga (se queda el último). #591: distancia contestada
//                  con 3 ganchos apilados (apartar + agendar + venir).
//  R3 TERMOSTATO — si nuestro último mensaje fue un gancho y el comprador NO lo contestó
//                  (preguntó otra cosa), este turno sale SIN gancho: sustancia sola.
//                  Insistir con gancho tras gancho ignorado lee como desesperación.
//  R4 CANDADO ✅ — con cita ya confirmada, ningún gancho de cita vuelve a salir fuera
//                  del carril de cita (tras el "sí" se deja de vender).
//  R5 ENFRIAMIENTO — sin cita viva, el gancho a cita sale EVENTUALMENTE, no en cada turno: si ya
//                  salió un gancho en las últimas 6 burbujas nuestras y el comprador no lo contestó,
//                  este turno va sin gancho (resuelve y deja explorar). Orden owner 2026-09-22.
//  R4b CITA VIVA  — con una visita viva (motor de citas flexible o cita confirmada legado) NO se
//                  vuelve a empujar a cita: se resuelve lo comercial y ya. El motor de citas sigue aparte.
//  CAP           — máximo 4 burbujas: el confeti de 7 fragmentos mata el argumento.
//
// EXENTOS: los universos de coordinación de cita (la pregunta final ahí no es empuje,
// es el dato que falta) y los segmentos protegidos ("Cita confirmada ✅" = trigger
// literal del dueño; tarjetas multilínea = cotizaciones/requisitos).

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const nkey = s => norm(s).replace(/\s+/g, ' ').trim();

// ¿El segmento es un GANCHO (CTA de empuje)? Pregunta que pide acción del comprador.
const RE_GANCHO = /(te cotizo|te agendo|agendarte|agendo (la |una )?(cita|prueba)|dia te queda|hora te queda|dia (te|les) (late|acomoda)|te late (venir|que)|venir a verl|te animas|como (la |lo )?ves|como ves los numeros|sabado o (el )?domingo|te esperamos|te coordino|que dia (te|les)|prueba de manejo|cuando te (viene|queda|interesa)|se te acomoda|le hacemos los numeros|gustas que te (cotice|mande)|te queda bien venir|con cuanto de enganche|arrancamos|le damos|cual opcion|con cual (opcion )?le|te coordinamos|a que hora te (coordin|esper|agend|viene)|que lo manejes|te interesa venir|gustas venir|venir a hacer|te late ir|cual te late ir|te agendo de una vez|te animas a venir|para venir a verl|que dia (nos vemos|vienes|te vienes))/;
function esGancho(seg) {
    const s = String(seg || '').trim();
    if (!/\?/.test(s)) return false;   // el gancho trae pregunta (aunque cierre con 'Te agendo de una vez')
    return RE_GANCHO.test(norm(s));
}

// ¿El comprador CONTESTÓ nuestro gancho? (afirmación, dato de cita, número, interés).
// Si sí, el termostato se resetea y el siguiente gancho está permitido.
function respondioGancho(t) {
    t = norm(t);
    return /^(si+|sii+|claro|va+|vale|sale|dale|ok+|okey|perfecto|excelente|simon|andale|de acuerdo|arre)\b/.test(t)
        || /(me interesa|me late|me gusta|me animo|va que va|cotiza|el (lunes|martes|miercoles|jueves|viernes|sabado|domingo)|\bmanana\b|\bhoy\b|a las \d|\d ?(pm|am)|\d+ ?mil|\$ ?\d|de enganche|\d+ ?meses)/.test(t);
}

// Universos donde la pregunta final ES la mecánica (coordinación de cita en curso /
// "¿qué sigue?"): ahí no se enfría — el dato que falta se pide siempre.
const UNIVERSOS_CITA = new Set(['cita', 'cita_firme', 'cita_confirmada', 'multi', 'que_sigue', 'promesa']);

// Segmento intocable: el trigger literal del dueño, o una tarjeta multilínea.
const protegido = s => /cita confirmada/i.test(String(s)) || /\n/.test(String(s));

// gobernar(resultado, { texto, est }) → resultado ajustado (mismo shape) o { silencio }.
//  - resultado: lo que devolvió responderEtapa3 ({ universo, segmentos, fotos?, ... }).
//  - texto: el mensaje entrante del comprador (crudo).
//  - est: estadoConv (necesita ultimos_out, gancho_abierto, cita_confirmada).
function gobernar(r, ctx) {
    if (!r || !Array.isArray(r.segmentos) || !r.segmentos.length) return r;
    const est = (ctx && ctx.est) || {};
    const t = norm((ctx && ctx.texto) || '');
    // cita_resume=true (🚩632): la pregunta final RETOMA una cita pendiente tras un
    // desvío del comprador — es cerrar el loop, no insistir → exenta del termostato.
    const enCita = UNIVERSOS_CITA.has(r.universo) || r.cita_resume === true;
    const cambios = [];

    // Trabajamos con índices originales para poder remapear fotos_after_index/pin_after_index.
    let items = r.segmentos
        .map((s, i) => ({ s: String(s == null ? '' : s), i }))
        .filter(x => x.s.trim());

    // R1 — DEDUP (dentro de la ráfaga y contra lo ya enviado).
    const enviados = new Set(est.ultimos_out || []);
    const vistos = new Set();
    items = items.filter(x => {
        if (protegido(x.s)) return true;
        const n = nkey(x.s);
        if (vistos.has(n)) { cambios.push('dup_interno'); return false; }
        vistos.add(n);
        const sustancioso = n.split(' ').length >= 4 || n.length >= 25;
        if (sustancioso && enviados.has(n)) { cambios.push('ya_enviado'); return false; }
        return true;
    });

    // R2 — UN GANCHO MÁXIMO: si hay 2+ CTAs, se queda solo el último.
    const idxG = items.map((x, k) => esGancho(x.s) ? k : -1).filter(k => k >= 0);
    if (idxG.length > 1) {
        const keep = idxG[idxG.length - 1];
        items = items.filter((x, k) => !idxG.includes(k) || k === keep);
        cambios.push('multi_gancho');
    }

    // R3 — TERMOSTATO + R4 — CANDADO ✅ (no aplican dentro del carril de cita).
    const respondio = respondioGancho(t);
    const enfriar = !enCita && !respondio && (est.gancho_abierto || (Number.isFinite(est.outs_desde_gancho) && est.outs_desde_gancho < 6));
    const candado = !enCita && (est.cita_confirmada || est.cita_viva);
    if (enfriar || candado) {
        const antes = items.length;
        items = items.filter(x => protegido(x.s) || !esGancho(x.s));
        if (items.length < antes) cambios.push(candado ? (est.cita_viva && !est.cita_confirmada ? 'candado_cita_viva' : 'candado_cita') : (est.gancho_abierto ? 'termostato' : 'enfriamiento'));
    }

    // CAP — máximo 4 burbujas: se funden las del medio (nunca tarjetas ni el trigger).
    const MAX = 4;
    if (items.length > MAX && !r.fotos && r.ubicacion_auto_id == null) {
        const head = items[0];
        const tail = items[items.length - 1];
        const medio = items.slice(1, -1);
        if (!medio.some(x => protegido(x.s))) {
            const fundido = medio.map(x => x.s.replace(/[.;\s]+$/, '')).join('. ');
            items = [head, { s: fundido, i: medio[0].i }, tail];
            cambios.push('confeti');
        }
    }

    if (!items.length) {
        return { silencio: true, universo: r.universo || 'gobernador', motivo: 'gobernador: todo era repetido o gancho enfriado — mejor callar que insistir' };
    }

    // Remapeo de índices de media (fotos/pin van "después del segmento N" original).
    const out = { ...r, segmentos: items.map(x => x.s) };
    const remap = a => {
        if (a == null) return a;
        let n = -1;
        items.forEach((x, k) => { if (x.i <= a) n = k; });
        return n < 0 ? 0 : n;
    };
    if (out.fotos_after_index != null) out.fotos_after_index = remap(out.fotos_after_index);
    if (out.pin_after_index != null) out.pin_after_index = remap(out.pin_after_index);
    if (cambios.length) out._gobernado = cambios;
    return out;
}

// PUERTA ÚNICA para lo que sale del panel (perro, mesa, continuación, aparador, duda general, etapa 3):
// mismo gobernador, mismo shape de respuesta {segmentos, fotos_after_index, pin_after_index, tipo}. El opener y las
// respuestas de la máquina de citas no pasan por aquí (no son empuje comercial).
const MODOS_COMERCIALES = new Set(['perro', 'mesa', 'continuacion', 'aparador', 'duda_general', 'etapa3']);
function gobernarSalida(payload, ctx) {
    if (!payload || !payload.ok || !Array.isArray(payload.segmentos) || !payload.segmentos.length || !MODOS_COMERCIALES.has(payload.modo)) return payload;
    const universo = String(payload.tipo || '').replace(/^(e3_|cont_|mesa_|perro_|mesa_accion_)/, '');
    const r = { universo, segmentos: payload.segmentos, fotos: payload.fotos || null, fotos_after_index: payload.fotos_after_index, pin_after_index: payload.pin_after_index, ubicacion_auto_id: payload.ubicacion_auto_id, cita_resume: payload.cita_resume };
    const g = gobernar(r, ctx);
    if (!g) return payload;
    if (g.silencio) {
        // solo quedaban ganchos/repetidos: si traía media (fotos/pin) igual se entrega, con la primera burbuja sustanciosa
        if (payload.fotos || payload.ubicacion_auto_id != null) return { ...payload, segmentos: [payload.segmentos[0]], _gobernado: ['solo_media'] };
        return { ok: false, motivo: 'gobernador_silencio', _gobernado: ['silencio'] };
    }
    const out = { ...payload, segmentos: g.segmentos };
    if (payload.fotos_after_index != null) out.fotos_after_index = g.fotos_after_index;
    if (payload.pin_after_index != null) out.pin_after_index = g.pin_after_index;
    if (g._gobernado) out._gobernado = g._gobernado;
    return out;
}
module.exports = { gobernar, gobernarSalida, esGancho, respondioGancho };
