// lib/seb/contexto.js — CONTEXTO DE UNIVERSO AMBIENTE (orden owner 2026-09-18, TERRA MOTORS)
// El cerebro completo de Seb (opener → continuación → etapa 3, mesa, aparador, ruteador…) nació cableado al universo 0:
// decenas de `U.leerEstado(0, tel)` y consultas al inventario global. En vez de reescribirlo, el universo viaja como
// contexto ambiente (AsyncLocalStorage): dentro de `correr(tenantId, catalogoIds, fn)`
//   · universo.js redirige todo lo que pida el universo 0 → al universo del contexto (memoria, chats, foco)
//   · el inventario que ve el cerebro se filtra al catálogo de ese universo (autos_universo)
// Fuera del contexto nada cambia: el número principal (universo 0) corre exactamente igual que siempre.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
// catalogo: [{ id (inventario), web (fyradrive_web_id) }] — los lotes guardan el foco con el id de la WEB; el cerebro piensa en ids de INVENTARIO
function correr(tenantId, catalogo, fn) {
    const filas = (catalogo || []).map(a => (typeof a === 'object' ? { id: Number(a.id), web: a.web == null ? null : Number(a.web) } : { id: Number(a), web: null }));
    const invDeWeb = new Map(), webDeInv = new Map(); filas.forEach(a => { if (a.web) { invDeWeb.set(a.web, a.id); webDeInv.set(a.id, a.web); } });
    return als.run({ tenant: Number(tenantId) || 0, ids: new Set(filas.map(a => a.id)), invDeWeb, webDeInv }, fn);
}
/** foco guardado (id web) → id de inventario que entiende el cerebro */
function aInv(v) { const s = als.getStore(); const n = Number(v) || null; if (!s || !s.tenant || !n) return n; if (s.invDeWeb.has(n)) return s.invDeWeb.get(n); return n; }
/** id de inventario que decide el cerebro → id web con el que el lote guarda su foco */
function aWeb(v) { const s = als.getStore(); const n = Number(v) || null; if (!s || !s.tenant || !n) return n; if (s.webDeInv.has(n)) return s.webDeInv.get(n); return n; }
function tenant() { const s = als.getStore(); return s && s.tenant ? s.tenant : 0; }
/** tenantId pedido por el código (casi siempre 0) → universo efectivo */
function remap(tenantId) { const t = Number(tenantId) || 0; if (t) return t; return tenant() || 0; }
/** filas de inventario → solo las del catálogo del universo ambiente (copia; jamás muta el caché) */
function filtrar(rows) { const s = als.getStore(); if (!s || !s.tenant) return rows; return (rows || []).filter(r => s.ids.has(Number(r.id))); }
module.exports = { correr, tenant, remap, filtrar, aInv, aWeb };
