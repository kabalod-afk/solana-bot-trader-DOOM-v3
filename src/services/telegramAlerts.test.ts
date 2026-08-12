import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dexscreenerUrl,
  formatEntryAlert,
  formatExitAlert,
  formatStatusCheck,
  photonUrl,
  tokenDisplay,
} from './telegramAlerts';

const MINT = '2wPc2rfQqHy2pTyoP1cvouDqFkioHjVRBDvKFw5ipump';
const WALLET_A = 'WorkWallet111111111111111111111111111111111';
const WALLET_B = 'VaultWallet11111111111111111111111111111111';

describe('tokenDisplay', () => {
  it('prefers name / $symbol', () => {
    const d = tokenDisplay(MINT, 'TESTICLES', 'TesticlesCoin');
    assert.equal(d.ticker, 'TESTICLES');
    assert.equal(d.headline, 'TesticlesCoin / $TESTICLES');
  });

  it('falls back to mint prefix', () => {
    const d = tokenDisplay(MINT);
    assert.equal(d.ticker, MINT.slice(0, 6));
    assert.equal(d.headline, `$${MINT.slice(0, 6)}`);
  });
});

describe('formatStatusCheck', () => {
  it('shows LIVE_TRADING, WSS and both wallets once', () => {
    const html = formatStatusCheck({
      liveTrading: true,
      wssConnected: true,
      walletA: WALLET_A,
      walletB: WALLET_B,
    });
    assert.match(html, /Status Check/);
    assert.match(html, /LIVE_TRADING=true/);
    assert.match(html, /WebSocket Helius:<\/b> conectado/);
    assert.match(html, /Cartera A/);
    assert.match(html, /Cartera B/);
    assert.match(html, new RegExp(WALLET_A));
    assert.match(html, new RegExp(WALLET_B));
    assert.doesNotMatch(html, /HELIOS ONLINE/);
    assert.doesNotMatch(html, /ADMITIR/);
  });

  it('labels dry-run and pending WSS', () => {
    const html = formatStatusCheck({
      liveTrading: false,
      wssConnected: false,
      walletA: WALLET_A,
      walletB: WALLET_B,
    });
    assert.match(html, /LIVE_TRADING=false/);
    assert.match(html, /pendiente \/ reconectando/);
  });
});

describe('formatEntryAlert', () => {
  it('includes name, mint, MC, pool and chart links', () => {
    const html = formatEntryAlert({
      mint: MINT,
      name: 'TesticlesCoin',
      symbol: 'TESTICLES',
      mcUsd: 12_500,
      poolSol: 2.4,
      live: true,
    });
    assert.match(html, /Entrada/);
    assert.match(html, /TesticlesCoin \/ \$TESTICLES/);
    assert.match(html, new RegExp(MINT));
    assert.match(html, /\$12500 USD/);
    assert.match(html, /2\.40 SOL/);
    assert.match(html, new RegExp(dexscreenerUrl(MINT).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, new RegExp(photonUrl(MINT).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(html, /RADAR B0/);
    assert.doesNotMatch(html, /breakout/i);
  });

  it('tags dry-run entries', () => {
    const html = formatEntryAlert({
      mint: MINT,
      mcUsd: 800,
      poolSol: 1.1,
      live: false,
    });
    assert.match(html, /\[DRY-RUN\] Entrada/);
  });
});

describe('formatExitAlert', () => {
  it('shows PnL percent, SOL and live vault signature', () => {
    const sig = '5VaultSigExample111111111111111111111111111111111';
    const html = formatExitAlert({
      mint: MINT,
      name: 'TesticlesCoin',
      symbol: 'TESTICLES',
      reason: 'Trailing −8% ATH',
      pnlSol: 0.312,
      pnlPercent: 31.2,
      liveTrading: true,
      vaultedSol: 0.312,
      vaultSignature: sig,
    });
    assert.match(html, /Salida/);
    assert.match(html, /\+31\.2%/);
    assert.match(html, /\+0\.3120 SOL/);
    assert.match(html, /Cartera A → Cartera B/);
    assert.match(html, new RegExp(sig));
    assert.match(html, /solscan\.io\/tx/);
    assert.doesNotMatch(html, /VAULT_DRY/);
    assert.doesNotMatch(html, /HELIOS/);
  });

  it('emits [VAULT_DRY] when LIVE_TRADING=false and there is profit', () => {
    const html = formatExitAlert({
      mint: MINT,
      reason: 'Take Profit +30%',
      pnlSol: 0.2,
      pnlPercent: 20,
      liveTrading: false,
      vaultedSol: 0.2,
    });
    assert.match(html, /\[VAULT_DRY\]/);
    assert.match(html, /\+0\.2000 SOL/);
    assert.match(html, /LIVE_TRADING=false/);
    assert.doesNotMatch(html, /solscan/);
  });

  it('omits vault line on a live loss', () => {
    const html = formatExitAlert({
      mint: MINT,
      reason: 'límite de 4 minutos',
      pnlSol: -0.05,
      pnlPercent: -5,
      liveTrading: true,
      vaultedSol: 0,
    });
    assert.match(html, /-5\.0%/);
    assert.match(html, /-0\.0500 SOL/);
    assert.doesNotMatch(html, /Movimiento a Bóveda/);
  });
});
