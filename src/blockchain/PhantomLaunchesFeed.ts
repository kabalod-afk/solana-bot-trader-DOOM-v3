import {
  fetchPhantomMemeExplore,
  mapLaunchToPoolEvent,
  parseLaunchColumns,
  tokensForColumns,
  PhantomExploreFilters,
  PhantomLaunchColumn,
  PhantomLaunchPoolEvent,
  PHANTOM_LAUNCH_PLATFORMS,
} from './phantomLaunches';

export interface PhantomLaunchesFeedOpts {
  onToken: (event: PhantomLaunchPoolEvent) => void | Promise<void>;
  columns?: PhantomLaunchColumn[];
  pollMs?: number;
  /** Si false, el primer snapshot solo se memoriza (no dispara B0 sobre el tablero ya visible). */
  seedExisting?: boolean;
  filters?: PhantomExploreFilters;
}

/**
 * Fuente de candidatos = columna Launches de Phantom Terminal
 * (New / Migrating / Migrated), no el firehose de creates on-chain.
 */
export class PhantomLaunchesFeed {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private inFlight = false;
  private seen = new Set<string>();
  private primed = false;
  private readonly columns: PhantomLaunchColumn[];
  private readonly pollMs: number;
  private readonly seedExisting: boolean;
  private readonly filters: PhantomExploreFilters;

  constructor(private opts: PhantomLaunchesFeedOpts) {
    this.columns = opts.columns?.length ? opts.columns : parseLaunchColumns('new');
    this.pollMs = Math.max(2_000, opts.pollMs ?? 4_000);
    this.seedExisting = opts.seedExisting === true;
    this.filters = opts.filters ?? { platformsFilter: [...PHANTOM_LAUNCH_PLATFORMS] };
  }

  public start(): void {
    this.stopped = false;
    console.log(
      `👻 [PHANTOM_LAUNCHES] Fuente activa — columnas ${this.columns.join(',')} cada ${this.pollMs}ms (seed=${this.seedExisting})`
    );
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private remember(mint: string): void {
    this.seen.add(mint);
    if (this.seen.size > 8_000) {
      const first = this.seen.values().next().value;
      if (first) this.seen.delete(first);
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    try {
      const board = await fetchPhantomMemeExplore(this.filters);
      const rows = tokensForColumns(board, this.columns);
      const fresh: PhantomLaunchPoolEvent[] = [];

      for (const { token, column } of rows) {
        if (this.seen.has(token.tokenAddress)) continue;
        this.remember(token.tokenAddress);
        if (!this.primed && !this.seedExisting) continue;
        const event = mapLaunchToPoolEvent(token, column);
        if (event) fresh.push(event);
      }

      if (!this.primed) {
        this.primed = true;
        console.log(
          `[PHANTOM_LAUNCHES] Snapshot inicial ${this.seen.size} mints memorizados; solo se admiten altas nuevas.`
        );
        return;
      }

      for (const event of fresh) {
        if (this.stopped) return;
        console.log(
          `[PHANTOM_LAUNCHES] ${event.phantom.column} ${event.phantom.symbol || event.tokenAddress.slice(0, 8)} ` +
            `mc=$${event.phantom.marketCap.toFixed(0)} holders=${event.phantom.uniqueHolders} ` +
            `bundlers=${event.phantom.bundlersHolding.toFixed(0)}% ${event.tokenAddress}`
        );
        await this.opts.onToken(event);
      }
    } catch (err) {
      console.error(
        `[PHANTOM_LAUNCHES] poll error: ${err instanceof Error ? err.message : err}`
      );
    } finally {
      this.inFlight = false;
    }
  }
}
