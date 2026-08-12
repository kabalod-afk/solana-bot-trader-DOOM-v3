/** HTML de las 3 alertas de Telegram (arranque / entrada / salida). */

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function dexscreenerUrl(mint: string): string {
  return `https://dexscreener.com/solana/${mint}`;
}

export function photonUrl(mint: string): string {
  return `https://photon-sol.tinyastro.io/en/lp/${mint}`;
}

export function tokenDisplay(
  mint: string,
  symbol?: string,
  name?: string
): { ticker: string; headline: string } {
  const sym = symbol?.trim();
  const nm = name?.trim();
  const ticker = sym || mint.slice(0, 6);
  if (nm && sym) return { ticker, headline: `${nm} / $${sym}` };
  if (nm) return { ticker, headline: nm };
  return { ticker, headline: `$${ticker}` };
}

export interface StatusCheckOpts {
  liveTrading: boolean;
  wssConnected: boolean;
  walletA: string;
  walletB: string;
}

export function formatStatusCheck(opts: StatusCheckOpts): string {
  const mode = opts.liveTrading ? 'LIVE_TRADING=true' : 'LIVE_TRADING=false';
  const wss = opts.wssConnected
    ? 'conectado'
    : 'pendiente / reconectando';
  return (
    `🟢 <b>DOOM v3 — Status Check</b>\n\n` +
    `• <b>Modo:</b> <code>${mode}</code>\n` +
    `• <b>WebSocket Helius:</b> ${wss}\n` +
    `• 🔑 <b>Cartera A</b> (trabajo): <code>${escHtml(opts.walletA)}</code>\n` +
    `• 🏦 <b>Cartera B</b> (vault): <code>${escHtml(opts.walletB)}</code>`
  );
}

export interface EntryAlertOpts {
  mint: string;
  name?: string;
  symbol?: string;
  mcUsd: number;
  poolSol: number;
  live: boolean;
}

export function formatEntryAlert(opts: EntryAlertOpts): string {
  const { ticker, headline } = tokenDisplay(opts.mint, opts.symbol, opts.name);
  const tag = opts.live ? 'Entrada' : '[DRY-RUN] Entrada';
  const dex = dexscreenerUrl(opts.mint);
  const photon = photonUrl(opts.mint);
  return (
    `🎯 <b>${tag} — ${escHtml(headline)}</b>\n\n` +
    `• <b>Token:</b> ${escHtml(headline)}\n` +
    `• <b>Symbol:</b> $${escHtml(ticker)}\n` +
    `• <b>Mint:</b> <code>${escHtml(opts.mint)}</code>\n` +
    `• <b>Market Cap entrada:</b> $${opts.mcUsd.toFixed(0)} USD\n` +
    `• <b>Liquidez pool:</b> ${opts.poolSol.toFixed(2)} SOL\n` +
    `• <a href="${escHtml(dex)}">DexScreener</a> · <a href="${escHtml(photon)}">Photon</a>`
  );
}

export interface ExitAlertOpts {
  mint: string;
  name?: string;
  symbol?: string;
  reason: string;
  pnlSol: number;
  pnlPercent: number;
  liveTrading: boolean;
  vaultedSol: number;
  vaultSignature?: string;
}

export function formatExitAlert(opts: ExitAlertOpts): string {
  const { headline } = tokenDisplay(opts.mint, opts.symbol, opts.name);
  const icon = opts.pnlSol >= 0 ? '🟢' : '🔴';
  const pnlSolStr = `${opts.pnlSol >= 0 ? '+' : ''}${opts.pnlSol.toFixed(4)} SOL`;
  const pnlPctStr = `${opts.pnlPercent >= 0 ? '+' : ''}${opts.pnlPercent.toFixed(1)}%`;
  const vaultLine = formatVaultLine(opts);

  return (
    `🏁 <b>Salida — ${escHtml(headline)}</b>\n\n` +
    `• <b>Motivo:</b> ${escHtml(opts.reason)}\n` +
    `• <b>PnL:</b> ${pnlPctStr}  (${pnlSolStr}) ${icon}` +
    vaultLine
  );
}

function formatVaultLine(opts: ExitAlertOpts): string {
  const amount = opts.vaultedSol > 0 ? opts.vaultedSol : Math.max(0, opts.pnlSol);

  if (!opts.liveTrading) {
    if (amount <= 0) return '';
    return (
      `\n• <b>Movimiento a Bóveda:</b> <code>[VAULT_DRY]</code> +${amount.toFixed(4)} SOL ` +
      `Cartera A → Cartera B (simulado, LIVE_TRADING=false)`
    );
  }

  if (opts.vaultedSol > 0 && opts.vaultSignature) {
    const sig = escHtml(opts.vaultSignature);
    return (
      `\n• <b>Movimiento a Bóveda:</b> +${opts.vaultedSol.toFixed(4)} SOL Cartera A → Cartera B\n` +
      `• <b>Firma:</b> <code>${sig}</code>\n` +
      `• <a href="https://solscan.io/tx/${sig}">Ver transferencia en Solscan</a>`
    );
  }

  if (opts.pnlSol > 0) {
    return (
      `\n• <b>Movimiento a Bóveda:</b> ganancia no ruteada (sin saldo transferible o error de envío)`
    );
  }

  return '';
}
