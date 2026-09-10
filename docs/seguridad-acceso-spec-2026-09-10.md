# ESPEC. ANTI-HACKEO — Agente A → Agente B (2026-09-10)
(ver texto íntegro abajo; invariantes, inventario de llamadores, bloques 1–6, orden de despliegue, riesgos)

## INVARIANTES
1. NUNCA una key literal en código; SIEMPRE process.env.K_PUENTE / K_PANEL / CRON_KEY; si falta → falla cerrada (fyrachat/SB: 503 {error:'K_x no configurada'}; puente: process.exit(1) FATAL).
2. NUNCA key por query string ni por body; SIEMPRE header x-api-key (excepción transitoria KEY_VIEJA).
3. K_PANEL NUNCA vive en el VPS; K_PUENTE NUNCA abre sesiones ni acceso_*.
4. Tenant 0 SIEMPRE exige sesión maestra (OWNER_TEL) o teléfono en STAFF_TELS, o K_PUENTE/K_PANEL según acción; sin eso → 401 {login:true}.
5. acceso_ticket SIEMPRE enviar:1, NUNCA devuelve URL, SOLO K_PANEL.
6. NUNCA limpiarAuth sobre creds.registered=true salvo wa_sessions.estado='desvinculado'.
7. acceso_pedir SIEMPRE responde igual exista o no el número.
8. Toda escritura con cookie SIEMPRE registra sesion_id+ip (accesos_log); GET no escribe (cuota).
9. Desvinculado o re-alta ⇒ SIEMPRE cerrarTodas(tenant).

## INVENTARIO DE LLAMADORES (key actual → nueva)
- Puente v3 (líneas ~671,727,785,864,873,906,1059,1459/1462/1487) → seb-panel carga_pieza, recepcion_foto, rescate_manual, cierre_timbre, cita_entrante, rescate_turno, casilla_ejecutar, casillas_pendientes: body/query 'fyra-bridge-v2-2026' literal → header K_PUENTE
- Puente ~716,1018,1106 → seb-panel recepcion_activa, opener_auto, ghost_scan: SIN key → header K_PUENTE
- Puente ~382 → SB upload ingesta (external_id): SALESBRAIN_KEY, SB no la verifica → header K_PUENTE (SB verifica solo si env SB_EXIGIR_INGESTA=1, fase posterior)
- fyrachat libs citas-vivas.js:358,463, timbre.js:7, seb-panel :607,1665,1890,2109,2144 → puente /api/send, /api/send-fotos, /api/programar, /api/emit, /tenant/*/delegar|soltar: BRIDGE_API_KEY (env) || literal → header K_PUENTE (env K_PUENTE)
- fyrachat carga-lote.js:144, recepcion.js:809, citas-vivas.js:1035 → web publish-batch (particular), SB registrar_cita_canonica: body literal → header K_PANEL (web y SB verifican K_PANEL)
- SB upload.js:1907-1933,2084,2120,2745, cita-extractor.js, timbre.js → puente /tenant/*/open|codigo, /qr/<id>, /api/send, /api/emit: SELLER_BRIDGE_KEY||literal → header K_PUENTE
- SB direccion.js:75, upload.js:2519,2588,2661 → seb-panel casillas_estado, cancelar_match_manual, match_directo: body literal → header K_PANEL
- SB calendar.html (navegador) → seb-panel rescate_agenda, prog_machote, prog_crear, prog_cancelar, rescate_cancelar, rescate_reactivar, cita_vendedor_*, confirmar_match, timbre_url: sin nada → proxy upload.js action:'fyrachat_proxy' con cookie sb_admin → header K_PANEL (timbre_url pública)
- SB index.html:4930,4942, tenantQR → SB tenant_alta/tenant_codigo/tenant_qr/tenant_sesion: sin nada → cookie sb_admin
- web vinculacion/route.ts salesBrain() → SB tenant_alta/codigo/sesion, usuarios_vinculados_add: sin nada → header K_PANEL
- web vinculacion/route.ts ticketFyrachat() → seb-panel acceso_ticket: body FYRACHAT_PANEL_KEY → header K_PANEL (env K_PANEL)
- web admin/crm-pending/route.ts → seb-panel recepcion_pendientes/publicar/rechazar: SIN key → header K_PANEL (ya tras cookie admin de la web)
- crontab VPS → seb-cron?key=fyra-cron-2026: literal → curl -H "x-api-key: $CRON_KEY"; código lee process.env.CRON_KEY
- copilot.html (navegador, mismo origen) → chats, chat, ubic_img, tenant_info, delegar, soltar, nuevo_chat, foco_cambiar, accion_boton, sugerir, resolver, manual_directo, agregar_mensaje, flag_msg, prog_crear, prog_machote, acceso_*, timbre_url: → SESIÓN (tenant 0 = maestra/STAFF)
- sandbox.html → api/seb-sandbox.js (fuera de alcance)
- Claude/scripts → flags_msgs(_done), citas_backfill, universo_backfill, casillas_pendientes → header K_PANEL

Clasificación seb-panel: PÚBLICA: acceso_yo/pedir/entrar/salir/canjear, timbre_url. K_PUENTE (solo puente): opener_auto, ghost_scan, recepcion_activa, recepcion_foto, carga_pieza, rescate_turno, rescate_manual, cierre_timbre, cita_entrante, casilla_ejecutar, casillas_pendientes. K_PANEL: acceso_ticket, acceso_cerrar_todas_tenant, recepcion_*, casillas_estado, cancelar_match_manual, match_directo, confirmar_match, cita_vendedor_*, rescate_agenda/cancelar/reactivar, prog_*, flags_msgs*, *_backfill. SESIÓN: todo lo demás (las K_PANEL también aceptan sesión maestra).

## BLOQUE 1 — LLAVES
- api/seb-panel.js handler: sustituir KEY_PANEL/conKey/KEY_PUENTE/BRIDGE_KEY_T por: const hdr = String(req.headers['x-api-key']||''); conPuente = env.K_PUENTE && hdr===env.K_PUENTE; conPanel = env.K_PANEL && hdr===env.K_PANEL; transición: || (env.KEY_VIEJA && (body.key||query.key)===env.KEY_VIEJA) con console.warn('[key-vieja]',action). Comparar con crypto.timingSafeEqual sobre sha256 de ambos. Borrar TODAS las comparaciones locales (≈:443,464,480,495,512,585,654,2072,2089) → usar conPuente. Cada acción con key declara su conjunto; acceso_ticket: if(!conPanel) 401; if(!req.body.enviar) 400 'enviar:1 requerido'; respuesta {ok, enviado, expira, primera} sin url.
- lib/seb/citas-vivas.js enviarWA/programarCasillas, timbre.js, carga-lote.js, recepcion.js: const K = process.env.K_PUENTE; if(!K) return {ok:false,error:'K_PUENTE no configurada'}; publish-batch y SB con K_PANEL.
- api/seb-cron.js: hdr===env.CRON_KEY (transición query.key===env.KEY_VIEJA_CRON).
- Pruebas: acceso_ticket con K_PUENTE → 401; con K_PANEL sin enviar → 400; con enviar:1 → 200 sin url; casilla_ejecutar con ?key= (query) → 401; header → 200.

## BLOQUE 2 — CANDADO TENANT 0
- seb-panel tras resolver VEND_PARAM: const t0 = !VEND_PARAM; const STAFF = (env.STAFF_TELS||'').split(',').map(tel521).filter(Boolean); const mandaEnT0 = SES && (SES.maestra || STAFF.includes(SES.tenant.telefono)). Regla única antes de olvidar(): if (!ABIERTAS.has(action) && !conPuente && !conPanel && (t0 ? !mandaEnT0 : !SES)) return 401 {login:true}. STAFF con ?vendedor=0 → tenant 0; STAFF con ?vendedor=N≠0 → 403. Maestra sin ?vendedor= sigue abriendo tenant 2.
- copilot.html cargarTenant(): si !SESION → mostrarAcceso() SIEMPRE (también sin ?vendedor=); quitar el "sin nada = tenant 0".
- Pruebas: chats sin cookie → 401; cookie de vendedor tenant 3 + ?vendedor=0 → 401; maestra + ?vendedor=0 → 200; agregar_mensaje sin cookie → 401; opener_auto sin header → 401, con K_PUENTE → 200.

## BLOQUE 3 — PUERTA DEL SB
- upload.js acciones tenant_alta/tenant_codigo/tenant_qr/tenant_sesion/usuarios_vinculados_add/fyrachat_proxy: okPanel = hdr===K_PANEL (servidor web) o okAdmin = cookie sb_admin válida; si no → 401 {login:true}.
- Admin mínimo: env SB_ADMIN_PIN; acción sb_login {pin} → timingSafeEqual → token 32B en tabla sb_admin_sesiones(token_hash, creada, ultimo_uso, ip); cookie sb_admin HttpOnly Secure SameSite=Lax 90d; sb_logout. Intentos: 5/10 min por IP en tabla compartida rate_limits(clave PK, n, hasta) (UPSERT único). index.html api(): si {login:true} → prompt('PIN') → sb_login → reintenta. POST con cookie exige Origin === https://sales-brain-theta.vercel.app.
- fyrachat_proxy {accion, ...}: allowlist exacta; reenvía a seb-panel con header K_PANEL; calendar.html cambia FYRA por /api/upload + action:'fyrachat_proxy'.
- tenant_codigo: en puente codigoVinculacion(): if (creds.registered && (await estadoSesion(tenant.id)) !== 'desvinculado') return {ok:false, vinculado:true, error:'ya está vinculado'} ANTES de cualquier limpiarAuth; SB reenvía vinculado:true y NO manda WhatsApp. tenant_alta sobre tenant existente: UPDATE sesiones_vendedor SET cerrada=1 WHERE tenant_id=? + UPDATE tenants SET activo=1.
- Pruebas: tenant_alta sin nada → 401; con K_PANEL → 200; tenant_codigo de tenant registered desconectado → {ok:false,vinculado:true} y creds intactas; estado='desvinculado' → código nuevo.

## BLOQUE 4 — PUENTE
- wa-bridge-v3.js: SEND_KEY = process.env.K_PUENTE; si vacío → console.error('FATAL: falta K_PUENTE en /root/wa-bridge/.env'); process.exit(1). /status y /qr (compat) → if(!conKey) 401. Todas las salidas a seb-panel: header x-api-key: SEND_KEY, sin key en body (transición: body.key = process.env.KEY_VIEJA si existe). SB_KEY = process.env.K_PUENTE. CASILLA_KEY eliminado. deploy.sh: abortar si .env no tiene K_PUENTE; su curl /status con header. ecosystem.config.js: pasar K_PUENTE, KEY_VIEJA.
- Pruebas: /status sin header → 401; con header → JSON; /qr sin header → 401.

## BLOQUE 5 — SESIONES
- acceso.js: SESION_INACTIVIDAD_DIAS=7, SESION_MAX_DIAS=90; abrirSesion(t, ua, ip) guarda ip (ALTER ADD COLUMN ip TEXT idempotente); sesionDe filtra ultimo_uso > ahora-7d AND caduca > ahora y devuelve sid; cookie Max-Age 90d. pedirCodigo(tel, ip): UPSERT en rate_limits claves ap:ip:<ip> (10/10 min, 30/día) y ap:tel:<tel> (3/10 min); sin tenant → {ok:true, silencioso:true}. seb-panel acceso_pedir responde SIEMPRE 200 {ok:true, vida_min:3, tel_mascara} (429 solo por límite de IP). IP = x-forwarded-for[0] || x-real-ip.
- Texto: "Tu código para entrar a FyraChat es *123 456*. Vence en 3 minutos. Fyradrive nunca te pedirá este código. No lo compartas."
- cerrarTodas: en sesionDe (desvinculado); nuevo barrerSesionesDesvinculadas() en seb-cron (rama cadaHora): UPDATE sesiones_vendedor SET cerrada=1 WHERE cerrada=0 AND tenant_id IN (SELECT tenant_id FROM wa_sessions WHERE estado='desvinculado').
- Nuevas acciones (sesión): acceso_sesiones GET → [{id, creada, ultimo_uso, navegador, ip_mascara, actual}]; acceso_cerrar_todas POST → cerrarTodas(SES.tenant_id) + borrarCookie. copilot: botón "Tus dispositivos" junto a "Salir" (lista + "Cerrar todas las sesiones").
- Aviso: avisarSesionNueva(t, ua, ip) tras abrirSesion en acceso_entrar y acceso_canjear: navegador = resumenUA(ua); hora Monterrey; enviarWA(t.telefono, 'Entraste a tu FyraChat desde {navegador} a las {hora}. Si no fuiste tú, responde CERRAR y se cierran todas las sesiones.', 0); omitir si otra sesión del tenant nació hace <10 min.
- CERRAR: el mensaje llega al tenant 0 → puente llama opener_auto {telefono}. En seb-panel opener_auto, PRIMERA compuerta: texto = último entrante; if (/^\s*cerrar[.!]?\s*$/i.test(texto)) y ACC.tenantPorTelefono(tel) existe → cerrarTodas(t.id), accesos_log(action:'cerrar_wa'), enviarWA(tel,'Listo: cerré todas las sesiones de tu FyraChat. Para entrar de nuevo pide un código.',0), return {ok:true, acceso_cerrado:true} sin despertar bot.
- Bitácora: accesos_log(id, ts, sesion_id, tenant_id, action, ip) — 1 INSERT best-effort solo en POST con SES; acciones ADD COLUMN sesion_id INTEGER; acciones.registrar({...,sesion_id}) desde foco_cambiar, delegar, soltar, accion_boton, prog_crear con SES.sid.

## BLOQUE 6 — CSRF/CORS
- seb-panel: quitar Access-Control-Allow-Origin:*; solo si Origin ∈ env.CORS_ORIGENES (vacío por defecto) → ACAO=<origin>, Vary:Origin, Allow-Credentials:true, headers Content-Type, x-api-key. POST con cookie: si hay Origin y ≠ https://fyrachat.vercel.app → 403. SB upload.js: misma regla con su origen. acceso_canjear sigue GET.

## ORDEN DE DESPLIEGUE (sin downtime)
0. Generar K_PUENTE, K_PANEL, CRON_KEY, SB_ADMIN_PIN.
1. Envs: fyrachat K_PUENTE, K_PANEL, CRON_KEY, STAFF_TELS=, CORS_ORIGENES=, KEY_VIEJA=fyra-bridge-v2-2026, KEY_VIEJA_CRON=fyra-cron-2026; fyradrive K_PANEL; SB K_PUENTE, K_PANEL, SB_ADMIN_PIN; VPS .env K_PUENTE, KEY_VIEJA (conservar BRIDGE_API_KEY hasta el paso 6).
2. Puente (deploy.sh): acepta K_PUENTE o KEY_VIEJA; manda header + body.key=KEY_VIEJA.
3. fyrachat (vercel CLI): acepta headers nuevos o KEY_VIEJA; candado tenant 0 ON.
4. SB (push) y fyradrive-web (push): headers nuevos; calendar por proxy; PIN.
5. crontab: */10 * * * * curl -s -H "x-api-key: $CRON_KEY" https://fyrachat.vercel.app/api/seb-cron
6. Tras 60 min sin líneas [key-vieja]: borrar KEY_VIEJA*, BRIDGE_API_KEY, SELLER_BRIDGE_KEY, FYRACHAT_PANEL_KEY, SALESBRAIN_KEY; redeploy + pm2 restart. Aquí muere la key vieja.

## RIESGOS Y DETECCIÓN EN 5 MIN
- Puente sin K_PUENTE → sale: pm2 status + curl -H x-api-key /status.
- Owner bloqueado del tenant 0: probar copilot.html?vendedor=0 con maestra antes del paso 4.
- Calendar roto entre pasos 3-4: abrir calendar.
- Cron mal: curl -H al seb-cron → JSON.
- Mensaje real: tel de prueba del carril → opener_auto sin 401.
- Alta web: /seb con tel de prueba → código llega; acceso_ticket 200 enviado:true.
