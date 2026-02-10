// CRM Database API - uses JSONBlob.com as free cloud database
// Both Sebastian and Mario can read/write the same data in real time

const https = require('https');

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
                catch(e) { resolve({}); }
            });
        });

        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
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
            const data = await blobRequest('GET');
            return res.status(200).json(data);
        }

        // PUT - save all data (full replace)
        if (req.method === 'PUT') {
            await blobRequest('PUT', req.body);
            return res.status(200).json({ success: true });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
