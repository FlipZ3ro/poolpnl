// Robinhood Chain + Uniswap V4 config for PoolPnL (read-only, no wallet).
export const CHAIN = {
  id: 4663, name: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com/',
  explorer: 'https://robinhoodchain.blockscout.com',
  blockscoutApi: 'https://robinhoodchain.blockscout.com/api/v2',
}

// PoolManager — fee collects/withdrawals are ERC20/native transfers FROM this address.
export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
export const V4 = {
  positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
}

export const NATIVE = '0x0000000000000000000000000000000000000000'
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' // ~$1 stable, for ETH/USD

// Launchpad bonding curve — origin & price source for launched tokens that haven't
// "graduated" to a full V4 pool. currentPrice(token) → wei ETH per 1 whole token,
// or 0 if the token isn't (or is no longer) on the curve.
export const BONDING_CURVE = '0xd861cb5dc71a0171e8f0f6586cadb069f3a35e4d'
export const CURVE_SEL = { currentPrice: '0xe9833c2f', quoteSell: '0xd98b2f5c' }

export const PM_SEL = {
  balanceOf: '0x70a08231', ownerOf: '0x6352211e', nextTokenId: '0x75794a3c',
  getPoolAndPositionInfo: '0x7ba03aad', getPositionLiquidity: '0x1efeed33',
}
export const SV_SEL = {
  getSlot0: '0xc815641c', getPositionInfo: '0x97fd7b42', getFeeGrowthInside: '0x53e9c1fb',
}
export const ERC20_SEL = { symbol: '0x95d89b41', name: '0x06fdde03', decimals: '0x313ce567' }

export const lc = (s: string) => (s || '').toLowerCase()
export const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test((s || '').trim())
