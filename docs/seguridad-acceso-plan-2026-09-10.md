# Seguridad del acceso de vendedores a FyraChat — para decidir (Agente B, 2026-09-10)
(Informe técnico del Agente A en seguridad-acceso-informe-tecnico-2026-09-10.md)

## Hoyos (del más grave al menos)
1. Llave maestra del edificio pegada en la pared · crítico · 2 h · VPS sí
2. Tablero de Fyradrive (universo 0) sin candado · crítico · 3 h · VPS no
3. Puerta trasera del Sales Brain abierta (alta de números ajenos, spam de códigos, desvinculación forzada) · alto · 1.5 h · VPS sí (no borrar credenciales)
4. El gafete (sesión) no muere cuando debería (código compartido/phishing, celular perdido, desvincular no cierra, 30 días fijos) · alto · 6 h · VPS no
5. El padrón se ve desde la calle (/status, QR, oráculo del código, ids secuenciales) · medio · 1.5 h · VPS sí
6. Sin bitácora para reconstruir incidentes · medio · 3 h · VPS no
7. La llave del dueño es igual a la de un vendedor (maestra sin 2º factor) · medio · 3 h · VPS no

## Plan
HOY (≈5 h): rotar llave y sacarla del código · llave en upload.js tenant_* · llave en /status y /qr · acceso_ticket nunca devuelve URL · límite por IP + respuesta uniforme en acceso_pedir · texto "no lo compartas ni con Fyradrive" · no limpiarAuth si registered.
ESTA SEMANA (≈12 h): universo 0 detrás de la maestra · desvincular/re-alta = cerrar todas las sesiones (barredor) · caducidad 7 días sin uso + lista de sesiones "cerrar todas" · bitácora sesión+IP en mensajes/acciones · aviso WhatsApp "sesión nueva".
DESPUÉS (≈12 h): 2º factor y gafete 24 h para la maestra · dos llaves (puente vs panel) + HTTPS en el puente · rate limit en Turso · canje de ticket por POST · acciones de tenant 0 con etiqueta de universo.

## Decisiones del owner (pendientes)
(a) plazo del gafete (recomendado: renovación con uso + muerte a 7 días sin uso) · (b) universo 0 exige sesión maestra desde ya (recomendado: sí, esta semana) · (c) compartir el link público de alta solo después de HOY (conocidos) / ESTA SEMANA (público).

Frase: un código prueba que alguien leyó un WhatsApp tres minutos; todo lo demás lo sostienen las puertas, y hoy tres están abiertas.
