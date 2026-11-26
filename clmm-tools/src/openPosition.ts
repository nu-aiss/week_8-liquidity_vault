import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BN from 'bn.js';
import { Decimal } from 'decimal.js';
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PoolUtils, TickUtils, TxVersion } from '@raydium-io/raydium-sdk-v2';
import { CONFIG_ID, POOL_ID, PROGRAM_ID, TOKEN_A, TOKEN_B, createContext } from './config.js';

const options = process.argv.slice(2);
if (options.some((arg) => !['--send', '--preview'].includes(arg))) {
  throw new Error('Разрешённые параметры: --preview или --send');
}
if (options.length > 1) {
  throw new Error('Выбери только один режим: --preview или --send');
}
const send = options.includes('--send');

const TARGET_LOWER = new Decimal('0.90');
const TARGET_UPPER = new Decimal('1.10');
const DEPOSIT_A_UI = new Decimal('10');
const SLIPPAGE = 0.01; // 1% допуск при расчёте максимальной суммы другого токена
const DECIMALS = 6;
const STATE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../devnet-state.json');

function explorer(account: string) {
  return `https://explorer.solana.com/account/${account}?cluster=devnet`;
}

async function main() {
  console.log(`=== WEEK 11 / ${send ? 'SEND' : 'PREVIEW (NO TRANSACTION)'} ===`);
  const { connection, owner, raydium } = await createContext();

  if (fs.existsSync(STATE_FILE)) {
    const previous: unknown = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (previous && typeof previous === 'object' && 'position' in previous && previous.position) {
      throw new Error('В devnet-state.json уже есть позиция. Не создаём дубликат.');
    }
  }

  const poolAccount = await connection.getAccountInfo(POOL_ID);
  if (!poolAccount || !poolAccount.owner.equals(PROGRAM_ID)) {
    throw new Error('Пул не найден либо не принадлежит ожидаемой программе Raydium Devnet');
  }
  const rpc = await raydium.clmm.getRpcClmmPoolInfo({ poolId: POOL_ID.toBase58() });
  if (!rpc.ammConfig.equals(CONFIG_ID) || rpc.tickSpacing !== 60 ||
      !rpc.mintA.equals(TOKEN_A) || !rpc.mintB.equals(TOKEN_B)) {
    throw new Error('Параметры существующего пула отличаются от ожидаемых');
  }

  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(POOL_ID.toBase58());
  if (poolInfo.mintA.address !== TOKEN_A.toBase58() ||
      poolInfo.mintB.address !== TOKEN_B.toBase58()) {
    throw new Error('В SDK возвращён другой порядок токенов');
  }

  const price = new Decimal(rpc.currentPrice.toString());
  if (!price.greaterThan(TARGET_LOWER) || !price.lessThan(TARGET_UPPER)) {
    throw new Error('Цена вышла из диапазона 0.90–1.10. Открытие остановлено.');
  }

  const lowerResult = TickUtils.getPriceAndTick({ poolInfo, price: TARGET_LOWER, baseIn: true });
  const upperResult = TickUtils.getPriceAndTick({ poolInfo, price: TARGET_UPPER, baseIn: true });
  const tickLower = Math.min(lowerResult.tick, upperResult.tick);
  const tickUpper = Math.max(lowerResult.tick, upperResult.tick);
  if (tickLower >= rpc.tickCurrent || tickUpper <= rpc.tickCurrent ||
      tickLower % rpc.tickSpacing !== 0 || tickUpper % rpc.tickSpacing !== 0) {
    throw new Error('Рассчитанные тики некорректны');
  }

  const actualLower = TickUtils.getTickPrice({ poolInfo, tick: tickLower, baseIn: true }).price;
  const actualUpper = TickUtils.getTickPrice({ poolInfo, tick: tickUpper, baseIn: true }).price;
  const priceLower = Decimal.min(actualLower, actualUpper);
  const priceUpper = Decimal.max(actualLower, actualUpper);

  const ataA = getAssociatedTokenAddressSync(TOKEN_A, owner.publicKey);
  const ataB = getAssociatedTokenAddressSync(TOKEN_B, owner.publicKey);
  const [accountA, accountB] = await Promise.all([
    getAccount(connection, ataA), getAccount(connection, ataB),
  ]);
  const amountA = new BN(DEPOSIT_A_UI.mul(new Decimal(10).pow(DECIMALS)).toFixed(0));
  if (new BN(accountA.amount.toString()).lt(amountA)) {
    throw new Error('Недостаточно TOKEN A');
  }

  const epochInfo = await connection.getEpochInfo();
  const quote = await PoolUtils.getLiquidityAmountOutFromAmountIn({
    poolInfo,
    slippage: SLIPPAGE,
    inputA: true,
    tickUpper,
    tickLower,
    amount: amountA,
    add: true,
    amountHasFee: true,
    epochInfo,
  });
  const otherMax = quote.amountSlippageB.amount;
  if (otherMax.lte(new BN(0))) throw new Error('SDK рассчитал нулевое количество TOKEN B');
  if (new BN(accountB.amount.toString()).lt(otherMax)) {
    throw new Error('Недостаточно TOKEN B для расчётного максимума');
  }

  console.log('Кошелёк:', owner.publicKey.toBase58());
  console.log('Пул:', POOL_ID.toBase58());
  console.log('Цена TOKEN B за 1 TOKEN A:', price.toFixed(8));
  console.log('Целевой диапазон:', TARGET_LOWER.toString(), '–', TARGET_UPPER.toString());
  console.log('Тики:', tickLower, tickUpper);
  console.log('Фактический диапазон:', priceLower.toFixed(8), '–', priceUpper.toFixed(8));
  console.log('TOKEN A вход:', DEPOSIT_A_UI.toString());
  console.log('TOKEN B максимум:', new Decimal(otherMax.toString()).div(new Decimal(10).pow(DECIMALS)).toFixed(6));
  console.log('Текущие балансы:',
    new Decimal(accountA.amount.toString()).div(1e6).toString(),
    new Decimal(accountB.amount.toString()).div(1e6).toString());

  const { execute, extInfo } = await raydium.clmm.openPositionFromBase({
    poolInfo,
    poolKeys,
    tickLower,
    tickUpper,
    base: 'MintA',
    ownerInfo: { useSOLBalance: false },
    baseAmount: amountA,
    otherAmountMax: otherMax,
    txVersion: TxVersion.V0,
  });
  console.log('NFT mint будущей позиции:', extInfo.nftMint.toBase58());
  console.log('Предполагаемый position account:', extInfo.personalPosition.toBase58());

  if (!send) {
    console.log('PREVIEW COMPLETED — TRANSACTIONS SENT: 0');
    console.log('Это проверка параметров и сборки транзакции, НЕ RPC simulateTransaction.');
    return;
  }

  console.log('Отправка одной транзакции в DEVNET...');
  const { txId } = await execute({ sendAndConfirm: true });
  console.log('TX:', txId);
  console.log('Explorer TX:', `https://explorer.solana.com/tx/${txId}?cluster=devnet`);
  const positionInfo = await connection.getAccountInfo(extInfo.personalPosition, 'confirmed');
  if (!positionInfo || !positionInfo.owner.equals(PROGRAM_ID)) {
    throw new Error('Транзакция подтверждена, но позиция пока не проверена. Сохрани TX выше, не повторяй отправку!');
  }
  const nftAccountInfo = await connection.getAccountInfo(extInfo.positionNftAccount, 'confirmed');
  if (!nftAccountInfo) {
    throw new Error('Транзакция подтверждена, но NFT-аккаунт не найден. НЕ повторяй отправку!');
  }

  const result = {
    network: 'devnet',
    owner: owner.publicKey.toBase58(),
    tokens: { mintA: TOKEN_A.toBase58(), mintB: TOKEN_B.toBase58(), decimals: DECIMALS },
    pool: { id: POOL_ID.toBase58(), programId: PROGRAM_ID.toBase58(), configId: CONFIG_ID.toBase58() },
    position: {
      nftMint: extInfo.nftMint.toBase58(),
      personalPosition: extInfo.personalPosition.toBase58(),
      positionNftAccount: extInfo.positionNftAccount.toBase58(),
      tickLower, tickUpper,
      priceLower: priceLower.toFixed(8), priceUpper: priceUpper.toFixed(8),
      priceAtCreation: price.toFixed(8),
      depositA: DEPOSIT_A_UI.toString(),
      maxDepositB: new Decimal(otherMax.toString()).div(1e6).toFixed(6),
      txId,
    },
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log('Позиция подтверждена. Адрес:', explorer(extInfo.personalPosition.toBase58()));
  console.log('NFT:', explorer(extInfo.nftMint.toBase58()));
  console.log('Сохранено:', STATE_FILE);
}

main().catch((err: unknown) => {
  console.error('WEEK 11 ERROR:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
