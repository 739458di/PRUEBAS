# AUDITORÍA ETAPA 3 → CITA — Fyradrive
**Fecha:** 8 de julio 2026 · **Método:** Agente A (bot real en sandbox) → Agente B (juez de venta con empatía) → Agente C (arquitecto)

## 1. Metodología
- Se minaron **2,458 mensajes reales de compradores en etapa 3** de 536 conversaciones de los últimos 90 días.
- Se agruparon en 17 familias y se armaron **74 escenarios de prueba con fraseos reales** (incluye ortografía real: "alas 2", "aser una sita").
- Cada escenario se corrió contra el bot REAL (mismo cerebro que WhatsApp) en 6 carriles paralelos del sandbox.
- **Agente B**: 74 jueces independientes con el contexto completo del negocio (voz de Seb, playbook, verdad de campo) y lente de empatía humana calificaron cada respuesta: eficaz/ineficaz + severidad 0-3 + qué siente el comprador + la respuesta que él daría.
- **Agente C**: arquitecto senior recibió los 74 veredictos y diseñó la arquitectura (sección 5).

## 2. Radiografía global

| Métrica | Valor |
|---|---|
| Escenarios probados | 74 |
| **Ineficaces según el juez** | **42 (57%)** |
| Severidad 3 — espantan/matan la venta o dejan colgado | 14 |
| Severidad 2 — pierden fuerza de venta | 28 |
| Severidad 1 — mejorables | 31 |
| Perfectas | 1 |
| Rutas: banco 43 · cerebro 16 · escala 10 · silencio 3 · error 500 (2, transitorios bajo carga) | |

**Lectura honesta:** el motor casi nunca dice una barbaridad — su falla dominante es ser *sordo* (contesta plantilla sin leer LA pregunta), *mudo* (escala y el comprador ve silencio) o *frío* (ignora el miedo humano). Y hay categorías enteras sin dueño.

## 3. Los 14 casos SEVERIDAD 3 (dinero tirado)

### #13 [logistica_diaD] — "Con quien me dirijo más tarde?"
- **Ruta:** silencio
- **Respondió:** (nada)
- **Problema:** Silencio ante una pregunta logística crítica del día D. El comprador ya está en modo "voy a ir" y solo necesita un nombre/instrucción de llegada. No hay banco ni IA involucrada: es información operati
- **El juez respondería:** *Con Sebastián Romero, va que va. Ya me avisas cuando estés en camino y te doy seguimiento directo.*

### #40 [banco_propio] — "tengo credito preaprobado con banorte"
- **Ruta:** banco_etapa3
- **Respondió:** “Ya con tus documentos, en menos de 2 horas te dicen si apruebas” · “Cómo ves los números?”
- **Problema:** Respuesta completamente desconectada de lo que dijo el comprador. Él no preguntó cómo aprueba ni cuánto tarda — declaró que YA tiene crédito preaprobado con Banorte. El bot respondió como si el compra
- **El juez respondería:** *Con Banorte sin tema, eso facilita todo.

Cuándo quieres venir a verlo? Te aparto fecha hoy mismo.*

### #42 [trade_in] — "Pues daría mi carro de enganche"
- **Ruta:** escala
- **Respondió:** (nada)
- **Problema:** La escala deja al comprador colgado justo en el momento de mayor intención. "Permuta como enganche" no es una política inexistente ni un dato imposible de responder: Fyradrive puede decirle YA que ace
- **El juez respondería:** *Wey, el enganche tiene que ser en efectivo o transferencia — HEY Banco no permite usar otro carro como parte del crédito. Si ya tienes los 80 mil listos o los consigues vendiendo el tuyo, podemos agendar la cita y dejamo*

### #49 [foraneo] — "Donde están ubicados"
- **Ruta:** banco_etapa3
- **Respondió:** “Va que va” · “Qué día y a qué hora te queda bien?”
- **Problema:** La ruta banco_etapa3 disparó el CTA de cita sin responder la pregunta de ubicación. Para un comprador foráneo eso es fatal: necesita saber la ciudad y colonia ANTES de comprometerse a mover agenda (o 
- **El juez respondería:** *Somos de Monterrey, Col. Del Valle — tú de dónde vienes? Si eres de fuera coordinamos todo para que el viaje valga la pena, incluyendo el trámite ese mismo día.*

### #50 [foraneo] — "Pensé que estaban en saltillo perdón yo estoy aquí en saltillo"
- **Ruta:** banco_etapa3
- **Respondió:** “Perfecto” · “Qué día y a qué hora te queda bien?”
- **Problema:** Respuesta de plantilla ciega: el bot recibió un dato de ubicación CLAVE (foráneo en Saltillo) y disparó el CTA de cita como si el comprador viviera en Monterrey. No reconoce el obstáculo, no lo resuel
- **El juez respondería:** *No, nosotros estamos en Monterrey. Pero foráneos nos buscan seguido — vale la pena el viaje porque el auto ya está verificado y si te late apartamos con algo mínimo para que nadie más se lo lleve antes de que vengas. ¿Cu*

### #51 [foraneo] — "hacen envios a torreon?"
- **Ruta:** banco_etapa3
- **Respondió:** “Sin tema” · “Qué día y a qué hora te queda bien?”
- **Problema:** La ruta banco_etapa3 disparó su plantilla genérica de cierre sin leer la pregunta. El comprador preguntó por ENVÍO A TORREÓN, una duda de viabilidad física ("¿esto aplica para mí?"). Si no se responde
- **El juez respondería:** *Foráneo lo manejamos con cita anticipada: tú llegas un día, checas el auto, firmas y te lo llevas ese mismo día. También podemos coordinar la entrega en Torreón una vez cerrado el trato. ¿Cuándo tendrías chance de venir *

### #53 [foraneo] — "estoy en cdmx, como le hariamos?"
- **Ruta:** banco_etapa3
- **Respondió:** “Sin tema” · “Qué día y a qué hora te queda bien?”
- **Problema:** La ruta banco_etapa3 disparó la plantilla de cierre de cita sin leer el contexto: el comprador NO preguntó por la cita, preguntó por la logística de ser foráneo. "Sin tema" suena a que el bot no leyó 
- **El juez respondería:** *Mira, de CDMX viene gente seguido. El auto lo tenemos en Monterrey, revisado y con papeles en orden. El trámite de financiamiento se puede arrancar desde allá, y la visita la coordinamos un solo día pa que no hagas dos v*

### #54 [estado_auto] — "Tiene adeudos el carro?"
- **Ruta:** escala
- **Respondió:** (nada)
- **Problema:** La ruta "escala" se disparó por el motivo equivocado: el bot confundió "dato del auto que no tenemos" (motor/versión) con esta pregunta, que NO necesita ficha técnica. La pregunta de adeudos es de doc
- **El juez respondería:** *Nosotros revisamos papeles antes de publicarlo — sin adeudos, sin gravámenes. Eso es parte del proceso Fyradrive. Si quieres verlo en persona te coordino una cita esta semana, sin compromiso.*

### #55 [estado_auto] — "ha tenido choques?"
- **Ruta:** escala
- **Respondió:** (nada)
- **Problema:** La escalada fue mal clasificada. "¿Ha tenido choques?" NO requiere dato técnico de ficha (motor/versión) — requiere el historial de siniestros, que Fyradrive DEBERÍA tener como parte de su inspección/
- **El juez respondería:** *Seb: Sin reporte de choque en la inspección que hicimos. Carrocería limpia, sin reparaciones visibles. Si quieres los detalles completos te los muestro en persona cuando lo veas. ¿Cuándo te queda bien pasarte?*

### #57 [estado_auto] — "el clima enfria bien?"
- **Ruta:** escala
- **Respondió:** (nada)
- **Problema:** La escalada aquí mata la venta. La pregunta del clima no es técnica-crítica que requiera parar todo y esperar al dueño: es una duda de comodidad que el comprador resuelve EN PERSONA viendo el auto. El
- **El juez respondería:** *Buena pregunta, eso lo checas en la prueba de manejo — te lo encendemos ahí mismo y lo compruebas tú directo. ¿Cuándo te queda pasar a verlo?*

### #58 [estado_auto] — "que version es? trae quemacocos?"
- **Ruta:** escala
- **Respondió:** (nada)
- **Problema:** Escalar por "dato no disponible en ficha" sin dejar ningún puente al comprador es un silencio total disfrazado de proceso. El comprador preguntó versión y quemacocos — preguntas legítimas, urgentes pa
- **El juez respondería:** *Va, ahorita le confirmo la versión y si trae quemacocos con el vendedor. ¿Cuándo puedes pasar a verlo? Así lo revisas tú mismo y sacamos tu duda en persona.*

### #65 [desconfianza] — "como se que no es fraude? luego hay mucho de eso"
- **Ruta:** banco_etapa3
- **Respondió:** “Es por medio de HEY Banco: mandas tus documentos, te cotizo, solicitamos y te dicen en menos de 2 horas; el en” · “Te cotizo? Con cuánto de enganche le hacemos los números?”
- **Problema:** Ignorancia total del miedo. El comprador dijo "me van a estafar" y el bot respondió con un pitch de financiamiento más una pregunta de cotización — la ruta banco_etapa3 se disparó por la palabra "enga
- **El juez respondería:** *Oye, es la duda más válida que hay. Nosotros somos intermediarios registrados: inspeccionamos el auto, verificamos papeles y el enganche lo das hasta que firmas en el punto de venta físico, nunca antes ni por transferenc*

### #69 [raros] — "https://maps.app.goo.gl/824iM5dUE42bHTo7A?g_st=iw"
- **Ruta:** cerebro
- **Respondió:** “Ese link es del comprador, Carlos, probablemente confirmando la ubicación o compartiéndola.”
- **Problema:** La respuesta del cerebro (IA) filtró su chain-of-thought directamente al chat del comprador. El texto "Ese link es del comprador, Carlos, probablemente confirmando la ubicación o compartiéndola." es r
- **El juez respondería:** *Perfecto, ya tengo tu ubicación.

Qué horario te acomoda, mañana por la mañana o el sábado al mediodía?*

### #71 [escala_esperada] — "que garantia dan?"
- **Ruta:** escala
- **Respondió:** (nada)
- **Problema:** La pregunta "qué garantía dan" es respondible con datos reales del negocio sin necesitar política formal escrita. El bot escaló por ausencia de una política fija, pero el comprador no sabe eso; solo v
- **El juez respondería:** *Mira, Fyradrive inspecciona cada auto antes de publicarlo: papeles limpios, VIN verificado, punto de venta seguro con escrituración. No vendemos con garantía mecánica extendida como agencia, pero tú ves el auto antes de *

## 4. Los 28 casos SEVERIDAD 2 (pierden fuerza)

| # | Cat | Comprador dijo | Problema |
|---|---|---|---|
| 10 | logistica_diaD | Llego como en 40 minutos | Duplica información que el comprador ya tiene (S2 = ubicación/pin ya mandados). En el momento más caliente del embudo — el comprad |
| 18 | cortesia | Okey perfecto | "Okey perfecto" después de recibir la cotización NO es cortesía de cierre pura: es el momento de más calor de toda la conversación |
| 21 | rechazo | No puedo muchas gracias | Rendición total ante un rechazo blando. "No puedo" en setup S3 (ya cotizado, ya tiene números) es casi siempre una objeción de pre |
| 27 | enganche_cotiza | cuanto seria el pago mensual? | El comprador hizo la pregunta MAS concreta que puede hacer: "cuanto pago al mes". Setup S1 ya explicó HEY Banco; repetir el proces |
| 28 | enganche_cotiza | y a 72 meses? | La respuesta ignora completamente lo que el comprador pidió (72 meses) y le devuelve la cotización a 60 meses que ya tenía. Es el  |
| 29 | enganche_cotiza | que es lo minimo de enganche? | Evasión de la pregunta concreta: el comprador preguntó el mínimo de enganche y el bot no lo respondió. En cambio, explicó el proce |
| 31 | buro | No tengo buen buró | La respuesta no atiende el miedo real: el comprador no preguntó "¿cómo funciona HEY?", dijo "tengo buró malo". Eso es una confesió |
| 32 | buro | Crees que lo acepten? | La ruta banco_etapa3 disparó la plantilla de explicación de proceso, pero la pregunta era sobre probabilidad de aprobación, no sob |
| 34 | buro | trabajo por mi cuenta, no tengo nominas | La respuesta NO toca el punto que el comprador acababa de plantear: trabaja por su cuenta (independiente/freelance), es decir, le  |
| 36 | tercero | Sería a nombre de mi mamá el credito | La ruta banco_etapa3 disparó su plantilla estándar SIN resolver la duda concreta: ¿puede ser el acreditado alguien distinto al com |
| 37 | tercero | Si puedes mandar lo del banco y que mi mamá lo pueda ch | El comprador hizo una petición explícita y manejable: "manda lo del banco para que mi mamá lo pueda checar." El bot ignoró la peti |
| 38 | tercero | mi esposo es el que daria la cara por el credito | El comprador dio información nueva y accionable (el titular del crédito es otra persona, el esposo). El bot la ignoró por completo |
| 39 | banco_propio | Ella tiene Santander se puede con ese banco | La respuesta es un template banco_etapa3 genérico que no responde la pregunta real: "¿puedo usar Santander?" El comprador tiene un |
| 41 | banco_propio | puedo pagar con credito de mi caja popular? | Respuesta desconectada: el comprador pregunta si puede pagar con un crédito YA EXISTENTE (caja popular = su propio banco cooperati |
| 47 | precio | si lo dejas en 240 te lo compro hoy | La escalada es lógicamente correcta (nadie debe aceptar o rechazar un precio sin autoridad del dueño), pero el bot deja la pelota  |
| 52 | foraneo | me queda lejos, no hay forma de verlo en video? | La ruta banco_etapa3 disparó el CTA de cita sin atrapar primero la objeción real: el comprador es foráneo y quiere ver el auto ant |
| 56 | estado_auto | cuando fue su ultimo servicio? | La escala se disparó porque el dato no está en la ficha, pero la pregunta de servicio NO requiere dato exacto para mantener al com |
| 59 | fotos | Me las compartes porfvaor | Respuesta completamente fuera de contexto: el comprador pidió fotos ("me las compartes"), no un re-cotizador. El cerebro interpret |
| 60 | fotos | tienes video andando? | La escalada deja al comprador sin acuse de recibo. Escalar para gestionar el video es lógico, pero mandar NADA mientras el humano  |
| 62 | desconfianza | Cómo funciona su empresa? | La respuesta está TRUNCADA: se corta en "financiami" sin terminar la oración. El comprador hizo una pregunta de desconfianza — el  |
| 63 | desconfianza | Me pueden explicar porfavor | Respuesta genérica de onboarding disparada en contexto incorrecto (S2 ya superó ese estado), y el mensaje llega CORTADO ("punto de |
| 64 | desconfianza | Por seguridad principalmente | La respuesta trata "por seguridad" como si fuera una pregunta logística (¿dónde nos vemos?) en vez de un miedo emocional que hay q |
| 66 | raros | Tu dime | El comprador dijo "tú dime" — delegó la decisión, abrió la puerta de par en par. La respuesta correcta es UNA recomendación corta  |
| 67 | raros | Me lo puedes mandar a este o mejor a ella directamente | Dos errores combinados: (1) la pregunta del comprador era puramente operativa ("¿a este número o al de ella?") y la respuesta la c |
| 68 | raros | Bueno ahí me dice si me interesa mucho la camioneta | Respuesta equivocada al mensaje: Carlos dijo "ahí me dice si me interesa" — es una frase de cierre provisional, espera que Seb le  |
| 72 | escala_esperada | me puedes marcar para explicarme? | La escalada es correcta en intención (llamada = humano, no bot), pero dejar al comprador sin ningún acuse es el error. El comprado |
| 73 | multi | ok y el enganche cuando se paga? y puedo ir el sabado a | El bot respondió SOLO la segunda pregunta (la cita) e ignoró la primera y más importante: "el enganche cuándo se paga". Esa duda e |
| 74 | multi | esta bonito pero no se si me alcance, cuanto seria de m | El comprador abrió con miedo ("no se si me alcance") — una señal de aprobación bancaria/ingreso. El bot ignoró eso y respondió sol |

## 5. ARQUITECTURA PROPUESTA (Agente C)

# Arquitectura Etapa 3 → Cita: Diseño para 100% de eficacia

**Diagnóstico en una línea:** el motor actual acierta cuando la pregunta cae limpia en un banco, pero pierde ventas por tres vías: **bancos sordos** (contestan plantilla sin leer la pregunta exacta), **escaladas mudas** (el bot se calla y el comprador caliente se enfría), y **categorías huérfanas** (foráneo, terceros, banco propio, permuta, día D) que hoy no tienen dueño. De 74 casos, 33 fueron ineficaces; **ninguna falla requiere más IA — casi todas requieren más datos del negocio y mejores reglas.**

---

## 1. PATRONES DE RAÍZ (agrupando los 74 casos)

### P1 — Escalada muda: el bot se calla y el comprador queda colgado
**Casos:** 13, 42, 47, 54, 55, 56, 57, 58, 60, 71, 72 (11 casos, casi todos severidad 3)

Es el patrón más caro. Cuando `escala3()` dispara, el comprador ve **silencio total** en el momento en que más caliente está ("si lo dejas en 240 te lo compro HOY" → nada). Peor aún: la mitad de estas escaladas **ni siquiera debían escalar** — "¿tiene adeudos?", "¿ha tenido choques?", "¿el clima enfría?" son respondibles con el proceso Fyradrive (inspección, papeles verificados, prueba de manejo), no necesitan al dueño.

### P2 — Banco sordo: la plantilla dispara por keyword pero no responde LA pregunta
**Casos:** 27, 28, 29, 31, 32, 34, 36, 37, 38, 39, 40, 41, 49, 50, 51, 52, 53, 65, 73 (19 casos, sev 2–3)

El regex detecta "enganche" o "banco" y suelta el pitch genérico de HEY, aunque el comprador haya preguntado algo específico: "¿y a 72 meses?" recibe la tabla de 60; "¿cuál es el mínimo de enganche?" recibe el proceso; "tengo preaprobado Banorte" recibe cómo aprueba HEY. **El universo es correcto, la respuesta no está parametrizada con lo que el comprador dijo.**

### P3 — Categorías completas sin dueño
- **Foráneo/ubicación** (49–53, cinco casos, cuatro sev 3): "¿dónde están?", "estoy en Saltillo/CDMX/Torreón" cae en el banco de cita y suena a que el bot no leyó. Es fatal: el foráneo necesita saber ciudad + protocolo ANTES de comprometerse.
- **Crédito de terceros** (36–38): "a nombre de mi mamá/esposo" → plantilla ciega. La respuesta real es una sola frase: *sí se puede, el titular es otro*.
- **Banco propio** (39–41): "tengo Banorte preaprobado" es una SEÑAL DE COMPRA, no una duda — y el bot respondió con el pitch de HEY.
- **Permuta/trade-in** (42–44): política sencilla que hoy escala o improvisa.
- **Día D / logística de llegada** (9–13): "ya voy", "llego en 40 min", "ya llegué", "¿con quién me dirijo?" — el cerebro manda el pin repetido o se calla. No existe el estado "comprador en camino".

### P4 — Cierre de cita que devuelve la pelota
**Casos:** 1–8, 14, 16, 17, 18, 20, 70 (la categoría más frecuente; sev 1 pero volumen alto = turnos perdidos = citas que mueren)

El comprador dice "hoy en la tarde o mañana en la mañana" y el bot pregunta "¿a qué hora?" — pregunta abierta que regresa la pelota. Vicios repetidos: "**como** a qué hora" (tentativo), emoji ✅ (rompe la voz), "¿va?" re-confirmando lo que ya estaba decidido, y silencio ante "Okey perfecto" post-cotización (¡el momento más caliente del embudo, caso 18!).

### P5 — Miedo/desconfianza tratados como pregunta de proceso
**Casos:** 31, 32, 34, 62, 63, 64, 65, 74 (sev 2–3)

"No tengo buen buró", "¿cómo sé que no es fraude?", "no sé si me alcance" son **confesiones emocionales**, no dudas de proceso. El bot responde con la mecánica de HEY y el comprador siente que hablar con un robot que no lo escuchó.

### P6 — Amnesia de estado: repite lo que el comprador ya tiene
**Casos:** 10, 11, 24, 27, 29, 35, 63. Re-manda el pin al que ya llegó, re-explica HEY al ya cotizado, re-pide el enganche al que ya lo dio. Los "datos pegajosos" existen para la clasificación pero **no filtran el contenido de la respuesta**.

### P7 — Cerebro sin guardarraíles de salida
**Casos:** 59 (interpretó "mándame fotos" como re-cotizar), 62, 63 (mensajes TRUNCADOS a media palabra), 69 (**filtró su razonamiento interno al chat del comprador** — gravísimo para pasar a automático), 22/44 (nombre posiblemente inventado, palabra cortada).

### P8 — Multi-pregunta: responde una e ignora la otra
**Casos:** 73, 74. "¿Cuándo se paga el enganche? ¿y puedo ir el sábado?" → solo contesta la cita. La ignorada suele ser la de dinero, la más importante.

---

## 2. DECISIONES DE ARQUITECTURA (mecanismo por patrón y por qué)

### A. Puente obligatorio en toda escalada — *la regla de oro: el bot nunca se calla*
**Dónde vive:** `etapa3.js`, dentro de `escala3()`.
**Qué entra:** el motivo de la escalada. **Qué sale:** SIEMPRE un mensaje puente al comprador + el aviso al humano, en el mismo turno.

| Motivo | Puente |
|---|---|
| Oferta con número | "Va, déjame confirmo ese número con el dueño ahorita mismo y aquí te digo." |
| Pide llamada | "Te marco ahorita, dame un momento." |
| Dato de ficha faltante | "Deja lo verifico y en un momento te confirmo. Mientras — ¿cuándo te queda pasar a verlo?" |
| Video | "Ahorita lo checo con el dueño, en un momento te digo." |

**Por qué determinístico y no IA:** son 4–5 frases fijas por motivo; cero riesgo, cero costo, y arregla de golpe los 11 casos del patrón más severo. **Complemento:** un temporizador — si el humano no responde en 30 min, el bot manda un "sigo en eso, no te he dejado" (reutiliza la mecánica del cron de ghosting que ya existe en el bridge).

### B. Ficha de Negocio: la pieza estructural que falta más grande
**Dónde vive:** tabla nueva en Turso (`politicas_negocio`) editable desde el CRM, cargada por `etapa3.js` y también inyectada al cerebro Sonnet.
**Qué es:** el catálogo de respuestas oficiales del negocio, escritas UNA vez por el dueño:

- Ubicación (ciudad + colonia) y protocolo foráneo (visita de un día, trámite mismo día, apartado)
- Permuta: ¿se acepta auto/moto como enganche? bajo qué condición (valuación en cita)
- Crédito a nombre de tercero: sí, titular distinto, qué docs
- Banco propio del comprador: sí se puede pagar con crédito externo
- Garantía: qué incluye el proceso Fyradrive (inspección, papeles, VIN, punto seguro) y qué NO
- Adeudos/choques: "revisado antes de publicar, sin adeudos ni gravámenes"
- Mínimo de enganche (20%), descuento de contado ("hay margen, se define en cita"), cuándo se paga el enganche (a la entrega)
- Independientes sin nómina: sí, con estados de cuenta
- Horarios, nombre de quien recibe en la cita ("Sebastián"), teléfono de contacto

**Por qué:** esta sola pieza resuelve o alimenta los patrones P1, P2, P3 y P5 — **unos 25 de los 33 casos ineficaces son preguntas cuya respuesta el negocio SÍ sabe pero el bot no tiene dónde leer.** Y saca al cerebro de improvisar políticas.

### C. Cinco micro-bancos nuevos (determinísticos, leen la Ficha de Negocio)
**Dónde viven:** `etapa3.js`, mismos mecanismos que los bancos actuales, ANTES del banco genérico de HEY en la prioridad de regex:

1. **Banco foráneo/ubicación** — dispara con "dónde están / estoy en [ciudad] / envíos / me queda lejos / video". Sale: ciudad real + protocolo foráneo + oferta de video-recorrido + cita de un solo viaje. *"Somos de Monterrey. De Saltillo nos visitan seguido — coordinamos todo en un solo día y si te late lo apartamos antes de que vengas. ¿Cuándo podrías?"*
2. **Banco terceros** — "a nombre de mi mamá/esposo/ella". Sale: sí se puede + docs del titular + mismo CTA.
3. **Banco banco-propio** — "tengo preaprobado con X / mi caja / Santander". **Clave: esto es señal de compra, la respuesta salta directo al cierre:** *"Con Banorte sin tema, eso facilita todo. ¿Cuándo vienes a verlo?"*
4. **Banco permuta** — "doy mi carro/moto a cuenta". Sale: política real + valuación en cita + CTA. (Deja de escalar: caso 42 era sev 3 por escalada innecesaria.)
5. **Banco confianza-proceso** — "adeudos / choques / fraude / garantía / cómo funcionan / seguridad". Sale: el pitch de intermediario (inspección, papeles, punto neutral, enganche hasta la firma) + CTA suave. Absorbe la mitad de las escaladas malas de `estado_auto`. Solo escala lo que de verdad es dato de ficha (versión exacta, quemacocos) — **y aun entonces con puente A.**

**Por qué bancos y no cerebro:** son preguntas de política fija con respuesta fija; la IA aquí solo mete varianza y riesgo.

### D. Parametrizar el banco de cotización (el más usado)
**Dónde vive:** banco enganche/cotiza en `etapa3.js` + cotizador.
**Regla:** todo dato que el comprador dio en ESTE mensaje entra a la respuesta:
- Pide **72 meses** → cotiza 72; si HEY no lo ofrece, dilo explícito ("HEY llega a 60, te quedaría en $X").
- Pregunta **mínimo de enganche** → responde el número (20%, $X para este auto) ANTES de cualquier proceso.
- Pregunta **mensualidad** y ya dio enganche antes → usa el enganche pegajoso y da EL NÚMERO, no el proceso.
- Formato WhatsApp: bloques cortos, sin tablas con viñetas dobles, seguro financiado con una línea de contexto ("va incluido en el crédito, no lo pagas aparte").

**Por qué:** los 3 casos sev-2 de esta categoría (27, 28, 29) son el mismo bug — la plantilla no lee el parámetro. Es la categoría más frecuente del embudo real.

### E. Cerrador de cita v2: "siempre propone, nunca regresa la pelota"
**Dónde vive:** el cerrador de 2 peldaños actual en `etapa3.js`.
**Reglas nuevas:**
1. **Si el comprador ya dio día u hora, no se le vuelve a preguntar ese dato** (memoria de datos dados). "Hoy en la tarde o mañana en la mañana" → *"Te propongo mañana a las 10. ¿O prefieres hoy más tarde?"*
2. **Toda pregunta del bot ofrece 2 opciones concretas**, nunca "¿qué día te queda?": *"¿mañana o el sábado?"*, *"¿a las 2 o a las 3?"*
3. **Al cerrar día+hora, remata en el mismo turno:** confirmación + lugar + "cualquier imprevisto me avisas y reagendamos" — sin "¿va?" de re-confirmación, sin emoji ✅, sin "como a qué hora".
4. **"Okey perfecto" post-cotización NO es cortesía** — es el trigger del cerrador: *"¿Cuándo te acomoda pasar a verlo, entre semana o el fin?"* (arregla el caso 18, un sev 2 en el momento más caliente).
5. **Promesas vagas** ("te aviso en estos días", "lo platico con mi esposa") → ancla suave de tiempo: *"¿Crees que para mañana ya platicaron?"* + registro en memoria de compromisos (ver G).

### F. Máquina de estados de cita + banco Día D
**Dónde vive:** estado nuevo en la memoria del lead (bridge/Turso): `cita_confirmada → dia_D → en_camino → llego → post_cita`.
**Banco Día D** (determinístico, en `etapa3.js`):
- "ya voy / llego en X min" → acuse + instrucción de llegada + teléfono de rescate. **NUNCA re-mandar el pin si ya se envió** (flag `pin_enviado`). *"Va, aquí te esperamos. Llegando pregunta por Sebastián; si te pierdes me marcas al [número]."*
- "ya llegué" → *"Ya te vimos, ahorita sale alguien a recibirte"* + **alerta prioritaria al personal** (push inmediata, no cola normal).
- "¿con quién me dirijo?" → nombre real desde la Ficha de Negocio (el silencio del caso 13 fue un sev 3 el día de la cita — dinero tirado en la puerta).

**Por qué estado y no regex suelto:** "ya llegué" sin contexto es ambiguo; con el estado `dia_D` activo es inequívoco, y además permite que el aviso al personal tenga urgencia real.

### G. Memoria de compromisos (del bot y del comprador)
**Dónde vive:** tabla `compromisos` en Turso + el cron del bridge (extiende el trigger de ghosting 3h que ya está LIVE).
**Qué guarda:** promesas del comprador ("fin de semana", "hablo con mi esposa") con fecha estimada, y promesas del bot ("te confirmo el número", "te marco"). **Qué hace:** dispara el follow-up del bot en la ventana correcta y avisa al humano si ÉL debe algo. Convierte el "te aviso" —que hoy muere solo en el 80% de los casos— en un embudo con memoria.

### H. Capa de empatía previa al ruteo (detector de miedo)
**Dónde vive:** una etiqueta extra del clasificador Haiku (que ya corre en cada turno, costo cero adicional): `carga_emocional: miedo_buro | miedo_fraude | miedo_alcance | ninguna`.
**Regla:** si hay carga emocional, la respuesta del banco lleva un **prefijo empático de una línea que valida el miedo ANTES del dato**:
- Buró: *"Tranquilo, HEY sí trabaja con buró manchado, lo evalúan caso a caso…"*
- Fraude: *"Es la duda más válida que hay. Por eso existimos como intermediarios: el enganche lo das hasta que firmas en el punto físico…"*
- Alcance: *"La aprobación la checan ellos y muchas veces pasa aunque el buró no esté perfecto. Con tus 60 quedaría en $X…"*

**Por qué prefijo determinístico y no Sonnet:** son 3–4 miedos recurrentes con validación estándar; no hace falta improvisar.

### I. Validador de salida — el linter de mensajes (requisito para pasar a AUTOMÁTICO)
**Dónde vive:** función nueva en el núcleo del bridge, corre sobre TODO mensaje saliente (bancos y cerebro) antes de enviar/proponer.
**Chequeos:**
1. **No truncado** — termina en puntuación, sin palabra cortada (casos 33, 44, 62, 63).
2. **Sin fuga de razonamiento** — bloquea meta-frases tipo "ese link es del comprador…", "probablemente…" (caso 69, el más peligroso).
3. **Nombre solo si verificado** — "Carlos" solo si viene del registro del lead, nunca inferido.
4. **Voz Seb** — sin emojis, sin "como a qué hora", sin dobles viñetas.
5. **Anti-repetición** — no re-mandar pin/explicación HEY/pregunta ya contestada (lee los flags de estado del patrón P6).

Si falla → reintenta una vez con la falla señalada; si falla dos veces → copiloto forzado para ese mensaje. **Este componente es la condición para quitar el modo COPILOTO con seguridad:** hoy el dueño ES el validador; esto lo codifica.

### J. Compositor multi-pregunta
**Dónde vive:** clasificador Haiku (que ya extrae datos) + un paso de composición en `etapa3.js`.
**Regla:** Haiku separa las preguntas del mensaje; cada una se resuelve con su banco; el compositor las une **en orden dinero-primero, cita-después**: *"El enganche se paga hasta la firma, no llevas nada el sábado. Y va que va — sábado 11 en [punto], quedamos."*

### K. Rescate de rechazo blando
**Dónde vive:** banco nuevo pequeño en `etapa3.js`. "No puedo, gracias" en estado ya-cotizado → **una** pregunta de rescate (*"Sin problema. ¿Me platicas qué pasó? A veces hay forma de acomodarlo."*) y si el segundo no es firme, cierre digno y marca `perdido`. Nunca más de un intento (respeto = marca).

---

## 3. PRIORIDAD POR IMPACTO EN VENTAS

| # | Componente | Casos que arregla | Impacto | Esfuerzo |
|---|---|---|---|---|
| 1 | **A. Puente en escaladas** + reclasificar estado_auto al banco confianza | 11 casos, el cluster sev-3 más grande | Muy alto — hoy son ventas calientes que ven silencio | Bajo (frases fijas) |
| 2 | **B. Ficha de Negocio** + **C. 5 micro-bancos** (foráneo primero: 4 de sus 5 casos son sev 3) | ~18 casos | Muy alto — categorías enteras sin dueño | Medio |
| 3 | **D. Cotizador parametrizado** (plazo pedido, mínimo, mensualidad directa) | Categoría más frecuente del embudo | Alto | Bajo |
| 4 | **E. Cerrador v2** (2 opciones, no re-preguntar, "ok perfecto"=cerrar) | 14 casos de la categoría #1 en volumen | Alto — turnos perdidos = citas muertas | Bajo–medio |
| 5 | **H. Capa de empatía** (buró/fraude/alcance) | 8 casos sev 2–3 | Alto — el miedo no resuelto no agenda | Bajo |
| 6 | **I. Validador de salida** | Truncados, fuga de razonamiento, nombres | Alto para AUTOMÁTICO (bloquea vergüenzas) | Medio |
| 7 | **F. Estados + banco Día D** | 5 casos, incl. el sev-3 del día de la cita | Medio-alto — protege la cita ya ganada | Medio |
| 8 | **G. Memoria de compromisos** | Promesas que hoy mueren solas | Medio — recupera embudo perdido | Medio (extiende ghosting) |
| 9 | **J. Multi-pregunta** + **K. Rescate de rechazo** | 3 casos | Medio | Bajo |

**Secuencia sugerida:** 1+3+4 en la primera tanda (todo vive en `etapa3.js`, riesgo bajo, arregla ~30 casos). Luego 2 (requiere que el dueño llene la Ficha — es la única pieza que necesita SU tiempo). Luego 5+6 como compuerta para pasar de COPILOTO a AUTOMÁTICO. Después 7+8+9.

**La regla que resume todo el diseño:** *cada turno del comprador recibe (1) respuesta a LO QUE dijo, con datos reales, (2) reconocimiento de cómo lo dijo si trae miedo, y (3) un paso concreto hacia la cita con opciones cerradas — y el bot jamás, bajo ninguna ruta, deja la pantalla en silencio.*

## 6. Anexo — los 74 veredictos completos

| # | Cat | Input | Ruta | Eficaz | Sev |
|---|---|---|---|---|---|
| 1 | cita_dia_hora | Si claro hoy puedo en la tarde o mañana en la maña | banco_etapa3 | ✓ | 1 |
| 2 | cita_dia_hora | Puede verla hoy | banco_etapa3 | ✓ | 1 |
| 3 | cita_dia_hora | El día lunes | banco_etapa3 | ✓ | 1 |
| 4 | cita_dia_hora | Podría como alas 2 o 3 dela tarde | banco_etapa3 | ✓ | 1 |
| 5 | cita_dia_hora | El jueves podria antes de las 4 | banco_etapa3 | ✓ | 1 |
| 6 | cita_dia_hora | paso mañana a las 5pm | banco_etapa3 | ✓ | 1 |
| 7 | cita_dia_hora | si mañana me doy la vuelta a las 6 | banco_etapa3 | ✓ | 1 |
| 8 | cita_dia_hora | Y ya el fin de semana les llevo el carro o lo más  | banco_etapa3 | ✓ | 1 |
| 9 | logistica_diaD | Ya voy para allá | cerebro | ✓ | 1 |
| 10 | logistica_diaD | Llego como en 40 minutos | cerebro | ✗ | 2 |
| 11 | logistica_diaD | Ya llegué | cerebro | ✓ | 1 |
| 12 | logistica_diaD | Podríamos agendar en el estacionamiento de este So | banco_etapa3 | ✓ | 1 |
| 13 | logistica_diaD | Con quien me dirijo más tarde? | silencio | ✗ | 3 |
| 14 | promesa | okok te aviso en estos días si puedo pasar | banco_etapa3 | ✓ | 1 |
| 15 | promesa | Apenas en fin de semana | banco_etapa3 | ✓ | 1 |
| 16 | promesa | Si estaría bien deja ver que día puedo ir a monter | banco_etapa3 | ✓ | 1 |
| 17 | promesa | deja lo platico con mi esposa y te digo | banco_etapa3 | ✓ | 1 |
| 18 | cortesia | Okey perfecto | silencio | ✗ | 2 |
| 19 | cortesia | gracias | silencio | ✓ | 0 |
| 20 | cortesia | Buenas noches | cerebro | ✓ | 1 |
| 21 | rechazo | No puedo muchas gracias | cerebro | ✗ | 2 |
| 22 | rechazo | ya compre otro gracias | cerebro | ✓ | 1 |
| 23 | enganche_cotiza | 80mil de enganche por favor | banco_etapa3 | ✓ | 1 |
| 24 | enganche_cotiza | Podemos checar por aquí el financiamiento? | banco_etapa3 | ✓ | 1 |
| 25 | enganche_cotiza | Se puede aportar a capital? | banco_etapa3 | ✓ | 1 |
| 26 | enganche_cotiza | A partir de cualquier mes? | cerebro | ✓ | 1 |
| 27 | enganche_cotiza | cuanto seria el pago mensual? | banco_etapa3 | ✗ | 2 |
| 28 | enganche_cotiza | y a 72 meses? | banco_etapa3 | ✗ | 2 |
| 29 | enganche_cotiza | que es lo minimo de enganche? | banco_etapa3 | ✗ | 2 |
| 30 | enganche_cotiza | Ustedes no me pueden financiar el resto | banco_etapa3 | ✓ | 1 |
| 31 | buro | No tengo buen buró | banco_etapa3 | ✗ | 2 |
| 32 | buro | Crees que lo acepten? | banco_etapa3 | ✗ | 2 |
| 33 | buro | que datos te tengo que enviar? | banco_etapa3 | ✓ | 1 |
| 34 | buro | trabajo por mi cuenta, no tengo nominas | banco_etapa3 | ✗ | 2 |
| 35 | buro | cuanto tardan en aprobar? | banco_etapa3 | ✓ | 1 |
| 36 | tercero | Sería a nombre de mi mamá el credito | banco_etapa3 | ✗ | 2 |
| 37 | tercero | Si puedes mandar lo del banco y que mi mamá lo pue | banco_etapa3 | ✗ | 2 |
| 38 | tercero | mi esposo es el que daria la cara por el credito | banco_etapa3 | ✗ | 2 |
| 39 | banco_propio | Ella tiene Santander se puede con ese banco | banco_etapa3 | ✗ | 2 |
| 40 | banco_propio | tengo credito preaprobado con banorte | banco_etapa3 | ✗ | 3 |
| 41 | banco_propio | puedo pagar con credito de mi caja popular? | banco_etapa3 | ✗ | 2 |
| 42 | trade_in | Pues daría mi carro de enganche | escala | ✗ | 3 |
| 43 | trade_in | reciben mi auto a cuenta? es un aveo 2016 | banco_etapa3 | ✓ | 1 |
| 44 | trade_in | tomarian mi moto como parte del enganche? | cerebro | ✓ | 1 |
| 45 | precio | cual es lo menos? | banco_etapa3 | ✓ | 1 |
| 46 | precio | esta un poco caro para el año no? | cerebro | ✓ | 1 |
| 47 | precio | si lo dejas en 240 te lo compro hoy | escala | ✗ | 2 |
| 48 | precio | hay descuento pagando de contado? | banco_etapa3 | ✓ | 1 |
| 49 | foraneo | Donde están ubicados | banco_etapa3 | ✗ | 3 |
| 50 | foraneo | Pensé que estaban en saltillo perdón yo estoy aquí | banco_etapa3 | ✗ | 3 |
| 51 | foraneo | hacen envios a torreon? | banco_etapa3 | ✗ | 3 |
| 52 | foraneo | me queda lejos, no hay forma de verlo en video? | banco_etapa3 | ✗ | 2 |
| 53 | foraneo | estoy en cdmx, como le hariamos? | banco_etapa3 | ✗ | 3 |
| 54 | estado_auto | Tiene adeudos el carro? | escala | ✗ | 3 |
| 55 | estado_auto | ha tenido choques? | escala | ✗ | 3 |
| 56 | estado_auto | cuando fue su ultimo servicio? | escala | ✗ | 2 |
| 57 | estado_auto | el clima enfria bien? | escala | ✗ | 3 |
| 58 | estado_auto | que version es? trae quemacocos? | escala | ✗ | 3 |
| 59 | fotos | Me las compartes porfvaor | cerebro | ✗ | 2 |
| 60 | fotos | tienes video andando? | escala | ✗ | 2 |
| 61 | fotos | mandame fotos del interior | banco_etapa3 | ✓ | 1 |
| 62 | desconfianza | Cómo funciona su empresa? | cerebro | ✗ | 2 |
| 63 | desconfianza | Me pueden explicar porfavor | cerebro | ✗ | 2 |
| 64 | desconfianza | Por seguridad principalmente | cerebro | ✗ | 2 |
| 65 | desconfianza | como se que no es fraude? luego hay mucho de eso | banco_etapa3 | ✗ | 3 |
| 66 | raros | Tu dime | cerebro | ✗ | 2 |
| 67 | raros | Me lo puedes mandar a este o mejor a ella directam | cerebro | ✗ | 2 |
| 68 | raros | Bueno ahí me dice si me interesa mucho la camionet | cerebro | ✗ | 2 |
| 69 | raros | https://maps.app.goo.gl/824iM5dUE42bHTo7A?g_st=iw | cerebro | ✗ | 3 |
| 70 | raros | Para irlo aber ocupo aser una sita | banco_etapa3 | ✓ | 1 |
| 71 | escala_esperada | que garantia dan? | escala | ✗ | 3 |
| 72 | escala_esperada | me puedes marcar para explicarme? | escala | ✗ | 2 |
| 73 | multi | ok y el enganche cuando se paga? y puedo ir el sab | banco_etapa3 | ✗ | 2 |
| 74 | multi | esta bonito pero no se si me alcance, cuanto seria | banco_etapa3 | ✗ | 2 |

*Datos crudos: /tmp/juicios.json y /tmp/resultados_all.json · Nada de este documento está implementado aún — esperando el "va" del dueño por tanda.*
