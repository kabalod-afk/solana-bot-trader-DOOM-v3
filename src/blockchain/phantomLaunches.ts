import { PublicKey } from '@solana/web3.js';
import { NewPoolEvent, PhantomLaunchHint } from './PoolListener';

export const PHANTOM_MEME_EXPLORE_URL =
  'https://api.phantom.app/sniper/v1/memeExplore';

export const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);

/** Plataformas que Phantom muestra en Launches (filtro por defecto del Terminal). */
export const PHANTOM_LAUNCH_PLATFORMS = [
  'Pumpfun',
  'Bonk',
  'Raydium Launch Labs',
  'Believe',
  'Meteora DBC',
  'MoonShot',
  'Jupiter Studio',
  'TimeDotFun',
  'GoFundMeme',
  'Forward',
  'OhFuck',
  'SubsDotFun',
  'TrendsDotFun',
  'BagsFm',
  'DubDubTv',
  'CookingCity',
] as const;

export type PhantomLaunchColumn = 'new' | 'migrating' | 'migrated';

export type PhantomLaunchMetrics = PhantomLaunchHint;

export interface PhantomLaunchToken {
  tokenAddress: string;
  bondingCurve: string;
  migratedPool?: string;
  name: string;
  symbol: string;
  marketCap: number;
  liquidity: number;
  bondingCurvePercentage: number;
  tokenCreatedAt: string;
  migratedAt?: string;
  bondingCurvePlatform: string;
  uniqueHolders: number;
  bundlersHolding: number;
  snipersHolding: number;
  devHolding: number;
  top10Holding: number;
  volume: number;
  buysCount: number;
  sellsCount: number;
}

export interface PhantomLaunchPoolEvent extends NewPoolEvent {
  phantom: PhantomLaunchMetrics;
}

export interface PhantomExploreFilters {
  platformsFilter: string[];
  tokenAgeInMinuteMin?: string;
  tokenAgeInMinuteMax?: string;
  marketcapMin?: string;
  marketcapMax?: string;
  liquidityMin?: string;
  volumeMin?: string;
}

const EMPTY_FILTER: PhantomExploreFilters = {
  platformsFilter: [...PHANTOM_LAUNCH_PLATFORMS],
};

export function associatedBondingCurvePda(
  bondingCurve: string,
  mint: string,
  tokenProgram: PublicKey = TOKEN_2022_PROGRAM_ID
): string {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(bondingCurve).toBuffer(),
      tokenProgram.toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0].toBase58();
}

/** Pump 2026 usa Token-2022; tokens viejos siguen en Tokenkeg. B0 prueba ambos. */
export function associatedBondingCurveCandidates(
  bondingCurve: string,
  mint: string
): string[] {
  const t22 = associatedBondingCurvePda(bondingCurve, mint, TOKEN_2022_PROGRAM_ID);
  const spl = associatedBondingCurvePda(bondingCurve, mint, TOKEN_PROGRAM_ID);
  return t22 === spl ? [t22] : [t22, spl];
}

export function parseLaunchColumns(raw: string | undefined): PhantomLaunchColumn[] {
  const allowed: PhantomLaunchColumn[] = ['new', 'migrating', 'migrated'];
  const parts = (raw ?? 'new')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is PhantomLaunchColumn =>
      allowed.includes(s as PhantomLaunchColumn)
    );
  return parts.length > 0 ? [...new Set(parts)] : ['new'];
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function parseLaunchToken(raw: unknown): PhantomLaunchToken | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const tokenAddress = str(o.tokenAddress);
  const bondingCurve = str(o.bondingCurve);
  if (!tokenAddress || !bondingCurve) return null;
  try {
    new PublicKey(tokenAddress);
    new PublicKey(bondingCurve);
  } catch {
    return null;
  }
  const migratedPool = str(o.migratedPool) || undefined;
  if (migratedPool) {
    try {
      new PublicKey(migratedPool);
    } catch {
      return null;
    }
  }
  return {
    tokenAddress,
    bondingCurve,
    migratedPool,
    name: str(o.name),
    symbol: str(o.symbol),
    marketCap: num(o.marketCap),
    liquidity: num(o.liquidity),
    bondingCurvePercentage: num(o.bondingCurvePercentage),
    tokenCreatedAt: str(o.tokenCreatedAt),
    migratedAt: str(o.migratedAt) || undefined,
    bondingCurvePlatform: str(o.bondingCurvePlatform) || 'Pumpfun',
    uniqueHolders: num(o.uniqueHolders),
    bundlersHolding: num(o.bundlersHolding),
    snipersHolding: num(o.snipersHolding),
    devHolding: num(o.devHolding),
    top10Holding: num(o.top10Holding),
    volume: num(o.volume),
    buysCount: num(o.buysCount),
    sellsCount: num(o.sellsCount),
  };
}

export function isPumpishPlatform(platform: string): boolean {
  const p = platform.toLowerCase();
  return p === 'pumpfun' || p === 'pump.fun' || p === 'pump';
}

export function isRaydiumishPlatform(platform: string): boolean {
  const p = platform.toLowerCase();
  return p.includes('raydium') || p === 'bonk' || p.includes('launch lab');
}

export function mapLaunchToPoolEvent(
  token: PhantomLaunchToken,
  column: PhantomLaunchColumn
): PhantomLaunchPoolEvent | null {
  const createdAtMs = Date.parse(token.tokenCreatedAt) || Date.now();
  const phantom: PhantomLaunchMetrics = {
    column,
    name: token.name,
    symbol: token.symbol,
    platform: token.bondingCurvePlatform,
    marketCap: token.marketCap,
    liquidity: token.liquidity,
    uniqueHolders: token.uniqueHolders,
    bundlersHolding: token.bundlersHolding,
    snipersHolding: token.snipersHolding,
    devHolding: token.devHolding,
    top10Holding: token.top10Holding,
    buysCount: token.buysCount,
    sellsCount: token.sellsCount,
    volume: token.volume,
    bondingCurvePercentage: token.bondingCurvePercentage,
    createdAtMs,
  };

  const migrated = column === 'migrated' && !!token.migratedPool;
  if (migrated && token.migratedPool) {
    return {
      tokenAddress: token.tokenAddress,
      poolAddress: token.migratedPool,
      deployerAddress: '',
      signature: `phantom:${column}:${token.tokenAddress}`,
      timestamp: createdAtMs,
      source: 'raydium',
      phantom,
    };
  }

  if (!isPumpishPlatform(token.bondingCurvePlatform)) {
    return null;
  }

  let associatedBondingCurve: string | undefined;
  try {
    associatedBondingCurve = associatedBondingCurvePda(
      token.bondingCurve,
      token.tokenAddress,
      TOKEN_2022_PROGRAM_ID
    );
  } catch {
    return null;
  }

  return {
    tokenAddress: token.tokenAddress,
    poolAddress: token.bondingCurve,
    deployerAddress: '',
    associatedBondingCurve,
    signature: `phantom:${column}:${token.tokenAddress}`,
    timestamp: createdAtMs,
    source: 'pump',
    phantom,
  };
}

export interface PhantomExploreResult {
  new: PhantomLaunchToken[];
  migrating: PhantomLaunchToken[];
  migrated: PhantomLaunchToken[];
}

function parseColumn(raw: unknown): PhantomLaunchToken[] {
  if (!Array.isArray(raw)) return [];
  const out: PhantomLaunchToken[] = [];
  for (const item of raw) {
    const parsed = parseLaunchToken(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function fetchPhantomMemeExplore(
  filters: PhantomExploreFilters = EMPTY_FILTER,
  fetchImpl: typeof fetch = fetch
): Promise<PhantomExploreResult> {
  const body = {
    newFilter: filters,
    aboutToGraduateFilter: filters,
    graduatedFilter: filters,
  };
  const res = await fetchImpl(PHANTOM_MEME_EXPLORE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'DOOM-v3/3.0',
      Origin: 'https://trade.phantom.com',
      Referer: 'https://trade.phantom.com/launches',
      'X-Phantom-Platform': 'terminal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Phantom memeExplore HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    success?: boolean;
    data?: {
      NEW?: unknown[];
      ABOUT_TO_GRADUATE?: unknown[];
      GRADUATED?: unknown[];
    };
  };
  const data = json.data ?? {};
  return {
    new: parseColumn(data.NEW),
    migrating: parseColumn(data.ABOUT_TO_GRADUATE),
    migrated: parseColumn(data.GRADUATED),
  };
}

export function tokensForColumns(
  result: PhantomExploreResult,
  columns: PhantomLaunchColumn[]
): Array<{ token: PhantomLaunchToken; column: PhantomLaunchColumn }> {
  const out: Array<{ token: PhantomLaunchToken; column: PhantomLaunchColumn }> = [];
  if (columns.includes('new')) {
    for (const token of result.new) out.push({ token, column: 'new' });
  }
  if (columns.includes('migrating')) {
    for (const token of result.migrating) out.push({ token, column: 'migrating' });
  }
  if (columns.includes('migrated')) {
    for (const token of result.migrated) out.push({ token, column: 'migrated' });
  }
  return out;
}
