# PROPUESTA — CIERRE DE CITA 100% CUBIERTO
**Fyradrive · +8 de julio 2026+** · análisis de SOLO el área de cita en conversaciones reales

## 1. Qué miré
Saqué de tus conversaciones reales **cada respuesta del comprador que vino JUSTO DESPUÉS de que Seb pidió la cita** ("¿qué día?", "¿a qué hora?", "¿te agendo?", "¿vienes a verlo?"). Son **359 respuestas reales** — el momento exacto donde se gana o se pierde la cita.

## 2. El problema de raíz (tus 2 banderitas)
El bot **confirma humo**: toma un titubeo como cita firme y lanza el ✅.

| 🚩 | Comprador dijo | Bot hizo | Debía |
|---|---|---|---|
| 99 | "deja veo si mañana 4pm" | **Cita confirmada ✅** mañana 4pm | "deja veo si" = 0 compromiso → formalizar, NO cerrar |
| 462 | "pues como trabajo yo creo que en la mañana" | **Cita confirmada ✅** "Lunes a las mañana" | ver la objeción (trabaja) + bajarla a real + hora concreta |

**La regla de oro que falta:** *nunca emitir el ✅ si el mensaje trae un titubeo o una objeción sin resolver — por más que traiga día y hora.*

## 3. Las situaciones reales (así divagan)

| Situación | Cuántas | Ejemplo real | Qué hace HOY el bot | ✅/❌ |
|---|---|---|---|---|
| **Firme** (día+hora, sin titubeo) | pocas | "mañana a las 5pm" | confirma ✅ | ✅ |
| **Falta dato** (solo día/hora/franja) | ~13 | "el lunes" / "a las 3" / "en la mañana" | pide el dato o propone slots | ✅ casi |
| **Titubeo / al aire** | ~14 | "dejame ver si el viernes" | a veces confirma, a veces promesa | ❌ inconsistente |
| **Objeción TRABAJO** | 4+ | "Ok lo que pasa es que trabajo de lunes a sábado déjeme ver si el sábado puedo ir" | ignora la objeción, pide hora | ❌ |
| **Objeción DISTANCIA** | 2+ | "soy de saltillo te aviso cuando pueda" | foráneo (ya cubierto) | 🟡 |
| **Objeción TERCERO** | varias | "lo tengo que ver con mi esposa" | pide día (ignora al decisor) | ❌ |
| **Objeción DINERO previo** | varias | "cuando junte el enganche voy" | pide día (ignora la traba) | ❌ |
| **Deflexión a otro tema** | ~250 | "me interesa financiado" / "cómo quedaría" | contesta pero no re-ancla la cita | 🟡 |
| **Promesa** ("te aviso") | ~10 | "Yo te aviso cuando podre ir" | acusa recibo (bien) | ✅ |
| **Rechazo / freno** | pocas | "no puedo, mejor luego" | — | ❌ |

## 4. LA PROPUESTA — El "Cerrador de Cita" de 3 marchas

La idea: cada respuesta de cita pasa por 3 marchas antes de agendar. Nunca se salta a ✅ sin pasar por la realidad.

### 🥇 Marcha 1 — LEER el termómetro de compromiso
Antes de nada, el bot clasifica la respuesta:

- **FIRME** = día + hora concretos y CERO titubeo → va directo a cerrar (Marcha 3).
- **TENTATIVO / AL AIRE** = trae marcador de duda ("deja veo", "creo que", "si puedo", "checo y te digo", "tal vez") → **jamás ✅**; se formaliza y se espera el sí.
- **OBJECIÓN** = trae una traba escondida (trabajo, distancia, tercero, dinero) → Marcha 2.
- **FALTA DATO** = solo día, solo hora, o franja vaga → se completa con propuesta concreta.
- **DEFLEXIÓN** = contesta con otra duda (crédito/precio/foto) → se responde y se RE-ANCLA la cita.
- **PROMESA** = "te aviso / yo te digo" → acuse + ancla de tiempo + el timer de ghosting 3h ya la cuida.

> **El candado anti-humo:** si detecta titubeu U objeción, el ✅ queda BLOQUEADO aunque el mensaje traiga día y hora. Primero se baja a realidad.

### 🥈 Marcha 2 — BAJAR A REALIDAD (poner de NUESTRA parte)
El corazón de lo que pediste. Cuando hay objeción, el bot NO la ignora ni agenda humo — la nombra y ofrece una solución nuestra, luego cierra:

| Objeción (real, de tus chats) | La jugada del bot (bajar a realidad) |
|---|---|
| "trabajo de lunes a sábado" / "entre semana se me dificulta" | "Sin tema, también abrimos **sábado y domingo**, y te esperamos **a la hora que salgas**. ¿El sábado a las 5 o el domingo en la mañana?" |
| "salgo tarde del trabajo" | "No hay bronca, te agendo **saliendo de tu chamba**, la prueba de manejo es rápida. ¿A qué hora sales?" |
| "cuando junte el enganche" / "el día de pago" | "El enganche lo das **hasta la entrega**, no necesitas tenerlo ya — ven a verlo y manejarlo sin compromiso primero. ¿Mañana o el sábado?" |
| "lo tengo que ver con mi esposa" | "Claro, **tráela a la cita** y lo ven juntos, o te mando un resumen para que lo revisen. ¿Qué día les acomoda?" |
| "soy de Saltillo / me queda lejos" | (banco foráneo ya vivo) envío + persona de confianza que dé luz verde |
| "en la mañana / en la tarde / al mediodía" | propone 2 horas concretas dentro de esa ventana: "¿te late a las 10 o a las 11?" |

### 🥉 Marcha 3 — CERRAR EN FIRME (la escalera de compromiso)
El ✅ solo se emite al final de esta escalera, cuando la cita es REAL:

```
  palabras al aire   →   eco formal + objeción resuelta   →   propuesta concreta (2 opciones)
  "deja veo mañana"      "va, mañana entonces, sin tema"      "¿te late a las 4 o a las 5?"
         ↓
     el "sí"        →   CITA CONFIRMADA ✅   →   aviso al dueño (ya construido)
```

- **Compromiso DURO** ("paso mañana a las 5", firme) → salta directo a ✅.
- **Todo lo demás** (tentativo, objeción, franja) → sube la escalera peldaño por peldaño; el ✅ espera hasta el sí real.
- **Doble candado:** si ya se pidió cita 2+ veces sin cerrar → deja de empujar (no rogar) y el ghosting 3h la retoma.

## 5. Qué se construye (todo en etapa3.js, bajo)
1. **Detector de titubeo/0-compromiso** (candado anti-✅): "deja veo/ver/checo", "te confirmo la hora", "si puedo", "creo que", "tal vez", "yo te digo" → fuerza la escalera, nunca cierra directo. *(arregla 🚩 99)*
2. **Detector de objeción + banco de soluciones** (Marcha 2): trabajo / dinero-previo / tercero / distancia → cada uno con su jugada de "bajar a realidad". *(arregla 🚩 462 y la mitad de las trabas)*
3. **Franja → 2 horas concretas** (ya existe, se refuerza: "en la mañana" nunca se confirma como "a las mañana").
4. **Deflexión → responder + re-anclar** la cita al final (para las ~250 que cambian de tema).
5. **Re-uso** del cerrador de 2 peldaños y del aviso al dueño que YA están vivos.

**Prioridad:** (1) y (2) primero — son tus dos banderitas y el 80% de las trabas reales. Todo vive en etapa3.js, riesgo bajo, se prueba en el sandbox antes de nada.

*Nada de esto está construido aún — es la propuesta. Dame el "va" (completo o por marcha) y lo armo y pruebo en el sandbox con estas mismas frases reales.*
