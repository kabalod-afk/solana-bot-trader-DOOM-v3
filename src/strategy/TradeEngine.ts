import { JitoExecution } from '../blockchain/JitoExecution';
import { TelegramService } from '../services/TelegramService';
import { HeliosEngine } from '../core/HeliosEngine';
import { loadMomentumConfig } from '../core/momentumConfig';

export class TradeEngine {
  private highestPriceUSD = 0;
  private entryPriceUSD = 0;
  private currentSolExposed = 0;
  private hasTakenProfit = false;
  private trailingArmed = false;
  private entryTimeMs = Date.now();
  private forceCloseRequested = false;
  private readonly takeProfitMult: number;
  private readonly trailingPct: number;
  private readonly positionMaxMs: number;

  constructor(
    private instanceBotId: string,
    private tokenAddress: string,
    private deployerAddress: string,
    private observationTimeMs: number,
    private baseInvestmentSol: number,
    private jito: JitoExecution,
    private telegram: TelegramService,
    private helios: HeliosEngine,
    /** Saldo nativo de B ANTES de la compra. Compra y venta quedan en esta cartera. */
    private solBeforeBuy: number
  ) {
    this.currentSolExposed = baseInvestmentSol;
    const cfg = loadMomentumConfig(helios.weights().min_pool_sol_threshold);
    this.takeProfitMult = 1 + cfg.takeProfitPct / 100;
    this.trailingPct = cfg.trailingStopPct / 100;
    this.positionMaxMs = cfg.positionMaxMs;
  }

  requestForceClose(): void {
    this.forceCloseRequested = true;
  }

  async processTick(metrics: {
    currentPriceUSD: number;
    mcUSD: number;
    buyVolumeRatio: number;
    consecutiveSells: number;
    txPerMinute: number;
    isDevSelling: boolean;
    solPriceUSD?: number;
  }): Promise<'RUNNING' | 'CLOSED'> {
    const solPrice = metrics.solPriceUSD ?? 160;

    if (this.entryPriceUSD === 0) {
      this.entryPriceUSD = metrics.currentPriceUSD;
      this.highestPriceUSD = metrics.currentPriceUSD;
    }

    if (metrics.currentPriceUSD > this.highestPriceUSD) {
      this.highestPriceUSD = metrics.currentPriceUSD;
    }

    if (this.forceCloseRequested) {
      return this.closeFull(
        'Cierre forzado (Telegram)',
        metrics.buyVolumeRatio,
        false,
        false
      );
    }

    if (metrics.isDevSelling) {
      void this.telegram.sendText(
        `🚨 *[${this.instanceBotId}] RUG PULL EN MEMPOOL.* Evacuado vía Jito.`
      );
      return this.closeFull('Rug pull (dev vendiendo)', metrics.buyVolumeRatio, true, true);
    }

    const currentMult = metrics.currentPriceUSD / this.entryPriceUSD;

    // Trailing solo tras TP: no armar en el medio camino.
    if (currentMult >= this.takeProfitMult && !this.hasTakenProfit) {
      const balBefore = await this.jito.solBalanceA();
      const ok = await this.jito.executePartialSellByRatio(this.tokenAddress, 0.5);
      if (ok.ok) {
        const balAfter = await this.jito.solBalanceA();
        const returned = balAfter - balBefore;
        const coveredSol = this.currentSolExposed * 0.5;
        const realizedPnl = coveredSol * (currentMult - 1);
        this.currentSolExposed -= coveredSol;
        this.hasTakenProfit = true;
        this.trailingArmed = true;
        // Cobertura queda en A. Superávit real se rutea a B solo al cierre.
        this.telegram.notifyTakeProfit(
          this.instanceBotId,
          currentMult,
          Math.max(0, realizedPnl * solPrice),
          `TP +${((this.takeProfitMult - 1) * 100).toFixed(0)}% (cobertura 50% queda en B)`,
          returned,
          balAfter
        );
      }
    }

    const dropFromPeak =
      this.highestPriceUSD > 0
        ? (this.highestPriceUSD - metrics.currentPriceUSD) / this.highestPriceUSD
        : 0;

    if (this.trailingArmed && dropFromPeak >= this.trailingPct) {
      return this.closeFull(
        `Trailing −${(this.trailingPct * 100).toFixed(0)}% ATH`,
        metrics.buyVolumeRatio,
        false,
        false
      );
    }

    const elapsedMs = Date.now() - this.entryTimeMs;
    if (elapsedMs >= this.positionMaxMs && !this.hasTakenProfit) {
      return this.closeFull(
        `Estancamiento ${Math.round(this.positionMaxMs / 1000)}s sin TP`,
        metrics.buyVolumeRatio,
        false,
        false
      );
    }

    return 'RUNNING';
  }

  private async closeFull(
    reason: string,
    buyVolumeRatio: number,
    wasRug: boolean,
    emergency: boolean
  ): Promise<'RUNNING' | 'CLOSED'> {
    const balBefore = await this.jito.solBalanceA();
    const sell = emergency
      ? await this.jito.executeEmergencyEvacuation(this.tokenAddress)
      : await this.jito.executeFullSell(this.tokenAddress);
    if (!sell.ok) return this.abortClose(reason.includes('Rug') ? 'rug' : reason.slice(0, 24));

    const balAfterSell = await this.jito.solBalanceA();
    const returnedSol = balAfterSell - balBefore;
    const actualPnl = balAfterSell - this.solBeforeBuy;

    this.helios.updateAfterTrade(
      actualPnl,
      this.observationTimeMs,
      buyVolumeRatio,
      wasRug,
      wasRug ? this.deployerAddress : undefined
    );
    await this.reportClose(reason, actualPnl, sell.signature, wasRug, returnedSol, balAfterSell);
    return 'CLOSED';
  }

  private abortClose(reason: string): 'RUNNING' {
    console.error(
      `[CLOSE_ABORT] ${this.instanceBotId} venta no confirmada (${reason}) — se reintenta`
    );
    return 'RUNNING';
  }

  private async reportClose(
    reason: string,
    pnlSol: number,
    txHash: string,
    wasRug = false,
    walletAReturnedSol?: number,
    walletABalanceSol?: number
  ): Promise<void> {
    const durationSec = Math.max(0, Math.round((Date.now() - this.entryTimeMs) / 1000));
    const pnlPercent =
      this.baseInvestmentSol > 0 ? (pnlSol / this.baseInvestmentSol) * 100 : 0;
    await this.telegram.notifyTradeClosed(
      this.tokenAddress,
      reason,
      pnlSol,
      pnlPercent,
      durationSec,
      txHash,
      undefined,
      walletAReturnedSol,
      walletABalanceSol
    );
    void this.telegram.notifyHelios(this.helios.briefAfterTrade(pnlSol, wasRug, this.tokenAddress));
  }
}
