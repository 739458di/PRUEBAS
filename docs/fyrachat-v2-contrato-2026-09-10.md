# FYRACHAT v2 — CONTRATO FRONT ⇄ BACK (2026-09-10). Ambos agentes lo cumplen AL PIE DE LA LETRA.

## Principios (orden del owner)
INTENCIÓN → UNA PUERTA → VALIDACIÓN → IDEMPOTENCIA → EJECUCIÓN → RESULTADO → REINTENTO. La UI nunca decide el destino: manda `chat_id` + `clave`; el servidor resuelve de nuevo (tenant de la sesión, chat del tenant, teléfono, auto en foco, delegación) antes de ejecutar. Sin toasts de éxito; la burbuja es la confirmación. Sin alert/prompt/confirm.

## Identidad
- Sesión por cookie `fyra_v` (ya existe). El tenant SIEMPRE sale de la sesión (o maestra con ?vendedor=). `chat_id` = `conversaciones.id` (hilo `whatsapp:<tel>` en t0, `whatsapp:<tel>#t<id>` en tenant≠0). Nunca teléfono como identidad en el cliente.
- `clave` de idempotencia: string generado por el cliente `<accion>:<chat_id>:<uuid>`; el servidor la guarda en `envios(clave PK, tenant_id, chat_id, accion, estado, resultado_json, ts)`; repetir la misma clave devuelve el mismo resultado sin ejecutar dos veces.

## Endpoints (todos en /api/seb-panel, mismo origen, JSON; GET por query, POST por body con `action`)
1. GET `inbox` `&q=<texto>&filtro=todos|sugerencia|compradores&cursor=<ts>&limit=40`
   → `{ok, chats:[{chat_id, telefono, nombre, ini, ult_texto, ult_dir:'in'|'out', ult_emisor, ult_ts, no_leidos, sugerencia:bool, delegado:bool, auto:{id,nombre,precio,portada}|null, bot:'seb'|'humano'|'pausado'|'n/a', ghost_dias:int|null}], cursor_next:<ts>|null}`
   Cada fila = SOLO datos de ESA conversación (ult_* de conversaciones por id). Búsqueda por nombre/teléfono en servidor.
2. GET `hilo` `&chat_id=&antes=<ts>&limit=40`
   → `{ok, chat:{chat_id, telefono, nombre, ini, auto:{...}|null, autos_disponibles:[{id,nombre,precio,portada}], bot:'seb'|'humano'|'pausado'|'n/a', delegado, ghost_dias, no_leidos}, mensajes:[{id, msg_id, dir, emisor:'comprador'|'dueno'|'asistente'|'sistema'|'bot', texto, ts, media:{tipo:'imagen'|'ubicacion'|'audio', url}|null, estado:'enviando'|'enviado'|'error'}], hay_mas:bool}`
   Sin `antes` = últimos `limit`. Marca leído (no_leidos=0) al pedir sin `antes`.
3. POST `enviar` `{chat_id, texto, clave}` → `{ok, mensaje:{id,msg_id,ts,estado}}` | `{ok:false,error}`. Pasa por `mensajeria.enviar`.
4. POST `foco` `{chat_id, auto_id}` → `{ok, auto:{...}}` (valida catálogo del tenant).
5. POST `delegar_v2` `{telefono, nombre?, auto_id, entrada:{modo:'silencio'|'texto'|'bot'|'info'|'fotos'|'ubicacion'|'cotizar'|'cita', texto?, enganche?, fecha_iso?, hora?}, clave}` → `{ok, chat_id, telefono, nombre, ya_delegado, accion_ejecutada?, enviado?}`. Reutiliza `delegar` actual (puente) + `ejecutarAccion`.
6. POST `cotizar_v2` `{chat_id, enganche, plazo?:36|48|60, clave}` → `{ok, texto_tarjeta, enviado}` (usa ejecutarAccion 'cotizar').
7. POST `cita_v2` `{chat_id, fecha_iso, hora, clave}` → `{ok, cita:{fecha,hora,auto}, enviado}` (usa ejecutarAccion 'cita' → casillas).
8. POST `bot_estado` `{chat_id, estado:'seb'|'humano'}` → `{ok, bot}`. t0: 'humano' = standby/posesión (lo que hoy hace el manual del owner); 'seb' = liberar. tenant≠0: bot='n/a' (no hay cerebro; el front oculta el control) salvo que exista lógica real.
9. POST `reactivar` `{chat_id, clave}` → `{ok, programado_ts}`: crea la INTENCIÓN (casilla/programado) que sale por la puerta de mensajes; no manda directo.
10. POST `soltar_v2` `{chat_id}` → `{ok}`.
11. GET `autos_mios` → `{ok, autos:[{id, nombre, marca, modelo, anio, precio, km, portada, estado:'activo'|'revision'|'vendido', fotos:int}]}` (autosDeTenant; t0 = inventario activo completo, límite 200).
12. POST `foto_subir` `{nombre, base64}` → `{ok, url}` (reenvía a fyradrive.com upload-photo; límite 6 MB).
13. POST `auto_subir` `{marca, modelo, anio, precio, km, version?, color?, transmision?, combustible?, descripcion?, fotos:[url…(≥4)], clave}` → `{ok, auto_id, estado:'revision'}` (publish-batch particular del web con K_PANEL, dueño = teléfono del tenant; nace en revisión). Errores claros por campo.
14. Existentes que se conservan: `acceso_*`, `acceso_sesiones`, `acceso_cerrar_todas`, `timbre_url`, `demo_responder`, `demo_reset`, `tenant_info` (compat).
Errores: `{ok:false, error, login?:true, necesita?:'enganche'|'fecha_hora'|'auto'}` con HTTP 400/401/403/404/409.

## Timbre (WebSocket del puente)
Eventos: `{tipo:'mensaje', tenant_id, chat_id, mensaje:{...igual que hilo}}` y `{tipo:'cambio', tenant_id, chat_id, que:'foco'|'bot'|'cita'|'delegacion'|'ghost'}`. El cliente IGNORA todo evento con `tenant_id !== TENANT.id` y actualiza SOLO la fila/hilo con ese `chat_id`. El puente incluye `tenant_id` y `chat_id` en TODO evento (hoy emite por teléfono).

## Puerta de mensajes (servidor): lib/seb/mensajeria.js
`enviar({tenantId, chatId, origen:'manual'|'boton:<acc>'|'sugerencia'|'delegar'|'programado'|'rescate'|'cita'|'sb', clave, texto?, fotos?, imagen?, location?, sesionId?})` → resuelve chat por (tenantId, chatId), tel, delegación viva si tenantId≠0 (si no → 403), tel de prueba (simula), idempotencia por `clave` (UPSERT en `envios`), llama al puente (`/api/send` o `/api/send-fotos`), persiste resultado, registra en `acciones` con sesion_id, emite timbre. TODO envío desde seb-panel (manual_directo, resolver, ejecutarAccion, delegar opener t0, prog/rescates cuando toque, opener_auto respuestas NO: eso vive en el puente) pasa por aquí. Sin cambiar firmas exportadas de citas-vivas (paridad sandbox).

## Datos reales del diseño
Logo: tratamiento tipográfico de la portada fyradrive.com/seb ("FYRADRIVE" blanco bold, letter-spacing .34em, barra degradada 70×4 px #35e0b0→#4f8bff debajo). Seb: `/seb-like.webp` (pulgar arriba) en el header, arriba a la derecha, recortado por el header como en la referencia. Sin "Sebastian Romero" fijo, sin "¡Buenas, Seb!". Barra inferior: Inicio · Autos · (+) · Ventas · Más — Ventas y Más existen pero muestran "pronto" (no se construyen). (+) = subir auto (flujo propio). Autos = lista de autos del universo.
