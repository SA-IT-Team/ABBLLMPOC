export default async function handler(req, res) {
  // CORS headers
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

    // Step 1: Start document analysis
    const sourceBody = fileUrl
      ? { urlSource: String(fileUrl) }
      : { base64Source: String(base64 || '').replace(/^data:.*;base64,/, '').replace(/\s+/g, '') };

    const qs = new URLSearchParams({ 'api-version': '2024-11-30', outputContentFormat: outFmt });
    if (pages) qs.set('pages', String(pages));

    const azureUrl = `${endpoint}/documentintelligence/documentModels/${modelId}:analyze?${qs.toString()}`;

    const analyzeResponse = await fetch(azureUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(sourceBody)
    });

    const analyzeText = await analyzeResponse.text();
    if (analyzeResponse.status !== 202) {
      let details; 
      try { details = JSON.parse(analyzeText); } catch { details = { message: analyzeText }; }
      return res.status(analyzeResponse.status).json({ error: 'analyze_failed', details });
    }

    // Extract operation ID
    const opLoc = analyzeResponse.headers.get('operation-location');
    if (!opLoc) return res.status(502).json({ error: 'missing_operation_location' });

    const m = opLoc.match(/analyzeResults\/([^?]+)/);
    const operationId = m ? m[1] : opLoc;

    // Step 2: Poll for results until completion
    const resultUrl = `${endpoint}/documentintelligence/analyzeResults/${encodeURIComponent(operationId)}?api-version=2024-11-30`;
    const maxAttempts = 30; // 30 attempts * 2 seconds = 1 minute max
    let attempts = 0;

    while (attempts < maxAttempts) {
      // Wait before polling (except first attempt)
      if (attempts > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      const resultResponse = await fetch(resultUrl, { 
        headers: { 'Ocp-Apim-Subscription-Key': key } 
      });
      
      const resultText = await resultResponse.text();
      let resultData;
      
      try { 
        resultData = JSON.parse(resultText); 
      } catch { 
        resultData = { raw: resultText }; 
      }

      // If the operation is not found, return error
      if (resultResponse.status === 404) {
        return res.status(404).json({ 
          error: 'operation_not_found', 
          operationId,
          message: 'The analysis operation was not found or has expired' 
        });
      }

      // If there's an error in the result, return it
      if (resultResponse.status !== 200) {
        return res.status(resultResponse.status).json({ 
          error: 'result_fetch_failed', 
          details: resultData 
        });
      }

      // Check the status
      const status = resultData.status;

      if (status === 'succeeded') {
        // Success! Return the complete result
        return res.status(200).json({
          success: true,
          operationId,
          model: modelId,
          format: outFmt,
          status: 'succeeded',
          result: resultData,
          content: resultData.analyzeResult?.content || null,
          pages: resultData.analyzeResult?.pages || null
        });
      } else if (status === 'failed' || status === 'canceled') {
        // Failed or canceled
        return res.status(400).json({
          success: false,
          operationId,
          status,
          error: 'analysis_failed',
          details: resultData
        });
      }

      // Still running, continue polling
      attempts++;
    }

    // Timeout - operation took too long
    return res.status(408).json({
      error: 'analysis_timeout',
      operationId,
      message: 'Document analysis is taking longer than expected. You can check the status manually.',
      checkUrl: `/api/getContent?id=${operationId}`
    });

  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}