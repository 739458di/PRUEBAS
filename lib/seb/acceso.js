// lib/seb/acceso.js — ACCESO DEL VENDEDOR A SU FYRACHAT (orden owner 2026-09-10, bloque 2 del blindaje)
//
// Principio: el universo lo dicta la SESIÓN, nunca la barra de direcciones. Una sesión solo se consigue
// (a) con un código de 6 dígitos que llega al WhatsApp del vendedor, o (b) con un TICKET de un solo uso que
// nace en el instante en que el vendedor termina de vincular su WhatsApp (ya demostró tener el teléfono).
//
// Tablas (DDL idempotente, se crea al primer uso):
//   sesiones_vendedor(token_hash, tenant_id, creada, caduca, ultimo_uso, ua, ip, cerrada)
//   codigos_acceso(telefono, codigo_hash, expira, intentos, usado, creado)
//   tickets_acceso(token_hash, tenant_id, expira, usado, creado)
//   rate_limits(clave PK, n, hasta)           — límites por IP / teléfono (UPSERT único, compartida con SB)
//   accesos_log(id, ts, sesion_id, tenant_id, action, ip) — bitácora de escrituras con cookie (best-effort)
// Los tokens de sesión/ticket son 32 bytes aleatorios (nunca se guardan en claro: sha256). Los códigos de
// 6 dígitos se guardan con sha256 + PIMIENTA del servidor (ACCESO_PEPPER) para que una lectura de la tabla no baste.
//
// SESIONES DESLIZANTES (bloque 5, 2026-09-10): 7 días sin uso la matan; 90 días es el máximo absoluto;
// ultimo_uso se renueva como máximo una vez cada 10 min (cuota Turso).
//
// El owner (OWNER_TEL) obtiene una sesión MAESTRA: puede pasar ?vendedor= y ver cualquier universo (la casa es suya).

const crypto = require('crypto');
const { query, run } = require('./db.js');
const DEMO = require('./demo.js');   // FYRACHAT DE PRUEBA (2026-09-10): tenant PRUEBAS# con código fijo, sin WhatsApp

const OWNER_TEL = String(process.env.OWNER_TEL || '5218120066355');
const SESION_INACTIVIDAD_DIAS = 180;   // orden owner 2026-09-24: la sesión NO muere por inactividad; solo por 'Cerrar sesión' o el tope de 180 días
const SESION_MAX_DIAS = 180;           // tope absoluto (también Max-Age de la cookie)
const MAX_DISPOSITIVOS = 5;            // sesiones vivas por universo; al abrir la 6ª se cierra la más vieja
// CONTRASEÑA (orden owner 2026-09-12): alta con código por WhatsApp → contraseña obligatoria → volver a entrar con número + contraseña.
const CONTRA_MIN = 8, CONTRA_MAX = 72;
const LIM_CONTRA_TEL = 5, LIM_CONTRA_IP = 20;   // intentos fallidos por 10 min (teléfono / IP) → "espera 10 minutos o entra con código"
const TOQUE_MIN = 10;                  // ultimo_uso se renueva a lo más cada 10 min
const CODIGO_MIN = 3;                  // vida del código
const CODIGO_MAX_INTENTOS = 5;
const TICKET_MIN = 15;
const COOKIE = 'fyra_v';
// Límites de acceso_pedir (rate_limits): por IP 10/10 min y 30/día; por teléfono 3/10 min
const LIM_IP_10MIN = 10, LIM_IP_DIA = 30, LIM_TEL_10MIN = 3;
const MIN10 = 10 * 60 * 1000, DIA = 24 * 3600 * 1000;

let listo = false, _ensP = null;
// RENDIMIENTO (2026-09-23): el DDL idempotente corre UNA vez por instancia (ya lo hacía), pero ahora
//   · una sola promesa compartida (dos llamadas simultáneas en frío ya no lo corren dos veces),
//   · los CREATE TABLE independientes salen en paralelo (1 viaje en vez de 6),
//   · los ALTER TABLE solo se intentan si la columna FALTA (PRAGMA table_info): antes eran 6 ALTER que
//     fallaban "duplicate column" en cada arranque y, con los reintentos de db.js, costaban ~2 s cada uno (13 s medidos en frío).
// El estado final del esquema es idéntico al de antes.
async function _colsDe(tabla) { try { return new Set((await query('PRAGMA table_info(' + tabla + ')')).map(c => String(c.name))); } catch (e) { return new Set(); } }
async function _alterSiFalta(tabla, cols, col, tipo) { if (cols.has(col)) return; try { await run('ALTER TABLE ' + tabla + ' ADD COLUMN ' + col + ' ' + tipo); } catch (e) { /* ya existe */ } }
function ensureAcceso() {
    if (listo) return Promise.resolve();
    if (_ensP) return _ensP;
    _ensP = (async () => {
        await Promise.all([
            run(`CREATE TABLE IF NOT EXISTS sesiones_vendedor (
        id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE, tenant_id INTEGER NOT NULL,
        creada INTEGER, caduca INTEGER, ultimo_uso INTEGER, ua TEXT, cerrada INTEGER DEFAULT 0)`),
            run(`CREATE TABLE IF NOT EXISTS codigos_acceso (
        id INTEGER PRIMARY KEY AUTOINCREMENT, telefono TEXT, codigo_hash TEXT, expira INTEGER,
        intentos INTEGER DEFAULT 0, usado INTEGER DEFAULT 0, creado INTEGER)`),
            run(`CREATE TABLE IF NOT EXISTS tickets_acceso (
        id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE, tenant_id INTEGER NOT NULL,
        expira INTEGER, usado INTEGER DEFAULT 0, creado INTEGER)`),
            run(`CREATE TABLE IF NOT EXISTS rate_limits (clave TEXT PRIMARY KEY, n INTEGER, hasta INTEGER)`),
            // contraseña por universo: scrypt(contraseña, sal + pimienta) → hex; jamás texto plano
            run(`CREATE TABLE IF NOT EXISTS contrasenas_acceso (tenant_id INTEGER PRIMARY KEY, hash TEXT, sal TEXT, creada INTEGER, cambiada INTEGER)`),
            run(`CREATE TABLE IF NOT EXISTS accesos_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, sesion_id INTEGER, tenant_id INTEGER, action TEXT, ip TEXT)`),
            run(`CREATE TABLE IF NOT EXISTS contrasenas_miembro (miembro_id INTEGER PRIMARY KEY, hash TEXT, sal TEXT, creada INTEGER, cambiada INTEGER)`)
        ]);
        const [cS, cT] = await Promise.all([_colsDe('sesiones_vendedor'), _colsDe('tickets_acceso')]);
        await Promise.all([
            run(`CREATE INDEX IF NOT EXISTS idx_ses_tenant ON sesiones_vendedor(tenant_id, cerrada)`),
            run(`CREATE INDEX IF NOT EXISTS idx_cod_tel ON codigos_acceso(telefono, usado, expira)`),
            _alterSiFalta('sesiones_vendedor', cS, 'ip', 'TEXT'),
            _alterSiFalta('sesiones_vendedor', cS, 'via', 'TEXT'),
            // MIEMBROS (orden owner 2026-09-23): un vendedor del lote entra con SU WhatsApp y cae en el FyraChat del lote; su sesión trae miembro_id y el panel general le queda cerrado
            _alterSiFalta('sesiones_vendedor', cS, 'miembro_id', 'INTEGER'),
            _alterSiFalta('tickets_acceso', cT, 'destino', 'TEXT'),
            _alterSiFalta('tickets_acceso', cT, 'origen', 'TEXT'),
            _alterSiFalta('tickets_acceso', cT, 'miembro_id', 'INTEGER')
        ]);
        listo = true;
    })().catch(e => { _ensP = null; throw e; });
    return _ensP;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function pimienta() {
    // ACCESO_PEPPER en Vercel; si faltara, se deriva de otro secreto del servidor para NUNCA correr sin pimienta
    return process.env.ACCESO_PEPPER || sha('acceso:' + (process.env.TURSO_AUTH_TOKEN || '')).slice(0, 32);
}
const hashCodigo = (tel, codigo) => sha(pimienta() + '|' + tel + '|' + String(codigo).replace(/\D/g, ''));
const nuevoToken = () => crypto.randomBytes(32).toString('base64url');

/** Comparación de llaves en TIEMPO CONSTANTE: timingSafeEqual sobre sha256 de ambas (largos distintos no filtran nada). */
function mismaClave(a, b) {
    if (a == null || b == null) return false;
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/** IP del cliente detrás de Vercel: primer salto de x-forwarded-for, o x-real-ip. */
function ipDe(req) {
    const h = (req && req.headers) || {};
    const xff = String(h['x-forwarded-for'] || '').split(',')[0].trim();
    return (xff || String(h['x-real-ip'] || '').trim() || '').slice(0, 64);
}
const ipMascara = (ip) => {
    const s = String(ip || '');
    if (!s) return '';
    if (s.includes('.')) { const p = s.split('.'); return p.length === 4 ? p[0] + '.' + p[1] + '.•.•' : '•'; }
    return s.split(':').slice(0, 2).join(':') + ':…';
};

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
/** Miembro activo (vendedores_universo) por teléfono, con su universo. → { miembro:{id,nombre,telefono}, tenant } | null */
async function miembroPorTelefono(tel) {
    const t = tel521(tel); if (!t) return null;
    const r = await query(`SELECT m.id, m.nombre, m.telefono, m.rol, t.id tid, t.nombre tnombre, t.telefono ttel, t.config_json FROM vendedores_universo m JOIN tenants t ON t.id = m.tenant_id
                           WHERE m.telefono = ? AND m.activo = 1 AND t.activo = 1 ORDER BY m.id DESC LIMIT 1`, [t]).catch(() => []);
    if (!r.length) return null;
    return { miembro: { id: Number(r[0].id), nombre: r[0].nombre, telefono: r[0].telefono, rol: r[0].rol || 'vendedor' }, tenant: { id: Number(r[0].tid), nombre: r[0].tnombre, telefono: r[0].ttel, activo: 1, config_json: r[0].config_json } };
}
/** Miembro o universo por teléfono. LA MEMBRESÍA MANDA (orden owner 2026-09-23: "ya estoy agregado en TERRA, lo único que existe es mi perfil"):
 *  si el número está dado de alta como vendedor de un lote, entra como ese vendedor aunque también tenga universo propio. → { t, m } | null */
async function quienPorTelefono(tel) {
    const mm = await miembroPorTelefono(tel); if (mm) return { t: mm.tenant, m: mm.miembro };
    const t = await tenantPorTelefono(tel); if (t) return { t, m: null };
    return null;
}

// ── RATE LIMIT (UPSERT único; ventana fija) ────────────────────────────────────────────────────
/** Cuenta un intento en la clave. Devuelve { n, excedido } con la ventana ventanaMs y el tope max. */
async function contarLimite(clave, max, ventanaMs) {
    await ensureAcceso();
    const ahora = Date.now();
    const r = await run(`INSERT INTO rate_limits (clave, n, hasta) VALUES (?, 1, ?)
        ON CONFLICT(clave) DO UPDATE SET
            n = CASE WHEN rate_limits.hasta < ? THEN 1 ELSE rate_limits.n + 1 END,
            hasta = CASE WHEN rate_limits.hasta < ? THEN ? ELSE rate_limits.hasta END
        RETURNING n`, [clave, ahora + ventanaMs, ahora, ahora, ahora + ventanaMs]);
    const n = Number(r && r.rows && r.rows[0] && (r.rows[0].n != null ? r.rows[0].n : r.rows[0][0])) || 1;
    return { n, excedido: n > max };
}

// ── CÓDIGO POR WHATSAPP ────────────────────────────────────────────────────────────────────────
/** Genera un código para el teléfono. Límites por IP (429 arriba) y por teléfono (silencioso).
 *  Devuelve { ok, codigo, tenant, vida_min } · { ok:true, silencioso:true } (no existe / tope por tel) ·
 *  { ok:false, limite:'ip' } (tope por IP). El envío lo hace el llamador; la respuesta HTTP es SIEMPRE igual exista o no el número. */
async function pedirCodigo(telefono, ip) {
    await ensureAcceso();
    const ipK = String(ip || 'sin-ip');
    const l1 = await contarLimite('ap:ip:' + ipK, LIM_IP_10MIN, MIN10);
    const l2 = await contarLimite('ap:ip:d:' + ipK, LIM_IP_DIA, DIA);
    if (l1.excedido || l2.excedido) return { ok: false, limite: 'ip', espera: true, error: 'Demasiados intentos. Espera unos minutos.' };
    const tel = tel521(telefono);
    if (!tel) return { ok: true, silencioso: true, vida_min: CODIGO_MIN };
    const l3 = await contarLimite('ap:tel:' + tel, LIM_TEL_10MIN, MIN10);
    if (l3.excedido) return { ok: true, silencioso: true, vida_min: CODIGO_MIN };
    const q = await quienPorTelefono(tel);
    if (!q) return { ok: true, silencioso: true, vida_min: CODIGO_MIN };   // mismo aspecto que un número real (invariante 7)
    const t = q.t; const telDestino = q.m ? q.m.telefono : t.telefono;
    const ahora = Date.now();
    const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await run("UPDATE codigos_acceso SET usado = 1 WHERE telefono = ? AND usado = 0", [telDestino]);   // solo vive el último
    await run("INSERT INTO codigos_acceso (telefono, codigo_hash, expira, intentos, usado, creado) VALUES (?,?,?,?,?,?)",
        [telDestino, hashCodigo(telDestino, codigo), ahora + CODIGO_MIN * 60 * 1000, 0, 0, ahora]);
    return { ok: true, codigo, tenant: t, miembro: q.m, telefono: telDestino, vida_min: CODIGO_MIN };
}
/** Texto EXACTO del código (orden owner). */
function textoCodigo(codigo, vidaMin) {
    const c = String(codigo);
    return 'Tu código para entrar a FyraChat es *' + c.slice(0, 3) + ' ' + c.slice(3) + '*. Vence en ' + (vidaMin || CODIGO_MIN) + ' minutos. Fyradrive nunca te pedirá este código. No lo compartas.';
}

/** Verifica el código y abre sesión. Devuelve { ok, token, sid, tenant, maestra } o { ok:false, error }. */
async function entrarConCodigo(telefono, codigo, ua, ip) {
    const v = await verificarCodigo(telefono, codigo);
    if (!v.ok) return v;
    return abrirSesion(v.t, ua, ip, 'codigo', v.m);
}
/** Solo verifica el código (lo quema si es correcto) y dice de quién es: { ok, t, m } o { ok:false, error }. Puerta única para entrarConCodigo y para el pase desde la portada. */
async function verificarCodigo(telefono, codigo) {
    await ensureAcceso();
    const q = await quienPorTelefono(telefono);
    if (!q) return { ok: false, error: 'Código incorrecto.' };   // no revela si el número existe
    const t = q.t, m = q.m; const telDestino = m ? m.telefono : t.telefono;
    // MODO PRUEBA: el tenant demo (config.demo=1) acepta el código fijo (además del normal si existiera). Jamás otro tenant.
    if (DEMO.esDemo(t) && String(codigo || '').replace(/\D/g, '') === DEMO.DEMO_CODIGO) return { ok: true, t, m };
    const ahora = Date.now();
    const filas = await query("SELECT id, codigo_hash, expira, intentos FROM codigos_acceso WHERE telefono = ? AND usado = 0 ORDER BY id DESC LIMIT 1", [telDestino]);
    if (!filas.length || Number(filas[0].expira) < ahora) return { ok: false, error: 'El código venció. Pide otro.' };
    const f = filas[0];
    if (Number(f.intentos) >= CODIGO_MAX_INTENTOS) { await run("UPDATE codigos_acceso SET usado = 1 WHERE id = ?", [f.id]); return { ok: false, error: 'Demasiados intentos. Pide otro código.' }; }
    const okCod = mismaClave(f.codigo_hash, hashCodigo(telDestino, codigo));
    if (!okCod) { await run("UPDATE codigos_acceso SET intentos = intentos + 1 WHERE id = ?", [f.id]); return { ok: false, error: 'Código incorrecto.' }; }
    await run("UPDATE codigos_acceso SET usado = 1 WHERE id = ?", [f.id]);
    return { ok: true, t, m };
}
/** PASE POR CÓDIGO desde la portada (orden owner 2026-09-24: "si no puede entrar el número dado de alta, que se mande código"):
 *  verifica el código y devuelve un pase de un solo uso que abre la sesión en fyrachat (via 'codigo' → pedirá poner contraseña). */
async function crearTicketPorCodigo({ telefono, codigo }) {
    const tel = tel521(telefono); if (!tel) return { ok: false, error: 'Escribe tu WhatsApp de 10 dígitos.' };
    const v = await verificarCodigo(tel, codigo);
    if (!v.ok) return v;
    const t = v.t, m = v.m; const token = nuevoToken(); const ahora = Date.now(); const destino = inicioDe(t, m);
    await run("INSERT INTO tickets_acceso (token_hash, tenant_id, expira, usado, creado, destino, origen, miembro_id) VALUES (?,?,?,?,?,?,?,?)", [sha(token), t.id, ahora + 5 * 60 * 1000, 0, ahora, destino, 'web-codigo', m ? Number(m.id) : null]);
    return { ok: true, token, destino, tenant_id: t.id, miembro_id: m ? Number(m.id) : null };
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
/** TICKET MAESTRO (orden owner 2026-09-10): el Sales Brain (solo el owner, con PIN) abre directo el FyraChat de un vinculado.
 *  Sesión = la del OWNER (maestra); destino = el universo a abrir. Un solo uso, 5 min. Nunca desde la web pública. */
async function crearTicketMaestra(destinoTenantId) {
    await ensureAcceso();
    const owner = await tenantPorTelefono(OWNER_TEL);
    if (!owner) return { ok: false, error: 'El owner no tiene universo dado de alta.' };
    const dest = await tenantPorId(destinoTenantId);
    if (!dest) return { ok: false, error: 'Ese universo no existe o está inactivo.' };
    const token = nuevoToken(); const ahora = Date.now();
    await run("INSERT INTO tickets_acceso (token_hash, tenant_id, expira, usado, creado, destino, origen) VALUES (?,?,?,?,?,?,?)", [sha(token), owner.id, ahora + 5 * 60 * 1000, 0, ahora, String(dest.id), 'sb']);
    return { ok: true, token, expira: ahora + 5 * 60 * 1000, destino: dest.id };
}
/** A dónde cae cada quien al entrar (orden owner 2026-09-23: "te manda directo a donde estés dado de alta"):
 *  miembro → su FyraChat · config.inicio (ruta) si el universo la trae · lote con usuario/tipo lote → panel general · si no → FyraChat. */
function inicioDe(t, miembro) {
    if (miembro) return '/fyrachat.html';   // TODO miembro (también el admin) cae en SU FyraChat; el admin administra el lote desde Más › Vendedores del lote (orden owner 2026-09-23)
    let c = {}; try { c = JSON.parse((t && t.config_json) || '{}') || {}; } catch (e) { }
    if (typeof c.inicio === 'string' && /^\/[a-z0-9_./?=&-]*$/i.test(c.inicio)) return c.inicio;
    if (c.usuario || c.tipo === 'lote') return '/panel.html';
    return '/fyrachat.html';
}
/** LOGIN REMOTO desde fyradrive.com (portada): usuario o teléfono + contraseña → ticket de un solo uso con destino.
 *  Respuesta uniforme; candados por IP del visitante y por cuenta. Solo lo llama el servidor web con K_PANEL. */
async function crearTicketRemoto({ usuario, telefono, contrasena, ip }) {
    await ensureAcceso();
    const ERR = { ok: false, error: 'Usuario o contraseña incorrectos.' };
    const ESPERA = { ok: false, error: 'Demasiados intentos. Espera 10 minutos.', limite: true };
    const u = String(usuario || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, ''); const tel = tel521(telefono);
    if ((!u && !tel) || !String(contrasena || '')) return ERR;
    if ((await contarLimite('remoto:ip:' + String(ip || 'sin-ip'), LIM_CONTRA_IP, MIN10)).excedido) return ESPERA;
    if ((await contarLimite('remoto:cta:' + (u || tel), LIM_CONTRA_TEL, MIN10)).excedido) return ESPERA;
    let t = null, m = null;
    if (u) {
        const todos = await query('SELECT id, nombre, telefono, activo, config_json FROM tenants WHERE activo = 1').catch(() => []);
        t = todos.find(x => { try { return String((JSON.parse(x.config_json || '{}') || {}).usuario || '').toLowerCase() === u; } catch (e) { return false; } }) || null;
        if (!t || !(await verificarContrasena(t.id, contrasena))) { hashContrasena('sin-sal', String(contrasena)); return ERR; }
    } else {
        const q = await quienPorTelefono(tel);
        if (!q || DEMO.esDemo(q.t)) { hashContrasena('sin-sal', String(contrasena)); return ERR; }
        t = q.t; m = q.m;
        const okC = m ? await verificarContrasenaMiembro(m.id, contrasena) : await verificarContrasena(t.id, contrasena);
        if (!okC) return ERR;
    }
    const token = nuevoToken(); const ahora = Date.now(); const destino = inicioDe(t, m);
    await run("INSERT INTO tickets_acceso (token_hash, tenant_id, expira, usado, creado, destino, origen, miembro_id) VALUES (?,?,?,?,?,?,?,?)", [sha(token), t.id, ahora + 5 * 60 * 1000, 0, ahora, destino, 'web', m ? Number(m.id) : null]);
    return { ok: true, token, destino, tenant_id: t.id, miembro_id: m ? Number(m.id) : null };
}
/** Canjea el ticket por una sesión (una sola vez). Devuelve además destino/origen si el ticket los trae. */
async function canjearTicket(token, ua, ip) {
    await ensureAcceso();
    if (!token || String(token).length < 20) return { ok: false, error: 'Ticket inválido.' };
    const h = sha(token);
    const r = await run("UPDATE tickets_acceso SET usado = 1 WHERE token_hash = ? AND usado = 0 AND expira > ?", [h, Date.now()]);   // claim atómico
    if (!Number(r.rowsAffected)) return { ok: false, error: 'Este link ya se usó o venció. Entra con el código que te llega a tu WhatsApp.' };
    const f = await query("SELECT tenant_id, destino, origen, miembro_id FROM tickets_acceso WHERE token_hash = ? LIMIT 1", [h]);
    const t = f.length ? await tenantPorId(f[0].tenant_id) : null;
    if (!t) return { ok: false, error: 'Universo no disponible.' };
    let mT = null;
    if (f[0].miembro_id != null) { const rm = await query("SELECT id, nombre, telefono, rol FROM vendedores_universo WHERE id = ? AND activo = 1 AND tenant_id = ? LIMIT 1", [Number(f[0].miembro_id), Number(t.id)]).catch(() => []); if (!rm.length) return { ok: false, error: 'Ese vendedor ya no está dado de alta.' }; mT = { id: Number(rm[0].id), nombre: rm[0].nombre, telefono: rm[0].telefono, rol: rm[0].rol || 'vendedor' }; }
    const ses = await abrirSesion(t, ua, ip, f[0].origen === 'web-codigo' ? 'codigo' : f[0].origen === 'web' ? (mT ? 'contrasena' : 'usuario') : 'ticket', mT);
    return Object.assign(ses, { destino: f[0].destino || null, origen: f[0].origen || null });
}

// ── SESIONES ───────────────────────────────────────────────────────────────────────────────────
async function abrirSesion(t, ua, ip, via, miembro) {
    const token = nuevoToken(); const ahora = Date.now(); const mid = miembro ? Number(miembro.id) : null;
    const ins = await run("INSERT INTO sesiones_vendedor (token_hash, tenant_id, creada, caduca, ultimo_uso, ua, ip, cerrada, via, miembro_id) VALUES (?,?,?,?,?,?,?,0,?,?)",
        [sha(token), t.id, ahora, ahora + SESION_MAX_DIAS * 86400 * 1000, ahora, String(ua || '').slice(0, 200), String(ip || '').slice(0, 64), String(via || 'codigo'), mid]);
    // TOPE DE DISPOSITIVOS: si el universo ya tiene más de MAX_DISPOSITIVOS sesiones vivas, se cierran las más viejas (por último uso)
    try {
        const vivas = await query("SELECT id FROM sesiones_vendedor WHERE tenant_id = ? AND cerrada = 0 AND caduca > ? AND ultimo_uso > ? ORDER BY ultimo_uso DESC, id DESC",
            [t.id, ahora, ahora - SESION_INACTIVIDAD_DIAS * 86400 * 1000]);
        const sobran = vivas.slice(MAX_DISPOSITIVOS).map(x => Number(x.id));
        if (sobran.length) await run(`UPDATE sesiones_vendedor SET cerrada = 1 WHERE id IN (${sobran.map(() => '?').join(',')})`, sobran);
    } catch (e) { /* el tope nunca impide entrar */ }
    const tiene = mid ? await tieneContrasenaMiembro(mid) : await tieneContrasena(t.id);
    return { ok: true, token, sid: Number(ins.lastInsertRowid) || null, tenant: { id: t.id, nombre: t.nombre, telefono: t.telefono, demo: DEMO.esDemo(t) }, maestra: !mid && esOwner(t), via: String(via || 'codigo'),
        miembro: miembro ? { id: mid, nombre: miembro.nombre, telefono: miembro.telefono } : null,
        contrasena_pendiente: !DEMO.esDemo(t) && !tiene, tiene_contrasena: tiene };
}

// ── CONTRASEÑA (orden owner 2026-09-12) ─────────────────────────────────────────────────────────
// Alta = código por WhatsApp (prueba de que el número es suyo) → crea contraseña (obligatoria) → entra.
// Vuelta = número + contraseña. "Olvidé" = código otra vez → nueva contraseña. El demo (PRUEBAS#) no lleva contraseña.
function hashContrasena(sal, contrasena) {
    return crypto.scryptSync(String(contrasena), String(sal) + '|' + pimienta(), 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}
function validarContrasena(c) {
    const v = String(c == null ? '' : c);
    if (v.length < CONTRA_MIN) return 'Mínimo ' + CONTRA_MIN + ' caracteres.';
    if (v.length > CONTRA_MAX) return 'Máximo ' + CONTRA_MAX + ' caracteres.';
    if (/^(.)\1+$/.test(v) || /^(0123456789|1234567890|12345678|87654321|password|contrasena|contraseña)/i.test(v)) return 'Esa contraseña es demasiado fácil.';
    return null;
}
async function tieneContrasena(tenantId) {
    await ensureAcceso();
    const r = await query("SELECT 1 FROM contrasenas_acceso WHERE tenant_id = ? LIMIT 1", [Number(tenantId)]).catch(() => []);
    return r.length > 0;
}
/** Crea o reemplaza la contraseña del universo. → { ok } | { ok:false, error } */
async function ponerContrasena(tenantId, contrasena) {
    await ensureAcceso();
    const err = validarContrasena(contrasena); if (err) return { ok: false, error: err };
    const sal = crypto.randomBytes(16).toString('hex'); const ahora = Date.now();
    await run(`INSERT INTO contrasenas_acceso (tenant_id, hash, sal, creada, cambiada) VALUES (?,?,?,?,?)
               ON CONFLICT(tenant_id) DO UPDATE SET hash = excluded.hash, sal = excluded.sal, cambiada = excluded.cambiada`,
        [Number(tenantId), hashContrasena(sal, contrasena), sal, ahora, ahora]);
    return { ok: true };
}
// ── contraseña de MIEMBRO (misma receta, tabla aparte) ──
async function tieneContrasenaMiembro(mid) { await ensureAcceso(); const r = await query("SELECT 1 FROM contrasenas_miembro WHERE miembro_id = ? LIMIT 1", [Number(mid)]).catch(() => []); return r.length > 0; }
async function ponerContrasenaMiembro(mid, contrasena) {
    await ensureAcceso(); const err = validarContrasena(contrasena); if (err) return { ok: false, error: err };
    const sal = crypto.randomBytes(16).toString('hex'); const ahora = Date.now();
    await run(`INSERT INTO contrasenas_miembro (miembro_id, hash, sal, creada, cambiada) VALUES (?,?,?,?,?) ON CONFLICT(miembro_id) DO UPDATE SET hash = excluded.hash, sal = excluded.sal, cambiada = excluded.cambiada`, [Number(mid), hashContrasena(sal, contrasena), sal, ahora, ahora]);
    return { ok: true };
}
async function verificarContrasenaMiembro(mid, contrasena) {
    await ensureAcceso(); const r = await query("SELECT hash, sal FROM contrasenas_miembro WHERE miembro_id = ? LIMIT 1", [Number(mid)]).catch(() => []);
    if (!r.length) { hashContrasena('sin-sal', String(contrasena || '')); return false; }
    return mismaClave(String(r[0].hash), hashContrasena(r[0].sal, String(contrasena || '')));
}
/** true si la contraseña es la del universo (comparación en tiempo constante). */
async function verificarContrasena(tenantId, contrasena) {
    await ensureAcceso();
    const r = await query("SELECT hash, sal FROM contrasenas_acceso WHERE tenant_id = ? LIMIT 1", [Number(tenantId)]).catch(() => []);
    if (!r.length) { hashContrasena('sin-sal', String(contrasena || '')); return false; }   // mismo costo aunque no exista (no revela)
    return mismaClave(String(r[0].hash), hashContrasena(r[0].sal, String(contrasena || '')));
}
/** ¿Cómo entra este número? 'contrasena' si ya tiene una; 'codigo' si no (o si el número no existe: no se revela). */
async function modoAcceso(telefono) {
    const q = await quienPorTelefono(telefono);
    if (!q || DEMO.esDemo(q.t)) return { ok: true, modo: 'codigo' };
    const tiene = q.m ? await tieneContrasenaMiembro(q.m.id) : await tieneContrasena(q.t.id);
    return { ok: true, modo: tiene ? 'contrasena' : 'codigo' };
}
/** Entrar con número + contraseña. Respuesta UNIFORME: "Número o contraseña incorrectos." Candados por teléfono e IP. */
async function entrarConContrasena(telefono, contrasena, ua, ip) {
    await ensureAcceso();
    const tel = tel521(telefono);
    const ERR = { ok: false, error: 'Número o contraseña incorrectos.' };
    const ESPERA = { ok: false, error: 'Demasiados intentos. Espera 10 minutos o entra con el código de WhatsApp.', limite: true };
    if (!tel || !String(contrasena || '')) return ERR;
    if ((await contarLimite('contra:ip:' + ip, LIM_CONTRA_IP, MIN10)).excedido) return ESPERA;
    if ((await contarLimite('contra:tel:' + tel, LIM_CONTRA_TEL, MIN10)).excedido) return ESPERA;
    const q = await quienPorTelefono(tel);
    if (!q || DEMO.esDemo(q.t)) { hashContrasena('sin-sal', String(contrasena)); return ERR; }
    const okC = q.m ? await verificarContrasenaMiembro(q.m.id, contrasena) : await verificarContrasena(q.t.id, contrasena);
    if (!okC) return ERR;
    return abrirSesion(q.t, ua, ip, 'contrasena', q.m);
}
/** Sesión viva a partir del token de la cookie: { sid, tenant_id, tenant:{id,nombre,telefono}, maestra } o null.
 *  Viva = no cerrada · caduca > ahora (90 d) · ultimo_uso > ahora − 7 d (deslizante). */
async function sesionDe(token) {
    if (!token) return null;
    await ensureAcceso();
    const ahora = Date.now();
    const r = await query(`SELECT s.id sid, s.ultimo_uso, s.creada, s.via, s.miembro_id, t.id, t.nombre, t.telefono, t.config_json,
                           CASE WHEN s.miembro_id IS NULL THEN (SELECT 1 FROM contrasenas_acceso c WHERE c.tenant_id = t.id) ELSE (SELECT 1 FROM contrasenas_miembro cm WHERE cm.miembro_id = s.miembro_id) END tiene_c,
                           (SELECT m.nombre FROM vendedores_universo m WHERE m.id = s.miembro_id AND m.activo = 1) m_nombre, (SELECT m.telefono FROM vendedores_universo m WHERE m.id = s.miembro_id AND m.activo = 1) m_tel, (SELECT m.rol FROM vendedores_universo m WHERE m.id = s.miembro_id AND m.activo = 1) m_rol
                           FROM sesiones_vendedor s JOIN tenants t ON t.id = s.tenant_id
                           WHERE s.token_hash = ? AND s.cerrada = 0 AND s.caduca > ? AND s.ultimo_uso > ? AND t.activo = 1 LIMIT 1`,
        [sha(token), ahora, ahora - SESION_INACTIVIDAD_DIAS * 86400 * 1000]);
    if (!r.length) return null;
    const s = r[0];
    // si el vendedor quitó el dispositivo desde su WhatsApp, su FyraChat también se cierra (sin WhatsApp no hay universo que operar)
    // un universo SIN número todavía (entra por usuario+contraseña, como TERRA) no puede estar "desvinculado": no hay WhatsApp del cual soltarse
    const desv = s.telefono ? await estaDesvinculado(s.id) : false;
    if (desv) { await cerrarTodas(s.id).catch(() => {}); return { desvinculado: true, tenant: { id: s.id, nombre: s.nombre, telefono: s.telefono } }; }
    if (ahora - Number(s.ultimo_uso || 0) > TOQUE_MIN * 60 * 1000) run("UPDATE sesiones_vendedor SET ultimo_uso = ? WHERE id = ?", [ahora, s.sid]).catch(() => {});   // toque cada 10 min (cuota)
    const demoS = DEMO.esDemo(s); const mid = s.miembro_id != null ? Number(s.miembro_id) : null;
    if (mid && !s.m_nombre) return null;   // el miembro fue dado de baja: su sesión ya no vale
    return { sid: Number(s.sid), tenant_id: s.id, tenant: { id: s.id, nombre: s.nombre, telefono: s.telefono, demo: demoS }, maestra: !mid && String(s.telefono) === OWNER_TEL,
        miembro: mid ? { id: mid, nombre: s.m_nombre, telefono: s.m_tel, rol: s.m_rol || 'vendedor' } : null,
        via: s.via || 'codigo', creada: Number(s.creada) || 0, tiene_contrasena: !!s.tiene_c, contrasena_pendiente: !demoS && !s.tiene_c };   // demo: universo de prueba (nunca maestra ni staff)
}
/** true si el universo (≠0) tiene su WhatsApp DESVINCULADO según el puente (wa_sessions). */
async function estaDesvinculado(tenantId) {
    if (!Number(tenantId)) return false;
    const w = await query("SELECT estado FROM wa_sessions WHERE tenant_id = ? LIMIT 1", [Number(tenantId)]).catch(() => []);
    return !!(w.length && String(w[0].estado) === 'desvinculado');
}
async function cerrarSesion(token) { if (!token) return; await ensureAcceso(); await run("UPDATE sesiones_vendedor SET cerrada = 1 WHERE token_hash = ?", [sha(token)]); }
async function cerrarTodas(tenantId) { await ensureAcceso(); await run("UPDATE sesiones_vendedor SET cerrada = 1 WHERE tenant_id = ? AND cerrada = 0", [Number(tenantId)]); }
/** Barredor (cron): cierra de un golpe las sesiones de universos cuyo WhatsApp está desvinculado. Devuelve n. */
async function barrerSesionesDesvinculadas() {
    await ensureAcceso();
    const r = await run("UPDATE sesiones_vendedor SET cerrada = 1 WHERE cerrada = 0 AND tenant_id IN (SELECT tenant_id FROM wa_sessions WHERE estado = 'desvinculado')");
    return Number(r && r.rowsAffected) || 0;
}
/** Sesiones VIVAS del universo, para "Tus dispositivos": [{ id, creada, ultimo_uso, navegador, ip_mascara, actual }]. */
async function listarSesiones(tenantId, sidActual) {
    await ensureAcceso();
    const ahora = Date.now();
    const r = await query(`SELECT id, creada, ultimo_uso, ua, ip FROM sesiones_vendedor
                           WHERE tenant_id = ? AND cerrada = 0 AND caduca > ? AND ultimo_uso > ? ORDER BY ultimo_uso DESC LIMIT 50`,
        [Number(tenantId), ahora, ahora - SESION_INACTIVIDAD_DIAS * 86400 * 1000]);
    return r.map(s => ({ id: Number(s.id), creada: Number(s.creada), ultimo_uso: Number(s.ultimo_uso), navegador: resumenUA(s.ua), ip_mascara: ipMascara(s.ip), actual: Number(s.id) === Number(sidActual) }));
}

// ── AVISO DE SESIÓN NUEVA (por WhatsApp, desde el número de Fyradrive) ─────────────────────────
/** "Chrome en iPhone", "Safari en Mac", … a partir del user-agent. */
function resumenUA(ua) {
    const s = String(ua || '');
    if (!s) return 'un navegador';
    let disp = 'computadora';
    if (/iPhone/i.test(s)) disp = 'iPhone'; else if (/iPad/i.test(s)) disp = 'iPad'; else if (/Android/i.test(s)) disp = 'Android';
    else if (/Macintosh|Mac OS/i.test(s)) disp = 'Mac'; else if (/Windows/i.test(s)) disp = 'Windows'; else if (/Linux/i.test(s)) disp = 'Linux';
    let nav = 'un navegador';
    if (/Edg\//i.test(s)) nav = 'Edge'; else if (/OPR\/|Opera/i.test(s)) nav = 'Opera'; else if (/Firefox\//i.test(s)) nav = 'Firefox';
    else if (/Chrome\/|CriOS/i.test(s)) nav = 'Chrome'; else if (/Safari\//i.test(s)) nav = 'Safari';
    return nav + ' en ' + disp;
}
function horaMonterrey(ts) {
    try { return new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Monterrey', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(ts || Date.now())); }
    catch (e) { const d = new Date((ts || Date.now()) - 6 * 3600000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); }
}
/** Tras abrirSesion: avisa por WhatsApp al dueño del universo. Se omite si OTRA sesión del mismo tenant nació hace <10 min. Best-effort. */
async function avisarSesionNueva(t, ua, ip, sid, miembro) {
    try {
        if (miembro && miembro.telefono) t = Object.assign({}, t, { telefono: miembro.telefono });   // el aviso va al WhatsApp del miembro
        if (!t || !t.telefono) return { ok: false, motivo: 'sin tenant' };
        if (DEMO.esDemo(t)) return { ok: true, omitido: true, demo: true };   // MODO PRUEBA: nada sale a WhatsApp
        // Sin número propio de Fyradrive (el 0 sin teléfono, 2026-09-23) el aviso saldría por el número de un lote (TERRA) y le ensuciaría
        // el FyraChat con "Entraste a tu FyraChat…" → se omite hasta que Fyradrive vuelva a tener número.
        { const t0 = await query("SELECT telefono FROM tenants WHERE id = 0").catch(() => []); if (t0.length && !t0[0].telefono) return { ok: true, omitido: true, sin_numero_casa: true }; }
        const otras = await query("SELECT COUNT(*) n FROM sesiones_vendedor WHERE tenant_id = ? AND creada > ? AND id != ?", [Number(t.id), Date.now() - MIN10, Number(sid) || 0]);
        if (Number(otras[0] && otras[0].n) > 0) return { ok: true, omitido: true };
        const txt = 'Entraste a tu FyraChat desde ' + resumenUA(ua) + ' a las ' + horaMonterrey() + '. Si no fuiste tú, responde CERRAR y se cierran todas las sesiones.';
        const { enviarWA } = require('./citas-vivas.js');   // lazy: evita ciclos de require
        return await enviarWA(String(t.telefono), txt, 0);
    } catch (e) { console.error('[acceso aviso]', e.message); return { ok: false, error: e.message }; }
}

// ── BITÁCORA (1 INSERT best-effort; jamás rompe la acción) ─────────────────────────────────────
async function accesosLog({ sesion_id, tenant_id, action, ip }) {
    try {
        await ensureAcceso();
        await run("INSERT INTO accesos_log (ts, sesion_id, tenant_id, action, ip) VALUES (?,?,?,?,?)",
            [Date.now(), sesion_id == null ? null : Number(sesion_id), tenant_id == null ? null : Number(tenant_id), String(action || '').slice(0, 60), String(ip || '').slice(0, 64)]);
    } catch (e) { /* silencioso */ }
}

// ── COOKIE ─────────────────────────────────────────────────────────────────────────────────────
function leerCookie(req) {
    const c = String((req.headers && req.headers.cookie) || '');
    const m = c.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
}
function ponerCookie(res, token) {
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESION_MAX_DIAS * 86400}; HttpOnly; Secure; SameSite=None`);   // SameSite=None: fyradrive.com puede preguntar (con CORS) si ya hay sesión y entrar directo
}
function borrarCookie(res) { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`); }
/** DISPOSITIVO DEL OWNER (orden owner 2026-09-24: "yo entro y salgo de todas las cuentas para verificar, sin que notifique"):
 *  cuando el owner abre sesión en un navegador (su número o la maestra), ese navegador queda marcado con una cookie de 400 días y
 *  ninguna sesión que se abra ahí manda el aviso de "Entraste a tu FyraChat…". No da acceso a nada: solo calla el aviso. */
const COOKIE_DEV = 'fyra_dev';
function tokenDispositivoOwner() { return sha(pimienta() + '|dispositivo-owner|v1'); }
function esSesionDelOwner(r) { return !!(r && (r.maestra || String(r.tenant && r.tenant.telefono) === OWNER_TEL || String(r.miembro && r.miembro.telefono) === OWNER_TEL)); }
function marcarDispositivoOwner(res) {
    const prev = res.getHeader('Set-Cookie'); const nuevo = `${COOKIE_DEV}=${tokenDispositivoOwner()}; Path=/; Max-Age=${400 * 86400}; HttpOnly; Secure; SameSite=None`;
    res.setHeader('Set-Cookie', [].concat(prev || [], nuevo));
}
function esDispositivoOwner(req) {
    const c = String((req.headers && req.headers.cookie) || ''); const m = c.match(new RegExp('(?:^|;\\s*)' + COOKIE_DEV + '=([^;]+)'));
    return !!(m && mismaClave(decodeURIComponent(m[1]), tokenDispositivoOwner()));
}

module.exports = {
    abrirSesion,
    tieneContrasena, ponerContrasena, verificarContrasena, modoAcceso, miembroPorTelefono, quienPorTelefono, tieneContrasenaMiembro, ponerContrasenaMiembro, verificarContrasenaMiembro, entrarConContrasena, validarContrasena, MAX_DISPOSITIVOS, CONTRA_MIN,
    ensureAcceso, estaDesvinculado, tel521, tenantPorTelefono, tenantPorId,
    pedirCodigo, textoCodigo, entrarConCodigo, verificarCodigo, crearTicketPorCodigo, crearTicket, crearTicketMaestra, crearTicketRemoto, canjearTicket, inicioDe,
    sesionDe, cerrarSesion, cerrarTodas, barrerSesionesDesvinculadas, listarSesiones,
    avisarSesionNueva, resumenUA, accesosLog, contarLimite,
    mismaClave, ipDe, leerCookie, ponerCookie, borrarCookie, esOwner, esSesionDelOwner, marcarDispositivoOwner, esDispositivoOwner,
    OWNER_TEL, COOKIE, SESION_INACTIVIDAD_DIAS, SESION_MAX_DIAS, CODIGO_MIN
};
