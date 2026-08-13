export interface MomentumConfig {
  minMcUSD: number;
  maxMcUSD: number;
  minTxCount: number;
  minPoolSol: number;
  radarMaxMs: number;
  positionMaxMs: number;
  takeProfitPct: number;
  trailingStopPct: number;
}

export function loadMomentumConfig(heliosMinPoolSol = 1): MomentumConfig {
  const num = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  const envPool = num('MIN_POOL_SOL', NaN);
  return {
    minMcUSD: num('MIN_MC_USD', 400),
    maxMcUSD: num('MAX_MC_USD', 250_000),
    minTxCount: num('MIN_TX_COUNT', 3),
    // .env MIN_POOL_SOL pisa el JSON (útil en Ocean). Si no está, manda Helios.
    minPoolSol: Number.isFinite(envPool) ? envPool : heliosMinPoolSol,
    radarMaxMs: num('RADAR_MAX_MS', 210_000),
    positionMaxMs: num('POSITION_MAX_MS', 240_000),
    takeProfitPct: num('TAKE_PROFIT_PCT', 30),
    trailingStopPct: num('TRAILING_STOP_PCT', 8),
  };
}
