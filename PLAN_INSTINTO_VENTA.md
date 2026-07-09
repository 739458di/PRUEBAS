# Plan: Tecnificar el instinto de venta del bot Seb

**Fuente:** conversación real #591 — Jorge Portales (844 130 4565), Toyota Tacoma 2014, 97 mensajes, 9-jul-2026.
**Objetivo:** convertir el instinto de Sebastián (cuándo ganchar, cuándo insistir, cuándo tirar rollo, cuándo contestar rápido) en una **fórmula replicable** que el bot ejecute solo.

---

## 0. La idea en una frase

> El bot hoy trata **cada** mensaje del comprador como excusa para empujar la cita. El instinto NO es empujar siempre — es **leer el momento** y elegir el registro correcto. Vender es un termostato, no un martillo.

Analogía 🎓: un buen vendedor es como un DJ. No pone la canción más intensa toda la noche; lee la pista. A veces baja el ritmo (contestar seco), a veces cuenta una historia (rollo), y **solo cuando la gente ya está bailando** suelta el drop (el gancho). El bot de hoy suelta el drop cada 20 segundos → cansa y suena desesperado.

---

## 1. Análisis de la conversación #591

Separo en dos categorías, porque se mezclaron en tu crítica:
- **🔧 BUG mecánico** = el bot se rompió (repitió, filtró mensajes, dato incorrecto). No es instinto, es defecto.
- **🧠 INSTINTO** = el bot funcionó pero en el momento/tono equivocado.

### 1.1 Dónde SÍ fue eficaz (esto se conserva)

| Msg | Qué dijo | Por qué funcionó |
|-----|----------|------------------|
| 1–4 | Saludo + nombre + resumen de condiciones + "¿gustas venir a verlo y manejarlo?" | Apertura limpia: humaniza, da valor (único dueño, sin choques, trae tu mecánico), y **un** gancho suave. Perfecto. |
| 27–28 | "Sí se puede abonar a capital y liquidar antes, sin penalización; y baja la mensualidad" | Respondió la objeción real (mensualidad alta) con **beneficio concreto**. Buen rollo. |
| 43–44 | "Que estés en otra ciudad no nos frena… envío a todo el país, manda tu mecánico, garantía de viaje" | **Substancia correcta**: derriba la objeción de distancia con una solución real. El CONTENIDO es oro. (El problema fue la ENTREGA — ver 1.3.) |
| 60, 64–66 | Ante el miedo a fraude: "es la duda más válida que hay… acá no pagas nada, sin compromiso, tú decides" | Validó la emoción antes de argumentar. Ese "es la duda más válida que hay" es instinto puro. |

### 1.2 🔧 Bugs mecánicos (arreglar, no son instinto)

| Msg | Defecto | Fix |
|-----|---------|-----|
| 7, 83 | Dijo **"HEY Banco"** para la Tacoma 2014; el banco real es **Renueva Car** (≤2017). El cotizador (msg 18) sí acertó. | La respuesta hablada de "¿financian?" usa `opener.js:36` con "HEY Banco" hardcodeado. Debe consultar `bancoDeAuto(auto_id)` igual que el cotizador. **Nunca nombres el banco sin preguntarle al auto.** |
| 10–16 | Repitió **"345,000 pesos amigo" ×3** y encimó contado + enganche + plazo. | Dedup (no repetir línea) + regla del turno limpio (§2.3). |
| 85–89 | Tras "va que va, hoy entonces" filtró "Fyradrive.com / La página / [mensaje]" — mensajes sueltos que obligaron a Sebastián a disculparse ("se mandan mensajes solos del bot"). | Bug del auto-opener/dispatch: mensajes fantasma. Candado anti-stray. |
| 68, 71 | Repitió idéntico "Ya con tus documentos, en menos de 2 horas te dicen si apruebas". | Dedup + variar o avanzar, no repetir. |

### 1.3 🧠 Fallas de instinto (el corazón del plan)

| Msg | Qué pasó | Registro correcto | Regla violada |
|-----|----------|-------------------|---------------|
| 9→10-16 | "¿Cuál es el precio de lista?" → soltó precio ×3 + gancho de contado + financiamiento | **SECO**: "$345,000." y ya. | Turno limpio: pregunta factual = respuesta factual, sin gancho pegado. |
| 32-35 | Jorge: "¿dónde se ubican?" → bot: "Plaza Tribeca" → **"¿Qué día te queda bien?"** — pero Jorge aún preguntaba "¿qué ciudad?" | **SECO** primero: resolver ciudad. Gancho después. | Cerrar el loop: resuelve la pregunta abierta del comprador antes de abrir la tuya. Una pregunta a la vez. |
| 45-49 | Objeción de distancia contestada en **7 burbujas** fragmentadas | **ROLLO** en 1–2 mensajes | Tempo: un pensamiento = un mensaje, no confeti. |
| 53 | "¿Qué te acomoda mejor, el sábado o el domingo?" justo después de ya haber ganchado | (sin gancho) — dejar respirar | Termostato del gancho: 2 ganchos seguidos = insistente. Enfriamiento. |
| 68/72 | "…te dicen si apruebas" + **"Le damos?"** | ROLLO/SECO sin el "le damos" | El "le damos" / "le damos?" empuja cuando el comprador aún calcula. Suena a vendedor ansioso. |
| 84→86 | "Va que va, hoy entonces" (compromiso) → siguió lanzando página/links | **CANDADO**: ya se comprometió → fijar día/hora en firme, UNA pregunta, y esperar. | Regla del compromiso: cuando ya dijo que sí, deja de vender y cierra el detalle. |

---

## 2. La Fórmula del Instinto

Cada mensaje del comprador pasa por 3 filtros: **SEÑAL → REGISTRO → TERMOSTATO**.

### 2.1 Los 4 registros (los "tonos" del vendedor)

| Registro | Cuándo | Forma |
|----------|--------|-------|
| **SECO** ⚡ | Pregunta factual/logística (precio, ubicación, año, km, ciudad) | 1 mensaje, la respuesta exacta, **cero gancho pegado**. Rápido. |
| **ROLLO** 💬 | Objeción, duda emocional, "está caro", miedo, distancia | 1–2 mensajes con substancia: valida + argumenta con beneficio concreto. |
| **GANCHO** 🎣 | Señal de compra (interés claro, pregunta de cierre, "me gusta") | **UN** CTA claro (cita/apartado). Nunca dos. |
| **ESPERA** 🌱 | "déjame ver / te aviso / me programo / voy a trabajar" | Acuse breve ("aquí ando pendiente") y **silencio**. No empujar. |

### 2.2 La lectura: SEÑAL → REGISTRO

```
Pregunta de dato          → SECO      (precio, dónde, año, km, ¿financian?)
Objeción / miedo / "caro" → ROLLO
Señal de compra           → GANCHO    (pero sujeto al termostato §2.4)
Compromiso ya dado        → CANDADO   (fijar detalle, no re-vender)
"te aviso / me programo"  → ESPERA
```

**Regla de oro del enganche verbal (bug §1.2):** cuando la señal es "¿financian?", el registro es SECO pero el dato debe venir de `bancoDeAuto(auto_id)` — HEY Banco o Renueva Car según el año. Nunca hardcode.

### 2.3 Regla del turno limpio (mata el sobre-ganchado)

> Si el comprador hizo una **pregunta factual**, la respuesta va **sola**. El gancho se lanza en el SIGUIENTE turno, no pegado.

Precio → "$345,000." (punto). El "¿te animas de contado?" viene después, cuando él reaccione — no encimado.

### 2.4 El termostato del gancho (cuándo ganchar y cuándo NO)

El bot lleva un **contador de calor** del comprador y un **enfriamiento** del gancho:

1. **Un gancho a la vez.** Máximo un CTA por mensaje. Prohibido apilar ("¿sábado o domingo?" + "te agendo" + "¿a qué hora?").
2. **Enfriamiento.** Si el último gancho recibió respuesta tibia o ninguna → **NO repetir el gancho**. Cambiar a ROLLO (atacar el motivo de fondo) o a ESPERA. Insistir con el mismo gancho = desesperación.
3. **Solo sube si sube.** La intensidad del gancho solo aumenta si la señal del comprador se **calentó** respecto al turno anterior. Si se enfrió, bajas tú también.
4. **Regla del compromiso.** En cuanto el comprador se compromete ("va que va", "sí me interesa", "le entro") → **deja de vender**. Cambias a CANDADO: fijas UN detalle concreto (día + hora) y esperas confirmación. Seguir vendiendo tras el "sí" lo enfría.
5. **Regla del respeto al freno.** "Déjame programarme / te aviso" es un **freno legítimo**, no una objeción a vencer. Registro ESPERA. Un empujón aquí quema la venta.

### 2.5 Cerrar el loop (mata los desconexos)

> **Una** pregunta abierta a la vez, y resuelve la del comprador antes de abrir la tuya.

Si preguntó "¿qué ciudad?", contesta ciudad → confirma → *después* "¿qué día te queda?". Nunca dispares tu pregunta encima de la suya sin resolver.

### 2.6 Tempo (rápido vs rollo)

- Dato/logística → **rápido y corto** (1 burbuja).
- Emoción/objeción → **pausado con substancia** (1–2 burbujas, no 7).
- Nunca partir un pensamiento en 5 burbujas (el confeti del msg 45–49).

---

## 3. Los 6 momentos, reescritos (antes → después)

**A. Precio** — msg 9
- ❌ "345,000 amigo / te animas de contado / y negociamos / 345,000 amigo / con $160 enganche / a 24 meses / 345,000 amigo"
- ✅ **"Son $345,000, Jorge."** *(y ya; el siguiente turno decide si gancho)*

**B. Financian** — msg 5-7
- ❌ "Es por medio de HEY Banco…" *(banco equivocado para Tacoma)*
- ✅ **"Claro. Esta va por Renueva Car; mandas documentos, te cotizo y en menos de 2 horas te dicen si apruebas. ¿Te armo un ejercicio?"** *(banco correcto por año, UN gancho suave)*

**C. Ubicación/ciudad** — msg 32-35
- ❌ "Plaza Tribeca / ¿Qué día te queda bien?" *(atropelló el '¿qué ciudad?')*
- ✅ **"Estamos en Monterrey, Plaza Tribeca. ¿De qué ciudad nos escribes?"** *(cierra el loop; el día viene después)*

**D. Otra ciudad** — msg 42-49
- ❌ 7 burbujas
- ✅ **"Que estés en Saltillo no es problema — enviamos a todo el país con garantía de viaje, y puedes mandar a tu mecánico aquí en Mty a revisarla antes. Si quieres la apartamos para que no se te vaya."** *(1 mensaje, substancia, gancho suave único)*

**E. Insistencia sábado/domingo** — msg 53
- ❌ "¿Qué te acomoda mejor, el sábado o el domingo?" *(2º gancho seguido)*
- ✅ *(nada — enfriamiento; ya había ganchado. Esperar su reacción.)*

**F. Compromiso** — msg 84
- ❌ "Va que va, hoy entonces / Fyradrive.com / La página / [mensaje]"
- ✅ **"Perfecto. ¿A qué hora te queda hoy para agendarte en firme?"** *(CANDADO: una pregunta, cero links sueltos)*

---

## 4. Cómo se implementa en el motor actual

El motor ya tiene las piezas; falta el **gobernador**.

1. **Clasificador** (`lib/seb/clasificador.js`): ya saca `compromiso_cita` y `objecion_tipo`. Agregar un campo **`registro`** derivado: `seco | rollo | gancho | candado | espera`. Es el §2.2.
2. **Estado de conversación** (`estadoConv` en `etapa3.js`): agregar el **termostato** — `calor` (0–3), `ultimo_gancho_turno`, `gancho_respondido`. Es el §2.4.
3. **Turno limpio** (§2.3): en el carril de respuestas factuales (`info_auto.js`, precio, ubicación), **prohibir** adjuntar CTA. El gancho es un turno aparte.
4. **Banco correcto** (§1.2): la respuesta hablada de crédito consulta `bancoDeAuto(auto_id)`; quitar "HEY Banco" de `opener.js:36` como default duro.
5. **Gobernador del gancho**: función `puedeGanchar(estado)` que aplica las 5 reglas del §2.4 antes de dejar salir cualquier CTA. Si no puede → ROLLO o ESPERA.
6. **Cerrar el loop** (§2.5): candado de "una pregunta abierta"; si el comprador tiene una pregunta sin responder, se responde antes de preguntar.
7. **Anti-stray + dedup** (§1.2): candado de mensajes fantasma en el dispatch + no repetir línea idéntica.

**Regla de escalada:** si el registro es GANCHO pero el gobernador duda (señal ambigua, calor bajo), en vez de arriesgar → **escala a Sebastián** (mismo mecanismo de ghosting al 8120066355). El instinto fino, cuando no es claro, lo pone el humano.

---

## 5. Orden sugerido (de más sólido a más fino)

1. 🔧 Bugs mecánicos primero (banco correcto, dedup, anti-stray) — son defectos, cero riesgo al arreglar.
2. Turno limpio + cerrar el loop — reglas duras, alto impacto, bajo riesgo.
3. Termostato del gancho — el corazón del instinto.
4. Registro `candado` post-compromiso.
5. Escalada en señal ambigua.

> Nada de esto se toca hasta tu "va". Este documento es el plano.
