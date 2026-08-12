import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadMomentumConfig } from './momentumConfig';

describe('loadMomentumConfig pool override', () => {
  it('uses Helios JSON when MIN_POOL_SOL is unset', () => {
    const prev = process.env.MIN_POOL_SOL;
    delete process.env.MIN_POOL_SOL;
    try {
      assert.equal(loadMomentumConfig(1).minPoolSol, 1);
      assert.equal(loadMomentumConfig(0.8).minPoolSol, 0.8);
    } finally {
      if (prev === undefined) delete process.env.MIN_POOL_SOL;
      else process.env.MIN_POOL_SOL = prev;
    }
  });

  it('lets Ocean .env MIN_POOL_SOL override Helios', () => {
    const prev = process.env.MIN_POOL_SOL;
    process.env.MIN_POOL_SOL = '1.5';
    try {
      assert.equal(loadMomentumConfig(1).minPoolSol, 1.5);
    } finally {
      if (prev === undefined) delete process.env.MIN_POOL_SOL;
      else process.env.MIN_POOL_SOL = prev;
    }
  });
});
