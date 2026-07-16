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
    const cached = await query("SELECT texto FROM ad_espia WHERE url=?", [url]).catch(() => []);
    if (cached.length) return cached[0].texto || null;   // '' = ya se intentó y no dio nada
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

module.exports = { espiar, linkDe };
