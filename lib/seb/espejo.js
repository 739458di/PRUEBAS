// lib/seb/espejo.js — EL ESPEJO SB → FYRADRIVE (orden del owner 2026-08-08):
// "encárgate de que todo lo que está en el salesbrain esté también en fyradrive".
// El Sales Brain (inventario_autos) es LA VERDAD del catálogo; la web (autos) es su
// copia. Barredor determinista, idempotente, corre en seb-cron cada 10 min:
//   1) FANTASMA: tarjeta web activa sin espejo SB activo → estado='eliminado'
//   2) REVIVIR: SB activo cuya tarjeta web quedó 'eliminado' → de vuelta a 'activo'
//      (las tarjetas 'vendido' NO se reviven: vendido en fyradmin es palabra del owner)
//   3) VENDIDO PROPAGA: tarjeta web 'vendido' con SB aún 'activo' → SB pasa a 'vendido'
//      (así el bot deja de ofrecer un auto que el owner ya marcó vendido)
//   4) PRECIO: SB manda — precio distinto en la tarjeta → se copia el del SB
//      (el horno v2 detecta el cambio y re-hornea la portada solo)
//   5) SIN TARJETA: SB activo sin tarjeta web → solo se REPORTA (crear tarjeta
//      necesita fotos; eso es de la carga de lote, no del barredor)
const { query, run } = require('./db.js');

async function tickEspejo() {
    const r = { fantasmas: 0, revividos: 0, vendidos_propagados: 0, precios: 0, sin_tarjeta: [] };

    // 3) vendido en fyradmin → SB lo respeta (antes de revivir, por si acaso)
    const v = await run(`UPDATE inventario_autos SET estado='vendido'
        WHERE estado='activo' AND fyradrive_web_id IN
        (SELECT id FROM autos WHERE estado='vendido')`, []);
    r.vendidos_propagados = v.rowsAffected || 0;

    // 1) fantasmas fuera
    const f = await run(`UPDATE autos SET estado='eliminado'
        WHERE estado='activo' AND id NOT IN
        (SELECT COALESCE(fyradrive_web_id,-1) FROM inventario_autos WHERE estado='activo')`, []);
    r.fantasmas = f.rowsAffected || 0;

    // 2) los del SB reviven si alguien los borró de la web
    const rv = await run(`UPDATE autos SET estado='activo'
        WHERE estado='eliminado' AND id IN
        (SELECT COALESCE(fyradrive_web_id,-1) FROM inventario_autos WHERE estado='activo')`, []);
    r.revividos = rv.rowsAffected || 0;

    // 4) precio: SB es la verdad
    const px = await query(`SELECT i.fyradrive_web_id fw, i.precio FROM inventario_autos i
        JOIN autos a ON a.id = i.fyradrive_web_id
        WHERE i.estado='activo' AND a.estado='activo'
        AND i.precio > 0 AND i.precio != a.precio`, []);
    for (const p of px) {
        await run(`UPDATE autos SET precio=? WHERE id=?`, [p.precio, p.fw]);
        r.precios++;
    }

    // 5) SB activo sin tarjeta — se reporta, no se inventa
    const sin = await query(`SELECT id, marca, modelo, anio FROM inventario_autos
        WHERE estado='activo' AND (fyradrive_web_id IS NULL
        OR fyradrive_web_id NOT IN (SELECT id FROM autos))`, []);
    r.sin_tarjeta = sin.map(s => `SB ${s.id}: ${s.marca} ${s.modelo} ${s.anio}`);

    return r;
}

module.exports = { tickEspejo };
