import { JitoExecution } from '../blockchain/JitoExecution';
import { VaultManager } from './VaultManager';
import { TelegramService } from '../services/TelegramService';
import { HeliosEngine } from '../core/HeliosEngine';
import { loadMomentumConfig } from '../core/momentumConfig';
import { isLiveTrading } from '../core/jupiter';

export interface TradeTokenMeta {
  name?: string;
  symbol?: string;
}

export class TradeEngine {
  private highestPriceUSD = 0;
  private entryPriceUSD = 0;
  private currentSolExposed = 0;
  private hasTakenProfit = false;
  private trailingArmed = false;
  private entryTimeMs = Date.now();
  private forceCloseRequested = false;
  private lastVaultedSol = 0;
  private lastVaultSignature = '';
  private realizedPnlSol = 0;
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
    private vault: VaultManager,
    private telegram: TelegramService,
    private helios: HeliosEngine,
    private tokenMeta: TradeTokenMeta = {}
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
        this.realizedPnlSol + pnl,
        this.observationTimeMs,
        metrics.buyVolumeRatio,
        false
      );
      await this.reportClose('Cierre forzado (Telegram)', pnl, false);
      return 'CLOSED';
    }

    if (metrics.isDevSelling) {
      const sell = await this.jito.executeEmergencyEvacuation(this.tokenAddress);
      if (!sell.ok) return this.abortClose('rug');
      console.log(
        `[RUG] ${this.instanceBotId} ${this.tokenAddress}: evacuado vía Jito (${sell.signature})`
      );
      this.helios.updateAfterTrade(
        -this.currentSolExposed,
        this.observationTimeMs,
        metrics.buyVolumeRatio,
        true,
        this.deployerAddress
      );
      await this.reportClose('Rug pull (dev vendiendo)', -this.currentSolExposed, true);
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
        this.realizedPnlSol += realizedPnl;
        await this.vaultProfit(realizedPnl);
        console.log(
          `[TP] ${this.instanceBotId} cobertura 50% @ ${currentMult.toFixed(2)}x pnl=${realizedPnl.toFixed(4)} SOL`
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
        this.realizedPnlSol + pnl,
        this.observationTimeMs,
        metrics.buyVolumeRatio,
        false
      );
      await this.reportClose(
        `Trailing Stop −${(this.trailingPct * 100).toFixed(0)}% ATH`,
        pnl,
        false
      );
      return 'CLOSED';
    }

    const elapsedMs = Date.now() - this.entryTimeMs;
    if (elapsedMs >= this.positionMaxMs && !this.hasTakenProfit) {
      const sell = await this.jito.executeFullSell(this.tokenAddress);
      if (!sell.ok) return this.abortClose('stagnation');
      const pnl =
        (metrics.currentPriceUSD / this.entryPriceUSD - 1) * this.currentSolExposed;
      await this.vaultProfit(pnl);
      this.helios.updateAfterTrade(
        this.realizedPnlSol + pnl,
        this.observationTimeMs,
        metrics.buyVolumeRatio,
        false
      );
      await this.reportClose(
        `límite de ${Math.round(this.positionMaxMs / 1000)}s`,
        pnl,
        false
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
    const swept = await this.vault.sweepProfitsToVault(surplus);
    this.lastVaultedSol += swept.sol;
    if (swept.signature) this.lastVaultSignature = swept.signature;
  }

  private async reportClose(
    reason: string,
    remainingPnlSol: number,
    wasRug = false
  ): Promise<void> {
    const pnlSol = this.realizedPnlSol + remainingPnlSol;
    const pnlPercent =
      this.baseInvestmentSol > 0 ? (pnlSol / this.baseInvestmentSol) * 100 : 0;
    this.helios.briefAfterTrade(pnlSol, wasRug, this.tokenAddress);
    await this.telegram.notifyExit({
      mint: this.tokenAddress,
      name: this.tokenMeta.name,
      symbol: this.tokenMeta.symbol,
      reason,
      pnlSol,
      pnlPercent,
      liveTrading: isLiveTrading(),
      vaultedSol: this.lastVaultedSol,
      vaultSignature: this.lastVaultSignature || undefined,
    });
  }
}
