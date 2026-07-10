import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com/'

// Dev-only middleware that mirrors api/rpc.js so `/api/rpc` works under `vite dev`
// exactly as it does on Vercel (the public RPC gates origin/UA).
function devRpcProxy() {
  return {
    name: 'dev-rpc-proxy',
    configureServer(server: any) {
      server.middlewares.use('/api/rpc', async (req: any, res: any) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return }
        let body = ''
        req.on('data', (c: any) => (body += c))
        req.on('end', async () => {
          try {
            const r = await fetch(RPC_URL, {
              method: 'POST',
              headers: {
                'content-type': 'application/json', accept: 'application/json',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
                origin: 'https://www.aeonprotocol.net', referer: 'https://www.aeonprotocol.net/',
              },
              body,
            })
            const text = await r.text()
            res.setHeader('content-type', 'application/json')
            res.statusCode = text ? r.status : 502
            res.end(text || JSON.stringify({ error: `RPC empty body (HTTP ${r.status})` }))
          } catch (e: any) {
            res.statusCode = 502; res.end(JSON.stringify({ error: `backend→RPC failed: ${e.message}` }))
          }
        })
      })
    },
  }
}

export default defineConfig({ plugins: [react(), devRpcProxy()], server: { port: 5182 } })
