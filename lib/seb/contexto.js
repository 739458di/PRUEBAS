// lib/seb/contexto.js — CONTEXTO DE UNIVERSO AMBIENTE (orden owner 2026-09-18, TERRA MOTORS)
// El cerebro completo de Seb (opener → continuación → etapa 3, mesa, aparador, ruteador…) nació cableado al universo 0:
// decenas de `U.leerEstado(0, tel)` y consultas al inventario global. En vez de reescribirlo, el universo viaja como
// contexto ambiente (AsyncLocalStorage): dentro de `correr(tenantId, catalogoIds, fn)`
//   · universo.js redirige todo lo que pida el universo 0 → al universo del contexto (memoria, chats, foco)
//   · el inventario que ve el cerebro se filtra al catálogo de ese universo (autos_universo)
// Fuera del contexto nada cambia: el número principal (universo 0) corre exactamente igual que siempre.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
function correr(tenantId, catalogoIds, fn) { return als.run({ tenant: Number(tenantId) || 0, ids: new Set((catalogoIds || []).map(Number)) }, fn); }
function tenant() { const s = als.getStore(); return s && s.tenant ? s.tenant : 0; }
/** tenantId pedido por el código (casi siempre 0) → universo efectivo */
function remap(tenantId) { const t = Number(tenantId) || 0; if (t) return t; return tenant() || 0; }
/** filas de inventario → solo las del catálogo del universo ambiente (copia; jamás muta el caché) */
function filtrar(rows) { const s = als.getStore(); if (!s || !s.tenant) return rows; return (rows || []).filter(r => s.ids.has(Number(r.id))); }
module.exports = { correr, tenant, remap, filtrar };
