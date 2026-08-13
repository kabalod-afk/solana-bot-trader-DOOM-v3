import { Keypair } from '@solana/web3.js';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

export interface LoadedWallet {
  keypair: Keypair;
  source: 'private_key' | 'mnemonic';
  path?: string;
}

function parsePrivateKeyEnv(raw: string, envName: string): Uint8Array {
  const t = raw.trim();
  if (t.startsWith('[')) {
    const arr = JSON.parse(t) as number[];
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error(`${envName} debe ser array JSON de 64 bytes (len=${arr?.length})`);
    }
    return Uint8Array.from(arr);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bs58 = require('bs58') as { decode: (s: string) => Uint8Array };
    const decoded = bs58.decode(t);
    if (decoded.length !== 64) {
      throw new Error(`base58 secret length ${decoded.length} (need 64)`);
    }
    return decoded;
  } catch (e) {
    throw new Error(
      `${envName} inválida (usa JSON [64 bytes] o base58). ${(e as Error).message}`
    );
  }
}

function keypairFromMnemonic(
  mnemonic: string,
  expectedPubkey?: string
): { keypair: Keypair; path: string } {
  const phrase = mnemonic.trim().replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(phrase)) {
    throw new Error('MASTER_MNEMONIC inválido (bip39).');
  }

  const seed = bip39.mnemonicToSeedSync(phrase);
  const paths: string[] = [];
  for (let i = 0; i <= 20; i++) {
    paths.push(`m/44'/501'/${i}'/0'`);
    paths.push(`m/44'/501'/${i}'`);
    paths.push(`m/44'/501'/${i}'/0'/0'`);
  }

  for (const path of paths) {
    try {
      const { key } = derivePath(path, seed.toString('hex'));
      const keypair = Keypair.fromSeed(key.slice(0, 32));
      if (!expectedPubkey || keypair.publicKey.toBase58() === expectedPubkey) {
        return { keypair, path };
      }
    } catch {
      /* path inválido */
    }
  }

  const { key } = derivePath("m/44'/501'/0'/0'", seed.toString('hex'));
  const fallback = Keypair.fromSeed(key.slice(0, 32));
  throw new Error(
    `MASTER_MNEMONIC no deriva ${expectedPubkey ?? 'la pubkey'}.\n` +
      `  path m/44'/501'/0'/0' → ${fallback.publicKey.toBase58()}`
  );
}

function tryMnemonic(mnemonic: string, expected?: string): LoadedWallet | null {
  try {
    const { keypair, path } = keypairFromMnemonic(mnemonic, expected);
    return { keypair, source: 'mnemonic', path };
  } catch {
    return null;
  }
}

/**
 * Cartera única de firma. Prioridad:
 * 1) WALLETB_PRIVATE_KEY
 * 2) mnemonic → WALLETB_PUBKEY
 * 3) mnemonic → WALLETA_PUBKEY (si B no sale del seed)
 * 4) WALLETA_PRIVATE_KEY
 * 5) mnemonic cuenta 0
 */
export function loadTradingWallet(): LoadedWallet {
  const wantB = (process.env.WALLETB_PUBKEY || '').trim();
  const wantA = (process.env.WALLETA_PUBKEY || '').trim();
  const privateB = (process.env.WALLETB_PRIVATE_KEY || '').trim();
  const privateA = (process.env.WALLETA_PRIVATE_KEY || '').trim();
  const mnemonic = (process.env.MASTER_MNEMONIC || '').trim();

  if (privateB) {
    const secret = parsePrivateKeyEnv(privateB, 'WALLETB_PRIVATE_KEY');
    const keypair = Keypair.fromSecretKey(secret);
    if (wantB && keypair.publicKey.toBase58() !== wantB) {
      throw new Error(
        `WALLETB_PUBKEY no coincide con WALLETB_PRIVATE_KEY.\n` +
          `  .env:     ${wantB}\n` +
          `  derivada: ${keypair.publicKey.toBase58()}`
      );
    }
    return { keypair, source: 'private_key' };
  }

  if (mnemonic && wantB) {
    const loaded = tryMnemonic(mnemonic, wantB);
    if (loaded) return loaded;
    console.warn(
      `[WALLET] WALLETB_PUBKEY ${wantB.slice(0, 8)}… no sale del mnemonic. ` +
        `Se usa la cartera que sí firma (WALLETA / cuenta 0).`
    );
  }

  if (mnemonic && wantA) {
    const loaded = tryMnemonic(mnemonic, wantA);
    if (loaded) return loaded;
  }

  if (privateA) {
    const secret = parsePrivateKeyEnv(privateA, 'WALLETA_PRIVATE_KEY');
    return { keypair: Keypair.fromSecretKey(secret), source: 'private_key' };
  }

  if (mnemonic) {
    const loaded = tryMnemonic(mnemonic);
    if (loaded) return loaded;
  }

  throw new Error(
    'Falta MASTER_MNEMONIC, WALLETB_PRIVATE_KEY o WALLETA_PRIVATE_KEY.'
  );
}

/** @deprecated usa loadTradingWallet */
export function loadWalletA(): LoadedWallet {
  return loadTradingWallet();
}
