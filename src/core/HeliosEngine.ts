import fs from 'fs';
import path from 'path';

export interface HeliosLearnedWeights {
  min_observation_window_ms: number;
  min_pool_sol_threshold: number;
  ideal_buy_ratio: number;
  derisk_sensitivity: number;
  volume_burst_sol: number;
  log_burst_buys: number;
  organic_mc_multiplier: number;
  min_unique_wallets: number;
  /** Máx. creates del mismo deployer en la ventana serial (antigranja suave). */
  serial_deploys_per_2h: number;
  /** Ventana rolling para contar serial deploys (horas). Default 24h — pumps 24–96h. */
  serial_window_hours: number;
  skip_after_rejects: number;
}

export interface TokenMemory {
  jupiterOk?: boolean;
  jupiterFails?: number;
  lastTs: number;
}

export interface DeployerMemory {
  seen: number;
  rejects: number;
  lastReason: string;
  lastTs: number;
  windowStart: number;
  windowSeen: number;
  /** Cabal on-chain ya limpio — no repetir getSignatures por deployer. */
  cabalClean?: boolean;
}

export interface HeliosPolicy {
  json_over_api: boolean;
}

export interface HeliosAssistanceEntry {
  ts: number;
  kind: 'skip' | 'admit' | 'breakout' | 'radar_reject' | 'trade' | 'online';
  verdict: string;
  note: string;
  token?: string;
  deployer?: string;
  poolSol?: number;
  mcUsd?: number;
  entrySol?: number;
  trigger?: string;
  pnlSol?: number;
}

export interface HeliosAssistanceState {
  enabled: boolean;
  last_verdict: HeliosAssistanceEntry | null;
  log: HeliosAssistanceEntry[];
}

export interface HeliosBrainSchema {
  version: string;
  learned_weights: HeliosLearnedWeights;
  cabal_patterns: {
    blacklisted_funding_wallets: string[];
    suspicious_deployer_signatures: string[];
  };
  performance_metrics: {
    total_trades: number;
    win_rate: number;
    average_pnl_sol: number;
  };
  analysis_memory: {
    deployers: Record<string, DeployerMemory>;
    tokens: Record<string, TokenMemory>;
  };
  assistance: HeliosAssistanceState;
  policy: HeliosPolicy;
}

const DEFAULT_WEIGHTS: HeliosLearnedWeights = {
  min_observation_window_ms: 3_000,
  min_pool_sol_threshold: 2.0,
  ideal_buy_ratio: 0.6,
  derisk_sensitivity: 0.3,
  volume_burst_sol: 1.5,
  log_burst_buys: 8,
  organic_mc_multiplier: 1.2,
  min_unique_wallets: 3,
  serial_deploys_per_2h: 40,
  serial_window_hours: 24,
  skip_after_rejects: 10,
};

const MAX_DEPLOYERS = 500;
const MAX_TOKENS = 400;
const MAX_ASSIST_LOG = 80;

export class HeliosEngine {
  private filePath: string;
  public brain: HeliosBrainSchema;
  private pendingNotes = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.filePath = path.join(process.cwd(), 'helios_brain.json');
    this.brain = this.loadBrain();
    this.logAssistance({ kind: 'online', verdict: 'ONLINE', note: 'JSON-first + telegram' }, true);
  }

  private loadBrain(): HeliosBrainSchema {
    if (!fs.existsSync(this.filePath)) {
      throw new Error('helios_brain.json no existe.');
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<HeliosBrainSchema>;
    return {
      version: raw.version ?? '3.0.0',
      learned_weights: { ...DEFAULT_WEIGHTS, ...raw.learned_weights },
      cabal_patterns: {
        blacklisted_funding_wallets: raw.cabal_patterns?.blacklisted_funding_wallets ?? [],
        suspicious_deployer_signatures: [],
      },
      performance_metrics: {
        total_trades: raw.performance_metrics?.total_trades ?? 0,
        win_rate: raw.performance_metrics?.win_rate ?? 0,
        average_pnl_sol: raw.performance_metrics?.average_pnl_sol ?? 0,
      },
      analysis_memory: {
        deployers: raw.analysis_memory?.deployers ?? {},
        tokens: raw.analysis_memory?.tokens ?? {},
      },
      assistance: {
        enabled: raw.assistance?.enabled ?? true,
        last_verdict: raw.assistance?.last_verdict ?? null,
        log: Array.isArray(raw.assistance?.log) ? raw.assistance.log.slice(-MAX_ASSIST_LOG) : [],
      },
      policy: {
        json_over_api: raw.policy?.json_over_api !== false,
      },
    };
  }

  public saveBrain(): void {
    this.pendingNotes = 0;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.brain, null, 2));
  }

  private scheduleSave(): void {
    this.pendingNotes++;
    if (this.pendingNotes >= 20) {
      this.saveBrain();
      return;
    }
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.saveBrain(), 10_000);
    }
  }

  public jsonOverApi(): boolean {
    return this.brain.policy?.json_over_api !== false;
  }

  /**
   * JSON-first: cabal por deployer, Jupiter dry-run por mint (token).
   */
  public apiGate(
    deployer: string,
    token: string
  ): {
    needCabalRpc: boolean;
    needJupiter: boolean;
    rejectFromJson: string | null;
    trust: string;
  } {
    if (!this.jsonOverApi()) {
      return {
        needCabalRpc: true,
        needJupiter: true,
        rejectFromJson: null,
        trust: 'api',
      };
    }

    const tokenMem = this.brain.analysis_memory.tokens[token];
    if ((tokenMem?.jupiterFails ?? 0) >= 2) {
      return {
        needCabalRpc: false,
        needJupiter: false,
        rejectFromJson: 'HELIOS_JSON: dry-run Jupiter fallido en este mint (memoria)',
        trust: 'json',
      };
    }

    const depMem = this.brain.analysis_memory.deployers[deployer];
    const needCabal = !depMem || depMem.cabalClean !== true;
    const needJupiter = tokenMem?.jupiterOk !== true;

    if (!depMem && !tokenMem) {
      return {
        needCabalRpc: true,
        needJupiter: true,
        rejectFromJson: null,
        trust: 'sin memoria JSON — API',
      };
    }

    return {
      needCabalRpc: needCabal,
      needJupiter,
      rejectFromJson: null,
      trust: 'json',
    };
  }

  public noteJupiterResult(deployer: string, token: string, ok: boolean): void {
    if (!token) return;
    const mem = this.ensureToken(token);
    if (ok) {
      mem.jupiterOk = true;
      mem.jupiterFails = 0;
    } else {
      mem.jupiterOk = false;
      mem.jupiterFails = (mem.jupiterFails ?? 0) + 1;
    }
    if (deployer) this.ensureDeployer(deployer).lastTs = Date.now();
    this.scheduleSave();
  }

  public noteCabalResult(deployer: string, isCabal: boolean): void {
    if (!deployer) return;
    const mem = this.ensureDeployer(deployer);
    mem.cabalClean = !isCabal;
    this.scheduleSave();
  }

  public weights(): HeliosLearnedWeights {
    return this.brain.learned_weights;
  }

  public deployerSnapshot(deployer: string): {
    seen: number;
    rejects: number;
    lastReason: string;
    windowSeen: number;
    blacklisted: boolean;
  } {
    const mem = this.brain.analysis_memory.deployers[deployer];
    return {
      seen: mem?.seen ?? 0,
      rejects: mem?.rejects ?? 0,
      lastReason: mem?.lastReason ?? '',
      windowSeen: mem?.windowSeen ?? 0,
      blacklisted: this.isBlacklisted(deployer),
    };
  }

  public logAssistance(
    entry: Omit<HeliosAssistanceEntry, 'ts'>,
    flush = false
  ): HeliosAssistanceEntry {
    const full: HeliosAssistanceEntry = { ts: Date.now(), ...entry };
    if (!this.brain.assistance) {
      this.brain.assistance = { enabled: true, last_verdict: null, log: [] };
    }
    this.brain.assistance.last_verdict = full;
    this.brain.assistance.log.push(full);
    if (this.brain.assistance.log.length > MAX_ASSIST_LOG) {
      this.brain.assistance.log = this.brain.assistance.log.slice(-MAX_ASSIST_LOG);
    }
    if (flush) this.saveBrain();
    else this.scheduleSave();
    return full;
  }

  /** Briefing de admisión B0 para Telegram + JSON. */
  public briefAdmission(
    deployer: string,
    poolSol: number,
    mcUsd: number,
    token?: string
  ): string {
    const s = this.deployerSnapshot(deployer);
    const serialCap = this.weights().serial_deploys_per_2h;
    const serialWin = this.weights().serial_window_hours;
    const risk =
      s.rejects >= 2 ? 'cautela (rejects previos)' : s.seen <= 1 ? 'deployer nuevo' : 'historial limpio';
    this.logAssistance({
      kind: 'admit',
      verdict: 'ADMITIR',
      note: risk,
      deployer,
      token,
      poolSol,
      mcUsd,
    }, true);
    return (
      `🧠 <b>HELIOS</b> — admisión B0\n` +
      `• Deployer: ${s.seen} vistos / ${s.rejects} rejects / serial ${s.windowSeen}/${serialCap} (${serialWin}h)\n` +
      `• Pool ${poolSol.toFixed(2)} SOL · MC $${mcUsd.toFixed(0)}\n` +
      `• Veredicto: <b>ADMITIR</b> → radar 4 min (${risk})\n` +
      `• JSON: helios_brain.json actualizado`
    );
  }

  public briefBreakout(
    trigger: string,
    txCount: number,
    buyRatio: number,
    observationMs: number,
    opts?: { token?: string; deployer?: string; entrySol?: number; note?: string }
  ): string {
    const label =
      trigger === 'price_tick'
        ? 'salto de precio (tick)'
        : trigger === 'volume_burst'
          ? 'ráfaga de volumen'
          : 'impulso orgánico';
    this.logAssistance({
      kind: 'breakout',
      verdict: 'DISPARAR',
      note: opts?.note ?? label,
      token: opts?.token,
      deployer: opts?.deployer,
      entrySol: opts?.entrySol,
      trigger,
    }, true);
    return (
      `🧠 <b>HELIOS</b> — breakout\n` +
      `• Gatillo: ${label}\n` +
      `• ${txCount} txs orgánicas · buy ${(buyRatio * 100).toFixed(0)}% · ${Math.round(observationMs / 1000)}s en radar\n` +
      `• Veredicto: <b>DISPARAR</b>`
    );
  }

  public recommendEntry(
    poolSol: number,
    buyRatio: number,
    deployer: string
  ): { sizeSol: number; note: string } {
    const w = this.weights();
    const s = this.deployerSnapshot(deployer);
    let sizeSol = 1.0;
    let note = 'entrada base 1.0 SOL';

    if (poolSol >= w.min_pool_sol_threshold * 3 && buyRatio >= 0.8) {
      sizeSol = 1.5;
      note = 'alta convicción (pool + buy ratio)';
    }
    if (s.rejects >= 2) {
      sizeSol = Math.min(sizeSol, 1.0);
      note = 'reduce tamaño: deployer con rejects';
    }
    if (s.seen <= 1 && buyRatio >= 0.7 && poolSol >= w.min_pool_sol_threshold * 2) {
      sizeSol = Math.max(sizeSol, 1.0);
    }
    return { sizeSol, note };
  }

  public briefAfterTrade(pnlSol: number, wasRug: boolean, token?: string): string {
    const m = this.brain.performance_metrics;
    const wr = (m.win_rate * 100).toFixed(0);
    this.logAssistance({
      kind: 'trade',
      verdict: wasRug ? 'RUG' : pnlSol > 0 ? 'WIN' : 'LOSS',
      note: wasRug ? 'blacklist' : pnlSol > 0 ? 'ajuste pesos win' : 'sube derisk',
      token,
      pnlSol,
    }, true);
    if (wasRug) {
      return `🧠 <b>HELIOS</b> — rug memorizado en JSON. Blacklist actualizada. WR ${wr}% · ${m.total_trades} trades.`;
    }
    const tone = pnlSol > 0 ? 'ajuste de pesos (win)' : 'sube sensibilidad de riesgo (loss)';
    return (
      `🧠 <b>HELIOS</b> — ${tone}\n` +
      `• Cerebro JSON: ${m.total_trades} trades · WR ${wr}% · PnL medio ${m.average_pnl_sol >= 0 ? '+' : ''}${m.average_pnl_sol.toFixed(3)} SOL`
    );
  }

  public statusReport(): string {
    const m = this.brain.performance_metrics;
    const w = this.weights();
    const deployers = Object.keys(this.brain.analysis_memory.deployers).length;
    const bl = this.brain.cabal_patterns.blacklisted_funding_wallets.length;
    const last = this.brain.assistance?.last_verdict;
    const lastLine = last
      ? `\n• Último JSON: ${last.verdict} (${last.kind}) ${last.note}`
      : '\n• Último JSON: —';
    return (
      `🧠 <b>HELIOS CEREBRO</b> v${this.brain.version}\n\n` +
      `• Trades: ${m.total_trades} · WR ${(m.win_rate * 100).toFixed(0)}% · PnL medio ${m.average_pnl_sol >= 0 ? '+' : ''}${m.average_pnl_sol.toFixed(3)} SOL\n` +
      `• Deployers en memoria: ${deployers} · Blacklist: ${bl}\n` +
      `• Pesos: pool≥${w.min_pool_sol_threshold} SOL · buy≥${w.ideal_buy_ratio} · burst ${w.log_burst_buys} logs / ${w.volume_burst_sol} SOL\n` +
      `• Skip: serial ${w.serial_deploys_per_2h}/${w.serial_window_hours}h · rejects≥${w.skip_after_rejects}` +
      `• Política: JSON-first (API solo si no hay memoria)` +
      lastLine +
      `\n• Archivo: <code>helios_brain.json</code>`
    );
  }

  public isBlacklisted(address: string): boolean {
    return this.brain.cabal_patterns.blacklisted_funding_wallets.includes(address);
  }

  public isSerialCabal(deployer: string): boolean {
    const mem = this.brain.analysis_memory.deployers[deployer];
    if (!mem) return false;
    this.touchWindow(mem);
    return mem.windowSeen >= this.weights().serial_deploys_per_2h;
  }

  /**
   * Paso 1: bloquea farming / bundling / granjas según memoria JSON de Helios.
   */
  public shouldSkipAnalysis(deployer: string): { skip: boolean; reason: string } | null {
    if (!deployer) return null;
    let reason: string | null = null;
    if (this.isBlacklisted(deployer)) {
      reason = 'HELIOS_SKIP: deployer en blacklist (rug confirmado)';
    } else if (this.isSerialCabal(deployer)) {
      reason = `HELIOS_SKIP: serial deployer (${this.weights().serial_deploys_per_2h}+ en ${this.weights().serial_window_hours}h)`;
    } else {
      const mem = this.brain.analysis_memory.deployers[deployer];
      if (mem && mem.rejects >= this.weights().skip_after_rejects) {
        reason = `HELIOS_SKIP: ${mem.rejects} rejects (granja/bots)`;
      }
    }
    if (!reason) return null;
    this.logAssistance({ kind: 'skip', verdict: 'SKIP', note: reason, deployer });
    return { skip: true, reason };
  }

  public noteSeen(deployer: string): void {
    if (!deployer) return;
    const mem = this.ensureDeployer(deployer);
    mem.seen++;
    mem.lastTs = Date.now();
    this.touchWindow(mem);
    mem.windowSeen++;
    this.pruneDeployers();
    this.scheduleSave();
  }

  public noteReject(deployer: string, reason: string): void {
    if (!deployer) return;
    const mem = this.ensureDeployer(deployer);
    mem.rejects++;
    mem.lastReason = reason.slice(0, 120);
    mem.lastTs = Date.now();
    this.scheduleSave();
  }

  public noteWindowOutcome(deployer: string, passed: boolean, reason?: string, token?: string): void {
    if (!deployer) return;
    if (!passed && reason) {
      this.noteReject(deployer, `radar: ${reason}`);
      this.logAssistance({
        kind: 'radar_reject',
        verdict: 'ABORT',
        note: reason.slice(0, 120),
        deployer,
        token,
      });
    }
  }

  public updateAfterTrade(
    pnlSol: number,
    observationWindowTimeMs: number,
    buyRatio: number,
    wasRug: boolean,
    devAddress?: string
  ): void {
    this.brain.performance_metrics.total_trades++;
    const total = this.brain.performance_metrics.total_trades;
    const isWin = pnlSol > 0;

    const prevWins = (total - 1) * this.brain.performance_metrics.win_rate;
    this.brain.performance_metrics.win_rate = (prevWins + (isWin ? 1 : 0)) / total;

    const prevAvgPnl = this.brain.performance_metrics.average_pnl_sol;
    this.brain.performance_metrics.average_pnl_sol =
      prevAvgPnl + (pnlSol - prevAvgPnl) / total;

    if (wasRug && devAddress && !this.isBlacklisted(devAddress)) {
      this.brain.cabal_patterns.blacklisted_funding_wallets.push(devAddress);
      console.log(`[HELIOS_BRAIN] Dev ${devAddress} añadido a la Blacklist.`);
    }

    const w = this.brain.learned_weights;
    if (isWin && observationWindowTimeMs > 0 && observationWindowTimeMs <= 240_000) {
      w.min_observation_window_ms = Math.min(
        30_000,
        Math.round(w.min_observation_window_ms * 0.8 + observationWindowTimeMs * 0.2)
      );
    }

    if (isWin) {
      w.ideal_buy_ratio = Number((w.ideal_buy_ratio * 0.9 + buyRatio * 0.1).toFixed(2));
    } else {
      w.derisk_sensitivity = Math.min(
        0.5,
        Number((w.derisk_sensitivity + 0.02).toFixed(2))
      );
    }

    this.saveBrain();
  }

  private ensureToken(address: string): TokenMemory {
    const map = this.brain.analysis_memory.tokens;
    if (!map[address]) {
      map[address] = { lastTs: Date.now() };
    }
    map[address].lastTs = Date.now();
    this.pruneTokens();
    return map[address];
  }

  private pruneTokens(): void {
    const map = this.brain.analysis_memory.tokens;
    const keys = Object.keys(map);
    if (keys.length <= MAX_TOKENS) return;
    keys
      .sort((a, b) => map[a].lastTs - map[b].lastTs)
      .slice(0, keys.length - MAX_TOKENS + 50)
      .forEach((k) => delete map[k]);
  }

  private ensureDeployer(address: string): DeployerMemory {
    const map = this.brain.analysis_memory.deployers;
    if (!map[address]) {
      const now = Date.now();
      map[address] = {
        seen: 0,
        rejects: 0,
        lastReason: '',
        lastTs: now,
        windowStart: now,
        windowSeen: 0,
      };
    }
    return map[address];
  }

  private serialWindowMs(): number {
    return this.weights().serial_window_hours * 3600 * 1000;
  }

  private touchWindow(mem: DeployerMemory): void {
    const now = Date.now();
    if (now - mem.windowStart > this.serialWindowMs()) {
      mem.windowStart = now;
      mem.windowSeen = 0;
    }
  }

  private pruneDeployers(): void {
    const map = this.brain.analysis_memory.deployers;
    const keys = Object.keys(map);
    if (keys.length <= MAX_DEPLOYERS) return;
    keys
      .sort((a, b) => map[a].lastTs - map[b].lastTs)
      .slice(0, keys.length - MAX_DEPLOYERS + 50)
      .forEach((k) => delete map[k]);
  }
}
