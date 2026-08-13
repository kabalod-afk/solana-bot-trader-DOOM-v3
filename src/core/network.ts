export type NetworkMode = 'testnet' | 'mainnet';

/**
 * testnet = papel (B0 + radar + Telegram, sin comprar).
 * mainnet = compras reales en Cartera B.
 *
 * NETWORK pisa el viejo LIVE_TRADING=true/false.
 */
export function networkMode(): NetworkMode {
  const raw = (process.env.NETWORK || process.env.SOLANA_NETWORK || '')
    .trim()
    .toLowerCase();
  if (raw === 'mainnet' || raw === 'mainnet-beta' || raw === 'live') return 'mainnet';
  if (raw === 'testnet' || raw === 'devnet' || raw === 'paper') return 'testnet';

  const legacy = (process.env.LIVE_TRADING || '').trim().toLowerCase();
  if (legacy === 'true' || legacy === 'mainnet') return 'mainnet';
  return 'testnet';
}

export function isLiveTrading(): boolean {
  return networkMode() === 'mainnet';
}

export function networkLabel(): string {
  return networkMode() === 'mainnet' ? 'MAINNET (live)' : 'TESTNET (papel, sin compras)';
}
