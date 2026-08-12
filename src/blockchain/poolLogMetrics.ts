const WALLET_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

export interface PoolLogSnapshot {
  buyVolumeRatio: number;
  consecutiveSells: number;
  isDevSelling: boolean;
  totalBuys: number;
  totalSells: number;
}

/** Métricas en vivo desde logs WSS (mismo parser que el radar). */
export class PoolLogMetrics {
  private totalBuys = 0;
  private totalSells = 0;
  private consecutiveSells = 0;
  private isDevSelling = false;

  consume(logs: string[], deployerAddress: string): void {
    for (const line of logs) {
      const lower = line.toLowerCase();
      const isIxBuy =
        lower.includes('instruction: buy') || lower.includes('instruction:buy');
      const isIxSell =
        lower.includes('instruction: sell') || lower.includes('instruction:sell');

      if (isIxBuy) {
        this.totalBuys++;
        this.consecutiveSells = 0;
      } else if (isIxSell) {
        this.totalSells++;
        this.consecutiveSells++;
      }

      if (deployerAddress && isIxSell && line.includes(deployerAddress)) {
        this.isDevSelling = true;
      }
    }
  }

  snapshot(fallbackBuyRatio = 0.5): PoolLogSnapshot {
    const total = this.totalBuys + this.totalSells;
    const buyVolumeRatio = total > 0 ? this.totalBuys / total : fallbackBuyRatio;
    return {
      buyVolumeRatio,
      consecutiveSells: this.consecutiveSells,
      isDevSelling: this.isDevSelling,
      totalBuys: this.totalBuys,
      totalSells: this.totalSells,
    };
  }
}

export function poolLogMentions(
  poolAddress: string,
  token: string,
  extra: string[] = []
): string[] {
  return [poolAddress, token, ...extra].filter(
    (addr, i, arr) => !!addr && arr.indexOf(addr) === i
  );
}
