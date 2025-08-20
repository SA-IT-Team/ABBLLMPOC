// api/get-azure-sas.js
const { BlobSASPermissions, SASProtocol, StorageSharedKeyCredential, generateBlobSASQueryParameters } =
  require('@azure/storage-blob');
const { randomUUID } = require('node:crypto');

const accountName   = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const accountKey    = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const containerName = process.env.AZURE_STORAGE_CONTAINER;
const ttlMinutes    = Number(process.env.SAS_TTL_MINUTES || 15);

// Comma-separated list, e.g. "pdf,doc,docx"
const allowedExts = (process.env.ALLOWED_UPLOAD_EXTS || 'pdf,doc,docx')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// For simple CORS control per-deployment
const corsAllowOrigin = (process.env.CORS_ALLOW_ORIGIN || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function allowOrigin(req) {
  const origin = req.headers.origin || '';
  if (corsAllowOrigin.includes('*')) return '*';
  if (corsAllowOrigin.includes(origin)) return origin;
  // Fallback: no CORS for unknown origins
  return '';
}

function json(res, status, data, origin = '') {
  if (!res.headersSent) {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

function sanitizePrefix(prefix) {
  // keep only safe chars, trim slashes, ensure trailing slash if not empty
  let p = String(prefix || '').replace(/[^a-zA-Z0-9/_-]/g, '').replace(/^\/+|\/+$/g, '');
  if (p && !p.endsWith('/')) p += '/';
  return p;
}

module.exports = async (req, res) => {
  const origin = allowOrigin(req);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method Not Allowed' }, origin);
  }

  if (!accountName || !accountKey || !containerName) {
    return json(res, 500, { error: 'Missing Azure env vars' }, origin);
  }

  try {
    // Parse JSON body
    let body = {};
    if (req.body && typeof req.body === 'object') {
      body = req.body;
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }

    const originalName = body.originalName || '';
    const contentType  = body.contentType || '';
    const prefix       = sanitizePrefix(body.prefix || '');

    // Validate extension
    let ext = 'bin';
    if (typeof originalName === 'string' && originalName.includes('.')) {
      ext = originalName.split('.').pop().toLowerCase();
    }
    if (!allowedExts.includes(ext)) {
      return json(res, 400, { error: `Unsupported file type .${ext}. Allowed: ${allowedExts.join(', ')}` }, origin);
    }

    // Unique blob name (optionally inside a logical folder)
    const blobName = `${prefix}${randomUUID()}.${ext}`;

    // Time window with clock skew buffer
    const startsOn  = new Date(Date.now() - 5 * 60 * 1000);
    const expiresOn = new Date(Date.now() + ttlMinutes * 60 * 1000);

    const sharedKey = new StorageSharedKeyCredential(accountName, accountKey);
    const baseUrl   = `https://${accountName}.blob.core.windows.net/${containerName}/${encodeURIComponent(blobName)}`;

    // SAS for upload (create + write)
    const writeSAS = generateBlobSASQueryParameters({
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse('cw'),
      protocol: SASProtocol.Https,
      startsOn,
      expiresOn
    }, sharedKey).toString();

    // SAS for read (pass this to your extractor)
    const readSAS = generateBlobSASQueryParameters({
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      protocol: SASProtocol.Https,
      startsOn,
      expiresOn
    }, sharedKey).toString();

    const resp = {
      ok: true,
      blobName,
      blobUrl: baseUrl,               // private URL (no SAS)
      uploadUrl: `${baseUrl}?${writeSAS}`,
      readUrl:   `${baseUrl}?${readSAS}`,
      uploadHeaders: {
        'x-ms-blob-type': 'BlockBlob',
        ...(contentType ? { 'Content-Type': contentType } : {})
      },
      expiresOn
    };

    return json(res, 200, resp, origin);
  } catch (err) {
    console.error('get-azure-sas error:', err);
    return json(res, 500, { error: 'Failed to generate SAS' }, origin);
  }
};
