import BN from 'bn.js';
import {
  PoolUtils,
} from '@raydium-io/raydium-sdk-v2';
import {
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
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

const TICK_LOWER = -1080;
const TICK_UPPER = 960;
const SLIPPAGE = 0.01;
const DECIMALS = 6;

const CANDIDATES = [
  5000n,
  10000n,
  20000n,
  40000n,
  80000n,
];

function formatAmount(value: bigint): string {
  const whole = value / 1000000n;
  const fraction = (value % 1000000n)
    .toString()
    .padStart(6, '0');

  return `${whole}.${fraction}`;
}

function check(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  console.log('================================');
  console.log('WEEK 13 - LIQUIDITY QUOTE');
  console.log('READ ONLY - DEVNET');
  console.log('================================');

  const { connection, raydium } =
    await createContext();

  const [poolAccount, accountA, accountB] =
    await Promise.all([
      connection.getAccountInfo(POOL_ID),
      getAccount(
        connection,
        STRATEGY_A,
        'confirmed',
        TOKEN_PROGRAM_ID
      ),
      getAccount(
        connection,
        STRATEGY_B,
        'confirmed',
        TOKEN_PROGRAM_ID
      ),
    ]);

  check(poolAccount, 'Pool does not exist');

  check(
    poolAccount.owner.equals(PROGRAM_ID),
    'Unexpected Raydium program'
  );

  check(
    accountA.owner.equals(VAULT_PDA) &&
      accountB.owner.equals(VAULT_PDA),
    'Strategy accounts are not owned by Vault PDA'
  );

  check(
    accountA.mint.equals(TOKEN_A) &&
      accountB.mint.equals(TOKEN_B),
    'Strategy token mint mismatch'
  );

  const rpc =
    await raydium.clmm.getRpcClmmPoolInfo({
      poolId: POOL_ID.toBase58(),
    });

  check(
    rpc.ammConfig.equals(CONFIG_ID),
    'Unexpected CLMM config'
  );

  check(
    rpc.mintA.equals(TOKEN_A) &&
      rpc.mintB.equals(TOKEN_B),
    'Unexpected pool token order'
  );

  check(
    rpc.tickCurrent > TICK_LOWER &&
      rpc.tickCurrent < TICK_UPPER,
    'Pool price is outside the proposed range'
  );

  check(
    TICK_LOWER % rpc.tickSpacing === 0 &&
      TICK_UPPER % rpc.tickSpacing === 0,
    'Ticks are not aligned to spacing'
  );

  console.log('Pool:', POOL_ID.toBase58());
  console.log('Current tick:', rpc.tickCurrent);
  console.log('Tick spacing:', rpc.tickSpacing);
  console.log('Current price:', String(rpc.currentPrice));
  console.log('Tick lower:', TICK_LOWER);
  console.log('Tick upper:', TICK_UPPER);

  console.log(
    'Available TOKEN A:',
    formatAmount(accountA.amount)
  );

  console.log(
    'Available TOKEN B:',
    formatAmount(accountB.amount)
  );

  console.log('Loading SDK pool information...');

  const { poolInfo } =
    await raydium.clmm.getPoolInfoFromRpc(
      POOL_ID.toBase58()
    );

  check(
    poolInfo.mintA.address === TOKEN_A.toBase58() &&
      poolInfo.mintB.address === TOKEN_B.toBase58(),
    'SDK pool tokens do not match'
  );

  check(
    poolInfo.mintA.decimals === DECIMALS &&
      poolInfo.mintB.decimals === DECIMALS,
    'Unexpected token decimals'
  );

  const epochInfo = await connection.getEpochInfo();

  console.log('--------------------------------');
  console.log('Checking candidate deposits...');
  console.log('--------------------------------');

  let selected:
    | { amountA: bigint; maxB: bigint }
    | undefined;

  for (const amountA of CANDIDATES) {
    if (amountA > accountA.amount) {
      console.log(
        'SKIP:',
        formatAmount(amountA),
        'TOKEN A - insufficient balance'
      );
      continue;
    }

    const quote =
      await PoolUtils.getLiquidityAmountOutFromAmountIn({
        poolInfo,
        slippage: SLIPPAGE,
        inputA: true,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        amount: new BN(amountA.toString()),
        add: true,
        amountHasFee: true,
        epochInfo,
      });

    const maxB = BigInt(
      quote.amountSlippageB.amount.toString()
    );

    const sufficient =
      maxB > 0n && maxB <= accountB.amount;

    console.log(
      'TOKEN A:',
      formatAmount(amountA),
      '| max TOKEN B:',
      formatAmount(maxB),
      '|',
      sufficient ? 'SUFFICIENT' : 'INSUFFICIENT'
    );

    if (sufficient) {
      selected = { amountA, maxB };
    }
  }

  console.log('================================');

  if (!selected) {
    console.log(
      'RESULT: No tested candidate fits the balances.'
    );
    console.log(
      'Do not open a position or transfer tokens yet.'
    );
  } else {
    console.log('RESULT: CANDIDATE FOUND');
    console.log(
      'TOKEN A input:',
      formatAmount(selected.amountA)
    );
    console.log(
      'TOKEN B maximum:',
      formatAmount(selected.maxB)
    );
    console.log('Slippage tolerance: 1%');
    console.log(
      'This is a quote, NOT an executed position.'
    );
  }

  console.log(
    'NFT ownership and tick-array accounts:',
    'NOT YET VALIDATED'
  );

  console.log('Transactions sent: 0');
  console.log('================================');
}

main().catch((error: unknown) => {
  console.error(
    'WEEK 13 QUOTE FAILED:',
    error instanceof Error
      ? error.message
      : String(error)
  );

  process.exitCode = 1;
});
