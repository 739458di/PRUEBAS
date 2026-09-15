// lib/seb/video-escenas.js — TOMAS DE VIDEO del owner (2026-09-15). Guiones EXACTOS dictados; nada lo redacta la IA.
// Dos tipos de escena:
//   · propio:true  → corre en el chat del owner consigo mismo (Juan habla por WhatsApp de verdad; lo del "comprador" solo se pinta en FyraChat)
//   · sintética    → chats falsos (teléfonos de prueba 52100000009x) que SOLO existen en FyraChat; contexto previo fechado atrás + pasos "en vivo"
// Tipos de paso: bot · comprador · tiempo(desfase_ms) · foto(url) · foto_in(url) · fotos_auto · ubicacion · sistema(pill) · cita(card)
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
/** próximo <dow> (0=dom..6=sáb) estrictamente después de hoy (Monterrey), +extra días opcional */
function proximo(dow, desde) {
    const base = desde ? new Date(desde) : new Date(Date.now() - 6 * 3600000);
    let d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
    do { d = new Date(d.getTime() + 86400000); } while (d.getUTCDay() !== dow);
    return d;
}
const fechaTxt = d => cap(DIAS[d.getUTCDay()]) + ' ' + d.getUTCDate() + ' de ' + MESES[d.getUTCMonth()];

const FOTO_VENDEDOR = process.env.VIDEO_FOTO_VENDEDOR || 'https://n29hevuhphbhhtlb.public.blob.vercel-storage.com/vehiculos/agencia-1789461566400-vendedor-fulano.png';
const DOCS = {
    ine: 'https://n29hevuhphbhhtlb.public.blob.vercel-storage.com/vehiculos/agencia-1789465339135-doc-ine.png',
    domicilio: 'https://n29hevuhphbhhtlb.public.blob.vercel-storage.com/vehiculos/agencia-1789465340004-doc-domicilio.png',
    nomina: 'https://n29hevuhphbhhtlb.public.blob.vercel-storage.com/vehiculos/agencia-1789465340732-doc-nomina.png',
    cuenta: 'https://n29hevuhphbhhtlb.public.blob.vercel-storage.com/vehiculos/agencia-1789465341491-doc-cuenta.png'
};
const VENDEDOR = process.env.VIDEO_VENDEDOR || 'Juan';

// ── ESCENAS PROPIAS (chat del owner consigo mismo) ──
function credito() {
    const vie = proximo(5);
    return { propio: true, nombre: 'Juan Pablo', auto_id: 285, titulo: 'Simulador crédito (Juan Pablo · Audi)', pasos: [
        { q: 'bot', t: '¿Qué tal Pablo? Soy ' + VENDEDOR + ', de Facebook. Te hablo para darte seguimiento a tu intención de crédito. Te molesto con los requisitos:', pausa: 1800 },
        { q: 'bot', t: 'Requisitos:\n• INE vigente\n• Comprobante de domicilio (no mayor a 3 meses)\n• 3 últimos recibos de nómina o estados de cuenta\n• RFC y CURP', pausa: 3400 },
        { q: 'comprador', t: 'Claro que sí, te los mando', pausa: 1800 },
        { q: 'foto_in', url: DOCS.ine, pausa: 1600 },
        { q: 'foto_in', url: DOCS.domicilio, pausa: 2600 },
        { q: 'bot', t: 'Recibido ✅', pausa: 1400 },
        { q: 'bot', t: 'Me faltan los otros.', pausa: 2800 },
        { q: 'foto_in', url: DOCS.nomina, pausa: 1600 },
        { q: 'foto_in', url: DOCS.cuenta, pausa: 2600 },
        { q: 'bot', t: 'Recibidos, los ingreso ahora mismo a crédito.', pausa: 2200 },
        { q: 'sistema', t: '🏦 Solicitando crédito bancario…', pausa: 4200 },
        { q: 'bot', t: 'Listo Pablo, tu crédito es aprobado ✅ ¿Gustas venir a manejar el auto antes de proceder?', pausa: 3400 },
        { q: 'comprador', t: 'Paso el viernes a las 6.', pausa: 2400 },
        { q: 'bot', t: 'Okey, muy bien.', pausa: 1500 },
        { q: 'bot', t: 'Cita confirmada ✅\n{AUTO} · ' + fechaTxt(vie) + ' · 6:00 pm', pausa: 0 }
    ] };
}
function toma2() {
    const dom = proximo(0), lun = proximo(1, dom.getTime() + 86400000);
    return { propio: true, nombre: 'Pedro', auto_id: 263, titulo: 'Toma 2 (Pedro · Tacoma: cancela y reagenda)', pasos: [
        { q: 'bot', t: 'Por aquí te mando tus fotos', pausa: 1600 },
        { q: 'fotos_auto', pausa: 3600 },
        { q: 'comprador', t: 'Okey, me gustaría ir a verla el domingo a las 11am.', pausa: 2600 },
        { q: 'bot', t: 'Okey, cita confirmada para el domingo ✅\n{AUTO} · ' + fechaTxt(dom) + ' · 11:00 am', pausa: 3200 },
        { q: 'tiempo', t: 'La noche antes de la cita', desfase_ms: 5 * 86400000, pausa: 2600 },
        { q: 'comprador', t: 'Oye, se me atravesó un imprevisto', pausa: 1600 },
        { q: 'comprador', t: 'No podré ir a la cita.', pausa: 2600 },
        { q: 'bot', t: 'Okey, qué lástima. Cita cancelada ❌', pausa: 1800 },
        { q: 'sistema', t: '❌ Cita cancelada · {AUTO}', pausa: 3000 },
        { q: 'tiempo', t: '2 días después', desfase_ms: 2 * 86400000, pausa: 2600 },
        { q: 'bot', t: '¿Qué tal Pedro? ¿Reagendamos la cita de la Tacoma?', pausa: 3000 },
        { q: 'comprador', t: 'Sí, el lunes.', pausa: 2200 },
        { q: 'bot', t: '¿A qué hora exacta?', pausa: 2600 },
        { q: 'comprador', t: 'Yo te aviso, no sé cómo estén mis horarios.', pausa: 3000 },
        { q: 'tiempo', t: 'Un día antes de la cita', desfase_ms: 4 * 86400000, pausa: 2600 },
        { q: 'bot', t: '¿Qué tal Pedro? ¿A qué hora mañana para la Tacoma?', pausa: 3000 },
        { q: 'comprador', t: 'Entre 9 y 11 por favor.', pausa: 2400 },
        { q: 'bot', t: 'Ok, mañana nos vemos. Cita confirmada ✅\n{AUTO} · ' + fechaTxt(lun) + ' · entre 9 y 11 am · Plaza Tribeca', pausa: 0 }
    ] };
}

// ── ESCENAS SINTÉTICAS (chats que solo viven en FyraChat) ──
function bryan() {
    return { titulo: 'Bryan (viene en la tarde)', chats: [{ tel: '5210000000091', nombre: 'Bryan', auto_id: 295,
        previo: [
            { q: 'comprador', t: 'Hola, me interesa la CX-5, ¿la puedo ver?' },
            { q: 'bot', t: 'Claro Bryan, ¿qué día y a qué hora te queda bien pasar a verla?' },
            { q: 'ubicacion' }
        ],
        vivo: [
            { q: 'comprador', t: 'Voy durante la tarde de hoy', pausa: 2600 },
            { q: 'bot', t: 'Okey, te espero durante el transcurso de la tarde.', pausa: 1800 },
            { q: 'bot', t: 'Te va a atender:', pausa: 1400 },
            { q: 'foto', url: FOTO_VENDEDOR, pausa: 2200 },
            { q: 'bot', t: 'Fulano Pérez, tu vendedor verificado.', pausa: 0 }
        ] }] };
}
function ignacio() {
    return { titulo: 'Ignacio (no alcanza a llegar)', chats: [{ tel: '5210000000092', nombre: 'Ignacio', auto_id: 284,
        previo: [
            { q: 'comprador', t: 'Buenas, ¿sigue disponible el Sentra?' },
            { q: 'bot', t: 'Sí Ignacio, disponible. ¿Te agendo para que lo veas?' },
            { q: 'comprador', t: 'Sí, hoy a las 5' },
            { q: 'bot', t: 'Cita confirmada ✅\n{AUTO} · hoy · 5:00 pm' }
        ],
        vivo: [
            { q: 'comprador', t: 'Oye, no alcanzo a llegar, una disculpa.', pausa: 2600 },
            { q: 'bot', t: 'Okey, ntp. Cita cancelada ❌ Me avisas si gustas reagendar.', pausa: 0 }
        ] }] };
}
function carrusel() {
    const man = proximo(new Date(Date.now() - 6 * 3600000 + 86400000).getUTCDay());
    const C = (tel, nombre, auto_id, previo, vivo) => ({ tel, nombre, auto_id, previo, vivo });
    const conf = (auto, cuando) => 'Cita confirmada ✅\n' + auto + ' · ' + cuando;
    return { titulo: 'Carrusel: 8 citas confirmadas', chats: [
        C('5210000000081', 'Laura', 236, [{ q: 'comprador', t: 'Hola, me interesa el Mazda 3' }, { q: 'bot', t: '¿Qué día te queda bien pasar a verlo, Laura?' }, { q: 'comprador', t: 'Mañana a las 10' }], [{ q: 'bot', t: conf('{AUTO}', 'mañana · 10:00 am'), pausa: 0 }]),
        C('5210000000082', 'Andrés', 257, [{ q: 'comprador', t: '¿Sigue disponible la CRV?' }, { q: 'bot', t: 'Sí Andrés. ¿Te agendo para verla?' }, { q: 'comprador', t: 'Sí, el sábado a las 12' }], [{ q: 'bot', t: conf('{AUTO}', 'sábado · 12:00 pm'), pausa: 0 }]),
        C('5210000000083', 'Paty', 280, [{ q: 'comprador', t: 'Me interesa la Sorento, ¿la puedo manejar?' }, { q: 'bot', t: 'Claro Paty, ¿qué día y hora?' }, { q: 'comprador', t: 'Jueves 6 pm' }], [{ q: 'bot', t: conf('{AUTO}', 'jueves · 6:00 pm'), pausa: 0 }]),
        C('5210000000084', 'Jorge', 292, [{ q: 'comprador', t: 'Cotízame la X5 con 200 de enganche' }, { q: 'bot', t: 'Va Jorge, te la mando. ¿Te agendo para verla?' }, { q: 'comprador', t: 'Mañana 5 pm' }], [{ q: 'bot', t: conf('{AUTO}', 'mañana · 5:00 pm'), pausa: 0 }]),
        C('5210000000085', 'Mónica', 261, [{ q: 'comprador', t: '¿El Wrangler está en Tribeca?' }, { q: 'bot', t: 'Sí Mónica, ahí lo tenemos. Tu cita quedó hoy a las 4.' }], [{ q: 'comprador', t: 'Ya voy en camino', pausa: 2400 }, { q: 'bot', t: 'Okey, aquí te esperamos!!!!', pausa: 0 }]),
        C('5210000000086', 'Ricardo', 278, [{ q: 'comprador', t: 'Quiero ver el Mustang' }, { q: 'bot', t: '¿Qué día te acomoda, Ricardo?' }, { q: 'comprador', t: 'Viernes a las 7' }], [{ q: 'bot', t: conf('{AUTO}', 'viernes · 7:00 pm'), pausa: 0 }]),
        C('5210000000087', 'Karla', 275, [{ q: 'comprador', t: 'Hola, el Onix ¿lo puedo ver hoy?' }, { q: 'bot', t: 'Claro Karla, ¿a qué hora?' }, { q: 'comprador', t: 'A las 3' }], [{ q: 'bot', t: conf('{AUTO}', 'hoy · 3:00 pm'), pausa: 0 }]),
        C('5210000000088', 'Daniel', 279, [{ q: 'comprador', t: 'Me interesa la Sienna para la familia' }, { q: 'bot', t: '¿Cuándo pasas a verla, Daniel?' }, { q: 'comprador', t: 'El domingo a las 11' }], [{ q: 'bot', t: conf('{AUTO}', 'domingo · 11:00 am'), pausa: 0 }])
    ] };
}

const ESCENAS = { credito, toma2, bryan, ignacio, carrusel };
const TELS_SINTETICOS = '52100000000%';   // todos los chats sintéticos de video llevan este prefijo (borrables con "Limpiar tomas")

module.exports = { ESCENAS, TELS_SINTETICOS, FOTO_VENDEDOR, DOCS, proximo, fechaTxt };
