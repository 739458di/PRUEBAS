// Test del validador (Paso 2). Se corre local: node lib/seb/_test-validador.js
const fs = require('fs');
fs.readFileSync(__dirname + '/../../.env', 'utf8').split('\n').forEach(l => {
    const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
});
const { validarYRellenar, juntarPlaceholders } = require('./validador.js');
const H = require('./herramientas.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? '  →  ' + extra : ''));
    cond ? pass++ : fail++;
};

(async () => {
    const ph = {
        precio: '$289,900', auto_nombre: 'Mazda 3 i sport 2021', kilometraje: '40,000 km',
        punto_nombre: 'Plaza Lúa', punto_maps: 'https://maps.google.com/?q=25.65,-100.35'
    };

    let r = validarYRellenar('Sii está disponible ✅ El {{auto_nombre}} anda en {{precio}}. ¿Te agendo cita mañana?', ph);
    check('rellena huecos', r.ok && r.texto_final.includes('$289,900') && r.texto_final.includes('Mazda'), r.texto_final);

    r = validarYRellenar('Te queda en {{mensualidad}} al mes', ph);
    check('hueco sin respaldo → rechaza', !r.ok && r.motivo === 'hueco_sin_respaldo' && r.detalle === 'mensualidad');

    r = validarYRellenar('Está en {{punto_direccion}}', { punto_direccion: null });
    check('hueco null → rechaza', !r.ok && r.motivo === 'hueco_sin_respaldo');

    r = validarYRellenar('El Mazda anda en $275,000, súper precio', ph);
    check('cifra $ tecleada → rechaza', !r.ok && r.motivo === 'cifra_no_autorizada', r.detalle);

    r = validarYRellenar('Lo dejamos en 280 mil y cerramos', ph);
    check("'280 mil' tecleado → rechaza", !r.ok && r.motivo === 'cifra_no_autorizada');

    r = validarYRellenar('Son 60000 de enganche', ph);
    check('60000 tecleado → rechaza', !r.ok && r.motivo === 'cifra_no_autorizada');

    r = validarYRellenar('¿Te queda bien mañana a las 6, o el sábado a las 10:30?', ph);
    check('horas/fechas chicas → pasa', r.ok, r.ok ? 'ok' : r.motivo + ':' + r.detalle);

    r = validarYRellenar('Es de 2 dueños y trae sus 4 llantas nuevas', ph);
    check('cantidades chicas → pasa', r.ok);

    r = validarYRellenar('Va, te lo aparto hasta el sábado', ph);
    check('frase prohibida → rechaza', !r.ok && r.motivo === 'frase_prohibida');

    r = validarYRellenar('bla '.repeat(300), ph);
    check('demasiado largo → rechaza', !r.ok && r.motivo === 'demasiado_largo');

    // INTEGRACIÓN REAL: tools de verdad → juntar → rellenar
    const ia = await H.info_auto({ auto_id: 236 });
    const ub = await H.ubicacion({ auto_id: 1 });
    const todos = juntarPlaceholders([ia, ub]);
    r = validarYRellenar('Claro! El {{auto_nombre}} está en {{precio}} con {{kilometraje}} 🚗 Lo puedes ver en {{punto_nombre}}: {{punto_maps}} ¿Mañana o el sábado?', todos);
    check('integración con tools reales', r.ok && r.texto_final.includes('$289,900') && r.texto_final.includes('Plaza Lúa'));
    if (r.ok) console.log('\n   MENSAJE FINAL:\n   ' + r.texto_final);

    console.log('\n' + (fail === 0 ? 'TODO OK' : 'FALLOS: ' + fail) + ' (' + pass + '/' + (pass + fail) + ')');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
