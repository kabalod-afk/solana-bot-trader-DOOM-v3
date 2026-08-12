import WebSocket from 'ws';
import {
  Connection,
  PublicKey,
  VersionedMessage,
  Message,
} from '@solana/web3.js';

export const RAYDIUM_LIQUIDITY_PROGRAM_V4 =
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

export const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const PUMP_FEE_RECIPIENT = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';

export interface PhantomLaunchHint {
  column: 'new' | 'migrating' | 'migrated';
  name: string;
  symbol: string;
  platform: string;
  marketCap: number;
  liquidity: number;
  uniqueHolders: number;
  bundlersHolding: number;
  snipersHolding: number;
  devHolding: number;
  top10Holding: number;
  buysCount: number;
  sellsCount: number;
  volume: number;
  bondingCurvePercentage: number;
  createdAtMs: number;
}

export interface NewPoolEvent {
  tokenAddress: string;
  poolAddress: string;
  deployerAddress: string;
  lpMintAddress?: string;
  coinVault?: string;
  pcVault?: string;
  associatedBondingCurve?: string;
  signature: string;
  timestamp: number;
  source: 'raydium' | 'pump';
  /** Presente si el candidato vino de Phantom Terminal → Launches (no del firehose Helius). */
  phantom?: PhantomLaunchHint;
}

export type PoolLogHandler = (logs: string[], signature: string) => void;

type LogsNotification = {
  jsonrpc?: string;
  id?: number;
  result?: number | { subscription?: number };
  method?: string;
  params?: {
    subscription?: number;
    result?: {
      value?: {
        signature?: string;
        err?: unknown;
        logs?: string[];
      };
    };
  };
};

export function parseRaydiumInitialize2(
  ixAccounts: PublicKey[],
  signature: string
): NewPoolEvent | null {
  if (ixAccounts.length < 18) return null;

  const poolAddress = ixAccounts[4].toBase58();
  const lpMintAddress = ixAccounts[7].toBase58();
  const mintA = ixAccounts[8].toBase58();
  const mintB = ixAccounts[9].toBase58();
  const deployerAddress = ixAccounts[17].toBase58();
  const coinVault = (ixAccounts[10] ?? ixAccounts[5])?.toBase58();
  const pcVault = (ixAccounts[11] ?? ixAccounts[6])?.toBase58();

  const tokenAddress = mintA === WSOL_MINT ? mintB : mintA;
  if (tokenAddress === WSOL_MINT) return null;

  const tokenIsMintA = mintA !== WSOL_MINT;
  const resolvedCoinVault = tokenIsMintA ? coinVault : pcVault;
  const resolvedPcVault = tokenIsMintA ? pcVault : coinVault;

  return {
    tokenAddress,
    poolAddress,
    deployerAddress,
    lpMintAddress,
    coinVault: resolvedCoinVault,
    pcVault: resolvedPcVault,
    signature,
    timestamp: Date.now(),
    source: 'raydium',
  };
}

export function parsePumpFunCreate(
  ixAccounts: PublicKey[],
  signature: string
): NewPoolEvent | null {
  if (ixAccounts.length < 8) return null;

  const tokenAddress = ixAccounts[0].toBase58();
  const poolAddress = ixAccounts[2].toBase58();
  const associatedBondingCurve = ixAccounts[3]?.toBase58();
  const deployerAddress = ixAccounts[7].toBase58();

  if (tokenAddress === WSOL_MINT || poolAddress === WSOL_MINT) return null;
  if (tokenAddress === PUMP_FEE_RECIPIENT || poolAddress === PUMP_FEE_RECIPIENT) return null;
  if (tokenAddress === poolAddress) return null;
  if (tokenAddress === deployerAddress) return null;

  return {
    tokenAddress,
    poolAddress,
    deployerAddress,
    associatedBondingCurve,
    signature,
    timestamp: Date.now(),
    source: 'pump',
  };
}

export function extractAccountKeysFromTx(tx: {
  transaction: { message: Message | VersionedMessage };
  meta?: {
    loadedAddresses?: { writable: PublicKey[]; readonly: PublicKey[] };
  } | null;
}): PublicKey[] {
  const message = tx.transaction.message;
  const loaded = tx.meta?.loadedAddresses;

  if ('getAccountKeys' in message && typeof message.getAccountKeys === 'function') {
    try {
      const keys = message.getAccountKeys(
        loaded ? { accountKeysFromLookups: loaded } : undefined
      );
      const out: PublicKey[] = [...keys.staticAccountKeys];
      if (loaded) {
        out.push(...(loaded.writable ?? []), ...(loaded.readonly ?? []));
      } else if (keys.accountKeysFromLookups) {
        out.push(
          ...(keys.accountKeysFromLookups.writable ?? []),
          ...(keys.accountKeysFromLookups.readonly ?? [])
        );
      }
      const seen = new Set<string>();
      return out.filter((k) => {
        const s = k.toBase58();
        if (seen.has(s)) return false;
        seen.add(s);
        return true;
      });
    } catch {
      /* fall through */
    }
  }

  if ('accountKeys' in message) {
    return (message as Message).accountKeys;
  }
  return [];
}

export function normalizeHeliusWssUrl(raw: string): string {
  let u = raw.trim();
  if (u.startsWith('https://')) u = `wss://${u.slice('https://'.length)}`;
  if (u.startsWith('http://')) u = `ws://${u.slice('http://'.length)}`;
  return u;
}

export function redactWssUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has('api-key')) u.searchParams.set('api-key', '***');
    return `${u.protocol}//${u.host}${u.pathname}${u.search}`;
  } catch {
    return url.replace(/api-key=[^&\s]+/gi, 'api-key=***');
  }
}

export function buildWssEndpointList(primary: string): string[] {
  const list = [primary];
  try {
    const u = new URL(primary);
    const key = u.searchParams.get('api-key') || '';
    if (key && !u.host.startsWith('beta.')) {
      list.push(`wss://beta.helius-rpc.com/?api-key=${key}`);
    }
  } catch {
    /* keep primary only */
  }
  return list;
}

/**
 * Un solo WSS Helius:
 *  - logsSubscribe Raydium/Pump → creates (opcional; off si la fuente es Phantom Launches)
 *  - logsSubscribe por pool/mint durante el radar de incubación (máx 4 min)
 */
export class PoolListener {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private connecting = false;
  private seenSignatures = new Set<string>();
  private reqId = 1;
  private reconnectAttempt = 0;
  private lastErrorWas522 = false;
  private endpointIndex = 0;
  private readonly endpoints: string[];
  private readonly watchCreates: boolean;

  private programSubIds = new Set<number>();
  private pendingProgramReqs = new Set<number>();
  private pendingPoolReqs = new Map<number, string>();
  private poolSubByRpcId = new Map<number, string>();
  private poolRpcIdByAddress = new Map<string, number>();
  private poolHandlers = new Map<string, Set<PoolLogHandler>>();
  private pendingCreates: Array<{ signature: string; kind: 'raydium' | 'pump' }> = [];
  private drainingPending = false;

  constructor(
    wssUrl: string,
    private connection: Connection,
    private onNewPoolCallback: (event: NewPoolEvent) => void | boolean | Promise<void | boolean>,
    private tryAcquireRpc?: () => boolean,
    private releaseRpc?: () => void,
    watchCreates = true
  ) {
    this.endpoints = buildWssEndpointList(normalizeHeliusWssUrl(wssUrl));
    this.watchCreates = watchCreates;
  }

  private currentUrl(): string {
    return this.endpoints[this.endpointIndex % this.endpoints.length];
  }

  public start(): void {
    this.stopped = false;
    if (this.connecting) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearPing();
    this.resetSubMaps();

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }

    const url = this.currentUrl();
    this.connecting = true;
    console.log(`📡 [HELIUS_WS] Conectando a ${redactWssUrl(url)} ...`);
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.connecting = false;
      this.reconnectAttempt = 0;
      this.lastErrorWas522 = false;
      console.log(
        `📡 [HELIUS_WS] Conectado (${redactWssUrl(url)}) — ${
          this.watchCreates ? 'creates + logs radar' : 'solo logs radar (sin firehose de creates)'
        }.`
      );
      if (this.watchCreates) this.subscribeToProgramLogs();
      this.resubscribePoolWatches();
      this.clearPing();
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          try {
            this.ws.ping();
          } catch {
            /* ignore */
          }
        }
      }, 45_000);
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      void this.handleIncomingMessage(data.toString());
    });

    this.ws.on('error', (err) => {
      const msg = err.message || String(err);
      this.lastErrorWas522 = /522|cloudflare|timed out/i.test(msg);
      console.error(`❌ [HELIUS_WS_ERROR] ${msg} (${redactWssUrl(url)})`);
    });

    this.ws.on('close', () => {
      this.connecting = false;
      this.clearPing();
      this.ws = null;
      if (this.stopped) return;
      if (this.reconnectTimer) return;
      this.scheduleReconnect();
    });
  }

  /**
   * Suscribe logs de un pool/mint en el mismo WSS (radar de incubación).
   * Devuelve unsubscribe.
   */
  public subscribePoolLogs(address: string, handler: PoolLogHandler): () => void {
    if (!address) return () => undefined;
    let set = this.poolHandlers.get(address);
    if (!set) {
      set = new Set();
      this.poolHandlers.set(address, set);
      this.sendPoolSubscribe(address);
    }
    set.add(handler);
    return () => {
      const handlers = this.poolHandlers.get(address);
      if (!handlers) return;
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.poolHandlers.delete(address);
        this.sendPoolUnsubscribe(address);
      }
    };
  }

  public stop(): void {
    this.stopped = true;
    this.connecting = false;
    this.clearPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.removeAllListeners();
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private resetSubMaps(): void {
    this.programSubIds.clear();
    this.pendingProgramReqs.clear();
    this.pendingPoolReqs.clear();
    this.poolSubByRpcId.clear();
    this.poolRpcIdByAddress.clear();
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 8);
    if (this.lastErrorWas522 && this.reconnectAttempt % 2 === 0 && this.endpoints.length > 1) {
      this.endpointIndex = (this.endpointIndex + 1) % this.endpoints.length;
      console.log(`[HELIUS_WS] Rotando endpoint → ${redactWssUrl(this.currentUrl())}`);
    }
    const base = this.lastErrorWas522 ? 15_000 : 3_000;
    const cap = this.lastErrorWas522 ? 120_000 : 60_000;
    const delayMs = Math.min(cap, base * 2 ** (this.reconnectAttempt - 1));
    console.log(
      `⚠️ [HELIUS_WS] Cerrado. Reconectando en ${Math.round(delayMs / 1000)}s (intento ${this.reconnectAttempt})...`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, delayMs);
  }

  private sendJson(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private subscribeToProgramLogs(): void {
    for (const programId of [RAYDIUM_LIQUIDITY_PROGRAM_V4, PUMP_FUN_PROGRAM]) {
      const id = this.reqId++;
      this.pendingProgramReqs.add(id);
      this.sendJson({
        jsonrpc: '2.0',
        id,
        method: 'logsSubscribe',
        params: [{ mentions: [programId] }, { commitment: 'processed' }],
      });
    }
  }

  private sendPoolSubscribe(address: string): void {
    if (this.poolRpcIdByAddress.has(address)) return;
    const id = this.reqId++;
    this.pendingPoolReqs.set(id, address);
    this.sendJson({
      jsonrpc: '2.0',
      id,
      method: 'logsSubscribe',
      params: [{ mentions: [address] }, { commitment: 'processed' }],
    });
  }

  private sendPoolUnsubscribe(address: string): void {
    const rpcId = this.poolRpcIdByAddress.get(address);
    if (rpcId === undefined) return;
    this.poolRpcIdByAddress.delete(address);
    this.poolSubByRpcId.delete(rpcId);
    this.sendJson({
      jsonrpc: '2.0',
      id: this.reqId++,
      method: 'logsUnsubscribe',
      params: [rpcId],
    });
  }

  private resubscribePoolWatches(): void {
    for (const address of this.poolHandlers.keys()) {
      this.sendPoolSubscribe(address);
    }
  }

  private async handleIncomingMessage(rawMessage: string): Promise<void> {
    try {
      const parsed = JSON.parse(rawMessage) as LogsNotification;

      if (typeof parsed.id === 'number' && typeof parsed.result === 'number') {
        if (this.pendingProgramReqs.has(parsed.id)) {
          this.pendingProgramReqs.delete(parsed.id);
          this.programSubIds.add(parsed.result);
          return;
        }
        const addr = this.pendingPoolReqs.get(parsed.id);
        if (addr) {
          this.pendingPoolReqs.delete(parsed.id);
          this.poolSubByRpcId.set(parsed.result, addr);
          this.poolRpcIdByAddress.set(addr, parsed.result);
          return;
        }
      }

      const value = parsed.params?.result?.value;
      if (!value || value.err || !value.signature) return;

      const logs = value.logs ?? [];
      const signature = value.signature;
      const subId = parsed.params?.subscription;

      if (subId !== undefined && this.poolSubByRpcId.has(subId)) {
        const addr = this.poolSubByRpcId.get(subId)!;
        const handlers = this.poolHandlers.get(addr);
        if (handlers) {
          for (const h of handlers) h(logs, signature);
        }
      }

      const isRaydiumInit = logs.some(
        (l) =>
          l.includes('initialize2') ||
          l.includes('Initialize2') ||
          l.includes('instruction: Initialize2')
      );
      const isPumpCreate = logs.some(
        (l) =>
          l.includes('Instruction: Create') ||
          l.includes('Program log: Instruction: Create')
      );
      if (!this.watchCreates) return;
      if (!isRaydiumInit && !isPumpCreate) return;
      if (this.seenSignatures.has(signature)) return;

      const kind = isRaydiumInit ? 'raydium' : 'pump';
      if (this.tryAcquireRpc && !this.tryAcquireRpc()) {
        if (this.pendingCreates.length < 8) {
          this.pendingCreates.push({ signature, kind });
        }
        return;
      }

      this.rememberSignature(signature);
      await this.processCreate(signature, kind);
    } catch {
      /* heartbeats / JSON basura */
    }
  }

  private rememberSignature(signature: string): void {
    this.seenSignatures.add(signature);
    if (this.seenSignatures.size > 5_000) {
      const first = this.seenSignatures.values().next().value;
      if (first) this.seenSignatures.delete(first);
    }
  }

  private async processCreate(signature: string, kind: 'raydium' | 'pump'): Promise<void> {
    try {
      const event = await this.resolvePoolFromSignature(signature, kind);
      if (!event?.poolAddress || !event.tokenAddress) return;
      console.log(
        `[HELIUS_WS] ${event.source} token=${event.tokenAddress} pool=${event.poolAddress}`
      );
      await this.onNewPoolCallback(event);
    } finally {
      this.releaseRpc?.();
      void this.drainPendingCreates();
    }
  }

  private async drainPendingCreates(): Promise<void> {
    if (this.drainingPending) return;
    this.drainingPending = true;
    try {
      while (this.pendingCreates.length > 0) {
        if (this.tryAcquireRpc && !this.tryAcquireRpc()) break;
        const next = this.pendingCreates.shift();
        if (!next) {
          this.releaseRpc?.();
          break;
        }
        if (this.seenSignatures.has(next.signature)) {
          this.releaseRpc?.();
          continue;
        }
        this.rememberSignature(next.signature);
        await this.processCreate(next.signature, next.kind);
      }
    } finally {
      this.drainingPending = false;
    }
  }

  private async resolvePoolFromSignature(
    signature: string,
    preferred: 'raydium' | 'pump'
  ): Promise<NewPoolEvent | null> {
    const fetchTx = () =>
      this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

    try {
      let tx = await fetchTx();
      if (!tx?.transaction) {
        await new Promise((r) => setTimeout(r, 400));
        tx = await fetchTx();
      }
      if (!tx?.transaction) return null;
      return this.extractEventFromTx(tx, signature, preferred);
    } catch (e) {
      console.error('[HELIUS_WS] resolvePoolFromSignature:', e);
      return null;
    }
  }

  private extractEventFromTx(
    tx: NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>,
    signature: string,
    _preferred: 'raydium' | 'pump'
  ): NewPoolEvent | null {
    const accountKeys = extractAccountKeysFromTx(tx);
    if (accountKeys.length === 0) return null;

    const message = tx.transaction.message;
    const raydiumPk = new PublicKey(RAYDIUM_LIQUIDITY_PROGRAM_V4);
    const pumpPk = new PublicKey(PUMP_FUN_PROGRAM);
    const instructions = this.getCompiledInstructions(message);

    for (const ix of instructions) {
      const programId = accountKeys[ix.programIdIndex];
      if (!programId) continue;

      const ixAccounts = ix.accountKeyIndexes
        .map((i) => accountKeys[i])
        .filter((k): k is PublicKey => !!k);

      if (programId.equals(raydiumPk)) {
        const parsed = parseRaydiumInitialize2(ixAccounts, signature);
        if (parsed) return parsed;
      }

      if (programId.equals(pumpPk) && ixAccounts.length >= 8) {
        const parsed = parsePumpFunCreate(ixAccounts, signature);
        if (parsed) return parsed;
      }
    }
    return null;
  }

  private getCompiledInstructions(
    message: Message | VersionedMessage
  ): Array<{ programIdIndex: number; accountKeyIndexes: number[] }> {
    if ('compiledInstructions' in message) {
      return message.compiledInstructions.map((ix) => ({
        programIdIndex: ix.programIdIndex,
        accountKeyIndexes: [...ix.accountKeyIndexes],
      }));
    }
    if ('instructions' in message) {
      return (message as Message).instructions.map((ix) => ({
        programIdIndex: ix.programIdIndex,
        accountKeyIndexes: [...ix.accounts],
      }));
    }
    return [];
  }
}
