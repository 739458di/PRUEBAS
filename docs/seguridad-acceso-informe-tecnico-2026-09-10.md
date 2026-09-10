# Informe técnico — Threat model del acceso al FyraChat de vendedores (Agente A, 2026-09-10)
Leyenda: [V] verificado en código · [S] supuesto/inferencia.

## 1. Inicio de sesión
Código de 6 dígitos — lib/seb/acceso.js:74-102. Entropía 10^6, vida 3 min, 5 intentos por código, 3 códigos/10 min por teléfono. Hash con pimienta; timingSafeEqual. Sin límite por IP en acceso_pedir (api/seb-panel.js:170-179): cualquiera que conozca el número puede pedirlo. Cada petición mata el código vivo anterior → un tercero puede invalidar el código del vendedor y agotar sus 3/10 min (bloqueo de login). Texto del mensaje no dice "no lo compartas ni con Fyradrive". Respuesta 404 vs 200 = oráculo de qué números tienen universo.
Ticket — acceso.js:106-125. 32 bytes, 15 min, claim atómico [V]. Solo viaja al WhatsApp vinculado; con key y sin `enviar`, la URL se devuelve al llamador (:208). Canje por GET: cualquier prefetch de link quema el ticket [S]; solo pierde disponibilidad.
Cookie — HttpOnly, Secure, SameSite=Lax, 30 días fijos (sin renovación ni expiración por inactividad). Sin atadura a IP/UA. Revocación: solo botón Salir; cerrarTodas no se llama desde ningún lado. Desvinculación: cierra sesiones solo si wa_sessions='desvinculado' Y alguien hace un request en esa ventana; si el vendedor se re-vincula antes, las cookies viejas reviven.

## 2. Autorización durante el uso
- Regla central seb-panel.js:162-167 [V]: sesión no-maestra → VEND_PARAM forzado; maestra o key → ?vendedor= libre. Sin sesión, sin key y sin vendedor → tenant 0 ABIERTO: chats, chat, sugerir, accion_boton, foco_cambiar, agregar_mensaje, flag_msg, delegar… operan el FyraChat de Fyradrive sin autenticación.
- agregar_mensaje usa 'whatsapp:'+tel sin sufijo de tenant y sin candado: cualquiera inserta mensajes falsos en la libreta de tenant 0.
- acceso_ticket con key = fabricar sesión de cualquier universo, incluido el del owner (tenant 2 → maestra). La key es la misma SELLER_BRIDGE_KEY/'fyra-bridge-v2-2026' hardcodeada en puente y SALES-BRAIN. Quien lea cualquiera de los repos la tiene [S fuerte].
- Key en query string → logs/Referer.
- CORS * sin credentials; SameSite Lax → CSRF bajo [V]. Residual: acciones de tenant 0 no necesitan cookie → cualquier sitio puede llamarlas.
- Puente: /status y /qr compat SIN key: lista de universos y el QR del tenant 0 cuando espera re-escaneo. HTTP plano en IP pública: la key viaja en claro.

## 3. Alta pública
- route.ts limita (alta 6/IP, 4/tel; código 8/IP, 6/tel) pero en memoria por instancia → evadible.
- Peor: Sales Brain upload.js tenant_alta/tenant_codigo/tenant_sesion SIN autenticación ni rate limit y CORS *. Un curl directo salta todos los límites: crea universos a nombre de terceros, dispara WhatsApp del número de Fyradrive al teléfono víctima y consulta el estado de vinculación de cualquier número.
- tenant_codigo sobre un tenant ya vinculado pero momentáneamente desconectado → limpiarAuth borra credenciales → desvinculación forzada de la víctima.
- Ids secuenciales + tenant_info = enumeración total. `buscar` revela los autos de cualquier teléfono.
- Quien hace el alta nunca recibe la sesión [V, correcto], pero controla cuándo y cómo se le pide a la víctima que teclee algo.

## 4. Amarre persona ↔ uso
Lo único que prueba "tiene el teléfono" es leer un WhatsApp durante 3 min (código) o 15 min (ticket). Se rompe con: código compartido/phishing, dispositivo prestado con cookie de 30 días, cookie exfiltrada, key compartida (fabrica sesión sin teléfono), sesión maestra (mismo 6 dígitos, sin segundo factor, alcance total). El puente como dispositivo vinculado ve todo el WhatsApp aunque solo persista chats delegados: compromiso del VPS = todos los WhatsApp.
Bitácora: sesiones_vendedor guarda ua, creada, ultimo_uso — sin IP, sin qué acción hizo cada sesión; mensajes no lleva sesion_id; acciones registra actor 'bot'/'fyrachat' sin la sesión. Reconstruir "quién mandó ese mensaje desde ese universo" hoy no es posible.

## 5. Escenarios (actor → obtiene · prob · impacto → contramedida)
1 JP con el número de la víctima: tenant_alta+tenant_codigo (web o curl a upload.js) → universo a nombre suyo, WhatsApp "oficial" a la víctima, oráculo · Alta · Medio → key en upload.js tenant_*; solo desde route.ts
2 JP + phishing: pide acceso_pedir (sin límite IP) y le escribe "Fyradrive: reenvíame el código" → sesión 30 días en el universo de la víctima; manda mensajes desde SU número · Media · Alto → texto "nunca lo compartas, ni con Fyradrive"; límite IP; aviso WA al abrir sesión nueva
3 Vendedor comparte código (asistente) → tercero opera indefinidamente · Alta · Medio → lista de sesiones + cerrar todas; expiración por inactividad
4 Robo de cookie → 30 días sin revocación · Baja · Alto → inactividad 7 días, cerrar-todas, notificar sesión nueva
5 Enumeración: /status sin key; acceso_pedir 404/200; ids secuenciales; buscar → padrón de vendedores, teléfonos, autos · Alta · Bajo/Medio → key en /status, respuesta uniforme
6 Key compartida (repo, log, sniff HTTP): acceso_ticket {telefono: OWNER_TEL} sin enviar → SESIÓN MAESTRA + /api/send desde cualquier universo · Media · Crítico → rotar key a env real; separar key puente vs "mint sesión"; acceso_ticket solo con enviar:1
7 Maestra comprometida → todos los universos + tenant 0 · Baja · Crítico → segundo factor para maestra, vida corta 24 h
8 Ticket interceptado (preview/proxy/pantalla) → sesión víctima 30 días · Baja · Alto → canje por POST tras pantalla intermedia; cerrar-todas
9 Dispositivo perdido con FyraChat en inicio → operar hasta 30 días · Media · Alto → desvincular WhatsApp debe cerrar sesiones SIEMPRE (barredor)
10 Desvinculación/re-vinculación → cookies viejas reviven · Media · Medio → cerrarTodas al detectar desvinculado y al tenant_alta de tenant existente
11 Desvinculación forzada: tenant_codigo sin auth mientras la víctima está reconectando → limpiarAuth · Media · Medio → no limpiar auth si registered; auth en upload.js
12 Tenant 0 sin candado: cualquier navegador sin sesión → leer/escribir chats de Fyradrive, agregar_mensaje, delegar, botones · Alta · Alto → exigir sesión maestra para tenant 0

## 6. Contramedidas priorizadas
HOY (≈4-6 h): (a) key real en env de los tres repos + puente y rotarla; (b) auth en upload.js tenant_* y en /status,/qr del puente; (c) acceso_ticket solo con enviar:1, nunca devolver URL; (d) límite por IP en acceso_pedir y respuesta uniforme; (e) texto del código con advertencia; (f) no limpiarAuth si creds.registered.
ESTA SEMANA (≈10-14 h): tenant 0 detrás de la maestra; cerrarTodas en desvinculación (barredor en seb-cron) y en re-alta; expiración por inactividad 7 días + lista de sesiones con "cerrar todas"; bitácora IP+sesion_id en sesiones/mensajes/acciones; aviso por WhatsApp "se abrió una sesión nueva en X".
DESPUÉS: segundo factor y vida corta para la maestra; key distinta puente vs panel, TLS en el puente; rate limit persistente en Turso; canje de ticket por POST; acciones de tenant 0 con sufijo de universo.
