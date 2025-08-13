export default async function handler(req, res) {
  // CORS
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

    const analyzeUrl = `${endpoint}/documentintelligence/documentModels/${modelId}:analyze?${qs.toString()}`;

    // 1) Start analysis
    const start = await fetch(analyzeUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(sourceBody)
    });

    const startBodyText = await start.text();
    if (start.status !== 202) {
      let details; try { details = JSON.parse(startBodyText); } catch { details = { message: startBodyText }; }
      return res.status(start.status).json({ error: 'analyze_failed', details });
    }

    // ✅ Use Operation-Location AS-IS (no regex, no rebuilding)
    const opLoc = start.headers.get('operation-location');
    if (!opLoc) return res.status(502).json({ error: 'missing_operation_location' });

    // 2) Poll Operation-Location directly
    const maxAttempts = 30; // ~1 min @ 2s
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000));

      const poll = await fetch(opLoc, { headers: { 'Ocp-Apim-Subscription-Key': key } });
      const pollText = await poll.text();
      let data; try { data = JSON.parse(pollText); } catch { data = { raw: pollText }; }

      // Sometimes first hit can be 404 if the op hasn't propagated — keep polling a few times
      if (poll.status === 404 && attempt < 2) continue;
      if (poll.status === 404) {
        return res.status(404).json({
          error: 'operation_not_found',
          operationLocation: opLoc,
          message: 'The analysis operation was not found or has expired'
        });
      }
      if (poll.status !== 200) {
        return res.status(poll.status).json({ error: 'result_fetch_failed', details: data });
      }

      const status = data.status;
      if (status === 'succeeded') {
        return res.status(200).json({
          success: true,
          operationLocation: opLoc,
          model: modelId,
          format: outFmt,
          status,
          result: data,
          content: data.analyzeResult?.content ?? null,
          pages: data.analyzeResult?.pages ?? null
        });
      }
      if (status === 'failed' || status === 'canceled') {
        return res.status(400).json({ success: false, status, error: 'analysis_failed', details: data });
      }
      // else: notStarted/running -> loop
    }

    // timeout
    return res.status(408).json({
      error: 'analysis_timeout',
      operationLocation: opLoc,
      message: 'Document analysis is taking longer than expected. Try polling again.'
    });

  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
