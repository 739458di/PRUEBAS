// Importa el catálogo Shopify de autos-universales.com tal cual (precio, texto, fotos crudas) al inventario del lote AUTOS UNIVERSALES (tenant 10).
require('fs').readFileSync(__dirname + '/../../.env','utf8').split('\n').forEach(l=>{const i=l.indexOf('=');if(i>0)process.env[l.slice(0,i).trim()]=process.env[l.slice(0,i).trim()]||l.slice(i+1).trim();});
const { query, run } = require('../../lib/seb/db.js');
const S='/private/tmp/claude-501/-Users-Shared/09361876-3e79-48d7-aa49-421441512658/scratchpad';
const TEN = 10, AGENCIA = 'AUTOS UNIVERSALES', ORIGEN = 'universales-shopify';
const limpiar = h => String(h||'').replace(/<br\s*\/?>/gi,'\n').replace(/<\/p>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n').trim();
const ALIAS = { vw:'Volkswagen', 'mercedes benz':'Mercedes Benz', 'mercedes-benz':'Mercedes Benz', chevy:'Chevrolet', 'land rover':'Land Rover' };
function parsear(p){
  const titulo = String(p.title||'').replace(/\s+/g,' ').trim();
  let marca = String(p.vendor||'').trim(); if (!marca || /autos universales/i.test(marca)) marca = titulo.split(' ')[0];
  const mAnio = titulo.match(/\b(19|20)\d{2}\b/); const anio = Number((p.tags||[]).find(t=>/^\d{4}$/.test(t)) || (mAnio ? mAnio[0] : 0)) || null;
  let modelo = titulo; const primera = titulo.split(' ')[0]; const alias = ALIAS[primera.toLowerCase()];
  if (alias && alias.toLowerCase()===marca.toLowerCase()) modelo = titulo.slice(primera.length).trim();
  else if (modelo.toLowerCase().startsWith(marca.toLowerCase())) modelo = modelo.slice(marca.length).trim();
  modelo = modelo.replace(/\b(19|20)\d{2}\b/,'').replace(/\s+/g,' ').trim() || titulo;
  const body = limpiar(p.body_html);
  const mKm = body.match(/(\d{1,3}(?:[.,]\d{3})+|\d{4,6})\s*(?:km|kms|kilómetros|kilometros)\b/i) || body.match(/^\s*(\d{1,3}(?:[.,]\d{3})+)\b/m);
  const km = mKm ? Number(String(mKm[1]).replace(/[.,]/g,'')) : null;
  const transmision = /autom[aá]tic/i.test(body) ? 'automatica' : (/manual|est[aá]ndar/i.test(body) ? 'manual' : null);
  const precio = Math.round(Number((p.variants||[])[0] && p.variants[0].price) || 0) || null;
  const disponible = (p.variants||[]).some(v => v.available !== false);
  const fotos = (p.images||[]).map(i => i.src).filter(Boolean);
  return { handle: p.handle, titulo, marca, modelo, anio, precio, km, transmision, body, disponible, fotos };
}
(async () => {
  const d = JSON.parse(require('fs').readFileSync(S+'/au-products.json','utf8')); const prods = d.products.map(parsear);
  // vendedor (web) del lote: contacto AUTOS UNIVERSALES (teléfono del negocio tal como lo publican)
  let v = await query("SELECT v.id FROM vendedores v JOIN contactos_info c ON c.id=v.contacto_id WHERE c.nombre=? LIMIT 1", ['AUTOS UNIVERSALES']);
  let vendedorId; if (v.length) vendedorId = Number(v[0].id); else {
    const c = await run("INSERT INTO contactos_info (nombre, apellido, telefono, metodo_contacto_preferido, origen_creacion, fecha_creacion) VALUES (?,?,?,'whatsapp','universales_import',datetime('now'))", ['AUTOS UNIVERSALES', null, '5218130840871']);
    const vr = await run("INSERT INTO vendedores (contacto_id, direccion, disponibilidad, fecha_creacion) VALUES (?,?,'lun-sab 9-19',datetime('now'))", [Number(c.lastInsertRowid), 'Av Fidel Velázquez 325, Mitras Nte., Monterrey']);
    vendedorId = Number(vr.lastInsertRowid);
  }
  const now = Date.now(); let nuevos = 0, existentes = 0, sinFoto = 0; const errores = [];
  for (const a of prods) {
    if (!a.fotos.length) { sinFoto++; continue; }
    const uid = ('AutosUniversales_' + a.handle).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,120);
    const ya = await query('SELECT id FROM autos WHERE uid=? LIMIT 1', [uid]);
    if (ya.length) { existentes++; continue; }
    try {
      const ins = await run(`INSERT INTO autos (vendedor_id, uid, marca, modelo, "año", precio, kilometraje, transmision, estado, tipo_vendedor, agencia_nombre, comentarios_adicionales, opciones_compra, fecha_creacion, needs_new_photos) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),0)`,
        [vendedorId, uid, a.marca, a.modelo, a.anio, a.precio, a.km, a.transmision, a.disponible ? 'activo' : 'vendido', 'agencia', AGENCIA, a.body.slice(0, 2000), 'Crédito bancario o de contado']);
      const webId = Number(ins.lastInsertRowid);
      for (let i = 0; i < a.fotos.length; i++) await run('INSERT INTO imagenes_autos (auto_id, url_imagen, texto_alternativo, orden_imagen, es_principal) VALUES (?,?,?,?,?)', [webId, a.fotos[i], a.titulo, i, i === 0 ? 1 : 0]);   // fotos CRUDAS, sin url_raw → el horno no las toca
      const inv = await run(`INSERT INTO inventario_autos (fyradrive_web_id, marca, modelo, version, anio, precio, kilometraje, color, transmision, tipo_carroceria, estado, synced_at, created_at, dueno_nombre, dueno_telefono, agencia_nombre, tipo_vendedor, listed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [webId, a.marca, a.modelo, null, a.anio, a.precio, a.km, null, a.transmision, null, a.disponible ? 'activo' : 'vendido', now, now, AGENCIA, null, AGENCIA, 'agencia', now]);
      await run("INSERT INTO autos_universo (inv_auto_id, tenant_id, rol, origen, activo, created, updated) VALUES (?,?,'dueno',?,1,?,?)", [Number(inv.lastInsertRowid), TEN, ORIGEN, now, now]);
      nuevos++;
    } catch (e) { errores.push(a.titulo + ': ' + e.message.slice(0, 80)); }
  }
  console.log({ productos: prods.length, nuevos, existentes, sinFoto, errores });
  console.log('en el lote:', (await query('SELECT COUNT(*) n FROM autos_universo WHERE tenant_id=? AND activo=1', [TEN]))[0].n);
  console.log('muestra:', prods.slice(0, 6).map(a => `${a.marca} | ${a.modelo} | ${a.anio} | $${a.precio} | ${a.km} km | ${a.transmision} | ${a.fotos.length} fotos`));
})();
