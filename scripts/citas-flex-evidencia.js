// PRUEBAS DE LA REGLA GENERAL (orden owner 2026-09-21): REALIDAD ANTERIOR + EVIDENCIA → SOLO CAMBIA LA PARTE QUE LA EVIDENCIA TOCÓ.
// Corre contra el motor REAL de TERRA (universo 9, sandbox: nada sale a WhatsApp). Teléfonos de prueba explícitos; limpia lo que crea.
//   node scripts/citas-flex-evidencia.js            (todos)      node scripts/citas-flex-evidencia.js A,E   (algunos)
process.env.CITAF_SIN_MAQUILLAJE = '1';   // estas pruebas verifican la MECÁNICA con las plantillas base (el maquillaje de la IA se prueba aparte)
const fs = require('fs'); fs.readFileSync(__dirname + '/../.env', 'utf8').split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) process.env[l.slice(0, i).trim()] = process.env[l.slice(0, i).trim()] || l.slice(i + 1).trim(); });
const DEMO = require('../lib/seb/demo.js'), C = require('../lib/seb/citas-flex.js'); const { query, run } = require('../lib/seb/db.js'); const { at, ymd } = C._t;
const SOLO = (process.argv[2] || '').toUpperCase().split(',').filter(Boolean); let fallas = 0, total = 0;
const JUE = '2026-09-24', VIE = '2026-09-25', SAB = '2026-09-26', DOM = '2026-09-27', LUN = '2026-09-28';

async function caso(letra, titulo, tel, pasos) {
    if (SOLO.length && !SOLO.includes(letra)) return;
    const T = (await query('SELECT id,telefono,nombre,config_json FROM tenants WHERE id=9'))[0]; T.config = JSON.parse(T.config_json); T.demo = true;
    await DEMO.delegar({ tenant: T, tel, auto_id: 1081, auto_nombre: 'Nissan Sentra Sr 2023', nombre: 'Juan Evidencia' });
    const ch = (await query('SELECT id,telefono,nombre,tenant_id FROM conversaciones WHERE tenant_id=9 AND telefono=?', [tel]))[0];
    const io0 = C.ioPara(T, ch); const out = [], ven = [];
    const io = Object.assign({}, io0, { mandar: async (tx, ts) => { out.push(tx.replace(/\n/g, ' ⏎ ')); return io0.mandar(tx, ts); }, vendedor: async tx => { ven.push(tx); return io0.vendedor(tx); } });
    console.log('\n══ ' + letra + ' · ' + titulo);
    try {
        for (const p of pasos) {
            if (p.lote) { await io0.mandar(p.lote); console.log('   🏢 (recordatorio) ' + p.lote); continue; }
            if (p.vencer) { const c = (await query('SELECT * FROM citaf WHERE chat_id=? ORDER BY id DESC LIMIT 1', [ch.id]))[0]; await run("UPDATE citaf SET ultima_palabra='ventana_vencida', version=version+1, version_ts=?, updated=updated+1 WHERE id=?", [p.vencer, c.id]); await C.reconciliar(T, c.id, p.vencer, 'prueba: ventana vencida'); console.log('   ⏱ (la ventana venció sin llegada acreditada)'); continue; }
            out.length = 0; ven.length = 0; await DEMO.responder({ tenant: T, tel, texto: p.di });
            const r = await C.entrante({ tenant: T, chat: ch, auto: { id: 291, nombre: 'Nissan Sentra Sr 2023' }, io, ahoraFijo: p.now });
            const c = (await query('SELECT * FROM citaf WHERE chat_id=? ORDER BY id DESC LIMIT 1', [ch.id]))[0] || {};
            const pend = c.id ? await query("SELECT tipo, due_ts, clave FROM citaf_casillas WHERE cita_id=? AND estado='pendiente' ORDER BY due_ts", [c.id]) : [];
            console.log('👤 "' + p.di + '"  →  ' + r.evento + (r.tipo ? ' / ' + r.tipo : ''));
            ((r.traza || {}).cambio || []).forEach(x => console.log('      Δ ' + x));
            out.forEach(o => console.log('      🏢 ' + o.slice(0, 200))); ven.forEach(o => console.log('      📣 ' + o.slice(0, 220)));
            console.log('      ⏰ plan: ' + (pend.map(k => k.tipo + ' ' + C.fechaCorta(k.due_ts)).join(' · ') || '(nada)'));
            const ver = (nombre, ok) => { total++; if (!ok) fallas++; console.log('      ' + (ok ? '✅' : '❌') + ' ' + nombre); };
            const E = p.espera || {};
            if (E.evento) ver('evento ' + E.evento.join('|'), E.evento.includes(r.evento));
            if (E.estado) ver('estado = ' + E.estado, c.estado === E.estado);
            if (E.dia) ver('día = ' + E.dia.join(' → '), ymd(Number(c.ini_ts)) === E.dia[0] && ymd(Number(c.fin_ts)) === E.dia[E.dia.length - 1]);
            if (E.precision) ver('concreción = ' + E.precision, c.precision === E.precision);
            if (E.confirmada != null) ver('día confirmado = ' + E.confirmada, Number(c.confirmada_dia || 0) === E.confirmada);
            if (E.version) ver('nueva versión', Number(c.version) > p._vAntes);
            if (E.sinPlanEn) ver('ya no hay mensajes del día ni vencimiento en ' + E.sinPlanEn, !pend.some(k => ymd(Number(k.due_ts)) === E.sinPlanEn && ['dia', 'dia_multi', 'dia_ultimo', 'empujon', 'marcar', 'me_avisas', 'vence'].includes(k.tipo)));
            if (E.planEn) ver('hay plan para ' + E.planEn, pend.some(k => ymd(Number(k.due_ts)) >= E.planEn));
            if (E.planSolo) ver('el plan solo tiene: ' + E.planSolo.join(','), pend.every(k => E.planSolo.includes(k.tipo)));
            if (E.todasDeVersion) ver('todos los pendientes son de la versión actual', pend.every(k => String(k.clave).includes(':v' + c.version + ':')));
            if (E.vendedor) ver('aviso al vendedor contiene "' + E.vendedor + '"', ven.some(v => v.toLowerCase().includes(E.vendedor.toLowerCase())));
            if (E.sinVendedor) ver('sin aviso al vendedor', ven.length === 0);
            if (E.responde) ver('le contesta algo con "' + E.responde + '"', out.some(v => v.toLowerCase().includes(E.responde.toLowerCase())));
            if (E.trazaCambio) ver('la traza dice qué cambió: "' + E.trazaCambio + '"', ((r.traza || {}).cambio || []).some(x => x.includes(E.trazaCambio)));
        }
    } finally {
        await C.borrarDeChat(ch.id); for (const [tb, col] of [['mensajes', 'conversacion_id'], ['delegaciones', 'chat_id'], ['acciones', 'chat_id'], ['envios', 'chat_id']]) await run('DELETE FROM ' + tb + ' WHERE ' + col + '=?', [ch.id]).catch(() => { }); await run('DELETE FROM conversaciones WHERE id=?', [ch.id]);
    }
}
(async () => {
    await caso('A', 'viernes-sábado → "sí hoy": el sábado queda invalidado', '5210000000031', [
        { di: 'paso entre viernes y sábado', now: at(JUE, 11, 0), espera: { evento: ['agenda_o_cambio'], estado: 'viva', dia: [VIE, SAB], precision: 'dias' } },
        { lote: 'Buen día Juan. ¿Vienes hoy a ver el Nissan Sentra Sr 2023 o te queda mejor el sábado? Hoy estamos hasta las 7 pm.' },
        { di: 'sí hoy', now: at(VIE, 9, 40), espera: { evento: ['confirma', 'agenda_o_cambio'], estado: 'viva', dia: [VIE], precision: 'dia', confirmada: 1, sinPlanEn: SAB, todasDeVersion: true, vendedor: 'HOY', trazaCambio: 'Día:' } },
    ]);
    await caso('B', 'hoy 12 pm → "llego más tarde" → "yo te aviso cuando vaya": solo muere la hora', '5210000000032', [
        { di: 'voy mañana a las 12', now: at(JUE, 18, 0), espera: { estado: 'viva', dia: [VIE], precision: 'hora' } },
        { lote: 'Buen día Juan. Hoy es tu cita a las 12 pm para ver el Nissan Sentra Sr 2023. ¿Seguimos en pie?' },
        { di: 'si, pero llego un poco mas tarde', now: at(VIE, 9, 30), espera: { evento: ['se_retrasa'], estado: 'viva', dia: [VIE], precision: 'dia' } },
        { di: 'yo te aviso cuando vaya', now: at(VIE, 9, 31), espera: { evento: ['promete_avisar'], estado: 'viva', dia: [VIE], precision: 'dia', confirmada: 1, planSolo: ['vence'], todasDeVersion: true, responde: 'avisas' } },
    ]);
    await caso('C', 'sábado 5 pm → "yo te aviso la hora": el sábado sigue', '5210000000033', [
        { di: 'voy el sábado a las 5', now: at(JUE, 11, 0), espera: { estado: 'viva', dia: [SAB], precision: 'hora' } },
        { di: 'el sábado sí, yo te aviso la hora', now: at(JUE, 11, 5), espera: { evento: ['promete_avisar', 'agenda_o_cambio'], estado: 'viva', dia: [SAB], precision: 'dia', planEn: SAB, todasDeVersion: true, vendedor: 'hora', trazaCambio: 'Hora: 5 pm → abierta' } },
    ]);
    await caso('D', 'viernes-sábado, el viernes → "hoy no puedo": el sábado sigue vivo', '5210000000034', [
        { di: 'paso entre viernes y sábado', now: at(JUE, 11, 0), espera: { estado: 'viva', dia: [VIE, SAB] } },
        { di: 'hoy no puedo', now: at(VIE, 10, 0), espera: { evento: ['se_complico', 'promete_avisar', 'agenda_o_cambio'], estado: 'viva', dia: [SAB], sinPlanEn: VIE, planEn: SAB, todasDeVersion: true, vendedor: 'actualizada' } },   // la IA puede leerlo de 3 formas; las 3 deben llegar a la MISMA realidad
    ]);
    await caso('D2', 'viernes-sábado, el viernes → "se me atravesó un imprevisto": NO se destruye la ventana', '5210000000035', [
        { di: 'paso entre viernes y sábado', now: at(JUE, 11, 0), espera: { estado: 'viva', dia: [VIE, SAB] } },
        { di: 'se me atravesó un imprevisto', now: at(VIE, 10, 0), espera: { evento: ['se_complico', 'incierto', 'promete_avisar'], estado: 'viva', dia: [VIE, SAB], planEn: SAB } },
    ]);
    await caso('E', 'ventana vencida → "no pude pero sí me interesa": pide nuevo cuándo y ESCALA', '5210000000036', [
        { di: 'voy el domingo', now: at(JUE, 11, 0), espera: { estado: 'viva', dia: [DOM] } },
        { vencer: at(DOM, 15, 30) },
        { lote: 'Hola Juan, ¿sí alcanzaste a pasar ayer o todavía tienes pensado venir a ver el Nissan Sentra Sr 2023?' },
        { di: 'no pude, pero sí me interesa el auto', now: at(LUN, 9, 40), espera: { evento: ['se_complico'], estado: 'viva', vendedor: 'sigue interesado', responde: 'reagend' } },
        { di: 'el miércoles a las 5', now: at(LUN, 9, 45), espera: { evento: ['agenda_o_cambio'], estado: 'viva', dia: ['2026-09-30'], precision: 'hora', todasDeVersion: true } },
    ]);
    await caso('F', 'sábado → "mejor domingo 12" (el domingo TERRA cierra a las 3): misma visita, plan del sábado muerto, plan del domingo creado', '5210000000037', [
        { di: 'voy el sábado', now: at(JUE, 11, 0), espera: { estado: 'viva', dia: [SAB] } },
        { di: 'mejor el domingo a las 12', now: at(JUE, 11, 5), espera: { evento: ['agenda_o_cambio'], estado: 'viva', dia: [DOM], sinPlanEn: SAB, planEn: DOM, todasDeVersion: true, vendedor: 'movida' } },
    ]);
    await caso('G', 'hoy sin hora → "ya voy": en camino y muere la espera normal', '5210000000038', [
        { di: 'paso hoy', now: at(VIE, 10, 0), espera: { estado: 'viva', dia: [VIE], precision: 'dia' } },
        { di: 'ya voy para allá', now: at(VIE, 13, 0), espera: { evento: ['ya_voy'], estado: 'en_camino', planSolo: ['vence'], vendedor: 'camino' } },
    ]);
    await caso('H', 'viernes-sábado → "ya voy" el viernes: la ventana se estrecha a HOY', '5210000000039', [
        { di: 'paso entre viernes y sábado', now: at(JUE, 11, 0), espera: { estado: 'viva', dia: [VIE, SAB] } },
        { di: 'ya voy saliendo para allá', now: at(VIE, 12, 0), espera: { evento: ['ya_voy'], estado: 'en_camino', dia: [VIE], sinPlanEn: SAB } },
    ]);
    await caso('I', 'sábado 5 pm → "sí, el sábado nos vemos": NO pierde la hora', '5210000000040', [
        { di: 'voy el sábado a las 5', now: at(JUE, 11, 0), espera: { estado: 'viva', dia: [SAB], precision: 'hora' } },
        { di: 'sí, el sábado nos vemos', now: at(JUE, 18, 0), espera: { evento: ['confirma', 'agenda_o_cambio'], estado: 'viva', dia: [SAB], precision: 'hora', sinVendedor: true } },
    ]);
    await caso('J', '"no sé qué día pueda, yo te aviso": ahí sí murió todo el cuándo', '5210000000041', [
        { di: 'voy el sábado a las 5', now: at(JUE, 11, 0), espera: { estado: 'viva', dia: [SAB] } },
        { di: 'no sé qué día pueda, yo te aviso', now: at(JUE, 11, 5), espera: { evento: ['promete_avisar', 'se_complico'], estado: 'pospuesta', planSolo: [], vendedor: 'sin fecha' } },
    ]);
    console.log('\nRESULTADO: ' + (total - fallas) + '/' + total + ' verificaciones OK' + (fallas ? ' · ' + fallas + ' FALLAS' : '')); process.exit(fallas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
