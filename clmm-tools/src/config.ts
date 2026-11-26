
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Raydium } from '@raydium-io/raydium-sdk-v2';

export const RPC_URL = 'https://api.devnet.solana.com';

export const DEVNET_GENESIS_HASH =
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

export const EXPECTED_OWNER = new PublicKey(
  '6AafER3aefcKUgQacaqLWXor5CbDruAMNM8j9prbggfb'
);

export const POOL_ID = new PublicKey(
  'BLpJrvf6CYTAkMXg4S3xQrtSssh9b3uhMrUNk94KHD8R'
);

export const PROGRAM_ID = new PublicKey(
  'DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH'
);

export const CONFIG_ID = new PublicKey(
  'CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu'
);

export const TOKEN_A = new PublicKey(
  'BbGbr6kU99qrS5oiNpPTBwC4mpw84wuN6ugVRQpA9Mii'
);

export const TOKEN_B = new PublicKey(
  'ENbngk26rEp1PJ2yoSo6ufvUXiwWjEte3ZqNPVTAdMqb'
);

export function loadWallet(): Keypair {
  const walletPath = path.join(
    os.homedir(),
    '.config',
    'solana',
    'id.json'
  );

  if (!fs.existsSync(walletPath)) {
    throw new Error('Локальный кошелёк Solana CLI не найден');
  }

  const raw = JSON.parse(
    fs.readFileSync(walletPath, 'utf8')
  ) as number[];

  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(raw)
  );

  if (!keypair.publicKey.equals(EXPECTED_OWNER)) {
    throw new Error(
      'Адрес локального кошелька не совпадает с ожидаемым!'
    );
  }

  return keypair;
}

export async function createContext() {
  const connection = new Connection(RPC_URL, 'confirmed');

  const owner = loadWallet();

  const genesisHash = await connection.getGenesisHash();

  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(
      `Ожидался Solana Devnet, получен genesis hash: ${genesisHash}`
    );
  }

  console.log('Devnet genesis hash: VERIFIED');

  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'devnet',
    disableLoadToken: true,
  });

  return {
    connection,
    owner,
    raydium,
  };
}
