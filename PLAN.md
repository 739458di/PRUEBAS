# PLAN: Test User Mode Invisible para 8120066355

## Resumen

Habilitar 8120066355 como usuario de pruebas end-to-end invisible.
Seb e Ignacio lo tratan como usuario real. Internamente es `is_test_user`.
Toggle con comandos `#test` y `#reset`.

## Archivo a modificar

**Solo wa-bridge.js en VPS** (134.209.51.172)

## Arquitectura

### Estado global nuevo

```javascript
// Linea ~56 (junto a BOSS_NUMBERS)
var TEST_USERS = ['5218120066355'];
var _testModeActive = {}; // phone -> { mode: 'buyer'|'seller', startedAt }

function isTestUser(phone) {
    var c = clean(phone);
    return TEST_USERS.some(function(t) { return clean(t) === c; });
}
function isTestModeActive(phone) {
    return !!_testModeActive[clean(phone)];
}
```

### Comandos de control (interceptados ANTES de cualquier routing)

| Comando | Accion |
|---------|--------|
| `#test comprador` | Activa test mode buyer: limpia Seb history + deals, rutea a onMessage como comprador normal |
| `#test vendedor` | Activa test mode seller: limpia Ignacio flows + vendedor state, permite seller lead detection |
| `#reset seb` | Limpia conversation history, deals activos -> test_reset, triggers |
| `#reset ignacio` | Limpia ignacioPubFlows, vendedorPhones, vendedorState, vendedores_registro |
| `#reset all` | Ejecuta ambos resets |
| `#test off` | Desactiva test mode, restaura Boss Mode normal |
| `#test status` | Responde con estado actual del test mode |

## Cambios punto por punto (10 puntos)

### CAMBIO 1: Constantes + funciones (linea ~56)
Agregar `TEST_USERS`, `_testModeActive`, `isTestUser()`, `isTestModeActive()`.

### CAMBIO 2: Command interceptor (en processBuffered, linea ~6725, ANTES de todo routing)
```javascript
// Intercept #test/#reset commands for test users
if (isTestUser(realPhone) && textoCombinado.startsWith('#')) {
    await handleTestCommand(clean(realPhone), textoCombinado, sock, jid);
    return;
}
```

### CAMBIO 3: Buffer isBoss flag (linea 7505)
```javascript
// ANTES:
isBoss: !isGroup && isBoss(realPhone)
// DESPUES:
isBoss: !isGroup && isBoss(realPhone) && !isTestModeActive(realPhone)
```
Cuando test mode activo, `isBossMsg = false` => todas las exclusiones de boss desaparecen.

### CAMBIO 4: Seb system prompt — no MODO JEFE en test mode (linea 5345)
```javascript
// ANTES:
if (isBoss(tel)) { systemPrompt += '--- MODO JEFE ---'... }
// DESPUES:
if (isBoss(tel) && !isTestModeActive(tel)) { systemPrompt += '--- MODO JEFE ---'... }
```

### CAMBIO 5: Privacy protection — aplicar en test mode (linea 5361)
```javascript
// ANTES:
if (!isBoss(tel)) { systemPrompt += '--- PROTECCION DE DATOS ---'... }
// DESPUES:
if (!isBoss(tel) || isTestModeActive(tel)) { systemPrompt += '--- PROTECCION DE DATOS ---'... }
```

### CAMBIO 6: Phone stripping — aplicar en test mode (linea 6246)
```javascript
// ANTES:
if (!isBoss(telClean)) { respuesta = respuesta.replace(...) }
// DESPUES:
if (!isBoss(telClean) || isTestModeActive(telClean)) { respuesta = respuesta.replace(...) }
```

### CAMBIO 7: bossContext self-lock prevention (linea 7196)
```javascript
// ANTES:
if (!isBoss(_fmPhone)) { bossContext[_bcPhone] = ... }
// DESPUES:
if (!isBoss(_fmPhone) || isTestModeActive(_fmPhone)) { bossContext[_bcPhone] = ... }
```
Cuando el test user manda mensaje manual a alguien, NO crea boss-active lock (es un usuario normal).
Nota: esto es para el outgoing message scanner. Evita que el test user bloquee a los agentes con sus propias pruebas.

### CAMBIO 8: SEB-ALLOWLIST boss-active check (linea 6075)
```javascript
// ANTES:
if (isBossActiveWith(telClean) && !isBoss(telClean)) {
// DESPUES:
if (isBossActiveWith(telClean) && !isBoss(telClean) && !isTestModeActive(telClean)) {
```
En test mode, Seb NO se silencia aunque haya boss-active (el test user IS el boss).

### CAMBIO 9: handleTestCommand function (nueva, ~50 lineas)
```javascript
async function handleTestCommand(tel, text, sock, jid) {
    var cmd = text.toLowerCase().trim();

    if (cmd === '#test comprador') {
        // Clear Seb state
        delete conversationHistory[tel];
        delete globalSebTriggers[tel];
        // Archive active deals
        await db("UPDATE claw_deals SET estado='test_reset' WHERE comprador_telefono LIKE ? AND estado NOT IN ('cancelado','completado','test_reset')", ['%' + tel.slice(-10)]);
        _testModeActive[tel] = { mode: 'buyer', startedAt: Date.now() };
        await sendAutoWA(tel, '[TEST] Modo comprador activado. Escribe como si fueras un comprador normal. Seb te responde como usuario real.\n#test off = salir\n#reset seb = limpiar estado');
        return;
    }

    if (cmd === '#test vendedor') {
        // Clear Ignacio state
        delete ignacioPubFlows[tel];
        delete vendedorState[tel];
        vendedorPhones.delete(tel);
        // Archive vendedor registro
        await db("UPDATE vendedores_registro SET status='test_reset' WHERE telefono LIKE ?", ['%' + tel.slice(-10)]);
        _testModeActive[tel] = { mode: 'seller', startedAt: Date.now() };
        await sendAutoWA(tel, '[TEST] Modo vendedor activado. Escribe como si quisieras vender un auto. Ignacio te responde como usuario real.\n#test off = salir\n#reset ignacio = limpiar estado');
        return;
    }

    if (cmd === '#reset seb') {
        delete conversationHistory[tel];
        delete globalSebTriggers[tel];
        await db("UPDATE claw_deals SET estado='test_reset' WHERE comprador_telefono LIKE ? AND estado NOT IN ('cancelado','completado','test_reset')", ['%' + tel.slice(-10)]);
        await sendAutoWA(tel, '[TEST] Seb reset completo. Historial, deals y triggers limpiados.');
        return;
    }

    if (cmd === '#reset ignacio') {
        delete ignacioPubFlows[tel];
        delete vendedorState[tel];
        vendedorPhones.delete(tel);
        await db("UPDATE vendedores_registro SET status='test_reset' WHERE telefono LIKE ?", ['%' + tel.slice(-10)]);
        await sendAutoWA(tel, '[TEST] Ignacio reset completo. Flow, vendedorState y registro limpiados.');
        return;
    }

    if (cmd === '#reset all') {
        // Both resets
        delete conversationHistory[tel];
        delete globalSebTriggers[tel];
        delete ignacioPubFlows[tel];
        delete vendedorState[tel];
        vendedorPhones.delete(tel);
        await db("UPDATE claw_deals SET estado='test_reset' WHERE comprador_telefono LIKE ? AND estado NOT IN ('cancelado','completado','test_reset')", ['%' + tel.slice(-10)]);
        await db("UPDATE vendedores_registro SET status='test_reset' WHERE telefono LIKE ?", ['%' + tel.slice(-10)]);
        await sendAutoWA(tel, '[TEST] Reset completo (Seb + Ignacio). Todo limpio para nueva prueba.');
        return;
    }

    if (cmd === '#test off') {
        delete _testModeActive[tel];
        await sendAutoWA(tel, '[TEST] Test mode desactivado. Modo Boss restaurado.');
        return;
    }

    if (cmd === '#test status') {
        var st = _testModeActive[tel];
        var inVendedor = vendedorPhones.has(tel);
        var hasIgnacio = !!ignacioPubFlows[tel];
        var hasHistory = !!conversationHistory[tel];
        var msg = '[TEST STATUS]\n' +
            'Mode: ' + (st ? st.mode : 'OFF (Boss Mode)') + '\n' +
            'Vendedor registered: ' + inVendedor + '\n' +
            'Ignacio flow active: ' + hasIgnacio + '\n' +
            'Seb history: ' + hasHistory + '\n' +
            'Started: ' + (st ? new Date(st.startedAt).toISOString() : 'N/A');
        await sendAutoWA(tel, msg);
        return;
    }

    // Unknown # command — ignore (don't pass to agents)
    await sendAutoWA(tel, '[TEST] Comandos: #test comprador, #test vendedor, #test off, #test status, #reset seb, #reset ignacio, #reset all');
    return;
}
```

### CAMBIO 10: notifyBoss tag para analytics (opcional, no-breaking)
En `notifyBoss()`, si el evento involucra a un test user, agregar [TEST] al inicio:
```javascript
// Dentro de notifyBoss, si el msg contiene el telefono del test user:
// Ya el boss vera las notificaciones de su propia prueba con contexto
// No se necesita tag extra — el boss sabe que esta testeando
```
Decidido: NO agregar tag. El boss quiere la experiencia completa sin distincion.

## Flujo de uso

### Probar como comprador:
1. Enviar `#test comprador` desde 8120066355
2. Enviar "Hola, vi un carro que me interesa" o click desde anuncio
3. Seb responde como a cualquier comprador
4. Citas, financiamiento, push notifications — todo real
5. `#reset seb` para limpiar y repetir
6. `#test off` para volver a Boss Mode

### Probar como vendedor:
1. Enviar `#test vendedor` desde 8120066355
2. Enviar "Quiero vender mi auto"
3. Ignacio inicia flujo completo de captura
4. Datos, fotos, comision, publicacion — todo real
5. `#reset ignacio` para limpiar y repetir
6. `#test off` para volver a Boss Mode

## Lo que NO se toca

- Scheduler/push notifications: ya operan sobre deals/citas sin filtrar boss. Funcionan automaticamente.
- Seller Pulse: opera sobre vendedor phone. Funciona automaticamente si el test user esta registrado como vendedor.
- FyraTrack: opera sobre citas. Funciona automaticamente.
- notifyBoss: sigue notificando al mismo numero (el boss ve TODO).
- DB schema: no requiere cambios. Deals/contactos se crean normalmente.
- Produccion: ningun usuario normal se ve afectado. Solo TEST_USERS con _testModeActive pueden activar el modo.

## Seguridad

- Solo numeros en `TEST_USERS` hardcoded pueden usar comandos #test
- Otros usuarios que escriban #test/#reset => el # no se intercepta, pasa como texto normal
- Boss Mode se restaura al 100% con `#test off`
- Si PM2 reinicia, `_testModeActive` se pierde (in-memory) => vuelve a Boss Mode por defecto (seguro)
