// ══════════════════════════════════════════════════════════════════════════
// LA MÁQUINA DE RESCATE (diseño owner 2026-07-22) — FUENTE ÚNICA
// sandbox y vida real usan ESTE cerebro; solo el final cambia (dónde acaba el push).
//
// LA LEY: el folio no existe para cobrar la respuesta — existe para REVIVIR el
// flujo. Dos tipos de folio y se cancelan distinto:
//   GHOST   = folio de SILENCIO  → cualquier palabra suya lo mata.
//   PROMESA = folio de PENDIENTE → solo muere si el pendiente muere (resuelto,
//             regresó a la cancha, renovado) — el RELLENO ("ok","gracias") no lo toca.
// Un solo folio vivo por teléfono. Promesa manda sobre ghost.
//
// RELOJES firmados: ghost 60min → +2h → mañana siguiente 9am → agotado (3 toques).
// Promesa: tarde 19:00 · noche 20:30 · al rato +3h · mañana 9am · en N días +N 9am ·
// día de semana ese día 9am · fin de semana viernes 9am · quincena 15/30 · semanal
// +48h · fin de mes día 22 · mediados día 15 · mensual genérico +7d · aire +24h.
// Ventana 9am–8pm (lo nocturno espera). Tras el reclamo de promesa sin respuesta →
// el folio se vuelve ghost etapa 1 (sigue la escalera).
// ══════════════════════════════════════════════════════════════════════════
const { createClient } = require('@libsql/client');
const db = createClient({ url: process.env.TURSO_URL || 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io', authToken: process.env.TURSO_AUTH_TOKEN });
const query = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const run = async (sql, args = []) => db.execute({ sql, args });
const normz = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

let tablaLista = false;
async function ensureTabla() {
    if (tablaLista) return;
    await run(`CREATE TABLE IF NOT EXISTS rescates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telefono TEXT, tipo TEXT, estado TEXT DEFAULT 'vivo', etapa INTEGER DEFAULT 0,
        carril TEXT, escala TEXT, etiqueta TEXT, pendiente TEXT,
        proxima_ts INTEGER, intentos INTEGER DEFAULT 0, motivo_cierre TEXT,
        historial TEXT DEFAULT '[]', created INTEGER, updated INTEGER)`).catch(() => { });
    tablaLista = true;
}
const folioDe = r => 'R-' + r.id;

// ── HORA MONTERREY (UTC-6 fijo, sin horario de verano) — el servidor vive en
// UTC y sin esto la ventana mandaba pushes a las 3am ──
const MX = -6 * 3600000;
const mx = ts => new Date(ts + MX);        // leer con getUTC*
const deMx = d => d.getTime() - MX;        // regresar al reloj real
// ── VENTANA 9am–8pm MTY: lo que caiga fuera espera a las 9 de la mañana ──
function enVentana(ts) {
    const h = mx(ts).getUTCHours();
    if (h >= 9 && h < 20) return ts;
    const m = mx(ts); m.setUTCHours(9, 0, 0, 0);
    if (h >= 20) m.setUTCDate(m.getUTCDate() + 1);
    return deMx(m);
}
function mananaA(ts, hora) { const d = mx(ts); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(hora, 0, 0, 0); return deMx(d); }

// ══ DETECCIÓN DE PROMESA (determinista primero; el que la nombra la interpreta) ══
const RE_PROMESA = /(te aviso|te confirmo|te digo|lo consulto|lo checo|lo veo con|lo platico|deja lo (pienso|checo|veo|consulto)|d[eé]jame (ver|checar|pensar|consultar)|lo pienso|en estos dias|durante la semana|esta semana|este mes|el fin de semana|la quincena|cuando cobre)/;
// RELLENO: TODAS las palabras son cortesía (máx 4) — "ok gracias", "va, perfecto"
const PAL_RELLENO = new Set(['ok', 'okey', 'okay', 'va', 'vale', 'sale', 'gracias', 'muchas', 'listo', 'perfecto', 'si', 'claro', 'de', 'acuerdo', 'entendido', 'excelente', 'genial', 'ntp', 'esta', 'bien', 'buenas', 'buenos', 'dias', 'tardes', 'noches', 'igualmente', 'super', 'oki']);
const esRelleno = t => { const ws = String(t).replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter(Boolean); return ws.length > 0 && ws.length <= 4 && ws.every(w => PAL_RELLENO.has(w)); };
const DIAS = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };

function interpretarPromesa(texto, ahora) {
    const t = normz(texto);
    if (!RE_PROMESA.test(t)) return null;
    const a9 = d => { d.setUTCHours(9, 0, 0, 0); return deMx(d); };
    // escala de DÍA entendible → Haiku-por-código llena la hora exacta (hora MTY)
    if (/\b(en la|a la|por la) tarde|tarde te (aviso|digo)/.test(t)) { const d = mx(ahora); d.setUTCHours(19, 0, 0, 0); const ts = deMx(d); return { escala: 'dia', ts: ts > ahora ? ts : mananaA(ahora, 19), etiqueta: 'hoy en la tarde (7pm)' }; }
    if (/\b(en la|a la|por la) noche|noche te (aviso|digo)/.test(t)) { const d = mx(ahora); d.setUTCHours(20, 30, 0, 0); const ts = deMx(d); return { escala: 'dia', ts: ts > ahora ? ts : mananaA(ahora, 9), etiqueta: 'hoy en la noche (8:30pm)' }; }
    if (/al rato|m[aá]s al rato|ahorita (lo|te)/.test(t)) return { escala: 'dia', ts: ahora + 3 * 3600000, etiqueta: 'al rato (+3h)' };
    if (/ma[nñ]ana/.test(t)) return { escala: 'fecha', ts: mananaA(ahora, 9), etiqueta: 'mañana 9am' };
    const mN = t.match(/en (\d+|dos|tres|cuatro|cinco) d[ií]as/);
    if (mN) { const n = { dos: 2, tres: 3, cuatro: 4, cinco: 5 }[mN[1]] || Number(mN[1]) || 2; const d = mx(ahora); d.setUTCDate(d.getUTCDate() + n); return { escala: 'fecha', ts: a9(d), etiqueta: `en ${n} días (9am)` }; }
    const mD = t.match(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
    if (mD) { const d = mx(ahora); let diff = (DIAS[mD[1]] - d.getUTCDay() + 7) % 7; if (!diff) diff = 7; d.setUTCDate(d.getUTCDate() + diff); return { escala: 'fecha', ts: a9(d), etiqueta: 'el ' + mD[1] + ' 9am' }; }
    if (/fin de semana/.test(t)) { const d = mx(ahora); let diff = (5 - d.getUTCDay() + 7) % 7; if (!diff) diff = 7; d.setUTCDate(d.getUTCDate() + diff); return { escala: 'fecha', ts: a9(d), etiqueta: 'viernes 9am (fin de semana)' }; }
    if (/quincena|cuando cobre/.test(t)) { const d = mx(ahora); const dia = d.getUTCDate(); if (dia < 15) d.setUTCDate(15); else { d.setUTCMonth(d.getUTCMonth() + (dia >= 30 ? 1 : 0)); d.setUTCDate(dia >= 30 ? 15 : 30); } return { escala: 'fecha', ts: a9(d), etiqueta: 'la quincena (9am)' }; }
    if (/fin de mes/.test(t)) { const d = mx(ahora); if (d.getUTCDate() >= 22) d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(22); return { escala: 'mensual', ts: a9(d), etiqueta: 'fin de mes (día 22)' }; }
    if (/mediados/.test(t)) { const d = mx(ahora); if (d.getUTCDate() >= 15) d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(15); return { escala: 'mensual', ts: a9(d), etiqueta: 'mediados de mes (día 15)' }; }
    if (/durante la semana|esta semana/.test(t)) return { escala: 'semanal', ts: ahora + 48 * 3600000, etiqueta: 'en la semana (+48h)' };
    if (/este mes/.test(t)) { const d = mx(ahora); d.setUTCDate(d.getUTCDate() + 7); return { escala: 'mensual', ts: a9(d), etiqueta: 'este mes (+7 días)' }; }
    // no se entiende el lapso → AL AIRE: 24h
    return { escala: 'aire', ts: ahora + 24 * 3600000, etiqueta: 'al aire (+24h)' };
}

// ══ LOS MACHOTES (voz sobria del banco — el owner los afina en training) ══
function machote(r) {
    if (r.tipo === 'promesa') return 'Qué onda, ¿cómo ves? ¿Seguimos en pie?';
    const bala = r.carril === 'caliente' ? (r.pendiente === 'cotizacion' ? 'cotizacion' : 'ubicacion') : 'info';
    if (Number(r.etapa) === 0) {   // push 1 — revividor por carril
        if (bala === 'cotizacion') return '¿Cómo ves los números? Si el enganche no te acomoda, lo cuadramos de otra forma 👍';
        if (bala === 'ubicacion') return '¿Te queda bien pasar hoy o mañana? Te aparto el auto para que lo manejes 👍';
        return '¿Cómo la ves? ¿Te late o te busco otra opción? 👍';
    }
    if (Number(r.etapa) === 1) return 'Sigo al pendiente por aquí — cualquier duda me dices y te apoyo con lo que ocupes 👍';
    return 'Qué tal, buen día! ¿Sigues buscando auto? Tengo opciones que te pueden interesar, dime y te paso todo 👍';
}

async function vivo(tel) {
    await ensureTabla();
    const r = await query("SELECT * FROM rescates WHERE telefono=? AND estado='vivo' ORDER BY id DESC LIMIT 1", [tel]);
    return r.length ? r[0] : null;
}
async function anotar(r, evento, extra) {
    let h = []; try { h = JSON.parse(r.historial || '[]'); } catch (e) { }
    h.push({ ts: Date.now(), ev: evento, ...(extra || {}) });
    return JSON.stringify(h).slice(0, 8000);
}
async function cerrar(r, motivo, ahora) {
    await run("UPDATE rescates SET estado='cerrado', motivo_cierre=?, historial=?, updated=? WHERE id=?",
        [motivo, await anotar(r, 'cierre', { motivo }), ahora, r.id]);
}

// ══ REGISTRAR TURNO — se llama al FINAL de cada turno del pipeline (fuente única).
// Decide: ¿promesa? ¿cancha? ¿relleno? y REARMA el reloj del silencio.
async function registrarTurno({ tel, textoIn, ruta, segmentos, pin, ahora }) {
    try {
        await ensureTabla();
        ahora = ahora || Date.now();
        const t = normz(textoIn);
        const r = await vivo(tel);
        const prom = interpretarPromesa(textoIn, ahora);
        const rellenoIn = esRelleno(t);
        const outTxt = (segmentos || []).join('\n');
        // la ÚLTIMA BALA de este turno (define el carril del próximo silencio)
        // la bala UBICACIÓN es solo cuando fue EL PIN (todo paquete dice "Lo tenemos
        // en..." y eso no vuelve caliente a cualquier ficha)
        const bala = /Enganche:/.test(outTxt) ? 'cotizacion' : (pin ? 'ubicacion' : 'info');
        const carril = (bala === 'cotizacion' || bala === 'ubicacion') ? 'caliente' : 'tibio';
        const conGancho = /\?/.test(outTxt);   // la pelota queda en su cancha

        if (prom) {
            // PROMESA (nueva o renovada) — manda sobre todo
            if (r) await cerrar(r, r.tipo === 'promesa' ? 'renovada' : 'promesa dicha', ahora);
            await run("INSERT INTO rescates (telefono, tipo, estado, etapa, carril, escala, etiqueta, pendiente, proxima_ts, historial, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                [tel, 'promesa', 'vivo', 0, carril, prom.escala, prom.etiqueta, String(textoIn).slice(0, 200), enVentana(prom.ts), JSON.stringify([{ ts: ahora, ev: 'promesa', etiqueta: prom.etiqueta }]), ahora, ahora]);
            return { accion: 'promesa', etiqueta: prom.etiqueta };
        }
        if (rellenoIn || !outTxt.trim()) {
            // RELLENO (o el bot no contestó nada): lo único que NO toca el reloj de una
            // promesa; el ghost sí muere (su palabra rompió el silencio)
            if (r && r.tipo === 'ghost') await cerrar(r, 'contestó (relleno)', ahora);
            return { accion: 'relleno' };
        }
        // CANCHA: habló y el loop atendió → todo folio muere y el silencio se REARMA
        if (r) await cerrar(r, 'regresó a la cancha', ahora);
        if (conGancho) {
            await run("INSERT INTO rescates (telefono, tipo, estado, etapa, carril, escala, pendiente, proxima_ts, historial, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [tel, 'ghost', 'vivo', 0, carril, '', bala, enVentana(ahora + 60 * 60000), JSON.stringify([{ ts: ahora, ev: 'armado', bala }]), ahora, ahora]);
            return { accion: 'ghost_armado', carril, bala };
        }
        return { accion: 'sin_folio' };
    } catch (e) { console.error('[rescate turno]', e.message); return null; }
}

// ══ EL BARREDOR — cron (real) o reloj simulado (sandbox). MISMA puerta.
// Regresa los pushes que tocan; el caller decide dónde acaban (WA real o burbuja).
async function barrer({ tel, ahora, ultimoInTs, standby }) {
    try {
        await ensureTabla();
        ahora = ahora || Date.now();
        const rows = tel
            ? await query("SELECT * FROM rescates WHERE telefono=? AND estado='vivo' AND proxima_ts<=?", [tel, ahora])
            : await query("SELECT * FROM rescates WHERE estado='vivo' AND proxima_ts<=?", [ahora]);
        const enviar = [];
        for (const r of rows) {
            // CHECKLIST DEL DISPARO (ley del timbre): vetos ANTES de ejecutar
            if (standby) { await run("UPDATE rescates SET proxima_ts=?, updated=? WHERE id=?", [ahora + 4 * 3600000, ahora, r.id]); continue; }
            if (ultimoInTs && ahora - ultimoInTs < 30 * 60000) {   // plática activa → espera la pausa
                await run("UPDATE rescates SET proxima_ts=?, updated=? WHERE id=?", [ahora + 30 * 60000, ahora, r.id]); continue;
            }
            const texto = machote(r);
            const etapa = Number(r.etapa) || 0;
            if (r.tipo === 'promesa') {
                // el reclamo suave salió → el folio se vuelve GHOST etapa 1 (la escalera sigue)
                await run("UPDATE rescates SET tipo='ghost', etapa=1, intentos=intentos+1, proxima_ts=?, historial=?, updated=? WHERE id=?",
                    [enVentana(mananaA(ahora, 9)), await anotar(r, 'reclamo_promesa', { texto }), ahora, r.id]);
            } else if (etapa === 0) {
                await run("UPDATE rescates SET etapa=1, intentos=intentos+1, proxima_ts=?, historial=?, updated=? WHERE id=?",
                    [enVentana(ahora + 2 * 3600000), await anotar(r, 'push1', { texto }), ahora, r.id]);
            } else if (etapa === 1) {
                await run("UPDATE rescates SET etapa=2, intentos=intentos+1, proxima_ts=?, historial=?, updated=? WHERE id=?",
                    [enVentana(mananaA(ahora, 9)), await anotar(r, 'push2', { texto }), ahora, r.id]);
            } else {
                // push 3 (primera hora) — el último toque: se agota (Mario queda pendiente)
                await run("UPDATE rescates SET estado='cerrado', etapa=3, intentos=intentos+1, motivo_cierre='agotado (3 toques)', historial=?, updated=? WHERE id=?",
                    [await anotar(r, 'push3', { texto }), ahora, r.id]);
            }
            enviar.push({ folio: folioDe(r), telefono: r.telefono, texto, tipo: r.tipo, etapa });
        }
        return enviar;
    } catch (e) { console.error('[rescate barrer]', e.message); return []; }
}

// ══ ESTADO PARA EL PANEL (la línea del tiempo del sandbox/fyrachat) ══
async function estadoPanel(tel) {
    try {
        await ensureTabla();
        const r = await vivo(tel);
        if (!r) return { activo: false };
        let h = []; try { h = JSON.parse(r.historial || '[]'); } catch (e) { }
        return {
            activo: true, folio: folioDe(r), tipo: r.tipo, etapa: Number(r.etapa) || 0,
            carril: r.carril, escala: r.escala || '', etiqueta: r.etiqueta || '',
            pendiente: r.pendiente || '', proxima_ts: Number(r.proxima_ts), created: Number(r.created), historial: h
        };
    } catch (e) { return { activo: false }; }
}

async function limpiar(tel) { await ensureTabla(); await run("DELETE FROM rescates WHERE telefono=?", [tel]).catch(() => { }); }

module.exports = { registrarTurno, barrer, estadoPanel, limpiar, interpretarPromesa, machote };
