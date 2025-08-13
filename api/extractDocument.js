export default async function handler(req, res) {
  // CORS (adjust origin for production)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const endpoint = (process.env.AZURE_DI_ENDPOINT || '').replace(/\/+$/, '');
  const key = process.env.AZURE_DI_KEY;
  if (!endpoint || !key) return res.status(500).json({ error: 'Missing AZURE_DI_ENDPOINT or AZURE_DI_KEY' });

  try {
    const { fileUrl, base64, model, format, pages } = req.body || {};
    if (!fileUrl && !base64) return res.status(400).json({ error: "Provide either 'fileUrl' or 'base64'" });

    const modelId = (model === 'prebuilt-read' || model === 'prebuilt-layout') ? model : 'prebuilt-layout';
    const outFmt = (format === 'text') ? 'text' : 'markdown';

    const sourceBody = fileUrl
      ? { urlSource: String(fileUrl) }
      : { base64Source: String(base64 || '').replace(/^data:.*;base64,/, '').replace(/\s+/g, '') };

    const qs = new URLSearchParams({ 'api-version': '2024-11-30', outputContentFormat: outFmt });
    if (pages) qs.set('pages', String(pages));

    const azureUrl = `${endpoint}/documentintelligence/documentModels/${modelId}:extractDocument?${qs.toString()}`;

    const r = await fetch(azureUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(sourceBody)
    });

    const text = await r.text();
    if (r.status !== 202) {
      let details; try { details = JSON.parse(text); } catch { details = { message: text }; }
      return res.status(r.status).json({ error: 'analyze_failed', details });
    }

    const opLoc = r.headers.get('operation-location');
    if (!opLoc) return res.status(502).json({ error: 'missing_operation_location' });

    const m = opLoc.match(/analyzeResults\/([^?]+)/);
    const operationId = m ? m[1] : opLoc;

    return res.status(202).json({ operationId, model: modelId, format: outFmt });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}