# FYRACHAT — SISTEMA VISUAL OBLIGATORIO (owner, 2026-09-12). TODA pantalla y TODA modificación futura del FyraChat lo sigue.
Referencia: imagen de 6 pantallas del owner (Chats · Nuevo comprador paso 1 · Nuevo comprador ¡Listo! · Agregar auto · Más · Chat abierto). La imagen manda sobre cualquier criterio propio.

## Tokens
BG #050C2A · SURFACE1 #09183F · SURFACE2 #10265B · PRIMARY #1F6FFF · PRIMARY LIGHT #2E8BFF · POSITIVE #35E0B0 · TEXT #FFFFFF · TEXT2 #9EB3E5 · MUTED #7088BD · DANGER #FF5C6C · BORDER rgba(55,110,255,.22) · GLOW 0 0 24px rgba(31,111,255,.18)
Tipografía: stack geométrico del sistema (-apple-system, Inter/SF); pesos 400/500/600/700. Sin tracking exagerado salvo logo/labels. Mobile: page title 28/32/700 · section 20/26/700 · body 15/22 · secondary 13/18 · small label 12/16.
Radios: card 20 · sheet 28 28 0 0 · input 16 · button 16 · pill 999. Spacing solo 4/8/12/16/20/24/32.
Sombras: card 0 12px 32px rgba(0,0,0,.18) · botón primario 0 10px 28px rgba(31,111,255,.28).
Bottom sheet: fixed; max-width 430; fondo linear-gradient(180deg,#10265B,#09183F); radius 28 28 0 0; border 1px BORDER; shadow 0 -20px 60px rgba(0,0,0,.35); padding 20 20 calc(20px+safe); handle 48×5 999 rgba(120,150,220,.45); abre 220ms cubic-bezier(.2,.8,.2,1).
Inputs: h 54; padding 0 16; bg rgba(7,20,58,.70); border 1px rgba(65,110,220,.28); radius 16; focus border #1F6FFF + 0 0 0 3px rgba(31,111,255,.14).
Botón primario: h 56; radius 16; bg linear-gradient(135deg,#1F6FFF,#2E8BFF); 700; blanco; active scale(.985); disabled .45; transición 140ms.
Bottom nav: fija; Inicio · Autos · (+) · Citas · Más; el + 64×64 redondo, gradiente primario, shadow 0 0 0 8px rgba(31,111,255,.12), 0 12px 28px rgba(31,111,255,.32); iconos lineales (Lucide-like inline SVG), NUNCA emojis.
Header: logo Fyradrive (wordmark: "Fyra" blanco + "drive" azul #2E8BFF, 700) — no existe asset gráfico en los repos; Seb (/seb-like.webp) pequeño arriba a la derecha junto a la campana; sin "¡Buenas, Seb!" ni nombre fijo.
Prohibido: emojis en UI, cards dentro de cards, bordes en todo, formularios largos, toasts de éxito, spinners grandes, "PASO 1 DE 3" enorme, dashboard SaaS.

## Pantallas
CHATS: header compacto + título "Chats" (28/700) + search "Buscar conversaciones" + pills Todos/Con sugerencia/Compradores + filas 72px (avatar 48 con inicial o foto, nombre 15/600, último mensaje real 13 TEXT2 elipsis, hora 12 MUTED, badge no leído azul); sin card por fila; separador 1px rgba(255,255,255,.05); hover rgba(255,255,255,.03); active rgba(31,111,255,.10).
NUEVO COMPRADOR (sheet, 3 pasos con indicador discreto 1-2-3 arriba): título "Nuevo comprador", sub "Solo necesitas su número para empezar.", campo "Número de WhatsApp" con +52 integrado a la izquierda y check verde "Número válido"; "¿A qué auto se refiere?" con row visual del auto (foto, nombre, año, precio verde, chevron) y "Buscar otro auto"; CTA fijo "Continuar →". Paso 2 = cómo entra (las 8 opciones existentes, como lista de rows). ¡LISTO! = mismo sheet: check verde animado (scale .8→1, opacity 0→1, 240ms) con confeti sutil, "¡Listo!", "El comprador se ha agregado y Seb se encargará de este chat.", row avatar+nombre+teléfono, estado "● Seb ahora atiende este chat" (verde), botón "Ir al chat", secundario "Agregar otro comprador".
AGREGAR AUTO (sheet): "Agregar auto"; fotos primero: cover grande + tile "Agregar fotos"; luego Marca · Modelo / Año · Precio / Kilometraje (opcional) · Color (opcional); "Más detalles ▾" colapsado (versión, transmisión, combustible, descripción); CTA "Agregar auto".
MÁS: header con logo + Seb; título "Más"; UNA lista agrupada (rows 68px: icono lineal, título, subtítulo, chevron): Tu cuenta / Tus dispositivos / Notificaciones / Ayuda / Ajustes; separado, "Cerrar sesión" en rojo.
CHAT ABIERTO: header ← avatar nombre "En línea" (estado pequeño) icono teléfono •••; debajo row compacto del auto en foco (foto, "Mazda CX-5 2021", precio verde, chevron) que abre el selector; burbujas comprador #20345F izquierda / vendedor #1F6FFF derecha, sin bordes ni sombras fuertes; acciones rápidas como botones cuadrados compactos "Cotizar · Agendar cita · Más" sobre el composer; composer sticky: clip (adjuntar) + input + botón redondo de enviar.
Microinteracciones: sheet 220ms; press scale(.985); row tap 120ms; success check 240ms.
Responsive: mobile-first max-width 430; desktop = la app centrada como panel de teléfono.
