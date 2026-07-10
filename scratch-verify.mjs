import { encodeAbiParameters, keccak256, toFunctionSelector } from 'viem'
const RPC = 'https://poolpnl.vercel.app/api/rpc'
const API = 'https://robinhoodchain.blockscout.com/api/v2'
const POSM = '0x58daec3116aae6d93017baaea7749052e8a04fa7'
const SV = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'
const CURVE = '0xd861cb5dc71a0171e8f0f6586cadb069f3a35e4d'
const owner = process.argv[2] || '0x00000dD20E55654faF951c521dc2e89b02Cc83f6'
const lc = s => (s || '').toLowerCase()
const isEth = t => /^0x0+$/.test(t) || t === lc('0x0bd7d308f8e1639fab988df18a8011f41eacad73')
const pad = v => (typeof v === 'string' && v.startsWith('0x') ? v.slice(2) : BigInt(v).toString(16)).toLowerCase().padStart(64, '0')
const sgn24 = n => n >= 0x800000 ? n - 0x1000000 : n
const Q96 = 1n << 96n, E18 = 10n ** 18n
let id = 0
async function call(to, data) { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'eth_call', params: [{ to, data }, 'latest'] }) }).then(r => r.json()); return r.result || null }
async function rt(u, n = 6) { for (let i = 0; i < n; i++) { try { const r = await fetch(u); if (r.ok) return await r.json() } catch {} await new Promise(r => setTimeout(r, 300 * (i + 1))) } return null }
const comps = [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }]
const derivePoolId = k => keccak256(encodeAbiParameters([{ type: 'tuple', components: comps }], [k]))
const sqrtAtTick = t => BigInt(Math.floor(Math.pow(1.0001, t / 2) * 2 ** 96))
function amounts(L, sp, sa, sb) { if (sa > sb)[sa, sb] = [sb, sa]; let a0 = 0n, a1 = 0n; if (sp <= sa) a0 = L * Q96 * (sb - sa) / (sb * sa); else if (sp < sb) { a0 = L * Q96 * (sb - sp) / (sb * sp); a1 = L * (sp - sa) / Q96 } else a1 = L * (sb - sa) / Q96; return [a0, a1] }
const c1ToEth = (a1, sp) => sp === 0n ? 0 : Number(a1 * Q96 * Q96) / Number(sp * sp)
const SEL_PRICE = toFunctionSelector('currentPrice(address)')

;(async () => {
  const nft = await rt(`${API}/addresses/${owner}/nft?type=ERC-721`)
  const ids = (nft?.items || []).filter(x => lc(x.token?.address || x.token?.address_hash) === lc(POSM)).map(x => Number(x.id))
  for (const idn of ids) {
    const gpi = await call(POSM, '0x7ba03aad' + pad(idn)); if (!gpi || gpi === '0x') continue
    const w = gpi.slice(2).match(/.{64}/g)
    const key = { currency0: '0x' + w[0].slice(24), currency1: '0x' + w[1].slice(24), fee: parseInt(w[2], 16), tickSpacing: sgn24(parseInt(w[3].slice(-6), 16)), hooks: '0x' + w[4].slice(24) }
    const info = BigInt('0x' + w[5]); const tl = sgn24(Number((info >> 8n) & 0xffffffn)), tu = sgn24(Number((info >> 32n) & 0xffffffn))
    const poolId = derivePoolId(key)
    const [liqH, slot0] = await Promise.all([call(POSM, '0x1efeed33' + pad(idn)), call(SV, '0xc815641c' + poolId.slice(2))])
    const liq = liqH && liqH !== '0x' ? BigInt(liqH) : 0n
    if (liq === 0n) continue
    let sp = 0n; if (slot0 && slot0 !== '0x') sp = BigInt('0x' + slot0.slice(2).match(/.{64}/g)[0])
    const [a0, a1] = amounts(liq, sp, sqrtAtTick(tl), sqrtAtTick(tu))
    const t0Eth = isEth(lc(key.currency0))
    const pair = t0Eth ? lc(key.currency1) : lc(key.currency0)
    const pairAmt = t0Eth ? a1 : a0
    const ethAmt = t0Eth ? a0 : a1
    const cpH = await call(CURVE, SEL_PRICE + pad(pair)); const cp = cpH ? BigInt(cpH) : 0n
    const v4 = Number(ethAmt) / 1e18 + (t0Eth ? c1ToEth(a1, sp) / 1e18 : 0)
    const curveVal = Number(ethAmt) / 1e18 + (cp ? Number((pairAmt * cp) / E18) / 1e18 : 0)
    // symbol
    const sh = await call(pair, '0x95d89b41'); let sym = pair.slice(0, 6)
    try { const off = parseInt(sh.slice(2, 66), 16), len = parseInt(sh.slice(2 + off * 2, 2 + off * 2 + 64), 16); sym = decodeURIComponent(sh.slice(2 + off * 2 + 64, 2 + off * 2 + 64 + len * 2).match(/.{2}/g).map(b => '%' + b).join('')) } catch {}
    console.log(`#${idn} ETH/${sym.padEnd(9)} onCurve=${cp > 0n ? 'YES' : 'no '}  V4val=${v4.toFixed(4)}  curveVal=${curveVal.toFixed(4)} ETH`)
  }
})().catch(e => console.error('FATAL', e))
