import { PublicKey } from '@solana/web3.js';
import {
  createContext,
  POOL_ID,
  PROGRAM_ID,
  TOKEN_A,
  TOKEN_B,
} from './config.js';

const VAULT_PROGRAM = new PublicKey(
  'DTFgRcxF6KWyrsTqWM9Lpzdtcc6FF7NqePkEMawQ7xBA'
);

const VAULT_PDA = new PublicKey(
  '48rrZWJcu2hV8r9s8PrL7QM1re1LqaCtfsRr7q1LEuwv'
);

const LOWER_TICK = -1080;
const UPPER_TICK = 960;
const TICKS_PER_ARRAY = 60;

function assert(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function getStartIndex(
  tick: number,
  spacing: number
): number {
  const arraySpan = spacing * TICKS_PER_ARRAY;

  return Math.floor(tick / arraySpan) * arraySpan;
}

function deriveTickArray(
  startIndex: number
): PublicKey {
  const indexBuffer = Buffer.alloc(4);
  indexBuffer.writeInt32BE(startIndex, 0);

  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('tick_array'),
      POOL_ID.toBuffer(),
      indexBuffer,
    ],
    PROGRAM_ID
  )[0];
}

async function main() {
  console.log('=== WEEK 13 CPI ACCOUNT CHECK ===');
  console.log('READ ONLY - NO TRANSACTIONS');

  const { connection, owner, raydium } =
    await createContext();

  const rpc =
    await raydium.clmm.getRpcClmmPoolInfo({
      poolId: POOL_ID.toBase58(),
    });

  assert(
    rpc.mintA.equals(TOKEN_A) &&
    rpc.mintB.equals(TOKEN_B),
    'Pool token order mismatch'
  );

  const spacing = rpc.tickSpacing;

  assert(spacing > 0, 'Invalid tick spacing');

  assert(
    LOWER_TICK % spacing === 0 &&
    UPPER_TICK % spacing === 0,
    'Tick alignment failed'
  );

  assert(
    LOWER_TICK < rpc.tickCurrent &&
    rpc.tickCurrent < UPPER_TICK,
    'Current price is outside range'
  );

  const [derivedVault, bump] =
    PublicKey.findProgramAddressSync(
      [Buffer.from('vault')],
      VAULT_PROGRAM
    );

  assert(
    derivedVault.equals(VAULT_PDA),
    'Vault PDA derivation mismatch'
  );

  const lowerStart =
    getStartIndex(LOWER_TICK, spacing);

  const upperStart =
    getStartIndex(UPPER_TICK, spacing);

  const lowerArray =
    deriveTickArray(lowerStart);

  const upperArray =
    deriveTickArray(upperStart);

  const [
    poolAccount,
    lowerInfo,
    upperInfo,
  ] = await connection.getMultipleAccountsInfo([
    POOL_ID,
    lowerArray,
    upperArray,
  ]);

  assert(
    poolAccount !== null &&
    poolAccount.owner.equals(PROGRAM_ID),
    'Invalid Raydium pool'
  );

  function reportArray(
    label: string,
    address: PublicKey,
    account: typeof lowerInfo
  ): void {
    console.log(label, address.toBase58());

    if (!account) {
      console.log(
        '  Status: NOT INITIALIZED'
      );
      return;
    }

    console.log(
      '  Status:',
      account.owner.equals(PROGRAM_ID)
        ? 'EXISTS - RAYDIUM OWNER'
        : 'INVALID OWNER'
    );

    console.log(
      '  Data length:',
      account.data.length
    );

    assert(
      account.owner.equals(PROGRAM_ID),
      `${label} belongs to unexpected program`
    );
  }

  console.log('-----------------------------');
  console.log('Administrator:', owner.publicKey.toBase58());
  console.log('Vault PDA:', VAULT_PDA.toBase58());
  console.log('Vault bump:', bump);
  console.log('Pool:', POOL_ID.toBase58());
  console.log('Current tick:', rpc.tickCurrent);
  console.log('Tick spacing:', spacing);
  console.log('-----------------------------');

  console.log('Lower tick:', LOWER_TICK);
  console.log('Upper tick:', UPPER_TICK);
  console.log('Lower array start:', lowerStart);
  console.log('Upper array start:', upperStart);

  reportArray(
    'Lower tick-array PDA:',
    lowerArray,
    lowerInfo
  );

  reportArray(
    'Upper tick-array PDA:',
    upperArray,
    upperInfo
  );

  console.log('-----------------------------');
  console.log(
    'NFT mint signer: NEW KEYPAIR REQUIRED'
  );
  console.log(
    'NFT recipient owner:',
    VAULT_PDA.toBase58()
  );
  console.log(
    'Exact NFT accounts: CREATE DURING OPEN'
  );

  console.log(
    'OPEN POSITION CPI NOT YET EXECUTED'
  );

  console.log('TRANSACTIONS SENT: 0');
}

main().catch((error: unknown) => {
  console.error(
    'WEEK 13 ACCOUNT CHECK FAILED:',
    error instanceof Error
      ? error.message
      : String(error)
  );

  process.exitCode = 1;
});
