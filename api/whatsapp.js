export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Missing "to" and "message"' });

    const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    const FROM_NUMBER = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

    const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;

    const params = new URLSearchParams();
    params.append('To', `whatsapp:+${to.replace(/\D/g, '')}`);
    params.append('From', FROM_NUMBER);
    params.append('Body', message);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });

        const data = await response.json();

        if (response.ok) {
            return res.status(200).json({ success: true, sid: data.sid, status: data.status });
        } else {
            return res.status(400).json({ success: false, error: data.message, code: data.code });
        }
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
}
