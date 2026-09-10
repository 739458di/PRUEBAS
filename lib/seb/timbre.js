// lib/seb/timbre.js — EL TIMBRE DE CAMBIOS (Ley del Timbre del owner, 2026-09-08).
// Quien CAMBIA algo (cita, rescate, programado, staff) lo toca aquí; el puente lo rebota por WebSocket a
// todas las pantallas (calendario del Sales Brain, FyraChat). Evento, no sondeo.
// Es best-effort: nunca tumba la acción que lo llama (timeout corto, errores tragados), pero SÍ se espera
// (en Vercel una promesa suelta muere al contestar).
const BRIDGE = (process.env.BRIDGE_SEND_URL || 'http://137.184.199.19:3000/api/send').replace('/api/send', '/api/emit');
async function tocar(ev) {
    try {
        const KEY = process.env.K_PUENTE || process.env.BRIDGE_API_KEY;   // llave saliente al puente (transición: BRIDGE_API_KEY); sin literal
        if (!KEY) return;                                                    // falla cerrada y silenciosa: el timbre jamás rompe la acción
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
        await fetch(BRIDGE, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(Object.assign({ tipo: 'cambio' }, ev || {})), signal: ctl.signal });
        clearTimeout(t);
    } catch (e) { /* silencioso: el timbre jamás rompe la acción */ }
}
module.exports = { tocar };
