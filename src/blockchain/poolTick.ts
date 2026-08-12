import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';

export interface RealPoolTick {
  currentPriceUSD: number;
  mcUSD: number;
  currentSolInPool: number;
  tokenReserve: number;
}

const WSOL = 'So11111111111111111111111111111111111111112';

export interface PoolTickOpts {
  coinVault?: string;
  pcVault?: string;
  associatedBondingCurve?: string;
  totalSupplyHint?: number;
}

/** Cache mint/rol de vaults para no repetir getParsedAccountInfo cada tick. */
const vaultRoleCache = new Map<
  string,
  { solVault: string; tokenVault: string; supply: number; tokenDecimals: number }
>();

function mintFromTokenAccount(data: Buffer): string | null {
  if (data.length < 32) return null;
  return new PublicKey(data.subarray(0, 32)).toBase58();
}

function uiAmountFromTokenAccount(data: Buffer, decimals: number): number {
  if (data.length < 72) return 0;
  const raw = data.readBigUInt64LE(64);
  return Number(raw) / 10 ** decimals;
}

function readMintDecimals(mintData: Buffer | undefined): number {
  if (mintData && mintData.length >= 45) return mintData[44];
  return 6;
}

function resolveVaultRoles(
  coinVault: string,
  pcVault: string,
  coinAcc: AccountInfo<Buffer> | null,
  pcAcc: AccountInfo<Buffer> | null
): { solVault: string; tokenVault: string } | null {
  const coinMint = coinAcc ? mintFromTokenAccount(coinAcc.data) : null;
  const pcMint = pcAcc ? mintFromTokenAccount(pcAcc.data) : null;
  if (coinMint === WSOL) return { solVault: coinVault, tokenVault: pcVault };
  if (pcMint === WSOL) return { solVault: pcVault, tokenVault: coinVault };
  if (pcMint) return { solVault: pcVault, tokenVault: coinVault };
  if (coinMint) return { solVault: coinVault, tokenVault: pcVault };
  return null;
}

/**
 * Precio on-chain barato: 1 getMultipleAccounts por tick (vaults).
 * Sin Jupiter, sin getParsed*, sin getTokenSupply si hay hint/cache.
 */
export async function fetchRealPoolTick(
  connection: Connection,
  poolAddress: string,
  tokenAddress: string,
  solPriceUSD: number,
  opts?: PoolTickOpts
): Promise<RealPoolTick> {
  let currentSolInPool = 0;
  let tokenReserve = 0;
  const cached = vaultRoleCache.get(poolAddress);
  let totalSupply = opts?.totalSupplyHint ?? cached?.supply ?? 0;
  let tokenDecimals = cached?.tokenDecimals ?? 6;

  if (opts?.coinVault && opts?.pcVault) {
    try {
      let roles = cached;
      const coinPk = new PublicKey(opts.coinVault);
      const pcPk = new PublicKey(opts.pcVault);
      const mintPk = tokenAddress ? new PublicKey(tokenAddress) : null;

      if (!roles) {
        const keys = mintPk ? [coinPk, pcPk, mintPk] : [coinPk, pcPk];
        const accs = await connection.getMultipleAccountsInfo(keys);
        const mintData = mintPk ? accs[2]?.data : undefined;
        tokenDecimals = readMintDecimals(mintData);
        const decoded = resolveVaultRoles(opts.coinVault, opts.pcVault, accs[0], accs[1]);
        if (decoded) {
          roles = { ...decoded, supply: totalSupply, tokenDecimals };
          vaultRoleCache.set(poolAddress, roles);
          const solAcc = decoded.solVault === opts.coinVault ? accs[0] : accs[1];
          const tokAcc = decoded.tokenVault === opts.coinVault ? accs[0] : accs[1];
          currentSolInPool = solAcc ? uiAmountFromTokenAccount(solAcc.data, 9) : 0;
          tokenReserve = tokAcc ? uiAmountFromTokenAccount(tokAcc.data, tokenDecimals) : 0;
        }
      } else {
        tokenDecimals = roles.tokenDecimals;
        const [solAcc, tokAcc] = await connection.getMultipleAccountsInfo([
          new PublicKey(roles.solVault),
          new PublicKey(roles.tokenVault),
        ]);
        currentSolInPool = solAcc ? uiAmountFromTokenAccount(solAcc.data, 9) : 0;
        tokenReserve = tokAcc ? uiAmountFromTokenAccount(tokAcc.data, tokenDecimals) : 0;
        if (roles.supply > 0) totalSupply = roles.supply;
      }
    } catch {
      /* fall through */
    }
  }

  // Pump: bonding curve (lamports) + ATA de tokens en 1 getMultipleAccounts
  if ((currentSolInPool <= 0 || tokenReserve <= 0) && opts?.associatedBondingCurve) {
    try {
      const mintPk = tokenAddress ? new PublicKey(tokenAddress) : null;
      const keys = mintPk
        ? [new PublicKey(poolAddress), new PublicKey(opts.associatedBondingCurve), mintPk]
        : [new PublicKey(poolAddress), new PublicKey(opts.associatedBondingCurve)];
      const accs = await connection.getMultipleAccountsInfo(keys);
      currentSolInPool = (accs[0]?.lamports ?? 0) / 1e9;
      if (mintPk && accs[2]?.data) {
        tokenDecimals = readMintDecimals(accs[2].data);
      }
      tokenReserve = accs[1] ? uiAmountFromTokenAccount(accs[1].data, tokenDecimals) : 0;
    } catch {
      /* fall through */
    }
  }

  if (currentSolInPool <= 0 && !opts?.coinVault) {
    currentSolInPool = (await connection.getBalance(new PublicKey(poolAddress)).catch(() => 0)) / 1e9;
  }

  if (!totalSupply) totalSupply = 1_000_000_000;

  if (currentSolInPool > 0 && tokenReserve > 0) {
    const currentPriceUSD = (currentSolInPool * solPriceUSD) / tokenReserve;
    return {
      currentPriceUSD,
      mcUSD: currentPriceUSD * totalSupply,
      currentSolInPool,
      tokenReserve,
    };
  }

  // Sin token reserve: no Jupiter (caro). El engine ignora ticks con precio 0.
  if (currentSolInPool > 0) {
    return {
      currentPriceUSD: 0,
      mcUSD: 0,
      currentSolInPool,
      tokenReserve,
    };
  }

  return {
    currentPriceUSD: 0,
    mcUSD: 0,
    currentSolInPool,
    tokenReserve,
  };
}

export function rememberPoolSupply(poolAddress: string, supply: number): void {
  const prev = vaultRoleCache.get(poolAddress);
  if (prev) vaultRoleCache.set(poolAddress, { ...prev, supply });
}
