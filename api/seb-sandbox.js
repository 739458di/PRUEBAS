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
                    try { const p = await pensar({ telefono: SANDBOX_TEL, mensaje: textoFamilia, clasificacion: clasif, estado: {} }); if (p && p.ok && p.borrador) out = { segmentos: [p.borrador], tipo: 'cerebro' }; } catch (e) { }
                }
                if (!out) {
                    const op = await responderOpener({ texto: textoFamilia, nombre: NOMBRE_COMPRADOR, auto_id: clasif.auto_id, intencion: clasif.intencion_principal });
                    if (op && op.segmentos && op.segmentos.length) out = op;
                }
                if (!out && clasif.escalar) out = { escala: true, motivo: 'vendedor / fuera de alcance' };
                if (!out && clasif.auto_id) {
                    try { const p = await pensar({ telefono: SANDBOX_TEL, mensaje: textoFamilia, clasificacion: clasif, estado: {} }); if (p && p.ok && p.borrador) out = { segmentos: [p.borrador], tipo: 'cerebro' }; } catch (e) { }
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
                const cont = await responderCont({ texto: textoFamilia, nombre: NOMBRE_COMPRADOR, auto_id: clasif.auto_id, enganche: clasif.datos && clasif.datos.enganche, plazo: clasif.datos && clasif.datos.plazo_meses, intencion: clasif.intencion_principal });
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
                    citaDueno = {
                        auto: autoNom,
                        dueno: dn || 'Vendedor',
                        cuando,
                        mensaje: `Qué tal${dn ? ' ' + dn : ''}, tengo cita para ver tu ${autoNom} ${cuando}. Me confirmas que esté disponible porfavor?`
                    };
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
