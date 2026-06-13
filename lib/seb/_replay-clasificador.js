// Replay del clasificador (Paso 3) contra mensajes REALES de wa_messages.
// Solo lectura + llamadas a Haiku. Correr: node lib/seb/_replay-clasificador.js
const fs = require('fs');
fs.readFileSync(__dirname + '/../../.env', 'utf8').split('\n').forEach(l => {
    const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
});
const { query } = require('./db.js');
const { entender } = require('./clasificador.js');

(async () => {
    // Mensajes entrantes reales con su contexto (los 6 mensajes previos del mismo teléfono)
    const all = await query(
        `SELECT telefono, mensaje, direccion, timestamp FROM wa_messages
         WHERE platform='whatsapp' AND mensaje IS NOT NULL
         ORDER BY telefono, timestamp`);
    const byPhone = {};
    all.forEach(m => { (byPhone[m.telefono] ||= []).push(m); });

    // Muestreo dirigido: variedad de situaciones reales
    const candidatos = [];
    for (const [tel, msgs] of Object.entries(byPhone)) {
        msgs.forEach((m, i) => {
            if (m.direccion !== 'in' || String(m.mensaje).trim().length < 2) return;
            const prev = msgs.slice(Math.max(0, i - 6), i);
            const prevSeb = [...prev].reverse().find(p => p.direccion === 'out');
            candidatos.push({
                mensaje: m.mensaje,
                historial: prev.map(p => ({ direccion: p.direccion, mensaje: String(p.mensaje).slice(0, 150) })),
                esPrimero: !prev.some(p => p.direccion === 'in'),
                tieneSebAntes: !!prevSeb
            });
        });
    }
    // 8 primeros contactos + 12 mensajes a media conversación (donde vive la "continuación")
    const primeros = candidatos.filter(c => c.esPrimero).sort(() => Math.random() - 0.5).slice(0, 8);
    const medios = candidatos.filter(c => !c.esPrimero && c.tieneSebAntes).sort(() => Math.random() - 0.5).slice(0, 12);
    const muestra = [...primeros, ...medios];

    console.log('REPLAY DEL CLASIFICADOR — ' + muestra.length + ' mensajes reales\n' + '═'.repeat(70));
    let usageIn = 0, usageOut = 0, errores = 0;
    for (const c of muestra) {
        try {
            const r = await entender({ mensaje: c.mensaje, historial: c.historial, estado: {} });
            usageIn += (r._usage?.input_tokens || 0); usageOut += (r._usage?.output_tokens || 0);
            const ultSeb = [...c.historial].reverse().find(h => h.direccion === 'out');
            console.log('\n' + (c.esPrimero ? '🆕 PRIMER MSG' : '💬 MEDIO') +
                (ultSeb ? '\n   Seb antes: "' + ultSeb.mensaje.slice(0, 70) + '"' : ''));
            console.log('   COMPRADOR: "' + String(c.mensaje).slice(0, 90).replace(/\n/g, ' ') + '"');
            const datos = Object.entries(r.datos || {}).filter(([, v]) => v !== null).map(([k, v]) => k + '=' + v).join(', ');
            console.log('   → ' + r.intencion_principal +
                (r.intenciones.length > 1 ? ' (+' + r.intenciones.filter(i => i !== r.intencion_principal).join(',') + ')' : '') +
                ' | auto: ' + (r.auto_id ?? '—') + (r.auto_via ? ' [' + r.auto_via + ']' : '') +
                ' | conf: ' + r.confianza + (r.escalar ? ' | ⚠️ ESCALAR' : '') +
                (datos ? ' | datos: ' + datos : ''));
        } catch (e) { errores++; console.log('\n❌ ERROR: ' + e.message.slice(0, 120)); }
    }
    const costo = (usageIn / 1e6 * 1) + (usageOut / 1e6 * 5);
    console.log('\n' + '═'.repeat(70));
    console.log('Tokens: ' + usageIn + ' in / ' + usageOut + ' out → costo del replay: $' + costo.toFixed(4) + ' USD');
    if (errores) console.log('Errores: ' + errores);
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
