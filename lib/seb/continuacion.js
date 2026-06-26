// lib/seb/continuacion.js
// EN_CURSO (CONTINUACIÓN): contesta la RESPUESTA del comprador a un opener YA enviado.
// SOLO 2 universos, los de sus manuales: FINANCIAMIENTO y UBICACIÓN. Cualquier otra cosa
// → null (el bot se calla / lo ve el owner). Aplica UNA sola vez (la 1ra respuesta al
// opener); después, silencio.
//
// Formato (de los manuales): 3 RÁFAGAS → maquillada+nombre · acción PELONA · gancho.
// Sobrio: sin emojis, sin "!", solo "?" al final. Números SIEMPRE del cotizador HEY Banco.
// Fuente: lib/seb/playbook/MANUAL_FINANCIAMIENTO_SEB.md + MANUAL_UBICACION_SEB.md.

const { cotizar, planes } = require('./herramientas.js');
const { query } = require('./db.js');

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const fmtMXN = n => '$' + Number(n || 0).toLocaleString('es-MX');
const rot = arr => arr[Math.floor(Math.random() * arr.length)];

// ── Textos exactos de los manuales ───────────────────────────────────────────
const REQUISITOS = `Estos son los requisitos:
- identificación oficial vigente
- comprobante de domicilio
- 3 meses de nóminas o estados de cuenta
- RFC
- teléfono de casa
- Celular
- Tiempo viviendo en el domicilio
- Soltero o casado, en caso de ser casado, nombre del cónyuge
- correo electrónico
- nombre de la empresa, dirección y teléfono
- Tiempo trabajando en la empresa
- 4 referencias: 2 familiares que no vivan contigo (nombre y teléfono) y 2 amistades (nombre y teléfono)`;
const PROCESO = 'Es por medio de HEY Banco, con muy buenas tasas. Mandas tus documentos, te cotizo, solicitamos el crédito, te dicen si apruebas en menos de 2 horas, ya aprobado tú decides cuándo firmas, y el enganche lo das a la entrega — no pagas nada hasta que se te entregue el auto';
const TASA = 'Manejamos del 13.99% al 15%, dependiendo de tu buró e historial, con HEY Banco';
const BURO = 'Es sujeto a aprobación con HEY Banco; estés en buró o no lo vemos, y con buen historial mejora la tasa';

// ¿En qué universo cae la respuesta del comprador? null = ninguno → silencio/escala.
// Lo que el manual manda escalar (objeción de tasa, comparar bancos, permuta-enganche,
// seguro, abono a capital) también devuelve null.
function universoCont(texto) {
    const t = norm(texto);
    // Lo que escala (manual §7): objeción de tasa, comparar bancos, permuta-enganche, seguro, capital.
    if (/(esta cara|muy cara|bajal|baja la tasa|otro banco|otra financiera|comparar banco|seguro (incluido|lleva|trae)|abono a capital|a capital|dejo mi (carro|auto|camioneta) de enganche|permuta.*enganche|enganche.*permuta)/.test(t)) return null;
    // FINANCIAMIENTO FUERTE primero (gana sobre ubicación; evita que "estoy en buro" caiga en envío).
    if (/(financ|credito|enganche|de enganche|mensualidad|tasa|interes|requisito|que (documentos|papeles|piden|necesito|ocupan)|buro|historial|aprob|apto|califico|cotiza|corrida|preautoriz|a (cuantos )?meses|cuantos meses|\d+ ?meses)/.test(t)) return 'financiamiento';
    // UBICACIÓN (lugar / ciudad / envío / horario).
    if (/(ubicacion|donde (esta|la|lo|los|las|se|queda|puedo|puede)|en que parte|de que parte|en que ciudad|como llego|direccion|domicilio|pasame la ubic|mandame la ubic|mande la ubic|enviame la ubic|comparte.*ubic|donde se ubican|donde estan|que (parte|zona)|a que hora (abren|cierran)|horario|hacen envio|envian|otra ciudad|otro estado|me queda (lejos|retirado)|de lejos|estoy en (saltillo|monterrey|santiago|linares|montemorelos|cdmx|mexico|guadalajara|reynosa|laredo))/.test(t)) return 'ubicacion';
    // FINANCIAMIENTO débil.
    if (/(plazo|como queda|cuanto.*queda)/.test(t)) return 'financiamiento';
    return null;
}

// ── FINANCIAMIENTO (manual §3) ───────────────────────────────────────────────
async function responderFin({ texto, nombre, auto_id, enganche, plazo }) {
    const t = norm(texto);
    const nm = nombre ? ' ' + nombre : '';
    const tieneDato = !!(enganche || plazo);
    const esCotizar = tieneDato || /(cotiza|corrida|como queda|cuanto (me )?queda|mensualidad|a (cuantos )?meses|de enganche|ejercicio)/.test(t);
    const esRequisitos = /(requisito|que (documentos|papeles|necesito|piden|ocupan))/.test(t);
    const esTasa = /(tasa|interes|porcentaje)/.test(t);
    const esBuro = /(buro|historial|apto|califico|aprob|me prestan|me dan el credito)/.test(t);

    // COTIZAR — SIEMPRE ejecuta con el dato que haya; nunca pregunta el faltante (manual §4).
    if (esCotizar) {
        let card = null, eng = enganche || null;
        if (eng && plazo) { const r = await cotizar({ auto_id, enganche: eng, plazo_meses: plazo }); if (r.ok) card = r.placeholders.cotizacion; }
        else if (eng) { const r = await cotizar({ auto_id, enganche: eng }); if (r.ok) card = r.placeholders.cotizacion; }
        else { const r = await planes({ auto_id }); if (r.ok) card = r.placeholders.planes; }
        if (!card) return null;                       // <2018 / sin precio → escala (no inventa)
        const r1 = eng
            ? `${rot(['Va', 'Mira', 'Con gusto'])}${nm}, con tus ${fmtMXN(eng)} de enganche queda así:`
            : `${rot(['Con gusto', 'Va', 'Mira'])}${nm}, te paso la corrida para que veas las opciones:`;
        return { segmentos: [r1, card, 'Qué te parece, con cuál opción le damos, y a su vez te voy agendando para que vengas a ver el auto?'] };
    }
    if (esRequisitos) {
        return { segmentos: [`${rot(['Va', 'Con gusto', 'Claro'])}${nm}, con gusto`, REQUISITOS, 'Gustas que te cotice, o te solicitamos de una vez la preautorización con los documentos?'] };
    }
    if (esTasa) {
        return { segmentos: [`Mira${nm}`, TASA, 'Gustas que te mande un ejercicio para que veas cómo quedaría?'] };
    }
    if (esBuro) {
        return { segmentos: [`Va${nm}`, BURO, 'Gustas que te cotice?'] };
    }
    // info / proceso (default fin)
    return { segmentos: [`${rot(['Con gusto', 'Va', 'Mira'])}${nm}, te explico`, PROCESO, 'Gustas que te mande un ejercicio para que veas cómo quedaría?'] };
}

// ── UBICACIÓN (manual §3) — SIEMPRE manda el pin ─────────────────────────────
async function datosPunto(auto_id) {
    const pe = await query("SELECT name, (image_b64 IS NOT NULL) tiene_img, lat, lng FROM punto_envio WHERE auto_id=?", [Number(auto_id)]);
    if (pe.length && (pe[0].name || pe[0].lat != null)) return { dir: pe[0].name || 'nuestro punto de venta', tienePin: !!(pe[0].tiene_img || pe[0].lat != null) };
    const inv = await query("SELECT puntos_venta FROM inventario_autos WHERE id=?", [Number(auto_id)]);
    if (inv.length) { try { const p = JSON.parse(inv[0].puntos_venta || '[]'); if (p[0] && p[0].name) return { dir: p[0].name, tienePin: p[0].lat != null }; } catch (e) { } }
    return null;
}
async function esCamioneta(auto_id) {
    const r = await query("SELECT tipo_carroceria, modelo FROM inventario_autos WHERE id=?", [Number(auto_id)]);
    if (!r.length) return false;
    const s = norm((r[0].tipo_carroceria || '') + ' ' + (r[0].modelo || ''));
    return /(camioneta|pickup|pick up|suv|truck|doble cabina|bighorn|suburban|tacoma|ranger|hilux|frontier|l ?200|macan|tiguan|cr-?v|rav4|cx-?\d|q[357]|x[1-7]|explorer|tahoe|durango|journey|equinox|kicks|hr-?v|seltos)/.test(s);
}
async function responderUbi({ texto, nombre, auto_id }) {
    const t = norm(texto);
    const nm = nombre ? ' ' + nombre : '';
    const punto = await datosPunto(auto_id);
    const dir = punto ? punto.dir : null;
    const base = { ubicacion_auto_id: auto_id };       // señal: mandar el pin del punto

    // D. ENVÍO / DE LEJOS (manual §3.D)
    if (/(hacen envio|envian|otra ciudad|otro estado|me queda (lejos|retirado)|estoy en|soy de|de lejos|foraneo)/.test(t)) {
        return { ...base, segmentos: [`Claro${nm}, sí manejamos envío`, 'La viene a ver un mecánico o conocido tuyo que te dé luz verde, y te la mandamos con garantía de viaje', 'Gustas que la revise alguien de tu confianza?'] };
    }
    // F. HORARIOS (manual §3.F)
    if (/(a que hora (abren|cierran)|horario|que horario)/.test(t)) {
        return { ...base, segmentos: [`Mira${nm}`, 'El horario es de 9 a 7pm, pero como son consignaciones de particulares de uso cotidiano es con cita previa; la hora no importa, igual sábado o domingo', 'Qué día y hora te coordino?'] };
    }
    // B. GENERAL ("¿de qué parte / ciudad?") (manual §3.B)
    if (/(de que parte|en que parte|en que ciudad|de que ciudad|que (zona|ciudad)|de donde son)/.test(t)) {
        return { ...base, segmentos: [`${rot(['Claro', 'Mira'])}${nm}, ${rot(['estamos en', 'nos ubicamos en'])} San Pedro Garza García, Nuevo León, sobre Vasconcelos`, 'Te interesa venir a verla y manejarla?'] };
    }
    // C. "PÁSAME LA UBICACIÓN" (orden directa → pin PRIMERO) (manual §3.C)
    if (/(pasame la ubic|mandame la ubic|mande la ubic|enviame la ubic|comparte.*ubic|mandar.*ubic)/.test(t)) {
        return { ...base, pin_primero: true, segmentos: [dir ? `Va${nm}, aquí en ${dir}` : `Va${nm}, aquí está`, 'A qué hora te esperamos para agendarte?'] };
    }
    // A. EXACTITUD (default: "¿dónde está / la veo?") (manual §3.A)
    const laLo = (await esCamioneta(auto_id)) ? 'la' : 'lo';
    const r1 = rot([`Claro${nm}, déjame te mando la ubicación`, `Mira${nm}, aquí la tenemos:`, `Con gusto${nm}, te paso la ubicación`]);
    const r2 = dir ? `Aquí es nuestro punto de venta, ${dir}` : 'Aquí es nuestro punto de venta';
    return { ...base, segmentos: [r1, r2, `A qué hora te coordinamos una cita${nm}, para que ${laLo} manejes y ${laLo} veas?`] };
}

// ENTRADA: ¿la respuesta del comprador cae en un universo con manual? Si sí, arma la
// ráfaga. Si no, null (silencio/escala). `enganche`/`plazo` los extrae el clasificador.
async function responderCont({ texto, nombre, auto_id, enganche, plazo }) {
    if (!auto_id) return null;
    let u = universoCont(texto);
    if (!u && (enganche || plazo)) u = 'financiamiento';   // Haiku extrajo enganche/plazo → cotización
    let r = null;
    if (u === 'financiamiento') r = await responderFin({ texto, nombre, auto_id, enganche, plazo });
    else if (u === 'ubicacion') r = await responderUbi({ texto, nombre, auto_id });
    return (r && r.segmentos && r.segmentos.length) ? { universo: u, ...r } : null;
}

module.exports = { responderCont, universoCont };
