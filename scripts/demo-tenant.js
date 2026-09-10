#!/usr/bin/env node
// scripts/demo-tenant.js — crea (idempotente) el tenant de prueba PRUEBAS# (8888888888) y su wa_sessions 'vinculado/demo'.
// Uso: cd /Users/Shared/PRUEBAS && node scripts/demo-tenant.js [--prueba]  (--prueba: además ejecuta un ciclo delegar→botón→respuesta→soltar→reset local y lo limpia)
require('fs').readFileSync('.env', 'utf8').split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) process.env[l.slice(0, i).trim()] = process.env[l.slice(0, i).trim()] || l.slice(i + 1).trim(); });
const { query } = require('../lib/seb/db.js');
const DEMO = require('../lib/seb/demo.js');
(async () => {
    const t = await DEMO.asegurarTenantDemo();
    const w = await query('SELECT estado, motivo FROM wa_sessions WHERE tenant_id=?', [Number(t.id)]);
    console.log('tenant demo:', { id: Number(t.id), telefono: t.telefono, nombre: t.nombre, activo: Number(t.activo), config_json: t.config_json, esDemo: DEMO.esDemo(t) }, 'wa_sessions:', w[0] || null);
    if (process.argv.includes('--prueba')) {
        const tel = DEMO.DEMO_COMPRADOR;
        const auto = (await query("SELECT id, fyradrive_web_id, marca, modelo, anio FROM inventario_autos WHERE estado='activo' ORDER BY id DESC LIMIT 1"))[0];
        const nom = [auto.marca, auto.modelo, auto.anio].filter(Boolean).join(' ');
        console.log('delegar →', await DEMO.delegar({ tenant: t, tel: '8112345678', auto_id: auto.fyradrive_web_id || auto.id, auto_nombre: nom, nombre: 'Comprador Prueba', opener: 'Hola, soy el asistente de PRUEBAS# para el ' + nom }));
        console.log('salida  →', await DEMO.salida(t, tel, 'tarjeta de precio simulada', 'asistente'));
        console.log('respond →', await DEMO.responder({ tenant: t, tel, texto: 'me interesa, ¿tiene fotos?' }));
        console.log('manual  →', await DEMO.salida(t, tel, 'claro, van', 'dueno'));
        const U = require('../lib/seb/universo.js');
        console.log('foco    →', await U.focoDe(Number(t.id), tel));
        console.log('chats   →', await query("SELECT channel_thread_id, tenant_id, telefono, nombre, ult_texto, ult_dir FROM conversaciones WHERE tenant_id=?", [Number(t.id)]));
        console.log('msgs    →', (await query("SELECT direccion, emisor, texto, ai_generated FROM mensajes WHERE conversacion_id IN (SELECT id FROM conversaciones WHERE tenant_id=?) ORDER BY ts, id", [Number(t.id)])).map(m => m.direccion + ' ' + m.emisor + ' ai=' + m.ai_generated + ' «' + m.texto + '»'));
        console.log('ca      →', await query("SELECT tenant_id, tel, car_id, car_nombre, hasta FROM chats_activos WHERE tenant_id=?", [Number(t.id)]));
        console.log('soltar  →', await DEMO.soltar({ tenant: t, tel }));
        console.log('ca post →', await query("SELECT tenant_id, tel, hasta FROM chats_activos WHERE tenant_id=?", [Number(t.id)]));
        console.log('t0 tocado? →', await query("SELECT COUNT(*) n FROM conversaciones WHERE telefono=? AND (tenant_id=0 OR tenant_id IS NULL) AND ult_msg_ts > ?", [tel, Date.now() - 120000]));
        console.log('reset   →', await DEMO.reset(t));
        console.log('quedan  →', await query("SELECT (SELECT COUNT(*) FROM conversaciones WHERE tenant_id=?) c, (SELECT COUNT(*) FROM delegaciones WHERE tenant_id=?) d, (SELECT COUNT(*) FROM chats_activos WHERE tenant_id=?) ca", [Number(t.id), Number(t.id), Number(t.id)]));
    }
    process.exit(0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
