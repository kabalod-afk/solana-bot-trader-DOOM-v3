import { JitoExecution } from '../blockchain/JitoExecution';
import { VaultManager } from './VaultManager';
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
  private lastVaultedSol = 0;
  private readonly takeProfitMult: number;
  private readonly trailingPct: number;

  constructor(
    private instanceBotId: string,
    private tokenAddress: string,
    private deployerAddress: string,
    private observationTimeMs: number,
    private baseInvestmentSol: number,
    private jito: JitoExecution,
    private vault: VaultManager,
    private telegram: TelegramService,
    private helios: HeliosEngine
  ) {
    this.currentSolExposed = baseInvestmentSol;
    const cfg = loadMomentumConfig(helios.weights().min_pool_sol_threshold);
    this.takeProfitMult = 1 + cfg.takeProfitPct / 100;
    this.trailingPct = cfg.trailingStopPct / 100;
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
      const sell = await this.jito.executeFullSell(this.tokenAddress);
      if (!sell.ok) return this.abortClose('cierre forzado');
      const pnl =
        (metrics.currentPriceUSD / this.entryPriceUSD - 1) * this.currentSolExposed;
      await this.vaultProfit(pnl);
      this.helios.updateAfterTrade(
        pnl,
        this.observationTimeMs,
        metrics.buyVolumeRatio,
        false
      );
      await this.reportClose('Cierre forzado (Telegram)', pnl, sell.signature);
      return 'CLOSED';
    }

    if (metrics.isDevSelling) {
      const sell = await this.jito.executeEmergencyEvacuation(this.tokenAddress);
      if (!sell.ok) return this.abortClose('rug');
      void this.telegram.sendText(
        `🚨 *[${this.instanceBotId}] RUG PULL EN MEMPOOL.* Evacuado vía Jito.`
      );
      this.helios.updateAfterTrade(
        -this.currentSolExposed,
        this.observationTimeMs,
        metrics.buyVolumeRatio,
        true,
        this.deployerAddress
      );
      await this.reportClose(
        'Rug pull (dev vendiendo)',
        -this.currentSolExposed,
        sell.signature
      );
      return 'CLOSED';
    }

    const currentMult = metrics.currentPriceUSD / this.entryPriceUSD;

    if (currentMult >= this.takeProfitMult * 0.5) {
      this.trailingArmed = true;
    }

    if (currentMult >= this.takeProfitMult && !this.hasTakenProfit) {
      const ok = await this.jito.executePartialSellByRatio(this.tokenAddress, 0.5);
      if (ok.ok) {
        const coveredSol = this.currentSolExposed * 0.5;
        const realizedPnl = coveredSol * (currentMult - 1);
        this.currentSolExposed -= coveredSol;
        this.hasTakenProfit = true;
        this.trailingArmed = true;
        await this.vaultProfit(realizedPnl);
        this.telegram.notifyTakeProfit(
          this.instanceBotId,
          currentMult,
          Math.max(0, realizedPnl * solPrice),
          `TP +${((this.takeProfitMult - 1) * 100).toFixed(0)}% (cobertura 50%)`
        );
      }
    }

    const dropFromPeak =
      this.highestPriceUSD > 0
        ? (this.highestPriceUSD - metrics.currentPriceUSD) / this.highestPriceUSD
        : 0;

    if (this.trailingArmed && dropFromPeak >= this.trailingPct) {
      const sell = await this.jito.executeFullSell(this.tokenAddress);
      if (!sell.ok) return this.abortClose('trailing');
      const pnl =
        (metrics.currentPriceUSD / this.entryPriceUSD - 1) * this.currentSolExposed;
      await this.vaultProfit(pnl);
      this.helios.updateAfterTrade(
        pnl,
        this.observationTimeMs,
        metrics.buyVolumeRatio,
        false
      );
      await this.reportClose(
        `Trailing −${(this.trailingPct * 100).toFixed(0)}% ATH`,
        pnl,
        sell.signature
      );
      return 'CLOSED';
    }

    return 'RUNNING';
  }

  private abortClose(reason: string): 'RUNNING' {
    console.error(
      `[CLOSE_ABORT] ${this.instanceBotId} venta no confirmada (${reason}) — se reintenta, no se rutea a B`
    );
    return 'RUNNING';
  }

  private async vaultProfit(pnlSol: number): Promise<void> {
    const surplus = Math.max(0, pnlSol);
    if (surplus <= 0) return;
    this.lastVaultedSol += await this.vault.sweepProfitsToVault(surplus);
  }

  private async reportClose(reason: string, pnlSol: number, txHash: string): Promise<void> {
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
      this.vault.walletBBase58(),
      this.lastVaultedSol
    );
  }
}
