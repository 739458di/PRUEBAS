// REGEX COMUNES — una sola definición para lo que antes vivía copiado en panel, sandbox, ruteador y auto-botón (limpieza 2026-09-22).
// Petición de posesión (fotos/ubicación/precio… pedidas al bot cuando el owner ya tomó el chat)
const RE_PETICION_POS = /(fotos?|im[aá]genes|videos?|ubicaci[oó]n|direcci[oó]n|d[oó]nde|mapa|precio|cu[aá]nto|cotiza|enganche|mensualidad|cita|agenda|disponible|informaci[oó]n|detalles|ficha)/i;
// Herramienta que contestó 'sin datos' (para no mandar ese texto al comprador)
const RE_HERR_SIN_DATOS = /(punto de venta configurado|no se pudo cotizar|arma t[uú] la cotizaci[oó]n|hey no lo financia)/i;
// Petición EXPLÍCITA de fotos / ubicación (fotos y ubicación mandan archivos: jamás por palabra suelta)
const RE_PIDE_FOTOS = /(foto|im[aá]gen|video|v[ií]deo|por dentro|por fuera|interior|exterior|c[oó]mo (se ve|luce|est[aá] de)|ens[eé][ñn]a|mu[eé]stra|verlo por aqu[ií])/i;
const RE_PIDE_UBIC = /(d[oó]nde|ubicaci|direcci|domicilio|zona|colonia|sucursal|mapa|\bpin\b|c[oó]mo llego|por d[oó]nde|queda (lejos|cerca)|en qu[eé] parte)/i;
// ¿Sigue disponible? (sobre texto normalizado sin acentos; antes vivía en continuación y etapa 3 con una diferencia de un '?')
const RE_DISPONIBLE = /(sigue disponible|aun disponible|todavia disponible|esta disponible|disponible (todavia|aun|verdad|\?)|todavia (lo|la) (tienes|tienen|venden|esta)|sigue (en|a la) venta|no (lo|la) han vendido|ya (lo|la) vendieron|ya se vendio|lo tienen todavia)/;
module.exports = { RE_DISPONIBLE, RE_PETICION_POS, RE_HERR_SIN_DATOS, RE_PIDE_FOTOS, RE_PIDE_UBIC };
