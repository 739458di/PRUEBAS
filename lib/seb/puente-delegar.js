// lib/seb/puente-delegar.js — DELEGAR CON INSTRUCCIÓN (orden owner 2026-09-22)
//
// El vendedor captó un contacto fuera del WhatsApp del lote (Messenger, en persona) y lo mete a la máquina con UNA caja de texto:
// "¿qué hacer? cotizar con 50 mil, mandar ubicación, fotos, ficha, agendar el sábado a las 4…". La IA chica traduce eso a las
// herramientas que YA existen (formulario cerrado; regex de respaldo si no hay IA), Seb saluda con el puente
// ("Hola nuevamente! Un gusto, somos {lote}, {vendedor}. Para darte seguimiento te comparto la ubicación y las fotos") y las
// herramientas salen por la misma puerta que los botones. De ahí el flujo sigue como si nada.
const HAIKU = 'claude-haiku-4-5-20251001';
const HERR = ['fotos', 'ubicacion', 'cotizar', 'info', 'cita'];
const SCHEMA = { type: 'object', additionalProperties: false, required: ['razon', 'herramientas', 'enganche', 'plazo_meses', 'fecha_iso', 'hora', 'saludar'], properties: {
    razon: { type: 'string' }, herramientas: { type: 'array', items: { type: 'string', enum: HERR } },
    enganche: { type: 'integer', description: 'pesos; 0 si no lo dice' }, plazo_meses: { type: 'integer', description: '36/48/60; 0 si no lo dice' },
    fecha_iso: { type: 'string', description: 'YYYY-MM-DD si pide agendar un día concreto; vacío si no' }, hora: { type: 'string', description: 'HH:MM 24h si da hora; vacío si no' },
    saludar: { type: 'boolean', description: 'true salvo que el vendedor diga explícitamente que NO salude' } } };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
function respaldo(txt, now) {   // sin IA: regex sobre lo que escribió el vendedor
    const t = norm(txt); const h = [];
    if (/foto|imagen|video/.test(t)) h.push('fotos'); if (/ubicaci|direcci|donde|mapa|pin\b/.test(t)) h.push('ubicacion');
    if (/cotiz|mensualidad|financ|credito|enganche/.test(t)) h.push('cotizar'); if (/ficha|info|caracter|detalle/.test(t)) h.push('info'); if (/cita|agend|visita/.test(t)) h.push('cita');
    const mE = t.match(/(\d+(?:[.,]\d+)?)\s*(mil|k)\b/) || t.match(/\$?\s*(\d{4,7})\b/); let enganche = 0; if (mE) { const n = Number(String(mE[1]).replace(',', '.')); enganche = /mil|k/.test(mE[2] || '') ? Math.round(n * 1000) : Math.round(n); }
    const mP = t.match(/\b(36|48|60)\s*(meses|m)\b/); const mH = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|hrs?|h)?\b/);
    let fecha_iso = ''; const d = new Date(now - 6 * 3600000); const hoy = d.toISOString().slice(0, 10);
    if (/\bhoy\b/.test(t)) fecha_iso = hoy; else if (/\bmanana\b/.test(t)) fecha_iso = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
    else { const md = DIAS.findIndex(x => new RegExp('\\b' + x + '\\b').test(t)); if (md >= 0) { for (let i = 1; i <= 7; i++) { const dd = new Date(d.getTime() + i * 86400000); if (dd.getUTCDay() === md) { fecha_iso = dd.toISOString().slice(0, 10); break; } } } }
    let hora = ''; if (mH && h.includes('cita')) { let hh = Number(mH[1]); const mm = mH[2] || '00'; if (mH[3] === 'pm' && hh < 12) hh += 12; if (!mH[3] && hh >= 1 && hh <= 7) hh += 12; hora = String(hh).padStart(2, '0') + ':' + mm; }
    return { razon: 'respaldo sin IA', herramientas: [...new Set(h)], enganche, plazo_meses: mP ? Number(mP[1]) : 0, fecha_iso, hora, saludar: true };
}
async function interpretar(txt, now) {
    const apiKey = process.env.CLAUDE_API_KEY; if (!apiKey || !String(txt || '').trim()) return respaldo(txt, now || Date.now());
    const d = new Date((now || Date.now()) - 6 * 3600000);
    const system = 'Eres el asistente de un vendedor de autos seminuevos en Monterrey. El vendedor acaba de meter a un comprador a la máquina y escribió QUÉ HACER con él. Tradúcelo a las herramientas disponibles (cero redacción): fotos · ubicacion · cotizar (con enganche y plazo si los da) · info (ficha completa) · cita (día y hora concretos). ' +
        'Varias a la vez si pide varias. Si no pide nada concreto, herramientas = []. Hoy es ' + DIAS[d.getUTCDay()] + ' ' + d.toISOString().slice(0, 10) + '. Primero escribe la razón, luego el formulario.';
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: HAIKU, max_tokens: 300, system, messages: [{ role: 'user', content: 'INSTRUCCIÓN DEL VENDEDOR: ' + String(txt).slice(0, 600) }], output_config: { format: { type: 'json_schema', schema: SCHEMA } } }) });
        const j = await r.json(); const tx = j && j.content && j.content[0] && j.content[0].text; const o = tx ? JSON.parse(tx) : null;
        if (!o || !Array.isArray(o.herramientas)) return respaldo(txt, now);
        o.herramientas = [...new Set(o.herramientas.filter(h => HERR.includes(h)))]; return o;
    } catch (e) { return respaldo(txt, now); }
}
const NOMBRES = { ubicacion: 'la ubicación', fotos: 'las fotos', info: 'la ficha completa', cotizar: 'la cotización', cita: 'los datos de tu cita' };
const capPalabras = s => String(s || '').toLowerCase().replace(/(^|\s)\S/g, x => x.toUpperCase()).trim();
// el saludo puente, en las palabras del owner
function saludo({ nombreComprador, lote, vendedor, herramientas, faltaEnganche, asistenteDe }) {
    const n = String(nombreComprador || '').trim().split(/\s+/)[0]; const quien = [lote ? 'somos ' + lote : '', vendedor].filter(Boolean).join(', ');
    const s1 = asistenteDe ? 'Qué tal' + (n ? ' ' + n : '') + ', soy Seb, asistente virtual de ' + asistenteDe + '; si ocupas hablar con él, me dices.' : 'Hola nuevamente' + (n ? ' ' + n : '') + '! Un gusto' + (quien ? ', ' + quien : '') + '.';
    const cosas = herramientas.filter(h => !(h === 'cotizar' && faltaEnganche)).map(h => NOMBRES[h]);
    const lista = cosas.length ? (cosas.length === 1 ? cosas[0] : cosas.slice(0, -1).join(', ') + ' y ' + cosas[cosas.length - 1]) : '';
    const s2 = lista ? 'Para darte seguimiento te comparto ' + lista : 'Para darte seguimiento quedo pendiente por aquí';
    const s3 = faltaEnganche ? 'Para la cotización, con cuánto de enganche le hacemos los números?' : '';
    return [s1, s2, s3].filter(Boolean);
}
module.exports = { interpretar, saludo, capPalabras, HERR };
