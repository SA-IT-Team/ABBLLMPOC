export default function handler(_req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ ok: true });
}