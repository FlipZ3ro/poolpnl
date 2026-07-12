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

// The public RPC rejects very large JSON-RPC batches, so split into ≤90-call chunks.
const BATCH_MAX = 90
async function oneBatch(reqs: { method: string; params: unknown[] }[]): Promise<(any | null)[]> {
  try {
    const body = reqs.map((r, i) => ({ jsonrpc: '2.0', id: i + 1, method: r.method, params: r.params }))
    const res = await fetch(FETCH_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (res.ok) {
      const arr = await res.json()
      if (Array.isArray(arr)) {
        const out = new Array(reqs.length).fill(null)
        for (const r of arr) out[r.id - 1] = r.error ? null : r.result
        return out
      }
    }
  } catch { /* fall through */ }
  return Promise.all(reqs.map((r) => rpc(r.method, r.params).catch(() => null)))
}

/** Batched arbitrary JSON-RPC, chunked under the RPC's batch-size cap. */
export async function batchRpc(reqs: { method: string; params: unknown[] }[]): Promise<(any | null)[]> {
  if (!reqs.length) return []
  if (reqs.length <= BATCH_MAX) return oneBatch(reqs)
  const out: (any | null)[] = []
  for (let i = 0; i < reqs.length; i += BATCH_MAX) out.push(...await oneBatch(reqs.slice(i, i + BATCH_MAX)))
  return out
}

/** Batched eth_call, chunked under the RPC's batch-size cap. */
export async function batchCall(calls: { to: string; data: string }[]): Promise<(string | null)[]> {
  return batchRpc(calls.map((c) => ({ method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] }))) as Promise<(string | null)[]>
}

export const ethCall = (to: string, data: string) => rpc('eth_call', [{ to, data }, 'latest'])
export const hexToBig = (h: string | null): bigint => (h && h !== '0x' ? BigInt(h) : 0n)
