// lib/seb/timbre.js — EL TIMBRE DE CAMBIOS (Ley del Timbre del owner, 2026-09-08).
// Quien CAMBIA algo (cita, rescate, programado, staff, foco, bot, delegación) lo toca aquí; el puente lo rebota
// por WebSocket a todas las pantallas (calendario del Sales Brain, FyraChat). Evento, no sondeo.
// Es best-effort: nunca tumba la acción que lo llama (timeout corto, errores tragados), pero SÍ se espera
// (en Vercel una promesa suelta muere al contestar).
//
// CONTRATO FyraChat v2 (2026-09-10): TODO evento `cambio` lleva `tenant_id` (default 0), `chat_id` (o null) y
// `que` ∈ 'foco' | 'bot' | 'cita' | 'delegacion' | 'ghost' | 'mensaje' | 'otro'. El cliente ignora lo que no sea de su
// universo y repinta SOLO la fila/hilo de ese chat_id. Los campos legacy (entidad, id, accion, tipo) se conservan.
const BRIDGE = (process.env.BRIDGE_SEND_URL || 'http://137.184.199.19:3000/api/send').replace('/api/send', '/api/emit');

// ¿Qué cambió? Determinista a partir de lo que ya mandan los que tocan el timbre (entidad / tipo de acción).
function queDe(ev) {
    if (ev.que) return String(ev.que);
    const ent = String(ev.entidad || ''), tipo = String(ev.tipo || ev.accion || '');
    if (ent === 'accion') {
        if (/^foco/.test(tipo)) return 'foco';
        if (/^bot_/.test(tipo)) return 'bot';
        if (/^(cita|recordatorio|en_camino|staff|post_cita)/.test(tipo)) return 'cita';
        if (/^(delegacion|soltado)/.test(tipo)) return 'delegacion';
        if (/^(programado|rescate)/.test(tipo)) return 'ghost';
        if (/^(envio|boton_|entrada)/.test(tipo)) return 'mensaje';
        return 'otro';
    }
    if (ent === 'cita' || ent === 'casilla' || ent === 'staff' || ent === 'cita_job') return 'cita';
    if (ent === 'programado' || ent === 'rescate') return 'ghost';
    if (ent === 'delegacion') return 'delegacion';
    if (ent === 'foco') return 'foco';
    if (ent === 'bot') return 'bot';
    return 'otro';
}

async function tocar(ev) {
    try {
        const KEY = process.env.K_PUENTE || process.env.BRIDGE_API_KEY;   // llave saliente al puente (transición: BRIDGE_API_KEY); sin literal
        if (!KEY) return;                                                    // falla cerrada y silenciosa: el timbre jamás rompe la acción
        const e = Object.assign({}, ev || {});
        const out = Object.assign({ tipo: 'cambio' }, e, {
            tenant_id: Number(e.tenant_id) || 0,
            chat_id: e.chat_id == null ? null : Number(e.chat_id),
            que: queDe(e)
        });
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
        await fetch(BRIDGE, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(out), signal: ctl.signal });
        clearTimeout(t);
    } catch (e) { /* silencioso: el timbre jamás rompe la acción */ }
}
module.exports = { tocar, queDe };
