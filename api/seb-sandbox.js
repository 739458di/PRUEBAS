// api/seb-sandbox.js
// SANDBOX de Seb — un chat de pruebas con EL MISMO CEREBRO que WhatsApp.
// El owner escribe como comprador y Seb contesta con el pipeline REAL:
//   bursts 0 → OPENER · bursts 1 → CONTINUACIÓN · bursts 2+ → ETAPA 3 → cerebro (Sonnet).
// La conversación vive en las tablas reales (conversaciones/mensajes) bajo un teléfono
// ficticio — cero validez de negocio: excluido del ghosting y jamás toca WhatsApp.
// "Reiniciar" borra todo y vuelve a cero al instante.
//
// Acciones (POST salvo autos):
//   GET  ?action=autos                → lista de autos activos (para simular el anuncio)
//   POST {action:'reset'}             → borra la conversación sandbox completa
//   POST {action:'mensaje', texto, auto_ad?} → guarda el mensaje del "comprador", corre el
//        cerebro y devuelve { etapa, segmentos, fotos, pin, escala, motivo }

const { query, run } = require('../lib/seb/db.js');
const { entender } = require('../lib/seb/clasificador.js');
const { pensar } = require('../lib/seb/loop.js');
const { responder: responderOpener, necesitaCerebro, nombreReal, saludoHora } = require('../lib/seb/opener.js');
const { responderCont } = require('../lib/seb/continuacion.js');
const { responderEtapa3 } = require('../lib/seb/etapa3.js');
// ══ PARIDAD (orden owner): el cerebro de citas/match/recordatorios es UNO SOLO —
// lib/seb/citas-vivas.js — compartido tal cual entre este sandbox y WhatsApp REAL.
const { parseHora, resolverCitaTs, mismaHora, mismaFecha, planRecordatorios, clasificarVendedor, clasificarCancelacion } = require('../lib/seb/citas-vivas.js');

// CARRILES: el panel del owner usa …000; las verificaciones automáticas de Claude
// usan …001 (carril 'pruebas') para JAMÁS pisar/resetear la conversación del owner.
// Vercel atiende una invocación a la vez por instancia → reasignar por request es seguro.
let SANDBOX_TEL = '5210000000000';
let THREAD = 'whatsapp:' + SANDBOX_TEL;
const NOMBRE_COMPRADOR = 'Carlos';   // nombre humano común → Seb lo usa como en la vida real

async function ensureConv() {
    const r = await query("SELECT id FROM conversaciones WHERE channel_thread_id=?", [THREAD]);
    if (r.length) return r[0].id;
    const ins = await run(
        "INSERT INTO conversaciones (channel_thread_id, telefono, nombre, ult_texto, ult_dir, ult_msg_ts, no_leidos, is_dueno_chat, source, created_at) VALUES (?,?,?,?,?,?,0,0,'sandbox',?)",
        [THREAD, SANDBOX_TEL, '🧪 ' + NOMBRE_COMPRADOR + ' (Sandbox)', '', 'in', Date.now(), Date.now()]);
    return Number(ins.lastInsertRowid || ins.lastInsertRowid === 0 ? ins.lastInsertRowid : 0) ||
        (await query("SELECT id FROM conversaciones WHERE channel_thread_id=?", [THREAD]))[0].id;
}

// ══════════════════════════════════════════════════════════════════════
// LADO VENDEDOR + MATCH + LÍNEA DEL TIEMPO (orden owner 2026-07-10):
// el vendedor contesta la solicitud → IA interpreta (afirma|negativo|propone_hora)
// → si afirma hay MATCH y se planean los RECORDATORIOS estratégicos (víspera,
// día D, 1h antes — proporcionales si es el mismo día). El owner adelanta un
// RELOJ SIMULADO (como cron de película) y los recordatorios van cayendo.
// ══════════════════════════════════════════════════════════════════════
const MTY_OFF = 6 * 3600000;                       // Monterrey = UTC-6
const sh = ts => new Date(ts - MTY_OFF);           // reloj corrido (leer con getUTC*)
const DIAS_SEM = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
async function ensureMatchTable() {
    await run(`CREATE TABLE IF NOT EXISTS sandbox_match (
        carril TEXT PRIMARY KEY, estado TEXT, auto_id INTEGER, auto_nombre TEXT, dueno TEXT,
        fecha TEXT, hora TEXT, cita_ts INTEGER, match_ts INTEGER, sim_ts INTEGER,
        recordatorios TEXT, updated INTEGER)`);
    await run("ALTER TABLE sandbox_match ADD COLUMN prop_fecha TEXT").catch(() => {});
    await run("ALTER TABLE sandbox_match ADD COLUMN prop_hora TEXT").catch(() => {});
    await run("ALTER TABLE sandbox_match ADD COLUMN avisos_vendedor TEXT").catch(() => {});
}
let seq = 0;
async function guardarMsg(convId, direccion, texto, tipo) {
    const ts = Date.now() + (seq++ % 50);   // ts únicos y en orden dentro del request
    await run(
        "INSERT INTO mensajes (conversacion_id, msg_id, ts, direccion, emisor, texto, tipo, ai_generated, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [convId, 'sbx_' + ts + '_' + Math.random().toString(36).slice(2, 6), ts, direccion,
         direccion === 'out' ? 'SRS010904' : NOMBRE_COMPRADOR, texto, tipo || 'text', direccion === 'out' ? 1 : 0, ts]);
    await run("UPDATE conversaciones SET ult_texto=?, ult_dir=?, ult_msg_ts=? WHERE id=?",
        [String(texto).slice(0, 120), direccion, ts, convId]);
    // FIDELIDAD: el cerebro (Sonnet/expediente) lee el historial de wa_messages —
    // sin esto, Sonnet ve la conversación vacía y saluda como primer contacto.
    if (texto) await run(
        "INSERT INTO wa_messages (telefono, nombre, mensaje, tipo, direccion, timestamp, mensaje_id, ai_generated, platform, origen_envio) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [SANDBOX_TEL, direccion === 'in' ? NOMBRE_COMPRADOR : null, texto, tipo || 'text', direccion,
         Math.floor(ts / 1000), 'sbx_' + ts, direccion === 'out' ? 1 : 0, 'sandbox', 'sandbox']).catch(() => {});
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const action = (req.query && req.query.action) || (req.body && req.body.action) || '';
        const carril = (req.body && req.body.carril) || (req.query && req.query.carril) || '';
        // Carriles: owner = …000 · pruebas/pruebas1-8 = …0001-…0008 (tests paralelos de
        // Claude sin pisarse entre sí ni tocar al owner; todos excluidos del ghosting).
        const mLane = String(carril).match(/^pruebas([1-8])?$/);
        SANDBOX_TEL = mLane ? ('521000000000' + (mLane[1] || '1')) : '5210000000000';
        THREAD = 'whatsapp:' + SANDBOX_TEL;

        // ── Autos activos (para el selector "vengo del anuncio de…") ──
        if (action === 'autos') {
            const autos = await query("SELECT id, marca, modelo, anio, precio FROM inventario_autos WHERE estado='activo' ORDER BY marca, modelo");
            return res.status(200).json({ ok: true, autos: autos.map(a => ({ id: a.id, nombre: [a.marca, a.modelo, a.anio].filter(Boolean).join(' '), precio: a.precio })) });
        }

        // ── RESET: borrar TODO lo del sandbox (instantáneo, sin validez de data) ──
        if (action === 'reset' && req.method === 'POST') {
            const convId = await ensureConv();
            await run("DELETE FROM mensajes WHERE conversacion_id=?", [convId]);
            await run("UPDATE conversaciones SET ult_texto='', ult_dir='in', ult_msg_ts=? WHERE id=?", [Date.now(), convId]);
            await run("DELETE FROM wa_messages WHERE telefono=?", [SANDBOX_TEL]).catch(() => {});
            await run("DELETE FROM wa_conversations WHERE telefono=?", [SANDBOX_TEL]).catch(() => {});
            await run("DELETE FROM ad_por_telefono WHERE telefono=?", [SANDBOX_TEL]).catch(() => {});
            await run("DELETE FROM seguimientos_ghost WHERE telefono=?", [SANDBOX_TEL]).catch(() => {});
            await run("DELETE FROM seb_queue WHERE telefono=?", [SANDBOX_TEL]).catch(() => {});
            await run("DELETE FROM sandbox_match WHERE carril=?", [carril || 'owner']).catch(() => {});
            return res.status(200).json({ ok: true, reset: true });
        }

        // ── MENSAJE del comprador → EL MISMO PIPELINE que WhatsApp ──
        if (action === 'mensaje' && req.method === 'POST') {
            const texto = String(req.body.texto || '').trim();
            if (!texto) return res.status(400).json({ ok: false, error: 'texto requerido' });
            const autoAd = Number(req.body.auto_ad || 0) || null;
            const convId = await ensureConv();

            // Simular el contexto de anuncio (como cuando el comprador da click al ad)
            let adCtx = null;
            if (autoAd) {
                const a = await query("SELECT marca, modelo, anio, precio FROM inventario_autos WHERE id=?", [autoAd]);
                if (a.length) {
                    adCtx = `Fyradrive | 🚘 ${String(a[0].marca || '').toUpperCase()} ${String(a[0].modelo || '').toUpperCase()} ${a[0].anio}\n💵 $${Number(a[0].precio || 0).toLocaleString('en-US')}`;
                    await run("INSERT INTO ad_por_telefono (telefono, ad_context, updated_at) VALUES (?,?,?) ON CONFLICT(telefono) DO UPDATE SET ad_context=excluded.ad_context, updated_at=excluded.updated_at",
                        [SANDBOX_TEL, adCtx, Date.now()]).catch(() => {});
                }
            } else {
                const prev = await query("SELECT ad_context FROM ad_por_telefono WHERE telefono=?", [SANDBOX_TEL]);
                if (prev.length) adCtx = prev[0].ad_context;
            }

            await guardarMsg(convId, 'in', texto, 'text');

            // 📝#7: con MATCH ACTIVO, primero se interpreta si el comprador CANCELA →
            // "cita cancelada", muere el flujo de recordatorios y se avisa al vendedor.
            try {
                await ensureMatchTable();
                const mAct = await query("SELECT * FROM sandbox_match WHERE carril=? AND estado='match'", [carril || 'owner']);
                if (mAct.length) {
                    const MC = mAct[0];
                    // "ya voy en camino" (respuesta al aviso de salida) → acuse y listo.
                    const tEC = String(texto).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
                    if (/(ya voy|voy en camino|en camino|ya salgo|saliendo|voy para alla|alla voy|ya merito llego|ya casi llego)/.test(tEC) && !/(no |cancel)/.test(tEC)) {
                        const ack = 'Va, aquí te esperamos 👍';
                        await guardarMsg(convId, 'out', ack, 'text');
                        // 📝#12: ACREDITAR el camino al vendedor — ahora sí puede moverse.
                        const avisoCamino = `${MC.dueno}, listo — el comprador ya va en camino 👍 Puedes ir preparando el ${MC.auto_nombre}`;
                        const avisosEC = (() => { try { return JSON.parse(MC.avisos_vendedor || '[]'); } catch (e) { return []; } })();
                        avisosEC.push(avisoCamino);
                        await run("UPDATE sandbox_match SET avisos_vendedor=?, updated=? WHERE carril=?", [JSON.stringify(avisosEC), Date.now(), carril || 'owner']);
                        return res.status(200).json({ ok: true, etapa: 'CITA', ruta: 'en_camino_ack', universo: 'cita', segmentos: [ack], vendedor_aviso: avisoCamino });
                    }
                    const cc = await clasificarCancelacion(texto, { fecha: MC.fecha, hora: MC.hora });
                    if (cc.cancela) {
                        const artC0 = /^(hoy|manana|mañana|pasado)/i.test(String(MC.fecha)) ? '' : 'el ';
                        const avisoV = `Qué tal ${MC.dueno}, una disculpa — el comprador canceló la cita de ${artC0}${MC.fecha} a las ${MC.hora}. Yo te aviso si se reagenda 👍`;
                        const avisosPrev = (() => { try { return JSON.parse(MC.avisos_vendedor || '[]'); } catch (e) { return []; } })();
                        avisosPrev.push(avisoV);
                        await run("UPDATE sandbox_match SET estado='cancelada', avisos_vendedor=?, updated=? WHERE carril=?", [JSON.stringify(avisosPrev), Date.now(), carril || 'owner']);
                        const segsCanc = [
                            'Va, sin tema — cita cancelada ❌',
                            'Cualquier cosa aquí ando para reagendarte cuando gustes 👍'
                        ];
                        for (const sx of segsCanc) await guardarMsg(convId, 'out', sx, 'text');
                        const artC = /^(hoy|manana|mañana|pasado)/i.test(String(MC.fecha)) ? '' : 'el ';
                        return res.status(200).json({
                            ok: true, etapa: 'CITA', ruta: 'cancelacion', universo: 'cita_cancelada',
                            segmentos: segsCanc,
                            cancelacion: { vendedor_aviso: `Qué tal ${MC.dueno}, una disculpa — el comprador canceló la cita de ${artC}${MC.fecha} a las ${MC.hora}. Yo te aviso si se reagenda 👍` },
                            silencio: false
                        });
                    }
                }
            } catch (e) { console.error('[sandbox] cancelacion:', e.message); }

            // Estado de la conversación (idéntico a opener_auto)
            const mr = await query("SELECT direccion, texto, ts FROM mensajes WHERE conversacion_id=? ORDER BY ts ASC, id ASC", [convId]);
            const mensajes = mr.map(m => ({ mensaje: m.texto || '', direccion: m.direccion, ts: Number(m.ts) }));
            let bursts = 0, prevDir = null, lastOutIdx = -1;
            mensajes.forEach((m, i) => { if (m.direccion === 'out') { if (prevDir !== 'out') bursts++; lastOutIdx = i; } prevDir = m.direccion; });
            const histCorto = mensajes.slice(-8).map(h => ({ direccion: h.direccion, mensaje: h.mensaje }));
            const entrantes = mensajes.filter(m => m.direccion === 'in');
            // CORTE POR ESCALA (🚩 training 9-12): al escalar, Seb no manda nada → la
            // ventana de "no contestados" acumulaba la pregunta escalada (garantía) y
            // re-escalaba TODO para siempre. La escalada ya es del owner: las preguntas
            // nuevas se atienden desde DESPUÉS de ese corte.
            let corteEscala = 0;
            try {
                const esc = await query("SELECT ts FROM sandbox_turnos WHERE carril=? AND ruta='escala' ORDER BY id DESC LIMIT 1", [carril || 'owner']);
                if (esc.length) corteEscala = Number(esc[0].ts) || 0;
            } catch (e) { }
            const textoFamilia = (bursts === 0)
                ? entrantes.filter(m => m.ts > corteEscala).map(e => e.mensaje).join(' ')
                : mensajes.slice(lastOutIdx + 1).filter(m => m.direccion === 'in' && m.ts > corteEscala).map(m => m.mensaje).join(' ');
            const mensajeCerebro = adCtx ? '[DESC: ' + adCtx + ']\n' + textoFamilia : textoFamilia;

            const clasif = await entender({ mensaje: mensajeCerebro, historial: histCorto, estado: {} });

            // AUTO ACTIVO con memoria (fidelidad con producción): si este mensaje no
            // menciona el auto, se usa el último resuelto (wa_conversations.auto_id_activo).
            let autoActivo = clasif.auto_id || null;
            if (autoActivo) {
                await run("UPDATE wa_conversations SET auto_id_activo=?, updated_at=? WHERE telefono=?", [autoActivo, Date.now(), SANDBOX_TEL]).catch(() => {});
                await run("INSERT INTO wa_conversations (telefono, auto_id_activo, updated_at) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM wa_conversations WHERE telefono=?)", [SANDBOX_TEL, autoActivo, Date.now(), SANDBOX_TEL]).catch(() => {});
            } else {
                const wc = await query("SELECT auto_id_activo FROM wa_conversations WHERE telefono=?", [SANDBOX_TEL]).catch(() => []);
                if (wc.length && wc[0].auto_id_activo) autoActivo = Number(wc[0].auto_id_activo) || null;
            }

            let out = null; let etapa = ''; let ruta = ''; let universo = '';

            if (bursts === 0) {
                etapa = 'OPENER';
                if (clasif.auto_id && !clasif.escalar && necesitaCerebro(textoFamilia)) {
                    try { const p = await pensar({ telefono: SANDBOX_TEL, mensaje: textoFamilia, clasificacion: clasif, estado: {} }); if (p && p.ok && p.borrador) out = { segmentos: String(p.borrador||'').split(/\|\|SEQ\|\||\n\s*\n/).map(x=>x.trim()).filter(Boolean), tipo: 'cerebro' }; } catch (e) { }
                }
                if (!out) {
                    const op = await responderOpener({ texto: textoFamilia, nombre: NOMBRE_COMPRADOR, auto_id: clasif.auto_id, intencion: clasif.intencion_principal });
                    if (op && op.segmentos && op.segmentos.length) out = op;
                }
                if (!out && clasif.escalar) out = { escala: true, motivo: 'vendedor / fuera de alcance' };
                if (!out && clasif.auto_id) {
                    try { const p = await pensar({ telefono: SANDBOX_TEL, mensaje: textoFamilia, clasificacion: clasif, estado: {} }); if (p && p.ok && p.borrador) out = { segmentos: String(p.borrador||'').split(/\|\|SEQ\|\||\n\s*\n/).map(x=>x.trim()).filter(Boolean), tipo: 'cerebro' }; } catch (e) { }
                }
                if (!out) {
                    const intOk = ['info_inicial', 'disponibilidad', 'estado_auto', 'cotizar_credito', 'cita_ubicacion', 'precio_negociacion', 'fotos_videos', 'otro'].includes(clasif.intencion_principal);
                    if (intOk && !clasif.escalar) {
                        const nm = nombreReal(NOMBRE_COMPRADOR);
                        out = { segmentos: [`Qué tal${nm ? ' ' + nm : ''} ${saludoHora()}!`, 'Mucho gusto, mi nombre es Sebastián Romero, para servirte', 'Claro que sí, de qué auto buscas información? Para poderte ayudar'], tipo: 'opener_sin_auto' };
                    }
                }
                ruta = !out ? 'silencio' : out.escala ? 'escala' : out.tipo === 'cerebro' ? 'cerebro' : out.tipo === 'opener_sin_auto' ? 'banco_opener_universal' : 'banco_opener';
            } else if (bursts === 1) {
                etapa = 'CONTINUACIÓN';
                const cont = await responderCont({ texto: textoFamilia, nombre: NOMBRE_COMPRADOR, auto_id: autoActivo || clasif.auto_id, enganche: clasif.datos && clasif.datos.enganche, plazo: clasif.datos && clasif.datos.plazo_meses, intencion: clasif.intencion_principal, conv_id: convId, clasif });
                // DOCTRINA: la continuación también escala (momentos de gol / fuera de lista blanca).
                if (cont && cont.escalar) { out = { escala: true, motivo: cont.motivo, puente: cont.puente || null }; ruta = cont.puente ? 'escala_puente' : 'escala'; }
                else if (cont && cont.silencio) { out = { silencio: true, motivo: 'cortesía — silencio' }; ruta = 'silencio'; }
                else if (cont && cont.segmentos && cont.segmentos.length) { out = cont; ruta = 'banco_continuacion'; universo = cont.universo || ''; }
                else { out = { escala: true, motivo: 'fuera de la lista blanca (continuación, no claro) — lo ves tú' }; ruta = 'escala'; }
            } else {
                etapa = 'ETAPA 3';
                const e3 = await responderEtapa3({ texto: textoFamilia, auto_id: autoActivo, conv_id: convId, clasif });
                universo = (e3 && e3.universo) || '';
                if (e3 && e3.escalar) { out = { escala: true, motivo: e3.motivo, puente: e3.puente || null }; ruta = e3.puente ? 'escala_puente' : 'escala'; }
                else if (e3 && e3.silencio) { out = { silencio: true, motivo: e3.motivo }; ruta = 'silencio'; }
                else if (e3 && e3.segmentos && e3.segmentos.length) { out = e3; ruta = 'banco_etapa3'; }
                else {
                    // DOCTRINA: fuera de la lista blanca JAMÁS improvisa Sonnet → escala (como producción).
                    out = { escala: true, motivo: 'fuera de la lista blanca (no claro / requiere tu criterio)' };
                    ruta = 'escala';
                }
            }

            // Registrar lo que Seb "mandó" (para que el estado avance igual que en WhatsApp)
            let segmentos = [], fotos = null, pin = null, citaDueno = null;
            if (out && out.escala && out.puente) {
                // ESCALA CON PUENTE (regla de oro): el comprador SÍ recibe el puente ("dame un
                // momento y te mando…"), y en paralelo se escala al humano para lo que sigue.
                segmentos = [out.puente];
                await guardarMsg(convId, 'out', out.puente, 'text');
            } else if (out && out.escala) {
                // escala pura sin puente: en la vida real Seb se queda callado y lo ves tú
            } else if (out && out.segmentos) {
                segmentos = out.segmentos;
                for (const s of segmentos) await guardarMsg(convId, 'out', s, 'text');
                if (out.fotos && out.fotos.length) { fotos = out.fotos; await guardarMsg(convId, 'out', '', 'image'); }
                if (out.ubicacion_auto_id) {
                    const pe = await query("SELECT name FROM punto_envio WHERE auto_id=?", [Number(out.ubicacion_auto_id)]);
                    pin = { nombre: (pe.length && pe[0].name) || 'Punto de venta' };
                    await guardarMsg(convId, 'out', '', 'location');
                }
                // CITA CONFIRMADA ✅ → en el SANDBOX se simula AUTOMÁTICO el aviso al dueño
                // (en la vida real es COPILOTO: el ✅ sale al aprobar y ahí dispara el trigger).
                if (out.cita_confirmada && out.cita_datos) {
                    const cd = out.cita_datos;
                    let autoNom = 'tu auto', duenoNom = '';
                    if (autoActivo) {
                        const a = await query("SELECT marca, modelo, anio, dueno_nombre FROM inventario_autos WHERE id=?", [autoActivo]).catch(() => []);
                        if (a.length) { autoNom = [a[0].marca, a[0].modelo, a[0].anio].filter(Boolean).join(' '); duenoNom = a[0].dueno_nombre || ''; }
                    }
                    // "el sábado" pero "mañana"/"hoy" van SIN "el".
                    const art = /^(hoy|manana|mañana|pasado)/i.test(cd.fecha || '') ? '' : 'el ';
                    const cuando = [art + (cd.fecha || ''), cd.hora ? 'a las ' + cd.hora : ''].filter(Boolean).join(' ').trim();
                    const dn = String(duenoNom || '').replace(/\s*-\s*$/, '').trim();   // limpia "Sebastian -"
                    // 📝 retro owner: la solicitud SIEMPRE dice EL LUGAR del auto (su punto).
                    let lugarCita = cd.lugar || null;
                    if (!lugarCita && autoActivo) {
                        try { const { datosPunto } = require('../lib/seb/continuacion.js'); const dpM = await datosPunto(autoActivo); lugarCita = dpM && dpM.dir ? dpM.dir : null; } catch (e) { }
                    }
                    citaDueno = {
                        auto: autoNom,
                        dueno: dn || 'Vendedor',
                        cuando,
                        lugar: lugarCita || null,
                        mensaje: `Qué tal${dn ? ' ' + dn : ''}, tengo cita para ver tu ${autoNom} ${cuando}${lugarCita ? ' ahí en ' + lugarCita : ''}. Me confirmas que esté disponible porfavor?`
                    };
                    // Persistir la SOLICITUD para el lado vendedor (match + línea del tiempo).
                    // MATCH DIRECTO: si el comprador confirmó EXACTAMENTE lo que el dueño ya
                    // propuso (contrapropuesta), el dueño NO re-confirma → match de una.
                    try {
                        await ensureMatchTable();
                        const laneKey = carril || 'owner';
                        const citaTs = resolverCitaTs(cd.fecha, cd.hora);
                        const prevM = await query("SELECT * FROM sandbox_match WHERE carril=?", [laneKey]);
                        const P = prevM[0];
                        if (P && P.estado === 'contrapropuesta' && mismaHora(P.prop_hora || P.hora, cd.hora) && mismaFecha(P.prop_fecha || P.fecha, cd.fecha)) {
                            const matchTs = Date.now();
                            const ctx = { nombre: NOMBRE_COMPRADOR, dueno: P.dueno, auto: autoNom, hora: cd.hora };
                            const recs = planRecordatorios(matchTs, citaTs, ctx);
                            await run("UPDATE sandbox_match SET estado='match', fecha=?, hora=?, cita_ts=?, match_ts=?, sim_ts=?, recordatorios=?, updated=? WHERE carril=?",
                                [cd.fecha || '', cd.hora || '', citaTs, matchTs, matchTs, JSON.stringify(recs), Date.now(), laneKey]);
                            citaDueno.match_directo = { fecha: cd.fecha, hora: cd.hora, auto: autoNom, dueno: P.dueno, cita_ts: citaTs, match_ts: matchTs, sim_ts: matchTs, recordatorios: recs };
                            citaDueno.vendedor_aviso = `Listo ${P.dueno}, el comprador confirmó — quedamos ${cuando} ✅`;
                            const avisosP = (() => { try { return JSON.parse(P.avisos_vendedor || '[]'); } catch (e) { return []; } })();
                            avisosP.push(citaDueno.vendedor_aviso);
                            await run("UPDATE sandbox_match SET avisos_vendedor=? WHERE carril=?", [JSON.stringify(avisosP), laneKey]);
                            // 📝 señal de match al comprador ("ahí nos vemos").
                            citaDueno.comprador_aviso = `Listo, el dueño particular confirmó ✅ Ahí nos vemos ${cuando} — te atendemos nosotros junto con el dueño 👍`;
                            await guardarMsg(convId, 'out', citaDueno.comprador_aviso, 'text');
                        } else {
                            await run(`INSERT INTO sandbox_match (carril, estado, auto_id, auto_nombre, dueno, fecha, hora, cita_ts, match_ts, sim_ts, recordatorios, updated)
                                       VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,?)
                                       ON CONFLICT(carril) DO UPDATE SET estado='solicitud', auto_id=excluded.auto_id, auto_nombre=excluded.auto_nombre,
                                         dueno=excluded.dueno, fecha=excluded.fecha, hora=excluded.hora, cita_ts=excluded.cita_ts,
                                         match_ts=NULL, sim_ts=NULL, recordatorios=NULL, updated=excluded.updated`,
                                [laneKey, 'solicitud', autoActivo || null, autoNom, dn || 'Vendedor', cd.fecha || '', cd.hora || '', citaTs, Date.now()]);
                        }
                    } catch (e) { console.error('[sandbox] match upsert:', e.message); }
                }
            }

            // ── CAJA NEGRA: cada turno queda registrado con su RUTA interna (para el
            // training con 🚩 — diagnóstico instantáneo sin arqueología en la base) ──
            let turnoId = null;
            try {
                await run(`CREATE TABLE IF NOT EXISTS sandbox_turnos (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, carril TEXT, texto_in TEXT, contexto TEXT,
                    etapa TEXT, intencion TEXT, universo TEXT, ruta TEXT, motivo TEXT, auto_id INTEGER,
                    respuesta TEXT, flag INTEGER DEFAULT 0, flag_nota TEXT, flag_ts INTEGER, procesado INTEGER DEFAULT 0)`);
                const ins = await run(
                    "INSERT INTO sandbox_turnos (ts, carril, texto_in, contexto, etapa, intencion, universo, ruta, motivo, auto_id, respuesta) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    [Date.now(), carril || 'owner', texto, JSON.stringify(histCorto), etapa, clasif.intencion_principal || '', universo, ruta,
                     (out && out.motivo) || '', autoActivo || null,
                     JSON.stringify({ segmentos, fotos: fotos ? fotos.length : 0, pin: !!pin, escala: !!(out && out.escala) })]);
                turnoId = Number(ins.lastInsertRowid) || null;
            } catch (e) { }

            return res.status(200).json({
                ok: true, etapa,
                intencion: clasif.intencion_principal,
                auto_id: autoActivo || null,
                segmentos, fotos, pin, cita_dueno: citaDueno,
                escala: !!(out && out.escala),
                puente: (out && out.puente) || null,
                silencio: (!out || !!out.silencio) && !(out && out.escala && out.puente),
                motivo: (out && out.motivo) || (!out ? 'ningún banco/cerebro aplicó — en WhatsApp Seb se queda callado' : null),
                ruta, universo, turno_id: turnoId
            });
        }

        // ══════════════ ⇄ HUMAN-IN-THE-LOOP: el owner escribe COMO SEB ══════════════
        // Se guarda como OUT en la conversación (sin correr el bot): el estado, el
        // sí-pelón y el cerrador SÍ leen estos mensajes (entiende lo que el owner dijo).
        if (action === 'mensaje_out' && req.method === 'POST') {
            const texto = String(req.body.texto || '').trim();
            if (!texto) return res.status(400).json({ ok: false, error: 'texto requerido' });
            const convId = await ensureConv();
            await guardarMsg(convId, 'out', texto, 'text');
            return res.status(200).json({ ok: true });
        }

        // ══════════════ ⇄ HABLAR COMO SEB EN EL PANEL DEL VENDEDOR ══════════════
        // Se persiste en avisos_vendedor (repinta al reabrir el panel), sin correr la IA.
        if (action === 'vendedor_out' && req.method === 'POST') {
            const texto = String(req.body.texto || '').trim();
            if (!texto) return res.status(400).json({ ok: false, error: 'texto requerido' });
            await ensureMatchTable();
            const laneKey = carril || 'owner';
            const rows = await query("SELECT * FROM sandbox_match WHERE carril=?", [laneKey]);
            const M = rows[0] || null;
            if (M) {
                const arr = (() => { try { return JSON.parse(M.avisos_vendedor || '[]'); } catch (e) { return []; } })();
                arr.push(texto);
                await run("UPDATE sandbox_match SET avisos_vendedor=?, updated=? WHERE carril=?", [JSON.stringify(arr), Date.now(), laneKey]);
            }
            // ══ LA SEÑAL DEL OWNER (human-in-the-loop): los dueños muchas veces confirman
            // POR TELÉFONO — el owner entra como Seb y escribe "cita confirmada" → se
            // EJECUTA el match real (confianza al comprador + recordatorios + timeline).
            // Su gemela: "cita cancelada" → mata el flujo y reacomoda con el comprador.
            const tS = texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
            if (M && /confirmad/.test(tS) && !/no |cancel/.test(tS) && ['solicitud', 'contrapropuesta', 'esperando_horario'].includes(M.estado) && M.cita_ts) {
                const matchTs = Date.now();
                const ctx = { nombre: NOMBRE_COMPRADOR, dueno: M.dueno, auto: M.auto_nombre, hora: M.hora };
                const recs = planRecordatorios(matchTs, Number(M.cita_ts), ctx);
                await run("UPDATE sandbox_match SET estado='match', match_ts=?, sim_ts=?, recordatorios=?, updated=? WHERE carril=?",
                    [matchTs, matchTs, JSON.stringify(recs), Date.now(), laneKey]);
                const artM = /^(hoy|manana|mañana|pasado)/i.test(String(M.fecha)) ? '' : 'el ';
                const aviso = `Listo ${NOMBRE_COMPRADOR}, el dueño particular ya confirmó ✅ Ahí nos vemos ${artM}${M.fecha} a las ${M.hora} — te atendemos nosotros junto con el dueño 👍`;
                const convId = await ensureConv();
                await guardarMsg(convId, 'out', aviso, 'text');
                return res.status(200).json({
                    ok: true, senal: 'confirmada', comprador_msgs: [aviso],
                    match: { fecha: M.fecha, hora: M.hora, auto: M.auto_nombre, dueno: M.dueno, cita_ts: Number(M.cita_ts), match_ts: matchTs, sim_ts: matchTs, recordatorios: recs }
                });
            }
            if (M && /cancelad/.test(tS) && ['match', 'solicitud', 'contrapropuesta', 'esperando_horario'].includes(M.estado)) {
                await run("UPDATE sandbox_match SET estado='cancelada', updated=? WHERE carril=?", [Date.now(), laneKey]);
                const artC = /^(hoy|manana|mañana|pasado)/i.test(String(M.fecha)) ? '' : 'el ';
                const compMsgs = [
                    `Oye ${NOMBRE_COMPRADOR}, una disculpa — surgió un imprevisto con el auto para ${artC}${M.fecha} a las ${M.hora}`,
                    'Te acomodo otro día u horario? Tú dime y lo dejamos en firme'
                ];
                const convId = await ensureConv();
                for (const sx of compMsgs) await guardarMsg(convId, 'out', sx, 'text');
                return res.status(200).json({ ok: true, senal: 'cancelada', comprador_msgs: compMsgs });
            }
            return res.status(200).json({ ok: true });
        }

        // ══════════════ LADO VENDEDOR: su respuesta a la solicitud ══════════════
        // IA interpreta → afirma (MATCH) | negativo | propone_hora (rebota al comprador).
        if (action === 'vendedor_responde' && req.method === 'POST') {
            const texto = String(req.body.texto || '').trim();
            if (!texto) return res.status(400).json({ ok: false, error: 'texto requerido' });
            await ensureMatchTable();
            const laneKey = carril || 'owner';
            const rows = await query("SELECT * FROM sandbox_match WHERE carril=?", [laneKey]);
            if (!rows.length || !rows[0].cita_ts) return res.status(200).json({ ok: false, error: 'no hay solicitud de cita activa' });
            const M = rows[0];
            let cls = await clasificarVendedor(texto, { fecha: M.fecha, hora: M.hora });
            // EN ESPERA DE HORARIO: lo que diga el dueño se lee PRIMERO como su horario
            // ("a las 5 está bien" venía saliendo como 'afirma' → matcheaba la cita VIEJA).
            if (M.estado === 'esperando_horario' && cls.accion !== 'negativo') {
                const tN = String(texto).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
                const mh = tN.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
                const mf = tN.match(/\b(hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|el \d{1,2})\b/);
                const horaX = (mh && Number(mh[1]) <= 23) ? (mh[1] + (mh[2] ? ':' + mh[2] : '') + (mh[3] || '')) : null;
                cls = {
                    accion: (horaX || mf || cls.fecha || cls.hora) ? 'propone_hora' : 'no_puede_hora',
                    fecha: cls.fecha || (mf ? mf[1] : null),
                    hora: cls.hora || horaX
                };
            }
            const convId = await ensureConv();
            const nombreComp = NOMBRE_COMPRADOR;

            if (cls.accion === 'afirma') {
                const matchTs = Date.now();
                const ctx = { nombre: nombreComp, dueno: M.dueno, auto: M.auto_nombre, hora: M.hora };
                const recs = planRecordatorios(matchTs, Number(M.cita_ts), ctx);
                await run("UPDATE sandbox_match SET estado='match', match_ts=?, sim_ts=?, recordatorios=?, updated=? WHERE carril=?",
                    [matchTs, matchTs, JSON.stringify(recs), Date.now(), laneKey]);
                // 📝 retro owner: al confirmarse el MATCH, al COMPRADOR le llega el
                // "ahí nos vemos" — la señal de que hay match y arrancan sus recordatorios.
                const artM = /^(hoy|manana|mañana|pasado)/i.test(String(M.fecha)) ? '' : 'el ';
                // 📝#5: el aviso del match transmite CONFIANZA (dueño particular confirmado
                // + los atendemos NOSOTROS junto con el dueño).
                const aviso = `Listo ${nombreComp}, el dueño particular ya confirmó ✅ Ahí nos vemos ${artM}${M.fecha} a las ${M.hora} — te atendemos nosotros junto con el dueño 👍`;
                await guardarMsg(convId, 'out', aviso, 'text');
                return res.status(200).json({
                    ok: true, accion: 'afirma',
                    vendedor_msgs: [`Perfecto, muchas gracias ${M.dueno} 👍`, 'Quedamos en firme, ahí estaremos con el comprador'],
                    comprador_msgs: [aviso],
                    match: { fecha: M.fecha, hora: M.hora, auto: M.auto_nombre, dueno: M.dueno, cita_ts: Number(M.cita_ts), match_ts: matchTs, sim_ts: matchTs, recordatorios: recs }
                });
            }
            if (cls.accion === 'negativo') {
                await run("UPDATE sandbox_match SET estado='rechazo', updated=? WHERE carril=?", [Date.now(), laneKey]);
                const compMsgs = [
                    `Oye ${nombreComp}, una disculpa — me avisa el dueño que se complicó para ${M.fecha} a las ${M.hora}`,
                    'Te acomodo otro día u horario? Tú dime y lo dejamos en firme'
                ];
                for (const s of compMsgs) await guardarMsg(convId, 'out', s, 'text');
                return res.status(200).json({ ok: true, accion: 'negativo', vendedor_msgs: ['Entendido, gracias por avisarme 👍'], comprador_msgs: compMsgs });
            }
            // NO PUEDE a esa hora (sin alternativa) → mecánica del owner: se le PIDE el
            // horario al dueño AHÍ MISMO; al comprador no le llega nada todavía.
            if (cls.accion === 'no_puede_hora' || (M.estado === 'esperando_horario' && cls.accion === 'afirma' && !cls.hora && !cls.fecha)) {
                await run("UPDATE sandbox_match SET estado='esperando_horario', updated=? WHERE carril=?", [Date.now(), laneKey]);
                return res.status(200).json({
                    ok: true, accion: 'no_puede_hora',
                    vendedor_msgs: ['Entendido, sin tema', 'Qué día y horario te acomoda mejor? Y yo lo amarro con el comprador']
                });
            }
            // propone_hora → CITA = DÍA + HORA, ambos amarrados con el dueño (orden owner):
            // si dio solo el DÍA (ej. "miércoles"), Seb le pide LA HORA antes de ir al
            // comprador — jamás se asume la hora vieja en un día nuevo.
            if (!cls.fecha && !cls.hora) {
                await run("UPDATE sandbox_match SET estado='esperando_horario', updated=? WHERE carril=?", [Date.now(), laneKey]);
                return res.status(200).json({ ok: true, accion: 'no_puede_hora', vendedor_msgs: ['Entendido, sin tema', 'Qué día y horario te acomoda mejor? Y yo lo amarro con el comprador'] });
            }
            if (cls.fecha && !cls.hora) {
                await run("UPDATE sandbox_match SET estado='esperando_horario', prop_fecha=?, prop_hora=NULL, updated=? WHERE carril=?", [cls.fecha, Date.now(), laneKey]);
                return res.status(200).json({
                    ok: true, accion: 'falta_hora', fecha: cls.fecha,
                    vendedor_msgs: [`Va, ${cls.fecha} entonces`, 'A qué hora te acomoda? Y así lo amarro en firme con el comprador']
                });
            }
            // hora presente: el día viene de lo que él propuso (aunque haya sido en el
            // mensaje anterior — prop_fecha), NUNCA del día viejo si él lo cambió.
            const nf = cls.fecha || M.prop_fecha || M.fecha, nh = cls.hora;
            await run("UPDATE sandbox_match SET estado='contrapropuesta', prop_fecha=?, prop_hora=?, updated=? WHERE carril=?", [nf, nh, Date.now(), laneKey]);
            const artN = /^(hoy|manana|mañana|pasado)/i.test(String(nf)) ? '' : 'el ';
            const compMsgs = [
                `Oye ${nombreComp}, me comenta el dueño que se le acomoda mejor ${artN}${nf} a las ${nh}`,
                `Te agendo en firme: ${String(nf).charAt(0).toUpperCase()}${String(nf).slice(1)} a las ${nh}, va?`
            ];
            for (const s of compMsgs) await guardarMsg(convId, 'out', s, 'text');
            return res.status(200).json({ ok: true, accion: 'propone_hora', fecha: nf, hora: nh, vendedor_msgs: ['Va, déjame lo checo con el comprador y aquí te confirmo 👍'], comprador_msgs: compMsgs });
        }

        // ══════════════ RELOJ SIMULADO: el owner adelanta el tiempo (cron de película) ══════════════
        if (action === 'tiempo' && req.method === 'POST') {
            await ensureMatchTable();
            const laneKey = carril || 'owner';
            const simTs = Number(req.body.sim_ts || 0);
            const rows = await query("SELECT * FROM sandbox_match WHERE carril=? AND estado='match'", [laneKey]);
            if (!rows.length) return res.status(200).json({ ok: false, error: 'no hay match activo' });
            const M = rows[0];
            const recs = JSON.parse(M.recordatorios || '[]');
            const due = [];
            const convId = await ensureConv();
            const avisosT = (() => { try { return JSON.parse(M.avisos_vendedor || '[]'); } catch (e) { return []; } })();
            let avisosDirty = false;
            for (const r of recs) {
                if (!r.enviado && r.ts <= simTs) {
                    r.enviado = 1; due.push(r);
                    if (r.para === 'comprador') await guardarMsg(convId, 'out', r.texto, 'text');
                    if (r.para === 'vendedor') { avisosT.push(r.texto); avisosDirty = true; }
                }
            }
            if (avisosDirty) await run("UPDATE sandbox_match SET avisos_vendedor=? WHERE carril=?", [JSON.stringify(avisosT), laneKey]);
            const nuevoSim = Math.max(simTs, Number(M.sim_ts || 0));
            await run("UPDATE sandbox_match SET sim_ts=?, recordatorios=?, updated=? WHERE carril=?", [nuevoSim, JSON.stringify(recs), Date.now(), laneKey]);
            return res.status(200).json({ ok: true, sim_ts: nuevoSim, due, recordatorios: recs, cita_ts: Number(M.cita_ts) });
        }

        // ── Estado del match (para re-pintar la línea del tiempo al recargar) ──
        if (action === 'match_estado') {
            await ensureMatchTable();
            const rows = await query("SELECT * FROM sandbox_match WHERE carril=?", [carril || 'owner']);
            if (!rows.length) return res.status(200).json({ ok: true, match: null });
            const M = rows[0];
            return res.status(200).json({ ok: true, match: { ...M, cita_ts: Number(M.cita_ts), match_ts: Number(M.match_ts || 0), sim_ts: Number(M.sim_ts || 0), recordatorios: JSON.parse(M.recordatorios || '[]'), avisos_vendedor: (() => { try { return JSON.parse(M.avisos_vendedor || '[]'); } catch (e) { return []; } })() } });
        }

        // ══════════════ 📝 CAJITA DE RETRO (por sesión, texto libre del owner) ══════════════
        // El owner escribe TODA su retroalimentación ahí; "procesa el training" la lee
        // junto con los 🚩 y se arregla directo. Se guarda con contexto (últimos turnos).
        if (action === 'retro' && req.method === 'POST') {
            const texto = String(req.body.texto || '').trim();
            if (!texto) return res.status(400).json({ ok: false, error: 'texto requerido' });
            await run(`CREATE TABLE IF NOT EXISTS sandbox_feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, carril TEXT, texto TEXT,
                contexto TEXT, procesado INTEGER DEFAULT 0)`);
            let ctxTurnos = [];
            try {
                const t = await query("SELECT id, texto_in, universo, ruta, respuesta FROM sandbox_turnos WHERE carril=? ORDER BY id DESC LIMIT 6", [carril || 'owner']);
                ctxTurnos = t.reverse().map(x => ({ id: x.id, in: x.texto_in, universo: x.universo, ruta: x.ruta, out: String(x.respuesta || '').slice(0, 300) }));
            } catch (e) { }
            const ins = await run("INSERT INTO sandbox_feedback (ts, carril, texto, contexto) VALUES (?,?,?,?)",
                [Date.now(), carril || 'owner', texto.slice(0, 4000), JSON.stringify(ctxTurnos)]);
            return res.status(200).json({ ok: true, id: Number(ins.lastInsertRowid) || null });
        }
        if (action === 'retros') {
            await run(`CREATE TABLE IF NOT EXISTS sandbox_feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, carril TEXT, texto TEXT,
                contexto TEXT, procesado INTEGER DEFAULT 0)`).catch(() => {});
            const fl = await query("SELECT * FROM sandbox_feedback WHERE procesado=0 ORDER BY id ASC").catch(() => []);
            return res.status(200).json({ ok: true, retros: fl });
        }
        if (action === 'retro_done' && req.method === 'POST') {
            const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(n => n > 0);
            if (ids.length) await run("UPDATE sandbox_feedback SET procesado=1 WHERE id IN (" + ids.join(',') + ")");
            return res.status(200).json({ ok: true, n: ids.length });
        }

        // ── 🚩 FLAG: el owner marca un turno como "esto está mal" (con nota opcional) ──
        if (action === 'flag' && req.method === 'POST') {
            const id = Number(req.body.turno_id || 0);
            if (!id) return res.status(400).json({ ok: false, error: 'turno_id requerido' });
            await run("UPDATE sandbox_turnos SET flag=1, flag_nota=?, flag_ts=? WHERE id=?",
                [String(req.body.nota || '').slice(0, 300), Date.now(), id]);
            return res.status(200).json({ ok: true });
        }

        // ── Flags pendientes ("procesa el training" los lee de aquí) ──
        if (action === 'flags') {
            const fl = await query("SELECT * FROM sandbox_turnos WHERE flag=1 AND procesado=0 ORDER BY id ASC").catch(() => []);
            return res.status(200).json({ ok: true, flags: fl });
        }

        // ── Marcar flags como procesados (al terminar un lote de training) ──
        if (action === 'flag_done' && req.method === 'POST') {
            const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(n => n > 0);
            if (ids.length) await run("UPDATE sandbox_turnos SET procesado=1 WHERE id IN (" + ids.join(',') + ")");
            return res.status(200).json({ ok: true, n: ids.length });
        }

        return res.status(400).json({ ok: false, error: 'action inválida' });
    } catch (e) {
        console.error('[sandbox]', e);
        return res.status(500).json({ ok: false, error: e.message });
    }
};
