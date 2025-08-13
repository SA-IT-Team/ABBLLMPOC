export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const endpoint = (process.env.AZURE_DI_ENDPOINT || '').replace(/\/+$/, '');
  const key = process.env.AZURE_DI_KEY;
  if (!endpoint || !key) return res.status(500).json({ error: 'Missing AZURE_DI_ENDPOINT or AZURE_DI_KEY' });

  const { id } = req.query || {};
  if (!id) return res.status(400).json({ error: "Missing 'id' query parameter" });

  try {
    const url = `${endpoint}/documentintelligence/getContent/${encodeURIComponent(id)}?api-version=2024-11-30`;
    const r = await fetch(url, { headers: { 'Ocp-Apim-Subscription-Key': key } });
    const text = await r.text();
    let payload; try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    return res.status(r.status).json(payload);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}