// Replay EN SECO del cerebro completo: entender (Haiku) → pensar (Sonnet).
// No escribe nada en Turso, no envía nada. Correr: node lib/seb/_replay-seb.js
const fs = require('fs');
fs.readFileSync(__dirname + '/../../.env', 'utf8').split('\n').forEach(l => {
    const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
});
const { entender } = require('./clasificador.js');
const { pensar } = require('./loop.js');

const ESCENARIOS = [
    {
        nombre: '1. PRIMER CONTACTO (anuncio de auto activo)',
        telefono: '5218100000001',
        mensaje: '¡Hola! Quiero más información [ANUNCIO: Fyradrive] [DESC: fyradrive 🚘 MAZDA 3 I SPORT 2021\n💵 $289,900 MXN',
        estado: {}
    },
    {
        nombre: '2. PIDE UBICACIÓN (auto activo en estado)',
        telefono: '5218100000002',
        mensaje: 'Cuál es la dirección para verlo?',
        estado: { auto_id_activo: 1, nombre: 'Carlos' }
    },
    {
        nombre: '3. PIDE COTIZACIÓN (cotizador en stand by)',
        telefono: '5218100000003',
        mensaje: 'cuanto seria de enganche y cuanto al mes?',
        estado: { auto_id_activo: 236 }
    },
    {
        nombre: '4. CONTINUACIÓN: confirma la cita propuesta',
        telefono: '5218100000004',
        mensaje: 'si va, ahí nos vemos',
        estado: { auto_id_activo: 1, pregunta_pendiente: '¿Te queda bien mañana a las 5 en Plaza Lúa?', cita_propuesta: 'mañana 17:00' }
    },
    {
        nombre: '5. AUTO QUE NO TENEMOS (anuncio viejo)',
        telefono: '5218100000005',
        mensaje: 'Hola me interesa la Odyssey [DESC: 🏴HONDA ODYSSEY EXL 2014',
        estado: {}
    }
];

(async () => {
    let totalIn = 0, totalOut = 0;
    for (const e of ESCENARIOS) {
        console.log('\n' + '═'.repeat(72) + '\n' + e.nombre);
        console.log('COMPRADOR: "' + e.mensaje.slice(0, 80).replace(/\n/g, ' ') + '"');
        try {
            const c = await entender({ mensaje: e.mensaje, historial: [], estado: e.estado });
            console.log('  entendió: ' + c.intencion_principal + ' | auto: ' + (c.auto_id ?? '—') + (c.auto_via ? ' [' + c.auto_via + ']' : ''));
            const r = await pensar({ telefono: e.telefono, mensaje: e.mensaje, clasificacion: c, estado: e.estado });
            totalIn += r.usage.in; totalOut += r.usage.out;
            if (r.ok) {
                console.log('  tools: ' + (r.tools_usadas.map(t => t.tool).join(', ') || '(ninguna)'));
                console.log('\n  📝 BORRADOR DE SEB:\n  ' + r.borrador.split('\n').join('\n  '));
                if (r.estado_nuevo.pregunta_pendiente) console.log('\n  (pregunta pendiente guardada: "' + r.estado_nuevo.pregunta_pendiente + '")');
            } else {
                console.log('  ⚠️ ESCALA A HUMANO — motivo: ' + r.motivo);
            }
        } catch (err) { console.log('  ❌ ERROR: ' + err.message.slice(0, 120)); }
    }
    const costo = (totalIn / 1e6 * 3) + (totalOut / 1e6 * 15);
    console.log('\n' + '═'.repeat(72));
    console.log('Sonnet: ' + totalIn + ' in / ' + totalOut + ' out → costo total: $' + costo.toFixed(4) + ' USD');
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
