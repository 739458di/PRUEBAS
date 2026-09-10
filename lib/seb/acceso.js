// lib/seb/acceso.js — ACCESO DEL VENDEDOR A SU FYRACHAT (orden owner 2026-09-10, bloque 2 del blindaje)
//
// Principio: el universo lo dicta la SESIÓN, nunca la barra de direcciones. Una sesión solo se consigue
// (a) con un código de 6 dígitos que llega al WhatsApp del vendedor, o (b) con un TICKET de un solo uso que
// nace en el instante en que el vendedor termina de vincular su WhatsApp (ya demostró tener el teléfono).
//
// Tablas (DDL idempotente, se crea al primer uso):
//   sesiones_vendedor(token_hash, tenant_id, creada, caduca, ultimo_uso, ua, cerrada)
//   codigos_acceso(telefono, codigo_hash, expira, intentos, usado, creado)
//   tickets_acceso(token_hash, tenant_id, expira, usado, creado)
// Los tokens de sesión/ticket son 32 bytes aleatorios (nunca se guardan en claro: sha256). Los códigos de
// 6 dígitos se guardan con sha256 + PIMIENTA del servidor (ACCESO_PEPPER) para que una lectura de la tabla no baste.
//
// El owner (OWNER_TEL) obtiene una sesión MAESTRA: puede pasar ?vendedor= y ver cualquier universo (la casa es suya).

const crypto = require('crypto');
const { query, run } = require('./db.js');

const OWNER_TEL = String(process.env.OWNER_TEL || '5218120066355');
const SESION_DIAS = 30;
const CODIGO_MIN = 3;          // vida del código
const CODIGO_MAX_INTENTOS = 5;
const CODIGO_MAX_POR_10MIN = 3;
const TICKET_MIN = 15;
const COOKIE = 'fyra_v';

let listo = false;
async function ensureAcceso() {
    if (listo) return;
    await run(`CREATE TABLE IF NOT EXISTS sesiones_vendedor (
        id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE, tenant_id INTEGER NOT NULL,
        creada INTEGER, caduca INTEGER, ultimo_uso INTEGER, ua TEXT, cerrada INTEGER DEFAULT 0)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ses_tenant ON sesiones_vendedor(tenant_id, cerrada)`);
    await run(`CREATE TABLE IF NOT EXISTS codigos_acceso (
        id INTEGER PRIMARY KEY AUTOINCREMENT, telefono TEXT, codigo_hash TEXT, expira INTEGER,
        intentos INTEGER DEFAULT 0, usado INTEGER DEFAULT 0, creado INTEGER)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_cod_tel ON codigos_acceso(telefono, usado, expira)`);
    await run(`CREATE TABLE IF NOT EXISTS tickets_acceso (
        id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE, tenant_id INTEGER NOT NULL,
        expira INTEGER, usado INTEGER DEFAULT 0, creado INTEGER)`);
    listo = true;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function pimienta() {
    // ACCESO_PEPPER en Vercel; si faltara, se deriva de otro secreto del servidor para NUNCA correr sin pimienta
    return process.env.ACCESO_PEPPER || sha('acceso:' + (process.env.TURSO_AUTH_TOKEN || '')).slice(0, 32);
}
const hashCodigo = (tel, codigo) => sha(pimienta() + '|' + tel + '|' + String(codigo).replace(/\D/g, ''));
const nuevoToken = () => crypto.randomBytes(32).toString('base64url');

/** 521 + 10 dígitos a partir de cualquier forma (10 dígitos, 52…, 521…). null si no es un celular MX. */
function tel521(v) {
    const d = String(v || '').replace(/\D/g, '');
    if (d.length === 10) return '521' + d;
    if (d.length === 12 && d.startsWith('52')) return '521' + d.slice(2);
    if (d.length === 13 && d.startsWith('521')) return d;
    return null;
}

async function tenantPorTelefono(tel) {
    const t = tel521(tel); if (!t) return null;
    const r = await query("SELECT id, nombre, telefono, activo, config_json FROM tenants WHERE telefono = ? AND activo = 1 LIMIT 1", [t]);
    return r.length ? r[0] : null;
}
async function tenantPorId(id) {
    const r = await query("SELECT id, nombre, telefono, activo, config_json FROM tenants WHERE id = ? AND activo = 1 LIMIT 1", [Number(id)]);
    return r.length ? r[0] : null;
}
const esOwner = (t) => !!t && String(t.telefono) === OWNER_TEL;

// ── CÓDIGO POR WHATSAPP ────────────────────────────────────────────────────────────────────────
/** Genera un código para el teléfono (si tiene universo). Devuelve { ok, codigo, tenant } o { ok:false, error }. El envío lo hace el llamador. */
async function pedirCodigo(telefono) {
    await ensureAcceso();
    const t = await tenantPorTelefono(telefono);
    if (!t) return { ok: false, error: 'Ese WhatsApp no tiene un universo dado de alta.' };
    const ahora = Date.now();
    const recientes = await query("SELECT COUNT(*) n FROM codigos_acceso WHERE telefono = ? AND creado > ?", [t.telefono, ahora - 10 * 60 * 1000]);
    if (Number(recientes[0].n) >= CODIGO_MAX_POR_10MIN) return { ok: false, error: 'Ya pediste varios códigos. Espera unos minutos.', espera: true };
    const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await run("UPDATE codigos_acceso SET usado = 1 WHERE telefono = ? AND usado = 0", [t.telefono]);   // solo vive el último
    await run("INSERT INTO codigos_acceso (telefono, codigo_hash, expira, intentos, usado, creado) VALUES (?,?,?,?,?,?)",
        [t.telefono, hashCodigo(t.telefono, codigo), ahora + CODIGO_MIN * 60 * 1000, 0, 0, ahora]);
    return { ok: true, codigo, tenant: t, vida_min: CODIGO_MIN };
}

/** Verifica el código y abre sesión. Devuelve { ok, token, tenant, maestra } o { ok:false, error }. */
async function entrarConCodigo(telefono, codigo, ua) {
    await ensureAcceso();
    const t = await tenantPorTelefono(telefono);
    if (!t) return { ok: false, error: 'Ese WhatsApp no tiene un universo dado de alta.' };
    const ahora = Date.now();
    const filas = await query("SELECT id, codigo_hash, expira, intentos FROM codigos_acceso WHERE telefono = ? AND usado = 0 ORDER BY id DESC LIMIT 1", [t.telefono]);
    if (!filas.length || Number(filas[0].expira) < ahora) return { ok: false, error: 'El código venció. Pide otro.' };
    const f = filas[0];
    if (Number(f.intentos) >= CODIGO_MAX_INTENTOS) { await run("UPDATE codigos_acceso SET usado = 1 WHERE id = ?", [f.id]); return { ok: false, error: 'Demasiados intentos. Pide otro código.' }; }
    const okCod = crypto.timingSafeEqual(Buffer.from(f.codigo_hash), Buffer.from(hashCodigo(t.telefono, codigo)));
    if (!okCod) { await run("UPDATE codigos_acceso SET intentos = intentos + 1 WHERE id = ?", [f.id]); return { ok: false, error: 'Código incorrecto.' }; }
    await run("UPDATE codigos_acceso SET usado = 1 WHERE id = ?", [f.id]);
    return abrirSesion(t, ua);
}

// ── TICKET DE UN SOLO USO (nace al terminar la vinculación) ────────────────────────────────────
/** Crea un ticket para el universo del teléfono. Devuelve { ok, token, expira } — el llamador arma la URL. */
async function crearTicket(telefono) {
    await ensureAcceso();
    const t = await tenantPorTelefono(telefono);
    if (!t) return { ok: false, error: 'Ese WhatsApp no tiene un universo dado de alta.' };
    const token = nuevoToken(); const ahora = Date.now();
    await run("INSERT INTO tickets_acceso (token_hash, tenant_id, expira, usado, creado) VALUES (?,?,?,?,?)", [sha(token), t.id, ahora + TICKET_MIN * 60 * 1000, 0, ahora]);
    return { ok: true, token, expira: ahora + TICKET_MIN * 60 * 1000, tenant: t };
}
/** Canjea el ticket por una sesión (una sola vez). */
async function canjearTicket(token, ua) {
    await ensureAcceso();
    if (!token || String(token).length < 20) return { ok: false, error: 'Ticket inválido.' };
    const h = sha(token);
    const r = await run("UPDATE tickets_acceso SET usado = 1 WHERE token_hash = ? AND usado = 0 AND expira > ?", [h, Date.now()]);   // claim atómico
    if (!Number(r.rowsAffected)) return { ok: false, error: 'Este link ya se usó o venció. Entra con el código que te llega a tu WhatsApp.' };
    const f = await query("SELECT tenant_id FROM tickets_acceso WHERE token_hash = ? LIMIT 1", [h]);
    const t = f.length ? await tenantPorId(f[0].tenant_id) : null;
    if (!t) return { ok: false, error: 'Universo no disponible.' };
    return abrirSesion(t, ua);
}

// ── SESIONES ───────────────────────────────────────────────────────────────────────────────────
async function abrirSesion(t, ua) {
    const token = nuevoToken(); const ahora = Date.now();
    await run("INSERT INTO sesiones_vendedor (token_hash, tenant_id, creada, caduca, ultimo_uso, ua, cerrada) VALUES (?,?,?,?,?,?,0)",
        [sha(token), t.id, ahora, ahora + SESION_DIAS * 86400 * 1000, ahora, String(ua || '').slice(0, 200)]);
    return { ok: true, token, tenant: { id: t.id, nombre: t.nombre, telefono: t.telefono }, maestra: esOwner(t) };
}
/** Sesión viva a partir del token de la cookie: { tenant_id, tenant:{id,nombre,telefono}, maestra } o null. */
async function sesionDe(token) {
    if (!token) return null;
    await ensureAcceso();
    const ahora = Date.now();
    const r = await query(`SELECT s.id sid, s.ultimo_uso, t.id, t.nombre, t.telefono FROM sesiones_vendedor s JOIN tenants t ON t.id = s.tenant_id
                           WHERE s.token_hash = ? AND s.cerrada = 0 AND s.caduca > ? AND t.activo = 1 LIMIT 1`, [sha(token), ahora]);
    if (!r.length) return null;
    const s = r[0];
    if (ahora - Number(s.ultimo_uso || 0) > 10 * 60 * 1000) run("UPDATE sesiones_vendedor SET ultimo_uso = ? WHERE id = ?", [ahora, s.sid]).catch(() => {});   // toque cada 10 min (cuota)
    return { tenant_id: s.id, tenant: { id: s.id, nombre: s.nombre, telefono: s.telefono }, maestra: String(s.telefono) === OWNER_TEL };
}
async function cerrarSesion(token) { if (!token) return; await ensureAcceso(); await run("UPDATE sesiones_vendedor SET cerrada = 1 WHERE token_hash = ?", [sha(token)]); }
async function cerrarTodas(tenantId) { await ensureAcceso(); await run("UPDATE sesiones_vendedor SET cerrada = 1 WHERE tenant_id = ?", [Number(tenantId)]); }

// ── COOKIE ─────────────────────────────────────────────────────────────────────────────────────
function leerCookie(req) {
    const c = String((req.headers && req.headers.cookie) || '');
    const m = c.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
}
function ponerCookie(res, token) {
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESION_DIAS * 86400}; HttpOnly; Secure; SameSite=Lax`);
}
function borrarCookie(res) { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`); }

module.exports = { ensureAcceso, tel521, pedirCodigo, entrarConCodigo, crearTicket, canjearTicket, sesionDe, cerrarSesion, cerrarTodas, leerCookie, ponerCookie, borrarCookie, esOwner, OWNER_TEL, COOKIE };
