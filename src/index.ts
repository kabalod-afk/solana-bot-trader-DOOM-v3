import dotenv from 'dotenv';
dotenv.config();

import { Connection, PublicKey } from '@solana/web3.js';
import { HeliosEngine } from './core/HeliosEngine';
import { MemoryScheduler } from './core/MemoryScheduler';
import { BlockZeroScanner } from './blockchain/BlockZeroScanner';
import { WindowObserver } from './blockchain/WindowObserver';
import { JitoExecution } from './blockchain/JitoExecution';
import { VaultManager } from './strategy/VaultManager';
import { TelegramService } from './services/TelegramService';
import { TradeEngine } from './strategy/TradeEngine';
import {
  NewPoolEvent,
  PoolListener,
  redactWssUrl,
  normalizeHeliusWssUrl,
} from './blockchain/PoolListener';
import { PhantomLaunchesFeed } from './blockchain/PhantomLaunchesFeed';
import { parseLaunchColumns } from './blockchain/phantomLaunches';
import { fetchRealPoolTick, rememberPoolSupply, PoolTickOpts } from './blockchain/poolTick';
import { PoolLogMetrics, poolLogMentions } from './blockchain/poolLogMetrics';
import { loadWalletA } from './core/loadWalletA';
import { loadMomentumConfig } from './core/momentumConfig';
import { getCachedSolPrice, refreshSolPrice } from './core/solPriceCache';
import { isLiveTrading } from './core/jupiter';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Falta variable de entorno: ${key}. Copia .env.example a .env y completa los valores.`
    );
  }
  return value;
}

interface ActivePosition {
  engine: TradeEngine;
  token: string;
  pool: string;
  deployer: string;
  interval: ReturnType<typeof setInterval>;
  tickLock: boolean;
  tickOpts?: PoolTickOpts;
  logMetrics: PoolLogMetrics;
  logUnsubs: Array<() => void>;
  fallbackBuyRatio: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function bootstrap(): Promise<void> {
  console.log('🚀 INICIANDO MOTOR DOOM v3 EN MAINNET...');

  const rpcUrl = requireEnv('SOLANA_RPC_URL');
  const wssUrl = normalizeHeliusWssUrl(requireEnv('SOLANA_WSS_URL'));
  const walletAPubkeyEnv = requireEnv('WALLETA_PUBKEY');
  const walletBPubkey = new PublicKey(requireEnv('WALLETB_PUBKEY'));
  const telegramToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const telegramChatId = requireEnv('TELEGRAM_CHAT_ID');
  const jitoUrl = process.env.JITO_ENGINE_URL;
  const liveTrading = isLiveTrading();

  console.log(`RPC:  ${rpcUrl.replace(/api-key=[^&\s]+/gi, 'api-key=***')}`);
  console.log(`WSS:  ${redactWssUrl(wssUrl)}`);
  if (!/api-key=/i.test(wssUrl)) {
    console.warn('⚠️ SOLANA_WSS_URL sin api-key= — Helius suele exigirla en el query string.');
  }

  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  });

  try {
    const health = await connection.getSlot('processed');
    console.log(`RPC health OK — slot ${health}`);
  } catch (e) {
    console.error(
      `[RPC_HEALTH] HTTP falló: ${e instanceof Error ? e.message : e}. Revisa SOLANA_RPC_URL / API key.`
    );
  }

  const loaded = loadWalletA();
  const walletA = loaded.keypair;
  const derivedA = walletA.publicKey.toBase58();
  if (derivedA !== walletAPubkeyEnv) {
    throw new Error(
      `WALLETA_PUBKEY no coincide con la keypair cargada.\n` +
        `  .env:     ${walletAPubkeyEnv}\n` +
        `  derivada: ${derivedA}`
    );
  }
  if (derivedA === walletBPubkey.toBase58()) {
    throw new Error('Cartera A y Cartera B no pueden ser la misma dirección.');
  }

  const walletBStr = walletBPubkey.toBase58();
  console.log(
    `🔑 Cartera A (trabajo): ${derivedA} (fuente: ${loaded.source}${loaded.path ? ` ${loaded.path}` : ''})`
  );
  console.log(`🏦 Cartera B (vault):    ${walletBStr}`);

  const helios = new HeliosEngine();
  const scheduler = new MemoryScheduler();
  const scanner = new BlockZeroScanner(connection, helios, walletA);
  const observer = new WindowObserver(connection, helios);
  const jito = new JitoExecution(connection, walletA, jitoUrl);
  const vault = new VaultManager(connection, walletA, walletBPubkey);
  const telegram = new TelegramService(telegramToken, telegramChatId);
  telegram.registerHeliosStatusHandler(() => helios.statusReport());

  const activeTokensSet = new Set<string>();
  const inflightTokens = new Set<string>();
  const activeEnginesList: ActivePosition[] = [];
  let opCounter = 1;
  await refreshSolPrice(true);
  let solPriceUSD = getCachedSolPrice();
  setInterval(() => {
    void refreshSolPrice().then(() => {
      solPriceUSD = getCachedSolPrice();
    });
  }, 5 * 60_000);

  telegram.registerForceCloseHandler(async () => {
    const snapshot = [...activeEnginesList];
    for (const item of snapshot) {
      item.engine.requestForceClose();
      const tick = await fetchRealPoolTick(
        connection,
        item.pool,
        item.token,
        solPriceUSD,
        item.tickOpts
      ).catch(() => null);
      const live = item.logMetrics.snapshot(item.fallbackBuyRatio);
      await item.engine.processTick({
        currentPriceUSD: tick?.currentPriceUSD || 0,
        mcUSD: tick?.mcUSD || 0,
        buyVolumeRatio: live.buyVolumeRatio,
        consecutiveSells: live.consecutiveSells,
        txPerMinute: 0,
        isDevSelling: live.isDevSelling,
        solPriceUSD,
      });
      clearInterval(item.interval);
      for (const unsub of item.logUnsubs) unsub();
      activeTokensSet.delete(item.token);
      scheduler.releaseThread();
    }
    activeEnginesList.length = 0;
  });

  const momentum = loadMomentumConfig(helios.brain.learned_weights.min_pool_sol_threshold);
  const candidateSource = (process.env.CANDIDATE_SOURCE || 'phantom_launches').toLowerCase();
  const watchPhantom =
    candidateSource === 'phantom_launches' || candidateSource === 'both';
  const watchCreates =
    candidateSource === 'helius_creates' || candidateSource === 'both';
  const phantomColumns = parseLaunchColumns(process.env.PHANTOM_LAUNCH_COLUMNS);
  const phantomPollMs = Number(process.env.PHANTOM_LAUNCH_POLL_MS || 4000);
  const phantomSeedExisting = process.env.PHANTOM_SEED_EXISTING === 'true';
  // Por defecto: Launches de Phantom = admisión ligera → radar directo.
  const phantomFastLane = process.env.PHANTOM_FAST_LANE !== 'false';

  console.log(
    `Helios ${helios.brain.version} | JSON-first=${helios.jsonOverApi()} | LIVE_TRADING=${liveTrading} | SOL≈$${solPriceUSD}`
  );
  console.log(
    `Fuente: ${candidateSource}${watchPhantom ? ` (Phantom ${phantomColumns.join(',')}${phantomFastLane ? ', fast-lane' : ''})` : ''}${watchCreates ? ' + Helius creates' : ''}`
  );
  console.log(
    `B0: pool≥${momentum.minPoolSol} SOL | MC $${momentum.minMcUSD}-$${momentum.maxMcUSD}`
  );
  console.log(
    `Radar: ≥${momentum.minTxCount} txs + breakout | máx ${Math.round(momentum.radarMaxMs / 1000)}s`
  );
  console.log(
    `Salida: TP +${momentum.takeProfitPct}% | trailing ${momentum.trailingStopPct}% ATH | max pos ${Math.round(momentum.positionMaxMs / 1000)}s`
  );

  const flushHelios = () => {
    try {
      helios.saveBrain();
    } catch {
      /* ignore */
    }
  };
  process.on('SIGINT', () => {
    flushHelios();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    flushHelios();
    process.exit(0);
  });
  if (!liveTrading) {
    console.log(
      watchPhantom
        ? `🧪 DRY-RUN: Phantom Launches${phantomFastLane ? ' (fast-lane)' : ''} → B0 ligero → radar 4 min; sin compras.`
        : '🧪 DRY-RUN: Helius → B0 (≥1 SOL, MC $400–$250k) → radar 4 min; sin compras.'
    );
  }

  await telegram.sendText(
    `🟢 *DOOM v3 ONLINE*\n• Modo: ${liveTrading ? 'LIVE' : 'DRY-RUN'}\n• Fuente: ${
      watchPhantom
        ? `Phantom Launches (${phantomColumns.join(', ')}${phantomFastLane ? ', fast-lane' : ''})`
        : 'Helius creates'
    }\n• Fases: ${
      watchPhantom && phantomFastLane
        ? 'Launches → B0 ligero → radar → TP/trailing'
        : `B0 → radar 4 min → TP +${momentum.takeProfitPct}% / trailing ${momentum.trailingStopPct}%`
    }\n• Cartera A (trabajo): \`${derivedA}\`\n• Cartera B (vault): \`${walletBStr}\``
  );
  await telegram.notifyHelios(
    `🧠 <b>HELIOS ONLINE</b> — asistencia activa\n` +
      `• Candidatos: ${
        watchPhantom
          ? 'columna Launches de Phantom (prefiltrada)'
          : 'creates Helius Pump/Raydium'
      }\n` +
      (watchPhantom && phantomFastLane
        ? `• Fast-lane: sin serial/bundlers/cabal/Jupiter — directo a radar\n`
        : `• B0 + radar 4 min + TP/trailing\n`) +
      `• Memoria JSON manda sobre Jupiter/cabal API\n` +
      `• Escribe <code>helios</code> para ver el cerebro`
  );

  const processBlockZeroChain = async (event: NewPoolEvent): Promise<boolean> => {
    const token = event.tokenAddress;
    const fromPhantom = !!event.phantom;
    const fastLane = fromPhantom && phantomFastLane;

    if (!event.poolAddress || !event.tokenAddress) return true;
    if (telegram.isPaused()) return false;
    if (activeTokensSet.has(token) || inflightTokens.has(token)) return false;
    if (!scheduler.canSpawnThread()) return false;

    if (fastLane) {
      // Phantom ya prefiltró: solo blacklist si conocemos deployer.
      if (event.deployerAddress && helios.isBlacklisted(event.deployerAddress)) {
        console.log(`[HELIOS_SKIP] ${token}: deployer en blacklist (rug confirmado)`);
        void telegram.notifyHelios(
          `🧠 <b>HELIOS_SKIP</b>\n<code>${token.slice(0, 8)}…</code>\ndeployer en blacklist`
        );
        return true;
      }
      console.log(
        `[PHANTOM_FAST] ${event.phantom?.symbol || token.slice(0, 8)} → B0 ligero → radar ` +
          `(mc≈$${event.phantom?.marketCap?.toFixed(0) ?? '?'})`
      );
    } else {
      const heliosSkip = helios.shouldSkipAnalysis(event.deployerAddress);
      if (heliosSkip?.skip) {
        console.log(`[HELIOS_SKIP] ${token}: ${heliosSkip.reason}`);
        if (/blacklist|rug/i.test(heliosSkip.reason)) {
          void telegram.notifyHelios(
            `🧠 <b>HELIOS_SKIP</b>\n<code>${token.slice(0, 8)}…</code>\n${heliosSkip.reason}`
          );
        }
        return true;
      }

      if (event.phantom) {
        const phantomSkip = helios.shouldSkipPhantomMetrics({
          bundlersHolding: event.phantom.bundlersHolding,
          snipersHolding: event.phantom.snipersHolding,
          devHolding: event.phantom.devHolding,
          token,
        });
        if (phantomSkip?.skip) {
          console.log(`[HELIOS_SKIP] ${token}: ${phantomSkip.reason}`);
          return true;
        }
      }
    }

    if (event.deployerAddress) helios.noteSeen(event.deployerAddress);

    inflightTokens.add(token);

    try {
      const b0Result = await scanner.auditToken(
        event.tokenAddress,
        event.poolAddress,
        event.deployerAddress,
        {
          lpMintAddress: event.lpMintAddress,
          source: event.source,
          coinVault: event.coinVault,
          pcVault: event.pcVault,
          associatedBondingCurve: event.associatedBondingCurve,
          phantomClean: !!event.phantom,
        }
      );

      if (b0Result.resolvedDeployer && !event.deployerAddress) {
        event.deployerAddress = b0Result.resolvedDeployer;
        helios.noteSeen(event.deployerAddress);
      }
      if (b0Result.resolvedAssociatedBondingCurve) {
        event.associatedBondingCurve = b0Result.resolvedAssociatedBondingCurve;
      }

      if (!b0Result.passed) {
        console.log(`[B0_REJECT] ${token}: ${b0Result.reason}`);
        helios.noteReject(event.deployerAddress, b0Result.reason ?? 'B0 reject');
        void telegram.notifyBlockZeroReject(token, b0Result.reason ?? '');
        inflightTokens.delete(token);
        return true;
      }

      void continueAfterBlockZero(event, b0Result);
      return true;
    } catch (err) {
      console.error(`[B0_CHAIN_ERROR] ${token}:`, err);
      inflightTokens.delete(token);
      return true;
    }
  };

  const poolListener = new PoolListener(
    wssUrl,
    connection,
    (event: NewPoolEvent) => processBlockZeroChain(event),
    () => scheduler.tryAcquireInflight(),
    () => scheduler.releaseInflight(),
    watchCreates
  );
  observer.bindListener(poolListener);

  let phantomFeed: PhantomLaunchesFeed | null = null;
  if (watchPhantom) {
    phantomFeed = new PhantomLaunchesFeed({
      onToken: (event) => processBlockZeroChain(event),
      columns: phantomColumns,
      pollMs: Number.isFinite(phantomPollMs) ? phantomPollMs : 4_000,
      seedExisting: phantomSeedExisting,
    });
  }

  const continueAfterBlockZero = async (
    event: NewPoolEvent,
    b0Result: { initialMcUSD: number; initialPoolSol: number; totalSupply?: number }
  ): Promise<void> => {
    const token = event.tokenAddress;

    try {
      if (!scheduler.canSpawnThread()) {
        inflightTokens.delete(token);
        return;
      }

      const botInstanceId = scheduler.registerThread();
      activeTokensSet.add(token);

      telegram.notifyAnalysisPassed(
        botInstanceId,
        token,
        b0Result.initialMcUSD,
        b0Result.initialPoolSol,
        helios.briefAdmission(
          event.deployerAddress,
          b0Result.initialPoolSol,
          b0Result.initialMcUSD,
          token
        )
      );

      const extraMentions = [
        event.tokenAddress,
        event.associatedBondingCurve,
        event.coinVault,
        event.pcVault,
      ].filter((x): x is string => !!x);

      const obsResult = await observer.observeWindow(
        event.poolAddress,
        b0Result.initialPoolSol,
        event.deployerAddress,
        b0Result.initialMcUSD,
        {
          solAccount:
            event.source === 'raydium' && event.pcVault
              ? event.pcVault
              : event.poolAddress,
          isTokenAccount: event.source === 'raydium' && !!event.pcVault,
        },
        extraMentions
      );

      if (!obsResult.passed) {
        console.log(`[RADAR_REJECT] ${token}: ${obsResult.reason}`);
        helios.noteWindowOutcome(event.deployerAddress, false, obsResult.reason, token);
        activeTokensSet.delete(token);
        scheduler.releaseThread();
        return;
      }

      const advice = helios.recommendEntry(
        b0Result.initialPoolSol,
        obsResult.buyVolumeRatio,
        event.deployerAddress
      );
      const entrySizeSol = advice.sizeSol;

      if (obsResult.trigger) {
        console.log(
          `[RADAR_PASS] ${token}: trigger=${obsResult.trigger} t=${obsResult.observationTimeMs}ms txs=${obsResult.txCount} entry=${entrySizeSol} (${advice.note})`
        );
      }
      void telegram.notifyHelios(
        helios.briefBreakout(
          obsResult.trigger ?? 'organic_impulse',
          obsResult.txCount,
          obsResult.buyVolumeRatio,
          obsResult.observationTimeMs,
          {
            token,
            deployer: event.deployerAddress,
            entrySol: entrySizeSol,
            note: advice.note,
          }
        ) + `\n• Tamaño: <b>${entrySizeSol.toFixed(2)} SOL</b> (${advice.note})`
      );

      if (!liveTrading) {
        await telegram.sendText(
          `🤖 *[${botInstanceId}] DRY-RUN OK:* \`${token.slice(0, 8)}…\` pasó B0+radar (${obsResult.observationTimeMs}ms, ${obsResult.txCount} txs, buy=${(obsResult.buyVolumeRatio * 100).toFixed(0)}%). Helios pedía ${entrySizeSol} SOL. Sin compra.`
        );
        activeTokensSet.delete(token);
        scheduler.releaseThread();
        return;
      }

      const balanceLamports = await connection.getBalance(walletA.publicKey);
      if (balanceLamports / 1e9 < entrySizeSol + 0.05) {
        console.log(
          `[CAPITAL] ${botInstanceId}: insuficiente para ${entrySizeSol} SOL + gas`
        );
        activeTokensSet.delete(token);
        scheduler.releaseThread();
        return;
      }

      const buy = await jito.executeBuy(token, entrySizeSol);
      if (!buy.ok) {
        activeTokensSet.delete(token);
        scheduler.releaseThread();
        return;
      }

      if (b0Result.totalSupply) {
        rememberPoolSupply(event.poolAddress, b0Result.totalSupply);
      }
      const tickOpts: PoolTickOpts = {
        coinVault: event.coinVault,
        pcVault: event.pcVault,
        associatedBondingCurve: event.associatedBondingCurve,
        totalSupplyHint: b0Result.totalSupply,
      };

      let entryTick = await fetchRealPoolTick(
        connection,
        event.poolAddress,
        token,
        solPriceUSD,
        tickOpts
      );
      for (let i = 0; i < 4 && entryTick.currentPriceUSD <= 0; i++) {
        await sleep(800);
        entryTick = await fetchRealPoolTick(
          connection,
          event.poolAddress,
          token,
          solPriceUSD,
          tickOpts
        );
      }
      if (entryTick.currentPriceUSD <= 0) {
        console.error(`[ENTRY_ABORT] ${token}: precio on-chain 0 tras compra — evacuando`);
        await jito.executeFullSell(token);
        activeTokensSet.delete(token);
        scheduler.releaseThread();
        return;
      }

      const entryPrice = entryTick.currentPriceUSD;
      const opNum = opCounter++;

      telegram.notifyStart(botInstanceId, opNum, token, entrySizeSol, entryPrice);
      void telegram.notifyBuyExecuted(
        token,
        obsResult.currentMcUsd ?? entryTick.mcUSD,
        obsResult.txCount,
        entrySizeSol,
        buy.signature
      );

      const engine = new TradeEngine(
        botInstanceId,
        token,
        event.deployerAddress,
        obsResult.observationTimeMs,
        entrySizeSol,
        jito,
        vault,
        telegram,
        helios
      );

      const logMetrics = new PoolLogMetrics();
      const logMentionAddrs = poolLogMentions(event.poolAddress, token, [
        event.associatedBondingCurve,
        event.coinVault,
        event.pcVault,
      ].filter((x): x is string => !!x));
      const logUnsubs = logMentionAddrs.map((addr) =>
        poolListener.subscribePoolLogs(addr, (logs) => {
          logMetrics.consume(logs, event.deployerAddress);
        })
      );

      const position: ActivePosition = {
        engine,
        token,
        pool: event.poolAddress,
        deployer: event.deployerAddress,
        interval: null as unknown as ReturnType<typeof setInterval>,
        tickLock: false,
        tickOpts,
        logMetrics,
        logUnsubs,
        fallbackBuyRatio: obsResult.buyVolumeRatio,
      };

      position.interval = setInterval(() => {
        void (async () => {
          if (position.tickLock) return;
          position.tickLock = true;
          try {
            const tick = await fetchRealPoolTick(
              connection,
              event.poolAddress,
              token,
              solPriceUSD,
              tickOpts
            );
            if (tick.currentPriceUSD <= 0) return;

            const live = logMetrics.snapshot(obsResult.buyVolumeRatio);
            const status = await engine.processTick({
              currentPriceUSD: tick.currentPriceUSD,
              mcUSD: tick.mcUSD,
              buyVolumeRatio: live.buyVolumeRatio,
              consecutiveSells: live.consecutiveSells,
              txPerMinute: 15,
              isDevSelling: live.isDevSelling,
              solPriceUSD,
            });

            if (status === 'CLOSED') {
              clearInterval(position.interval);
              for (const unsub of logUnsubs) unsub();
              activeTokensSet.delete(token);
              scheduler.releaseThread();
              const idx = activeEnginesList.findIndex((e) => e.token === token);
              if (idx !== -1) activeEnginesList.splice(idx, 1);
            }
          } catch (e) {
            console.error('[TICK_ERROR]', e);
          } finally {
            position.tickLock = false;
          }
        })();
      }, 4_000);

      activeEnginesList.push(position);
    } catch (err) {
      console.error(`[ASYNC_SPAWN_ERROR] ${token}:`, err);
      if (activeTokensSet.has(token)) {
        activeTokensSet.delete(token);
        scheduler.releaseThread();
      }
    } finally {
      inflightTokens.delete(token);
    }
  };

  poolListener.start();
  phantomFeed?.start();

  console.log(
    watchPhantom
      ? '📡 Phantom Launches + WSS radar — B0 → 4 min → TP/trailing; ticks 4s.'
      : '📡 PoolListener activo — B0 → radar 4 min (logs WSS) → TP/trailing; ticks 4s.'
  );
}

bootstrap().catch((err) => {
  console.error('[DOOM_FATAL]', err);
  process.exit(1);
});
