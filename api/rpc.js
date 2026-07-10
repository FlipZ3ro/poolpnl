// Vercel serverless RPC proxy → forwards JSON-RPC to Robinhood Chain with
// browser-like headers (the public RPC gates origin/UA). Same-origin from the
// deployed site → no browser CORS. Path: /api/rpc
const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com/'

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }
  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    const r = await fetch(RPC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        origin: 'https://www.aeonprotocol.net',
        referer: 'https://www.aeonprotocol.net/',
      },
      body,
    })
    const text = await r.text()
    res.setHeader('content-type', 'application/json')
    res.status(text ? r.status : 502).send(text || JSON.stringify({ error: `RPC empty body (HTTP ${r.status})` }))
  } catch (e) {
    res.status(502).json({ error: `backend→RPC failed: ${e.message}` })
  }
}
