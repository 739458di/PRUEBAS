// API para registrar leads desde ManyChat
// POST /api/lead
// Body: { tipo: "vendedor"|"comprador", nombre, telefono, auto?, vehiculo?, notas? }
// Header: x-api-key = fyradrive2026

const { createClient } = require('@libsql/client');

const API_KEY = 'fyradrive2026';

const client = createClient({
    url: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzA4MjUwMDYsImlkIjoiYTczOTliMjctYWFlNi00YjhmLWJmYjktODQ2M2JmMWU1MzljIiwicmlkIjoiNWVhMDBiM2QtNzNiNS00Njg3LWFjN2YtMTNhMGQzZmJlZmM1In0.ZVnn2UF2WdEw_yvQYGGB9Eyvbh_JRniPhkByn6Vxiavki0FkHVM8Xb0cwu1Ijrhti_j3iiOxS5jtt2IwCRWvDA'
});

const EMPTY_DATA = { vendedores: [], compradores: [], proyectos: [], eventos: [] };

async function getData() {
    try {
        const result = await client.execute("SELECT data FROM crm_data WHERE id = 'main'");
        if (result.rows.length === 0) return EMPTY_DATA;
        return JSON.parse(result.rows[0].data);
    } catch (err) {
        console.error('getData error:', err);
        return EMPTY_DATA;
    }
}

async function putData(data) {
    await client.execute({
        sql: 'UPDATE crm_data SET data = ?, updated_at = ? WHERE id = ?',
        args: [JSON.stringify(data), Date.now(), 'main']
    });
}

function validarTelefono(tel) {
    if (!tel) return false;
    const limpio = tel.replace(/\D/g, '');
    return limpio.length >= 10;
}

function limpiarTelefono(tel) {
    return tel.replace(/\D/g, '');
}

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Solo POST' });

    // Auth
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEY) {
        return res.status(401).json({ error: 'API key invalida' });
    }

    const { tipo, nombre, telefono, auto, vehiculo, notas } = req.body;

    // Validaciones
    if (!tipo || (tipo !== 'vendedor' && tipo !== 'comprador')) {
        return res.status(400).json({ error: 'tipo debe ser vendedor o comprador' });
    }
    if (!nombre || nombre.trim().length < 2) {
        return res.status(400).json({ error: 'nombre requerido (min 2 caracteres)' });
    }
    if (!validarTelefono(telefono)) {
        return res.status(400).json({
            error: 'telefono invalido - minimo 10 digitos',
            registrado: false
        });
    }

    try {
        const data = await getData();
        const vendedores = data.vendedores || [];
        const compradores = data.compradores || [];
        const proyectos = data.proyectos || [];
        const eventos = data.eventos || [];
        const telLimpio = limpiarTelefono(telefono);

        if (tipo === 'vendedor') {
            const existente = vendedores.findIndex(v =>
                limpiarTelefono(v.telefono || '') === telLimpio
            );

            if (existente >= 0) {
                vendedores[existente].updated = Date.now();
                vendedores[existente].notas = (vendedores[existente].notas || '') +
                    '\n[ManyChat ' + new Date().toLocaleDateString('es-MX') + '] ' + (notas || 'Contacto repetido');

                await putData({ vendedores, compradores, proyectos, eventos });
                return res.status(200).json({
                    registrado: true,
                    duplicado: true,
                    mensaje: 'Vendedor ya existia, se actualizo'
                });
            }

            const nuevoVendedor = {
                id: 'V' + Date.now(),
                nombre: nombre.trim(),
                telefono: telLimpio,
                auto: auto || 'Pendiente',
                seriedad: 'Media',
                estado: 'Carece Informacion',
                responsable: 'Sebastian',
                notas: '[ManyChat ' + new Date().toLocaleDateString('es-MX') + '] ' + (notas || 'Lead nuevo'),
                created: Date.now(),
                updated: Date.now()
            };

            vendedores.push(nuevoVendedor);
            await putData({ vendedores, compradores, proyectos, eventos });

            return res.status(200).json({
                registrado: true,
                duplicado: false,
                tipo: 'vendedor',
                id: nuevoVendedor.id,
                mensaje: 'Vendedor registrado exitosamente'
            });

        } else {
            const existente = compradores.findIndex(c =>
                limpiarTelefono(c.telefono || '') === telLimpio
            );

            if (existente >= 0) {
                compradores[existente].updated = Date.now();
                compradores[existente].notas = (compradores[existente].notas || '') +
                    '\n[ManyChat ' + new Date().toLocaleDateString('es-MX') + '] ' + (notas || 'Contacto repetido') +
                    (vehiculo ? ' - Interesado en: ' + vehiculo : '');

                await putData({ vendedores, compradores, proyectos, eventos });
                return res.status(200).json({
                    registrado: true,
                    duplicado: true,
                    mensaje: 'Comprador ya existia, se actualizo'
                });
            }

            const nuevoComprador = {
                id: 'C' + Date.now(),
                nombre: nombre.trim(),
                telefono: telLimpio,
                vehiculo: vehiculo || 'Por definir',
                estado: 'Previa Agendacion',
                responsable: 'Sebastian',
                notas: '[ManyChat ' + new Date().toLocaleDateString('es-MX') + '] ' + (notas || 'Lead nuevo'),
                citaFecha: '',
                citaHora: '',
                telDueno: '',
                telComprador: telLimpio,
                telResponsable: '',
                created: Date.now(),
                updated: Date.now()
            };

            compradores.push(nuevoComprador);
            await putData({ vendedores, compradores, proyectos, eventos });

            return res.status(200).json({
                registrado: true,
                duplicado: false,
                tipo: 'comprador',
                id: nuevoComprador.id,
                mensaje: 'Comprador registrado exitosamente'
            });
        }

    } catch (err) {
        return res.status(500).json({ error: err.message, registrado: false });
    }
};
