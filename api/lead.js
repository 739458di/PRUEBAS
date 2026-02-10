// API para registrar leads desde ManyChat
// POST /api/lead
// Body: { tipo: "vendedor"|"comprador", nombre, telefono, auto?, vehiculo?, notas? }
// Header: x-api-key = fyradrive2026

const https = require('https');

const API_KEY = 'fyradrive2026';
const BLOB_ID = '019c47e7-57ad-72e3-8ecf-2868ecf25ee7';
const BLOB_URL = '/api/jsonBlob/' + BLOB_ID;

function blobRequest(method, data) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'jsonblob.com',
            path: BLOB_URL,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch(e) { resolve({ vendedores: [], compradores: [] }); }
            });
        });
        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
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
        // Leer datos actuales
        const data = await blobRequest('GET');
        const vendedores = data.vendedores || [];
        const compradores = data.compradores || [];
        const telLimpio = limpiarTelefono(telefono);

        if (tipo === 'vendedor') {
            // Checar duplicado por telefono
            const existente = vendedores.findIndex(v =>
                limpiarTelefono(v.telefono || '') === telLimpio
            );

            if (existente >= 0) {
                // Actualizar notas y fecha
                vendedores[existente].updated = Date.now();
                vendedores[existente].notas = (vendedores[existente].notas || '') +
                    '\n[ManyChat ' + new Date().toLocaleDateString('es-MX') + '] ' + (notas || 'Contacto repetido');

                await blobRequest('PUT', { vendedores, compradores });
                return res.status(200).json({
                    registrado: true,
                    duplicado: true,
                    mensaje: 'Vendedor ya existia, se actualizo'
                });
            }

            // Nuevo vendedor
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
            await blobRequest('PUT', { vendedores, compradores });

            return res.status(200).json({
                registrado: true,
                duplicado: false,
                tipo: 'vendedor',
                id: nuevoVendedor.id,
                mensaje: 'Vendedor registrado exitosamente'
            });

        } else {
            // COMPRADOR
            const existente = compradores.findIndex(c =>
                limpiarTelefono(c.telefono || '') === telLimpio
            );

            if (existente >= 0) {
                compradores[existente].updated = Date.now();
                compradores[existente].notas = (compradores[existente].notas || '') +
                    '\n[ManyChat ' + new Date().toLocaleDateString('es-MX') + '] ' + (notas || 'Contacto repetido') +
                    (vehiculo ? ' - Interesado en: ' + vehiculo : '');

                await blobRequest('PUT', { vendedores, compradores });
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
            await blobRequest('PUT', { vendedores, compradores });

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
