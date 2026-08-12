import { Connection, PublicKey } from '@solana/web3.js';
import { HeliosEngine } from '../core/HeliosEngine';
import { loadMomentumConfig } from '../core/momentumConfig';
import { PoolListener } from './PoolListener';

export interface WindowSolWatch {
  solAccount: string;
  isTokenAccount: boolean;
}

export interface ObservationResult {
  passed: boolean;
  reason?: string;
  entrySizeSol: number;
  buyVolumeRatio: number;
  observationTimeMs: number;
  txCount: number;
  currentMcUsd?: number;
  trigger?: 'price_tick' | 'volume_burst' | 'organic_impulse';
}

export interface TxTick {
  timestamp: number;
  amountSol: number;
}

export interface TokenTrackingState {
  initialMcUsd: number;
  currentMcUsd: number;
  txHistory: TxTick[];
  uniqueWallets: Set<string>;
  buyTimestamps: number[];
}

interface LiveTicks {
  buys: number;
  sells: number;
  hasThirdPartySell: boolean;
  isDevSelling: boolean;
  lpDrained: boolean;
  volumeSolIn: number;
  wallets: string[];
  currentPoolSol: number;
  didRpc: boolean;
}

const WALLET_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

export class WindowObserver {
  constructor(
    private connection: Connection,
    private helios: HeliosEngine,
    private poolListener?: PoolListener
  ) {}

  public bindListener(listener: PoolListener): void {
    this.poolListener = listener;
  }

  /**
   * Paso 2: breakout por ticks de precio, ráfaga de volumen o impulso de MC.
   * Requiere además ≥ minTx compras orgánicas en observeRadar.
   */
  public evaluateBreakout(tokenData: TokenTrackingState): 'price_tick' | 'volume_burst' | 'organic_impulse' | null {
    const { initialMcUsd, currentMcUsd, txHistory, uniqueWallets, buyTimestamps } =
      tokenData;
    const w = this.helios.weights();
    const now = Date.now();

    if (initialMcUsd > 0 && currentMcUsd / initialMcUsd >= w.organic_mc_multiplier) {
      console.log(
        `[TRIGGER] Breakout tick: MC ${ (currentMcUsd / initialMcUsd).toFixed(2) }x`
      );
      return 'price_tick';
    }

    const recentBuys = buyTimestamps.filter((t) => now - t <= 15_000).length;
    if (recentBuys >= w.log_burst_buys) {
      console.log(
        `[TRIGGER] Ráfaga de logs ${recentBuys} buys / 15s (umbral ${w.log_burst_buys})`
      );
      return 'volume_burst';
    }

    const recentVolumeSol = txHistory
      .filter((tx) => now - tx.timestamp <= 15_000)
      .reduce((sum, tx) => sum + tx.amountSol, 0);

    if (recentVolumeSol >= w.volume_burst_sol) {
      console.log(
        `[TRIGGER] Ráfaga +${recentVolumeSol.toFixed(2)} SOL en 15s (umbral ${w.volume_burst_sol})`
      );
      return 'volume_burst';
    }

    if (initialMcUsd > 0) {
      const mcMultiplier = currentMcUsd / initialMcUsd;
      if (
        mcMultiplier >= Math.max(1.5, w.organic_mc_multiplier) &&
        uniqueWallets.size >= w.min_unique_wallets
      ) {
        console.log(
          `[TRIGGER] Impulso ${mcMultiplier.toFixed(2)}x MC con ${uniqueWallets.size} wallets`
        );
        return 'organic_impulse';
      }
    }

    return null;
  }

  /** @deprecated usar evaluateBreakout */
  public evaluateMomentum(tokenData: TokenTrackingState): boolean {
    return this.evaluateBreakout(tokenData) !== null;
  }

  async observeWindow(
    poolAddress: string,
    initialPoolSol: number,
    deployerAddress?: string,
    initialMcUsd = 0,
    solWatch?: WindowSolWatch,
    extraLogMentions: string[] = []
  ): Promise<ObservationResult> {
    const startTime = Date.now();
    const cfg = loadMomentumConfig(this.helios.weights().min_pool_sol_threshold);
    const MAX_RADAR_MS = cfg.radarMaxMs;
    const minTxCount = cfg.minTxCount;
    const w = this.helios.weights();
    const highConvictionPool = w.min_pool_sol_threshold * 3;

    let totalBuys = 0;
    let totalSells = 0;
    let isLpSecured = true;
    let lastPoolSol = initialPoolSol;

    const tracking: TokenTrackingState = {
      initialMcUsd,
      currentMcUsd: initialMcUsd,
      txHistory: [],
      uniqueWallets: new Set<string>(),
      buyTimestamps: [],
    };

    let pool: PublicKey;
    try {
      pool = new PublicKey(poolAddress);
    } catch {
      return {
        passed: false,
        reason: 'Pool address inválida',
        entrySizeSol: 0,
        buyVolumeRatio: 0,
        observationTimeMs: 0,
        txCount: 0,
      };
    }

    const logBuffer: string[] = [];
    const unsubs: Array<() => void> = [];
    const mentions = [poolAddress, ...extraLogMentions].filter(
      (addr, i, arr) => addr && arr.indexOf(addr) === i
    );
    if (this.poolListener) {
      for (const addr of mentions) {
        unsubs.push(
          this.poolListener.subscribePoolLogs(addr, (logs) => {
            logBuffer.push(...logs);
          })
        );
      }
    }

    let lastSolRpcAt = 0;

    try {
      while (Date.now() - startTime < MAX_RADAR_MS) {
        const elapsedPre = Date.now() - startTime;
        const forceRpc = elapsedPre >= 3_000 && Date.now() - lastSolRpcAt >= 2_000;
        const ticks = await this.consumeTicks(
          pool,
          logBuffer,
          deployerAddress,
          initialPoolSol,
          lastPoolSol,
          forceRpc,
          solWatch
        );
        if (ticks.didRpc) lastSolRpcAt = Date.now();
        logBuffer.length = 0;

        totalBuys += ticks.buys;
        totalSells += ticks.sells;
        if (ticks.lpDrained) isLpSecured = false;

        if (ticks.volumeSolIn > 0) {
          tracking.txHistory.push({
            timestamp: Date.now(),
            amountSol: ticks.volumeSolIn,
          });
        }
        if (ticks.buys > 0) {
          const nowTs = Date.now();
          for (let i = 0; i < ticks.buys; i++) tracking.buyTimestamps.push(nowTs);
        }
        for (const wallet of ticks.wallets) {
          if (wallet !== deployerAddress && wallet !== poolAddress) {
            tracking.uniqueWallets.add(wallet);
          }
        }

        lastPoolSol = ticks.currentPoolSol;
        if (initialPoolSol > 0 && initialMcUsd > 0) {
          tracking.currentMcUsd =
            initialMcUsd * (ticks.currentPoolSol / initialPoolSol);
        }

        const totalTx = totalBuys + totalSells;
        const buyRatio = totalTx > 0 ? totalBuys / totalTx : 0;
        const elapsedTime = Date.now() - startTime;

        if (ticks.isDevSelling || !isLpSecured) {
          return {
            passed: false,
            reason: 'Dev vendió o retiró LP durante el radar',
            entrySizeSol: 0,
            buyVolumeRatio: buyRatio,
            observationTimeMs: elapsedTime,
            txCount: totalBuys,
            currentMcUsd: tracking.currentMcUsd,
          };
        }

        const breakout = this.evaluateBreakout(tracking);
        if (elapsedTime >= 3_000 && totalBuys >= minTxCount && breakout) {
          const isHighConviction =
            buyRatio >= 0.8 && initialPoolSol >= highConvictionPool;
          return {
            passed: true,
            entrySizeSol: isHighConviction ? 1.5 : 1.0,
            buyVolumeRatio: buyRatio,
            observationTimeMs: elapsedTime,
            txCount: totalBuys,
            currentMcUsd: tracking.currentMcUsd,
            trigger: breakout,
          };
        }

        await new Promise((r) => setTimeout(r, 2_000));
      }
    } catch (e) {
      console.error('[RADAR_ERROR]', e);
    } finally {
      for (const unsub of unsubs) unsub();
    }

    return {
      passed: false,
      reason: `Tiempo agotado (${Math.round(MAX_RADAR_MS / 1000)}s) sin ≥${minTxCount} txs orgánicas + breakout`,
      entrySizeSol: 0,
      buyVolumeRatio: 0,
      observationTimeMs: MAX_RADAR_MS,
      txCount: totalBuys,
      currentMcUsd: tracking.currentMcUsd,
    };
  }

  private async consumeTicks(
    pool: PublicKey,
    logBuffer: string[],
    deployerAddress: string | undefined,
    initialPoolSol: number,
    lastPoolSol: number,
    forceRpc: boolean,
    solWatch?: WindowSolWatch
  ): Promise<LiveTicks> {
    let buys = 0;
    let sells = 0;
    let hasThirdPartySell = false;
    let isDevSelling = false;
    const wallets: string[] = [];

    for (const line of logBuffer) {
      const lower = line.toLowerCase();
      const isIxBuy =
        lower.includes('instruction: buy') || lower.includes('instruction:buy');
      const isIxSell =
        lower.includes('instruction: sell') || lower.includes('instruction:sell');

      if (isIxBuy) {
        buys++;
      } else if (isIxSell) {
        sells++;
        hasThirdPartySell = true;
      }

      if (deployerAddress && isIxSell && line.includes(deployerAddress)) {
        isDevSelling = true;
      }

      const matches = line.match(WALLET_RE);
      if (matches) {
        for (const m of matches) wallets.push(m);
      }
    }

    if (!forceRpc && buys + sells === 0 && logBuffer.length === 0) {
      return {
        buys: 0,
        sells: 0,
        hasThirdPartySell: false,
        isDevSelling: false,
        lpDrained: false,
        volumeSolIn: 0,
        wallets,
        currentPoolSol: lastPoolSol,
        didRpc: false,
      };
    }

    const currentPoolSol = await this.readPoolSol(pool, solWatch);
    const lpDrained =
      initialPoolSol > 0 &&
      currentPoolSol > 0.01 &&
      currentPoolSol < initialPoolSol * 0.9;
    const delta = currentPoolSol - lastPoolSol;
    const volumeSolIn = Math.max(0, delta);

    if (buys + sells === 0 && Math.abs(delta) <= 0.001) {
      return {
        buys: 0,
        sells: 0,
        hasThirdPartySell: false,
        isDevSelling,
        lpDrained,
        volumeSolIn: 0,
        wallets,
        currentPoolSol,
        didRpc: true,
      };
    }

    if (buys + sells === 0) {
      if (delta > 0.001) buys = 1;
      else if (delta < -0.001) {
        sells = 1;
        hasThirdPartySell = true;
      }
    }

    return {
      buys,
      sells,
      hasThirdPartySell,
      isDevSelling,
      lpDrained,
      volumeSolIn,
      wallets,
      currentPoolSol,
      didRpc: true,
    };
  }

  private async readPoolSol(
    pool: PublicKey,
    solWatch?: WindowSolWatch
  ): Promise<number> {
    try {
      if (solWatch?.isTokenAccount) {
        const bal = await this.connection.getTokenAccountBalance(
          new PublicKey(solWatch.solAccount)
        );
        return bal.value.uiAmount ?? 0;
      }
      const target = solWatch?.solAccount
        ? new PublicKey(solWatch.solAccount)
        : pool;
      return (await this.connection.getBalance(target).catch(() => 0)) / 1e9;
    } catch {
      return (await this.connection.getBalance(pool).catch(() => 0)) / 1e9;
    }
  }
}
