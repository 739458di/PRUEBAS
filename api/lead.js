// API para registrar leads desde ManyChat
// POST /api/lead
// Body: { tipo: "vendedor"|"comprador", nombre, telefono, auto?, vehiculo?, notas? }
// Header: x-api-key = fyradrive2026

const https = require('https');

const API_KEY = 'fyradrive2026';
let BLOB_ID = '019c4d4f-574f-716b-b8c1-4c3240cbd38b';

const EMPTY_DATA = { vendedores: [], compradores: [], proyectos: [], eventos: [] };

function blobRequest(method, blobId, data) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'jsonblob.com',
            path: '/api/jsonBlob/' + blobId,
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
                resolve({ statusCode: res.statusCode, headers: res.headers, body: body });
            });
        });
        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

function createNewBlob(data) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'jsonblob.com',
            path: '/api/jsonBlob',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                const newId = res.headers['x-jsonblob-id'];
                if (newId) resolve(newId);
                else reject(new Error('No blob ID returned'));
            });
        });
        req.on('error', reject);
        req.write(JSON.stringify(data || EMPTY_DATA));
        req.end();
    });
}

async function getDataSafe() {
    const result = await blobRequest('GET', BLOB_ID);
    if (result.statusCode === 404 || result.body.includes('not found') || result.body.includes('Not Found')) {
        const newId = await createNewBlob(EMPTY_DATA);
        BLOB_ID = newId;
        return EMPTY_DATA;
    }
    try {
        const parsed = JSON.parse(result.body);
        return {
            vendedores: parsed.vendedores || [],
            compradores: parsed.compradores || [],
            proyectos: parsed.proyectos || [],
            eventos: parsed.eventos || []
        };
    } catch (e) {
        return EMPTY_DATA;
    }
}

async function putDataSafe(data) {
    const result = await blobRequest('PUT', BLOB_ID, data);
    if (result.statusCode === 404 || result.body.includes('not found')) {
        const newId = await createNewBlob(data);
        BLOB_ID = newId;
    }
    return { success: true };
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
        const data = await getDataSafe();
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

                await putDataSafe({ vendedores, compradores, proyectos, eventos });
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
            await putDataSafe({ vendedores, compradores, proyectos, eventos });

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

                await putDataSafe({ vendedores, compradores, proyectos, eventos });
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
            await putDataSafe({ vendedores, compradores, proyectos, eventos });

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
