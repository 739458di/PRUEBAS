// Corredor del eval set fijo del clasificador.
// Correr: node lib/seb/_eval-clasificador.js
// Regla del proyecto: antes de aceptar CUALQUIER cambio al prompt del
// clasificador, este eval debe correr completo sin bajar de accuracy.
const fs = require('fs');
fs.readFileSync(__dirname + '/../../.env', 'utf8').split('\n').forEach(l => {
    const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
});
const { entender } = require('./clasificador.js');
const { query } = require('./db.js');
const { casos } = JSON.parse(fs.readFileSync(__dirname + '/eval-clasificador.json', 'utf8'));

(async () => {
    // Menú de autos UNA sola vez (en runtime el orquestador hará lo mismo)
    const rows = await query(
        "SELECT id, marca, modelo, version, anio, precio, codigo_corto FROM inventario_autos WHERE estado='activo' ORDER BY marca"
    );
    const autos = rows.map(a => ({
        id: a.id, nombre: [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' '),
        anio: a.anio, precio: a.precio, codigo_corto: a.codigo_corto || null
    }));

    let pass = 0, fail = 0, usageIn = 0, usageOut = 0;
    const fallos = [];
    for (const c of casos) {
        try {
            const r = await entender({ mensaje: c.mensaje, historial: c.historial || [], estado: {}, autos });
            usageIn += (r._usage?.input_tokens || 0); usageOut += (r._usage?.output_tokens || 0);
            const motivos = [];
            if (!c.esperado.includes(r.intencion_principal)) motivos.push(`intencion: ${r.intencion_principal} (esperaba ${c.esperado.join('|')})`);
            if (c.noEsperado && c.noEsperado.includes(r.intencion_principal)) motivos.push(`intencion PROHIBIDA: ${r.intencion_principal}`);
            if (c.auto !== undefined && c.auto !== 'any') {
                if (c.auto === null && r.auto_id !== null) motivos.push(`auto: ${r.auto_id} (esperaba null)`);
                if (c.auto !== null && r.auto_id !== c.auto) motivos.push(`auto: ${r.auto_id} (esperaba ${c.auto})`);
            }
            if (c.escalar !== undefined && c.escalar !== 'any' && r.escalar !== c.escalar) motivos.push(`escalar: ${r.escalar} (esperaba ${c.escalar})`);
            for (const d of (c.datos || [])) {
                if (r.datos?.[d] === null || r.datos?.[d] === undefined) motivos.push(`dato faltante: ${d}`);
            }
            if (motivos.length === 0) { pass++; console.log(`✅ #${c.id} "${c.mensaje.slice(0, 50)}" → ${r.intencion_principal}`); }
            else { fail++; fallos.push({ id: c.id, motivos }); console.log(`❌ #${c.id} "${c.mensaje.slice(0, 50)}" → ${motivos.join(' · ')}`); }
        } catch (e) { fail++; fallos.push({ id: c.id, motivos: ['ERROR: ' + e.message.slice(0, 80)] }); console.log(`❌ #${c.id} ERROR: ${e.message.slice(0, 80)}`); }
    }
    const acc = Math.round(pass / casos.length * 100);
    const costo = (usageIn / 1e6 * 1) + (usageOut / 1e6 * 5);
    console.log('\n══════════ ACCURACY: ' + pass + '/' + casos.length + ' (' + acc + '%) · costo $' + costo.toFixed(4) + ' ══════════');
    process.exit(fail === 0 ? 0 : (acc >= 85 ? 0 : 1));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
