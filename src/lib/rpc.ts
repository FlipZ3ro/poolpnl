// Chain reads. Prefer the connected wallet provider; fall back to a same-origin
// proxy (/api/rpc, Vercel serverless). batchRpc uses the proxy (JSON-RPC batch)
// for fast many-call scans — works on the deployed site.
import { CHAIN } from './config'

type Eip1193 = { request(a: { method: string; params?: any }): Promise<any> }
let readProvider: Eip1193 | null = null
export function setReadProvider(p: Eip1193 | null) { readProvider = p }
export const hasReadProvider = () => readProvider != null

const FETCH_URL = typeof window !== 'undefined' ? '/api/rpc' : CHAIN.rpcUrl
let _id = 0

async function viaFetch(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(FETCH_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_id, method, params }),
  })
  const j = await res.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}

export async function rpc(method: string, params: unknown[] = []): Promise<any> {
  if (readProvider) {
    try { return await readProvider.request({ method, params }) } catch (e: any) {
      if (!/method|not supported|unsupported/i.test(e?.message || '')) throw e
    }
  }
  return viaFetch(method, params)
}

/** Batched eth_call over one HTTP request. Falls back to parallel provider calls. */
export async function batchCall(calls: { to: string; data: string }[]): Promise<(string | null)[]> {
  if (!calls.length) return []
  // try a JSON-RPC batch via the proxy first (fast; works on the deployed site)
  try {
    const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] }))
    const res = await fetch(FETCH_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (res.ok) {
      const arr = await res.json()
      if (Array.isArray(arr)) {
        const out = new Array(calls.length).fill(null)
        for (const r of arr) out[r.id - 1] = r.error ? null : r.result
        return out
      }
    }
  } catch { /* fall through */ }
  // fallback: parallel single calls via provider (slower; works locally with wallet)
  return Promise.all(calls.map((c) => rpc('eth_call', [{ to: c.to, data: c.data }, 'latest']).catch(() => null)))
}

export const ethCall = (to: string, data: string) => rpc('eth_call', [{ to, data }, 'latest'])
export const hexToBig = (h: string | null): bigint => (h && h !== '0x' ? BigInt(h) : 0n)
