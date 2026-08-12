import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  associatedBondingCurvePda,
  mapLaunchToPoolEvent,
  parseLaunchColumns,
  parseLaunchToken,
  tokensForColumns,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  PhantomLaunchToken,
} from './phantomLaunches';
import { phantomMetricsSkipReason } from '../core/HeliosEngine';

function sampleToken(over: Partial<PhantomLaunchToken> = {}): PhantomLaunchToken {
  return {
    tokenAddress: '2wPc2rfQqHy2pTyoP1cvouDqFkioHjVRBDvKFw5ipump',
    bondingCurve: '3eaYaHzJNha3LR4LnoTsnEXpAYzpFzBm26FEcHDdLqdC',
    name: 'TesticlesCoin',
    symbol: 'TESTICLES',
    marketCap: 3023,
    liquidity: 0,
    bondingCurvePercentage: 12,
    tokenCreatedAt: '2026-08-12T18:42:34.259Z',
    bondingCurvePlatform: 'Pumpfun',
    uniqueHolders: 6,
    bundlersHolding: 8.5,
    snipersHolding: 0.03,
    devHolding: 8.5,
    top10Holding: 17,
    volume: 567,
    buysCount: 5,
    sellsCount: 4,
    ...over,
  };
}

describe('parseLaunchColumns', () => {
  it('defaults to new', () => {
    assert.deepEqual(parseLaunchColumns(undefined), ['new']);
    assert.deepEqual(parseLaunchColumns(''), ['new']);
  });

  it('parses comma list and drops junk', () => {
    assert.deepEqual(parseLaunchColumns('new, migrating, foo'), ['new', 'migrating']);
  });
});

describe('parseLaunchToken + mapLaunchToPoolEvent', () => {
  it('maps Pumpfun New to bonding curve + ATA', () => {
    const parsed = parseLaunchToken(sampleToken());
    assert.ok(parsed);
    const event = mapLaunchToPoolEvent(parsed, 'new');
    assert.ok(event);
    assert.equal(event.source, 'pump');
    assert.equal(event.poolAddress, parsed.bondingCurve);
    assert.equal(event.deployerAddress, '');
    assert.equal(event.phantom.column, 'new');
    assert.equal(
      event.associatedBondingCurve,
      associatedBondingCurvePda(
        parsed.bondingCurve,
        parsed.tokenAddress,
        TOKEN_2022_PROGRAM_ID
      )
    );
    new PublicKey(event.associatedBondingCurve!);
    assert.notEqual(
      associatedBondingCurvePda(parsed.bondingCurve, parsed.tokenAddress, TOKEN_2022_PROGRAM_ID),
      associatedBondingCurvePda(parsed.bondingCurve, parsed.tokenAddress, TOKEN_PROGRAM_ID)
    );
  });

  it('ignores unsupported launchpads like Meteora DBC', () => {
    const parsed = parseLaunchToken(
      sampleToken({ bondingCurvePlatform: 'Meteora DBC' })
    );
    assert.ok(parsed);
    assert.equal(mapLaunchToPoolEvent(parsed, 'new'), null);
  });

  it('maps migrated tokens to Raydium pool', () => {
    const parsed = parseLaunchToken(
      sampleToken({
        migratedPool: '5Q544fKrFoe6tsEbD7S8EmafBDThJvP6zkah5ctnK7Qp',
        bondingCurvePlatform: 'Pumpfun',
      })
    );
    assert.ok(parsed);
    const event = mapLaunchToPoolEvent(parsed, 'migrated');
    assert.ok(event);
    assert.equal(event.source, 'raydium');
    assert.equal(event.poolAddress, parsed.migratedPool);
  });

  it('rejects garbage addresses', () => {
    assert.equal(parseLaunchToken({ tokenAddress: 'nope', bondingCurve: 'x' }), null);
  });
});

describe('tokensForColumns', () => {
  it('only yields requested columns', () => {
    const token = sampleToken();
    const rows = tokensForColumns(
      { new: [token], migrating: [token], migrated: [token] },
      ['new']
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].column, 'new');
  });
});

describe('Helios phantom metrics skip', () => {
  const weights = {
    max_bundlers_holding_pct: 40,
    max_snipers_holding_pct: 55,
    max_dev_holding_pct: 25,
  };

  it('skips high bundler farms and admits clean launches', () => {
    const farm = phantomMetricsSkipReason(
      { bundlersHolding: 80, snipersHolding: 1, devHolding: 1 },
      weights
    );
    assert.ok(farm);
    assert.match(farm, /bundlers/);

    const clean = phantomMetricsSkipReason(
      { bundlersHolding: 8, snipersHolding: 2, devHolding: 5 },
      weights
    );
    assert.equal(clean, null);
  });
});
