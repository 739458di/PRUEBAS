// lib/seb/validador.js
// El guardián del contrato de huecos. Recibe el borrador de Sonnet (con
// {{huecos}}) + los placeholders recolectados de las tools del turno.
//
//   1. Rellena cada {{hueco}} con el valor EXACTO que devolvió una tool.
//   2. Rechaza si hay un hueco que ninguna tool respaldó (o vino null).
//   3. Rechaza si la IA tecleó una cifra de dinero por su cuenta
//      (la IA redacta, el código pone los números — P2 del diseño).
//   4. Rechaza frases prohibidas y borradores demasiado largos.
//
// Salida: { ok:true, texto_final }  ó  { ok:false, motivo, detalle }.
// El caller hace 1 reintento; si falla de nuevo, escala a humano sin borrador.

// NOTA: "te lo aparto" / "apártala" SÍ se permite — es la jugada de CIERRE #1 de
// Sebastián (separación REVERSIBLE, las 3 ventas pasaron por ahí). Solo se bloquea el
// OVERPROMISE real (garantías absolutas, precio final, urgencia mentirosa).
const FRASES_PROHIBIDAS = [
    '100% garantizado', 'sin ningun riesgo', 'sin ningún riesgo',
    'te garantizo', 'precio final', 'no es negociable'
];

const MAX_LARGO = 900; // corto vende (turnos <80 chars doblan avance); esto es tope duro

// Cifras de DINERO tecleadas por el modelo (no de un hueco):
//   $123 · 123,456 · 123.456 (miles) · "350 mil" · números de 5+ dígitos
// Permitido: números chicos (horas "a las 6", fechas "el 15", años ya vienen
// por hueco, "2 dueños", "10:30").
const CIFRA_DINERO = /(\$\s?\d)|(\d{1,3}[,.]\d{3}\b)|(\b\d+\s?mil\b)|(\b\d{5,}\b)/i;

function validarYRellenar(borrador, placeholders) {
    if (!borrador || !String(borrador).trim()) {
        return { ok: false, motivo: 'borrador_vacio', detalle: '' };
    }
    let texto = String(borrador);

    // 1+2. Rellenar huecos; cualquier hueco sin respaldo = rechazo
    const huecos = [...texto.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map(m => m[1]);
    for (const h of huecos) {
        const val = placeholders ? placeholders[h] : undefined;
        if (val === undefined || val === null || val === '') {
            return { ok: false, motivo: 'hueco_sin_respaldo', detalle: h };
        }
    }
    texto = texto.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, h) => String(placeholders[h]));
    // Limpieza de unidades duplicadas ("40,000 km km" cuando el hueco ya traía la unidad)
    texto = texto.replace(/\bkm\s+km\b/gi, 'km').replace(/\bMXN\s+MXN\b/gi, 'MXN');

    // SOBRIO: Seb va SIN emojis (regla del owner). Red de seguridad — quita cualquier
    // emoji que el modelo cuele en el loop (incl. variation selectors / tonos de piel)
    // y limpia los espacios que deja. Las flechas "→" NO son pictográficas → se conservan.
    texto = texto.replace(/\p{Extended_Pictographic}/gu, '')
                 .replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '');
    texto = texto.replace(/ {2,}/g, ' ').replace(/ +([,.;:?!])/g, '$1').trim();

    // 3. ¿La IA tecleó una cifra de dinero por su cuenta?
    //    Se revisa el BORRADOR original (antes de rellenar): ahí ninguna
    //    cifra de dinero es legítima — todas deben venir por hueco.
    const sinHuecos = String(borrador).replace(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g, '');
    const m = sinHuecos.match(CIFRA_DINERO);
    if (m) {
        return { ok: false, motivo: 'cifra_no_autorizada', detalle: m[0] };
    }

    // 4. Frases prohibidas + largo
    const lower = texto.toLowerCase();
    for (const f of FRASES_PROHIBIDAS) {
        if (lower.includes(f)) return { ok: false, motivo: 'frase_prohibida', detalle: f };
    }
    if (texto.length > MAX_LARGO) {
        return { ok: false, motivo: 'demasiado_largo', detalle: texto.length + ' chars' };
    }

    return { ok: true, texto_final: texto };
}

// Junta los placeholders de varias tools en un solo mapa (último gana;
// en la práctica no colisionan porque cada tool tiene claves propias).
function juntarPlaceholders(resultadosTools) {
    const out = {};
    for (const r of resultadosTools || []) {
        if (r && r.placeholders) Object.assign(out, r.placeholders);
    }
    return out;
}

module.exports = { validarYRellenar, juntarPlaceholders, FRASES_PROHIBIDAS, MAX_LARGO };
