export type NetworkMode = 'devnet' | 'mainnet';

/**
 * devnet = papel (B0 + radar + Telegram, sin comprar).
 * mainnet = compras reales en Cartera B.
 *
 * NETWORK pisa el viejo LIVE_TRADING=true/false.
 * `testnet` se acepta como alias de `devnet`.
 */
export function networkMode(): NetworkMode {
  const raw = (process.env.NETWORK || process.env.SOLANA_NETWORK || '')
    .trim()
    .toLowerCase();
  if (raw === 'mainnet' || raw === 'mainnet-beta' || raw === 'live') return 'mainnet';
  if (raw === 'devnet' || raw === 'testnet' || raw === 'paper') return 'devnet';

  const legacy = (process.env.LIVE_TRADING || '').trim().toLowerCase();
  if (legacy === 'true' || legacy === 'mainnet') return 'mainnet';
  return 'devnet';
}

export function isLiveTrading(): boolean {
  return networkMode() === 'mainnet';
}

export function networkLabel(): string {
  return networkMode() === 'mainnet' ? 'MAINNET (live)' : 'DEVNET (papel, sin compras)';
}
