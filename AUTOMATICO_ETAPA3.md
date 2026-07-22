# ¿QUÉ PUEDO ECHAR A VOLAR EN AUTOMÁTICO? — Etapa 3
**Fyradrive · 8 jul 2026** · análisis por ruta (la ruta = la certeza)

## La regla de oro
- **Banco** = respuesta prefabricada, probada, entrenada → NUNCA improvisa → **100% segura**.
- **Escala con puente** = el bot dice un puente seguro ("déjame te confirmo y en un momento te digo") y TÚ resuelves → **100% segura** (no puede decir algo mal).
- **Silencio** = cortesía de cierre, por diseño → segura.
- **Cerebro (Sonnet)** = IA libre → puede improvisar → **el ÚNICO riesgo**.

## El número (220 de tus mensajes reales de etapa 3, medidos)
| Ruta | % | ¿Seguro para automático? |
|---|---|---|
| Banco determinístico | 50% | ✅ SÍ |
| Escala con puente | 2% | ✅ SÍ |
| Silencio (cortesía) | 1% | ✅ SÍ |
| Cerebro (Sonnet) | 47%* | ⚠️ riesgo |

*De ese 47%: **~35% era falta de contexto** (se probaron aislados; en una conversación real caen en banco) y **~65% long-tail genuino**. En contexto real el cerebro ronda el **20-25%**.

## Tabla de certeza por ÁREA → SUBÁREA → INPUT (de más sólido a menos)

| Área | Subárea | Input ejemplo | Ruta | Certeza |
|---|---|---|---|---|
| CITA | firme dia+hora | "paso mañana a las 5pm" | banco | 🟢 SÓLIDO (banco probado) |
| CITA | al aire (puedo) | "puedo pasar mañana a las 11" | banco | 🟢 SÓLIDO (banco probado) |
| CITA | titubeo | "deja veo si el jueves" | banco | 🟢 SÓLIDO (banco probado) |
| CITA | solo dia | "el sabado" | banco | 🟢 SÓLIDO (banco probado) |
| CITA | franja vaga | "el jueves antes de las 4" | banco | 🟢 SÓLIDO (banco probado) |
| CITA | obj trabajo | "como trabajo entre semana se me complica" | banco | 🟢 SÓLIDO (banco probado) |
| CITA | obj dinero | "cuando junte el enganche voy" | banco | 🟢 SÓLIDO (banco probado) |
| CITA | obj tercero | "lo tengo que ver con mi esposa" | banco | 🟢 SÓLIDO (banco probado) |
| CITA | obj distancia | "estoy en saltillo como le hacemos" | banco | 🟢 SÓLIDO (banco probado) |
| CITA | promesa | "te aviso en estos dias" | banco | 🟢 SÓLIDO (banco probado) |
| CITA | drop-by | "yo ahi paso" | banco | 🟢 SÓLIDO (banco probado) |
| INFO AUTO | dueños | "cuantos dueños ha tenido" | banco | 🟢 SÓLIDO (banco probado) |
| INFO AUTO | km | "cuantos km tiene" | banco | 🟢 SÓLIDO (banco probado) |
| INFO AUTO | choques | "ha chocado" | banco | 🟢 SÓLIDO (banco probado) |
| INFO AUTO | adeudos | "tiene adeudos" | banco | 🟢 SÓLIDO (banco probado) |
| INFO AUTO | servicios | "tiene sus servicios" | banco | 🟢 SÓLIDO (banco probado) |
| INFO AUTO | clima | "el aire enfria" | banco | 🟢 SÓLIDO (banco probado) |
| INFO AUTO | color | "de que color es" | banco | 🟢 SÓLIDO (banco probado) |
| INFO AUTO | mas info | "me das mas informacion" | banco | 🟢 SÓLIDO (banco probado) |
| INFO AUTO | motor (sin dato) | "que motor trae" | escala+puente | 🟢 SÓLIDO (escala con puente) |
| FACTURA | tipo factura | "que factura tiene" | banco | 🟢 SÓLIDO (banco probado) |
| CREDITO | cotizar enganche | "como quedaria con 80 mil" | banco | 🟢 SÓLIDO (banco probado) |
| CREDITO | minimo enganche | "cual es el minimo de enganche" | banco | 🟢 SÓLIDO (banco probado) |
| CREDITO | mensualidad | "cuanto seria el pago mensual" | banco | 🟢 SÓLIDO (banco probado) |
| CREDITO | buro | "checan buro" | banco | 🟢 SÓLIDO (banco probado) |
| CREDITO | requisitos | "que requisitos piden" | banco | 🟢 SÓLIDO (banco probado) |
| CREDITO | que banco | "con que banco es" | banco | 🟢 SÓLIDO (banco probado) |
| CREDITO | tasa | "que tasa manejan" | banco | 🟢 SÓLIDO (banco probado) |
| CREDITO | 72 meses | "y a 72 meses" | escala+puente | 🟢 SÓLIDO (escala con puente) |
| CREDITO | tercero credito | "el credito a nombre de mi mama" | banco | 🟢 SÓLIDO (banco probado) |
| CREDITO | banco propio | "tengo credito aprobado con banorte" | banco | 🟢 SÓLIDO (banco probado) |
| CREDITO | abono capital | "se puede abonar a capital" | banco | 🟢 SÓLIDO (banco probado) |
| CREDITO | trabajo cuenta | "trabajo por mi cuenta sin nomina" | escala+puente | 🟢 SÓLIDO (escala con puente) |
| UBICACION | donde | "donde lo puedo ver" | banco | 🟢 SÓLIDO (banco probado) |
| UBICACION | horario | "que horario tienen" | banco | 🟢 SÓLIDO (banco probado) |
| UBICACION | necesito cita | "puedo ir sin cita" | banco | 🟢 SÓLIDO (banco probado) |
| UBICACION | lugar seguro | "el punto es seguro" | banco | 🟢 SÓLIDO (banco probado) |
| UBICACION | transporte | "puedo llegar en uber" | escala+puente | 🟢 SÓLIDO (escala con puente) |
| UBICACION | estacionamiento | "hay estacionamiento" | escala+puente | 🟢 SÓLIDO (escala con puente) |
| UBICACION | mecanico | "puedo llevar mi mecanico" | banco | 🟢 SÓLIDO (banco probado) |
| NEGOCIO | son lote | "son un lote" | banco | 🟢 SÓLIDO (banco probado) |
| NEGOCIO | como funciona | "como funciona su empresa" | cerebro | 🟡 CEREBRO (riesgo) |
| FOTOS | fotos | "me mandas fotos" | banco | 🟢 SÓLIDO (banco probado) |
| FOTOS | video | "tienes video" | escala+puente | 🟢 SÓLIDO (escala con puente) |
| PRECIO | negociable | "es negociable" | banco | 🟢 SÓLIDO (banco probado) |
| PRECIO | oferta numero | "te doy 240 y cerramos" | escala+puente | 🟢 SÓLIDO (escala con puente) |
| ESCALA | garantia | "que garantia dan" | escala+puente | 🟢 SÓLIDO (escala con puente) |
| ESCALA | llamada | "me puedes marcar" | escala+puente | 🟢 SÓLIDO (escala con puente) |
| ESCALA | miedo/fraude | "como se que no es fraude" | escala+puente | 🟢 SÓLIDO (escala con puente) |
| ESCALA | entrega mismo dia | "me lo llevo hoy mismo" | escala+puente | 🟢 SÓLIDO (escala con puente) |
| ESCALA | permuta | "doy mi carro de enganche" | banco | 🟢 SÓLIDO (banco probado) |
| OTROS | otros autos | "que otros autos tienes" | banco | 🟢 SÓLIDO (banco probado) |
| CORTESIA | gracias | "ok gracias" | silencio | 🟢 silencio (cortesía) |
| INTERES | interes pelón | "si me interesa" | banco | 🟢 SÓLIDO (banco probado) |
| LONG-TAIL | raro | "tu dime" | cerebro | 🟡 CEREBRO (riesgo) |
| LONG-TAIL | raro2 | "me lo puedes mandar a este o a ella" | cerebro | 🟡 CEREBRO (riesgo) |

## Veredicto por área

### 🟢 TIER 1 — LISTO PARA AUTOMÁTICO YA (banco probado + entrenado, cero improvisación)
- **CITA (cierre):** firme, al aire, titubeo, objeciones (trabajo/dinero/tercero/distancia), franja vaga, promesa, drop-by. *El corazón del embudo, todo banco.*
- **INFO DEL AUTO:** dueños, km, choques, adeudos, servicios, clima, color, factura, más-información (con espejo de verbo + proactividad).
- **CRÉDITO:** cotizar (herramienta real HEY/Renueva Car), mínimo enganche, mensualidad, buró, requisitos, qué banco, tasa, crédito a tercero, banco propio, abono a capital.
- **UBICACIÓN:** dónde/pin, horario, ¿necesito cita?, lugar seguro, llevar mecánico.
- **NEGOCIO/CONFIANZA:** ¿son lote?, cómo funciona (recién tapado).
- **FOTOS, PRECIO (negociable), INTERÉS (sí me interesa), OTROS AUTOS, CORTESÍA (silencio).**

### 🟢 TIER 2 — AUTOMÁTICO CON ESCALA (el bot manda el puente, tú das el dato — cero riesgo)
- **CRÉDITO:** 72 meses, trabajo por cuenta (sin nómina).
- **INFO:** motor / versión exacta sin dato en ficha.
- **UBICACIÓN:** transporte, estacionamiento, cuánto dinero llevar.
- **FOTOS:** video. **PRECIO:** oferta con número.
- **ESCALAS puras:** garantía, llamada, miedo/fraude, entrega mismo día, IVA completo, CAT.

### 🟡 TIER 3 — EL ÚNICO RIESGO: LONG-TAIL → CEREBRO
Mensajes raros/específicos que ningún banco atrapa: *"el seguro con qué compañía es?", "si le bajamos ya", "hay algún interesado?", "tú dime", "para llevarme el efectivo"*. ~20-25% en contexto real.

## MI RECOMENDACIÓN — 2 caminos

**Camino A (recomendado, 100% automático sin riesgo):** enciende automático para TODO lo Tier 1 + Tier 2, y **convierte el cerebro en escala con puente**: cuando ningún banco atrape el mensaje, en vez de dejar que Sonnet improvise, el bot dice *"Déjame reviso bien eso y en un momento te confirmo"* → lo ves tú. Resultado: **nada improvisado, todo es banco probado o escala segura.** El costo: te escala ~20-25% (el long-tail).

**Camino B (más cobertura, algo de riesgo):** Tier 1 + Tier 2 automáticos, y el cerebro (long-tail) lo dejas en COPILOTO (tú apruebas el borrador de Sonnet). Cero riesgo de que se envíe algo raro, pero tú revisas ese 20-25%.

**Camino C (agresivo):** todo automático incluyendo cerebro. NO recomendado hasta tener el VALIDADOR DE SALIDA (linter que bloquea truncados/fugas de razonamiento) — el cerebro ya tuvo esos fallos.

*Mi voto: **Camino A.** Es la forma de volar 100% automático hoy sin una sola improvisación. El long-tail que te escale lo vas convirtiendo en banco conforme lo veas (con el training 🚩).*
