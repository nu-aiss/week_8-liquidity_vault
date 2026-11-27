import { getAccount, getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import {
  createContext,
  POOL_ID,
  PROGRAM_ID,
  CONFIG_ID,
  TOKEN_A,
  TOKEN_B,
} from './config.js';


const VAULT_PDA = new PublicKey(
  '48rrZWJcu2hV8r9s8PrL7QM1re1LqaCtfsRr7q1LEuwv'
);

const STRATEGY_A = new PublicKey(
  'CSpHNCRPicoADCGW9ikbeCTiM1mFAVV6rCm4vL9SUvrE'
);

const STRATEGY_B = new PublicKey(
  '4CpFyaoqvh2jaruuxmwL4e5BcL5FeCrzCVGrJZkhRATa'
);

const RANGE_PERCENT = 10;
const LN_TICK = Math.log(1.0001);

function assert(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function formatUnits(
  raw: bigint,
  decimals: number
): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;

  const remainder = (raw % base)
    .toString()
    .padStart(decimals, '0');

  return decimals === 0
    ? whole.toString()
    : `${whole}.${remainder}`;
}

async function main() {
  console.log('=== WEEK 13 READ-ONLY PREFLIGHT ===');
  console.log('Transactions sent: 0');

  const { connection, raydium } =
    await createContext();

  const poolAccount =
    await connection.getAccountInfo(POOL_ID);

  assert(poolAccount, 'CLMM pool was not found');

  assert(
    poolAccount.owner.equals(PROGRAM_ID),
    'CLMM program owner mismatch'
  );

  const [
    mintA,
    mintB,
    accountA,
    accountB,
    rpc,
  ] = await Promise.all([
    getMint(connection, TOKEN_A, 'confirmed', TOKEN_PROGRAM_ID),
    getMint(connection, TOKEN_B, 'confirmed', TOKEN_PROGRAM_ID),
    getAccount(connection, STRATEGY_A, 'confirmed', TOKEN_PROGRAM_ID),
    getAccount(connection, STRATEGY_B, 'confirmed', TOKEN_PROGRAM_ID),
    raydium.clmm.getRpcClmmPoolInfo({
      poolId: POOL_ID.toBase58(),
    }),
  ]);

  assert(
    mintA.decimals === 6 && mintB.decimals === 6,
    'Unexpected token decimals'
  );

  assert(
    accountA.owner.equals(VAULT_PDA),
    'Strategy A is NOT owned by Vault'
  );

  assert(
    accountB.owner.equals(VAULT_PDA),
    'Strategy B is NOT owned by Vault'
  );

  assert(
    accountA.mint.equals(TOKEN_A),
    'Strategy A mint mismatch'
  );

  assert(
    accountB.mint.equals(TOKEN_B),
    'Strategy B mint mismatch'
  );

  assert(
    rpc.mintA.equals(TOKEN_A),
    'Pool mint A mismatch'
  );

  assert(
    rpc.mintB.equals(TOKEN_B),
    'Pool mint B mismatch'
  );

  assert(
    rpc.ammConfig.equals(CONFIG_ID),
    'Pool config mismatch'
  );

  const spacing = rpc.tickSpacing;
  const currentTick = rpc.tickCurrent;

  assert(
    Number.isInteger(spacing) && spacing > 0,
    'Invalid tick spacing'
  );

  assert(
    Number.isInteger(currentTick),
    'Invalid current tick'
  );


  const shiftLower =
    Math.log(1 - RANGE_PERCENT / 100) / LN_TICK;

  const shiftUpper =
    Math.log(1 + RANGE_PERCENT / 100) / LN_TICK;

  const tickLower =
    Math.floor(
      (currentTick + shiftLower) / spacing
    ) * spacing;

  const tickUpper =
    Math.ceil(
      (currentTick + shiftUpper) / spacing
    ) * spacing;

  assert(
    tickLower < currentTick &&
    currentTick < tickUpper,
    'Current tick outside proposed range'
  );

  assert(
    tickLower >= -443636 &&
    tickUpper <= 443636,
    'Ticks exceed CLMM limits'
  );

  console.log('Pool:', POOL_ID.toBase58());

  console.log('Mint A:', rpc.mintA.toBase58());
  console.log('Mint B:', rpc.mintB.toBase58());

  console.log('Current tick:', currentTick);
  console.log('Tick spacing:', spacing);

  console.log(
    'Current price reported by SDK:',
    String(rpc.currentPrice)
  );

  console.log(
    'Pool active liquidity (raw):',
    rpc.liquidity.toString()
  );

  console.log(
    'Strategy A:',
    formatUnits(accountA.amount, mintA.decimals)
  );

  console.log(
    'Strategy B:',
    formatUnits(accountB.amount, mintB.decimals)
  );

  console.log('Proposed tickLower:', tickLower);
  console.log('Proposed tickUpper:', tickUpper);

  console.log(
    'Approximate lower/upper tick price ratio:',
    Math.pow(1.0001, tickLower - currentTick).toFixed(6),
    Math.pow(1.0001, tickUpper - currentTick).toFixed(6)
  );

  console.log(
    'Tick arrays and exact liquidity: NOT YET VERIFIED'
  );

  console.log(
    'NFT mint and NFT ATA: NOT YET CREATED'
  );

  console.log('NO TRANSACTIONS SENT');
}

main().catch((error: unknown) => {
  console.error(
    'WEEK13 PREFLIGHT FAILED:',
    error instanceof Error ? error.message : String(error)
  );

  process.exitCode = 1;
});
