// CRM Database API - uses JSONBlob.com as free cloud database
// Both Sebastian and Mario can read/write the same data in real time
// Auto-recovery: if blob is deleted, creates a new one automatically

const https = require('https');

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

// Create a new blob and return its ID
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
                if (newId) {
                    resolve(newId);
                } else {
                    reject(new Error('No blob ID returned'));
                }
            });
        });

        req.on('error', reject);
        req.write(JSON.stringify(data || EMPTY_DATA));
        req.end();
    });
}

async function getDataSafe() {
    const result = await blobRequest('GET', BLOB_ID);

    // If blob was deleted/expired, create a new one
    if (result.statusCode === 404 || result.body.includes('not found') || result.body.includes('Not Found')) {
        console.log('Blob not found, creating new one...');
        const newId = await createNewBlob(EMPTY_DATA);
        BLOB_ID = newId;
        console.log('New blob created: ' + newId);
        return { ...EMPTY_DATA, _newBlobId: newId };
    }

    try {
        const parsed = JSON.parse(result.body);
        // Ensure all required arrays exist
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

    // If blob was deleted, create new and write there
    if (result.statusCode === 404 || result.body.includes('not found')) {
        console.log('Blob not found on PUT, creating new one...');
        const newId = await createNewBlob(data);
        BLOB_ID = newId;
        return { success: true, _newBlobId: newId };
    }

    return { success: true };
}

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // GET - fetch all data
        if (req.method === 'GET') {
            const data = await getDataSafe();
            return res.status(200).json(data);
        }

        // PUT - save all data (full replace)
        if (req.method === 'PUT') {
            const result = await putDataSafe(req.body);
            return res.status(200).json(result);
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
