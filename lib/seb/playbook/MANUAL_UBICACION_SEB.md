# 📘 MANUAL — UBICACIÓN (Bot Seb)

> **ALCANCE:** Aplica **ÚNICAMENTE en estado CONTINUACIÓN (EN_CURSO)** — cuando el bot contesta la respuesta del comprador a un opener ya enviado. Fuera de ese estado, el bot no actúa. Lo no entendido → ESCALA.

---

## 0. La constante (no cambia nunca)
**En TODAS las situaciones de ubicación se MANDA la ubicación (pin capturado).**
Lo que VARÍA según la sub-intención: la **maquillada**, el **orden**, el **# de mensajes** y el **gancho**.

- Estilo sobrio, sin emojis, sin "!", solo "?" al final, **nombre al inicio** (rota).
- **Todo es con cita previa.**
- El **punto de venta lo resuelve la IA por auto** (cada auto trae su punto). El bot solo llena `[dir]`.

## 1. El motor (Haiku)
1. Detecta la sub-intención de ubicación.
2. **Manda la ubicación** (pin + texto).
3. Elige el conector que **conecta con el verbo del sub-input** (ver regla §2).
4. Pone el gancho según la sub-intención.
5. No entendido → ESCALA.

## 2. Regla del conector (que conecte)
- Preguntan **"¿dónde está / la veo?"** (lugar exacto) → **"déjame te mando la ubicación"** / "te paso la ubicación".
- Preguntan **"¿de qué parte / ciudad?"** (general) → **"la tenemos en / estamos en…"**.
- **Ordenan "pásame la ubicación"** → directo, **pin primero**, luego "aquí en [dir]".

## 3. Tabla maestra — sub-input → ráfaga

### A. EXACTITUD ("¿dónde está / dónde la tienen / dónde la puedo ver / dónde se ubican?" — cualquier intención de ver la unidad)
```
🟦 [pool, rota]:
   Claro [Nombre], déjame te mando la ubicación
   Mira [Nombre], aquí la tenemos:
   Con gusto [Nombre], te paso la ubicación
🟨 [pin capturado] + Aquí es nuestro punto de venta, [dir]
🟩 A qué hora te coordinamos una cita, [Nombre], para que [la/lo] manejes y [la/lo] veas?
   ([la] si es camioneta, [lo] si es auto)
```

### B. GENERAL ("¿de qué parte son / en qué ciudad?")
```
🟦 [pool, rota]:
   Claro [Nombre], estamos en…
   Mira [Nombre], nos ubicamos en…
🟨 San Pedro Garza García, Nuevo León, sobre Vasconcelos + [pin]
🟩 Te interesa venir a verla y manejarla?
```

### C. "PÁSAME LA UBICACIÓN" (orden directa)
```
🟨 [pin capturado]  ← va PRIMERO
🟦 Va [Nombre], aquí en [dir]
   (o) Claro [Nombre], aquí está:
🟩 A qué hora te esperamos para agendarte, [Nombre]?
```

### D. ENVÍO / LA QUIERE DE LEJOS ("¿hacen envío?", "estoy en otra ciudad")
```
🟦 Claro [Nombre], sí manejamos envío
🟨 La viene a ver un mecánico o conocido tuyo que te dé luz verde, y te la mandamos con garantía de viaje + [pin]
🟩 Gustas que la revise alguien de tu confianza?
```

### E. CIUDAD LEJANA específica (Saltillo, Santiago, Linares, Montemorelos)
```
🟦 Con gusto [Nombre], te agendamos una cita con anticipación
🟨 [pin]
🟩 Qué día te coordino?
```

### F. HORARIOS ("¿a qué hora abren / cierran?")
```
🟦 Mira [Nombre]
🟨 El horario es de 9 a 7pm, pero como son consignaciones de particulares de uso cotidiano es con cita previa, la hora no importa, igual sábado o domingo + [pin]
🟩 Qué día y hora te coordino?
```

## 4. Orden / # de mensajes
- **A, B, E, F:** maquillada → acción (texto + pin) → gancho. *(3 ráfagas)*
- **C (orden directa):** **pin primero** → "aquí en [dir]" → gancho hora/día. *(2-3 ráfagas)*
- **D (envío/lejos):** maquillada → sugerencia de envío + pin → gancho de revisión por su gente.

## 5. Ganchos por sub-input
| Sub-input | Gancho |
|---|---|
| Exactitud | A qué hora te coordinamos una cita, [Nombre], para que [la/lo] manejes y [la/lo] veas? |
| General | Te interesa venir a verla y manejarla? |
| Pásame ubicación | A qué hora te esperamos para agendarte, [Nombre]? |
| Envío / lejos | Gustas que la revise alguien de tu confianza? |
| Ciudad lejana | Qué día te coordino? |
| Horarios | Qué día y hora te coordino? |

## 6. Variables
- `[dir]` — punto de venta del auto (lo resuelve la IA por auto).
- `[pin capturado]` — imagen/pin del punto.
- `[Nombre]` — del comprador si se tiene.

## 7. PROHIBIDO
- Actuar fuera de CONTINUACIÓN → el bot se calla.
- No mandar la ubicación → SIEMPRE se manda.
- Doble pregunta en el gancho.
- Conector que no pegue con el verbo del sub-input.
