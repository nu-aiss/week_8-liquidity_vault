
import {
  getMint,
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import {
  CONFIG_ID,
  POOL_ID,
  PROGRAM_ID,
  TOKEN_A,
  TOKEN_B,
  createContext,
} from './config.js';

function str(value: unknown): string {
  return value == null ? '(нет)' : String(value);
}

async function main() {
  console.log('=== WEEK 11 / READ-ONLY PREFLIGHT ===');
  console.log('Никаких транзакций скрипт не отправляет.');

  const { connection, owner, raydium } = await createContext();

  console.log('Сеть: Solana Devnet');
  console.log('Кошелёк:', owner.publicKey.toBase58());
  console.log('SDK: Raydium SDK V2');

  const poolAccount = await connection.getAccountInfo(POOL_ID);

  if (!poolAccount) {
    throw new Error('CLMM-пул не найден в Devnet');
  }

  if (!poolAccount.owner.equals(PROGRAM_ID)) {
    throw new Error('Неверный владелец аккаунта пула');
  }

  console.log('Pool ID:', POOL_ID.toBase58());
  console.log('Pool owner:', poolAccount.owner.toBase58());

  for (const mintAddress of [TOKEN_A, TOKEN_B]) {
    const mint = await getMint(
      connection,
      mintAddress,
      'confirmed',
      TOKEN_PROGRAM_ID
    );

    const ata = getAssociatedTokenAddressSync(
      mintAddress,
      owner.publicKey
    );

    const account = await getAccount(
      connection,
      ata,
      'confirmed',
      TOKEN_PROGRAM_ID
    );

    console.log('------------------------------');
    console.log('Mint:', mintAddress.toBase58());
    console.log('Decimals:', mint.decimals);
    console.log(
      'Supply:',
      Number(mint.supply) / 10 ** mint.decimals
    );
    console.log(
      'Wallet balance:',
      Number(account.amount) / 10 ** mint.decimals
    );

    if (mint.decimals !== 6) {
      throw new Error('Ожидалось 6 decimals');
    }

    if (account.amount === 0n) {
      throw new Error('Баланс токена равен нулю');
    }
  }

  const rpc = await raydium.clmm.getRpcClmmPoolInfo({
    poolId: POOL_ID.toBase58(),
  });

  const actualMints = [
    rpc.mintA.toBase58(),
    rpc.mintB.toBase58(),
  ].sort();

  const expectedMints = [
    TOKEN_A.toBase58(),
    TOKEN_B.toBase58(),
  ].sort();

  if (actualMints.join(',') !== expectedMints.join(',')) {
    throw new Error('В пуле обнаружены другие токены');
  }

  if (!rpc.ammConfig.equals(CONFIG_ID)) {
    throw new Error('Конфигурация пула не совпадает');
  }

  if (rpc.tickSpacing !== 60) {
    throw new Error('Неожиданный tick spacing');
  }

  console.log('=== ON-CHAIN CLMM POOL ===');

  console.log('Mint A:', rpc.mintA.toBase58());
  console.log('Mint B:', rpc.mintB.toBase58());
  console.log('Config:', rpc.ammConfig.toBase58());
  console.log('Tick spacing:', rpc.tickSpacing);
  console.log('Current price:', str(rpc.currentPrice));
  console.log('Current tick:', str(rpc.tickCurrent));
  console.log('Liquidity:', str(rpc.liquidity));
  console.log('Vault A:', rpc.vaultA.toBase58());
  console.log('Vault B:', rpc.vaultB.toBase58());

  console.log('=== SDK COMPATIBILITY PROBE ===');

  try {
    const data = await raydium.clmm.getPoolInfoFromRpc(
      POOL_ID.toBase58()
    );

    console.log('getPoolInfoFromRpc: OK');
    console.log(
      'Price from poolInfo:',
      str(data.poolInfo.price)
    );

    console.log(
      'Tick data available:',
      data.tickData != null
    );
  } catch (error) {
    console.log('getPoolInfoFromRpc: FAILED');

    console.log(
      'Error:',
      error instanceof Error ? error.message : str(error)
    );

    console.log(
      'Возможно, в новом пуле ещё нет tick arrays.'
    );
  }

  console.log('=================================');
  console.log(
    'READ-ONLY PREFLIGHT FINISHED — TRANSACTIONS SENT: 0'
  );
}

main().catch((error: unknown) => {
  console.error('PREFLIGHT ERROR:', error);
  process.exitCode = 1;
});
