// lib/seb/ad-espia.js — "PENETRAR" EL LINK DEL ANUNCIO (caso Patricio Garza 2026-07-15)
//
// Los clics de campaña general (carrusel) llegan sin auto en el ad_context — pero el
// link fb.me redirige a la PUBLICACIÓN PÚBLICA del anuncio, y su og:description dice
// el auto EXACTO de la tarjeta clickeada ("Chevrolet Suburban Premier 2020 $599,000").
// Este módulo sigue el redirect, saca los og: y cachea por URL (tabla ad_espia) para
// no volver a pegarle a Facebook por el mismo link.
//
// Falla suave: si Facebook no da nada (login wall, anuncio borrado), regresa null y
// el flujo sigue como antes (opener universal pregunta el auto).

const { query, run } = require('./db.js');

async function ensure() {
    await run("CREATE TABLE IF NOT EXISTS ad_espia (url TEXT PRIMARY KEY, texto TEXT, created INTEGER)");
}

// Primer link de anuncio de Facebook/Instagram en un texto (fb.me, facebook.com, instagram.com)
function linkDe(str) {
    const m = String(str || '').match(/https?:\/\/(?:fb\.me|www\.facebook\.com|facebook\.com|m\.facebook\.com|l\.facebook\.com|fb\.watch|www\.instagram\.com|instagram\.com)\/\S+/i);
    return m ? m[0].replace(/[)\].,;!]+$/, '') : null;
}

async function espiar(url) {
    await ensure();
    const cached = await query("SELECT texto, created FROM ad_espia WHERE url=?", [url]).catch(() => []);
    if (cached.length) {
        if (cached[0].texto) return cached[0].texto;
        // '' = ya se intentó y no dio nada — pero el muro de FB a veces es transitorio
        // (caso Daniel 2026-07-16): un fallo se reintenta pasadas 24h, no jamás.
        if (Date.now() - Number(cached[0].created || 0) < 24 * 3600000) return null;
    }
    let texto = null;
    try {
        // OJO: Facebook le da 400 al Chrome "falso" de Node, pero SÍ sirve los og:
        // a los agentes de scraping oficiales — facebookexternalhit es el estándar.
        const r = await fetch(url, {
            headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Accept': 'text/html,*/*' },
            redirect: 'follow', signal: AbortSignal.timeout(8000)
        });
        const html = (await r.text()).slice(0, 500000);
        const og = p => {
            const m = html.match(new RegExp('<meta[^>]+(?:property|name)="' + p + '"[^>]+content="([^"]*)"'))
                || html.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="' + p + '"'));
            return m ? m[1] : null;
        };
        const dec = s => String(s || '').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (x, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim();
        const tit = dec(og('og:title')), desc = dec(og('og:description'));
        const partes = [tit, desc].filter(x => x && !/^(facebook|instagram|log in|iniciar sesi)/i.test(x));
        texto = partes.join(' | ') || null;
    } catch (e) { texto = null; }
    await run("INSERT INTO ad_espia (url, texto, created) VALUES (?,?,?) ON CONFLICT(url) DO UPDATE SET texto=excluded.texto, created=excluded.created", [url, texto || '', Date.now()]).catch(() => {});
    return texto;
}

// ══ SANEAR EL AD_CONTEXT (caso Daniel/Cavalier 2026-07-16) ══
// En campañas CARRUSEL, Meta manda en el contexto la tarjeta de PORTADA del
// anuncio, NO la que el comprador clickeó (portada decía Yaris; el clic fue al
// Cavalier → el bot afirmó el auto equivocado). LEY: la portada de un carrusel
// JAMÁS afirma el auto — solo la tarjeta espiada (og: de la publicación) puede.
// Sin confirmación → se PODA la portada y el opener pregunta qué auto busca.
// Marcador de carrusel: el copy de campaña general dice "Desliza..." — si el
// owner cambia el copy de la campaña, actualizar este regex.
const RE_CARRUSEL = /desliza/i;

// Poda el primer segmento " | " (la portada) SOLO si ese segmento resuelve un
// auto — así la función es idempotente (al segundo paso ya no hay qué podar).
function sinPortada(ctx, resolver) {
    const partes = String(ctx).split(' | ');
    if (partes.length >= 2 && resolver(partes[0])) return partes.slice(1).join(' | ');
    return ctx;
}

// Entrada única para TODO consumidor de ad_context. Regresa el contexto confiable
// (y lo persiste si cambió). `textoMensajes` = primeros entrantes, por si el link
// del anuncio viene en el mensaje y no en el contexto.
async function sanearContexto(telefono, adCtx, textoMensajes) {
    if (!adCtx || /\[AD-ESPIA:/.test(adCtx)) return adCtx;   // ya procesado
    let autos, resolver;
    try {
        const { resolverAutoDeterminista } = require('./clasificador.js');
        const rows = await query("SELECT id, marca, modelo, version, anio, precio, codigo_corto FROM inventario_autos WHERE estado='activo'");
        autos = rows.map(a => ({ id: a.id, nombre: [a.marca, a.modelo, a.version, a.anio].filter(Boolean).join(' '), anio: a.anio, precio: a.precio, codigo_corto: a.codigo_corto || null }));
        resolver = t => resolverAutoDeterminista('[DESC: ' + t + ']', autos);
    } catch (e) { return adCtx; }

    const carrusel = RE_CARRUSEL.test(adCtx);
    const resuelto = resolver(adCtx);
    // Anuncio de UN auto que ya resuelve → contexto confiable, no se toca.
    if (resuelto && !carrusel) return adCtx;

    const url = linkDe(adCtx) || linkDe(textoMensajes || '');
    const tEspia = url ? await espiar(url) : null;

    let ctx = adCtx;
    if (carrusel) {
        // la portada se destrona SIEMPRE; la tarjeta espiada (si hay) toma su lugar
        const cola = sinPortada(adCtx, resolver);
        ctx = tEspia ? String('[AD-ESPIA: ' + tEspia + '] | ' + cola).slice(0, 1200) : cola;
    } else if (tEspia) {
        // campaña sin auto en el contexto (caso Patricio): se amarra la tarjeta espiada
        ctx = String(adCtx + ' | [AD-ESPIA: ' + tEspia + ']').slice(0, 1200);
    }
    if (ctx !== adCtx) {
        await run("UPDATE ad_por_telefono SET ad_context=?, updated_at=? WHERE telefono=?", [ctx, Date.now(), telefono]).catch(() => {});
    }
    return ctx;
}

module.exports = { espiar, linkDe, sanearContexto, sinPortada, RE_CARRUSEL };
