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

export function loadMomentumConfig(heliosMinPoolSol = 2): MomentumConfig {
  const num = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    minMcUSD: num('MIN_MC_USD', 400),
    maxMcUSD: num('MAX_MC_USD', 250_000),
    minTxCount: num('MIN_TX_COUNT', 3),
    // Lo aprendido (pool mínimo) manda el JSON de Helios, no MIN_POOL_SOL del .env
    minPoolSol: heliosMinPoolSol,
    radarMaxMs: num('RADAR_MAX_MS', 240_000),
    positionMaxMs: num('POSITION_MAX_MS', 240_000),
    takeProfitPct: num('TAKE_PROFIT_PCT', 30),
    trailingStopPct: num('TRAILING_STOP_PCT', 8),
  };
}
