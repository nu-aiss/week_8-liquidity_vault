import fs from 'node:fs';
import { createHash } from 'node:crypto';

import {
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import {
  getAccount,
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import {
  createContext,
  POOL_ID,
  PROGRAM_ID,
  TOKEN_A,
  TOKEN_B,
} from './config.js';

const EXECUTE_ONCE = false;

const VAULT_PROGRAM = new PublicKey(
  'DTFgRcxF6KWyrsTqWM9Lpzdtcc6FF7NqePkEMawQ7xBA'
);

const VAULT = new PublicKey(
  '48rrZWJcu2hV8r9s8PrL7QM1re1LqaCtfsRr7q1LEuwv'
);

const POSITION_STATE = new PublicKey(
  'BoR86payMxCYTN2yQMGgtURmHb6QqRfB9X5mx3rfiBaD'
);

const PERSONAL_POSITION = new PublicKey(
  '5E1GZFgz8xTa8L6fEb3oJcH2rky1txFr6xUFcXuQqcDA'
);

const NFT_MINT = new PublicKey(
  '8QckFraTGmFg91vqTcNGN1okN3uPP8EbbQYkbQG3Co6Y'
);

const NFT_ACCOUNT = new PublicKey(
  'FmzN7MDxpdVbAZ1MRxowaxnBkDDS4brdp1F7vcwcXi9m'
);

const STRATEGY_A = new PublicKey(
  'CSpHNCRPicoADCGW9ikbeCTiM1mFAVV6rCm4vL9SUvrE'
);

const STRATEGY_B = new PublicKey(
  '4CpFyaoqvh2jaruuxmwL4e5BcL5FeCrzCVGrJZkhRATa'
);

const POOL_VAULT_A = new PublicKey(
  'GhZ2VTpzXXmGAbxWKNZ4wFtYyC42WhvcYpsEwU1w3yqL'
);

const POOL_VAULT_B = new PublicKey(
  'AEhnX24oC7fuUeQe3sH8ByXAupEw2ryxW4jjWV3Sh6qZ'
);

const LOWER_ARRAY = new PublicKey(
  '4w7cA6bdxFJgCrDyE5k2pLW97nZffHsRnoci16kzp7Pm'
);

const UPPER_ARRAY = new PublicKey(
  '8nVWdxop2fSm2X7ay1qZ9p4fmL1w2SpaikefrJ7ybiEs'
);

const MEMO_PROGRAM = new PublicKey(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
);

type IdlAccount = {
  name: string;
  signer?: boolean;
  writable?: boolean;
  isSigner?: boolean;
  isMut?: boolean;
};

type IdlInstruction = {
  name: string;
  discriminator?: number[];
  accounts: IdlAccount[];
};

function check(
  value: unknown,
  message: string
): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function discriminator(name: string): Buffer {
  return createHash('sha256')
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

function buildInstruction(
  idl: { instructions: IdlInstruction[] },
  name: string,
  accounts: Record<string, PublicKey>,
  args: Buffer
): TransactionInstruction {
  const ix = idl.instructions.find(
    item => item.name === name
  );

  check(ix, `Missing instruction: ${name}`);

  const keys = ix.accounts.map(account => {
    const pubkey = accounts[account.name];

    check(
      pubkey,
      `Missing ${name} account: ${account.name}`
    );

    return {
      pubkey,
      isSigner: Boolean(
        account.signer ?? account.isSigner
      ),
      isWritable: Boolean(
        account.writable ?? account.isMut
      ),
    };
  });

  const prefix = ix.discriminator
    ? Buffer.from(ix.discriminator)
    : discriminator(name);

  return new TransactionInstruction({
    programId: VAULT_PROGRAM,
    keys,
    data: Buffer.concat([prefix, args]),
  });
}

function readU128LE(
  data: Buffer,
  offset: number
): bigint {
  const low = data.readBigUInt64LE(offset);
  const high = data.readBigUInt64LE(offset + 8);

  return low + (high << 64n);
}

async function main(): Promise<void> {
  console.log('========== WEEK 13 CLOSE ==========');
  console.log('Mode: simulation only');
  console.log('Real transactions sent: 0');

  console.log(
    'Execute enabled:',
    EXECUTE_ONCE
  );

  const { connection, owner } = await createContext();

  const idlPath = new URL(
    '../../target/idl/liquidity_vault.json',
    import.meta.url
  );

  const idl = JSON.parse(
    fs.readFileSync(idlPath, 'utf8')
  ) as { instructions: IdlInstruction[] };

  const [
    nftAccount,
    nftMint,
    personalInfo,
    positionInfo,
    accountA,
    accountB,
  ] = await Promise.all([
    getAccount(connection, NFT_ACCOUNT),
    getMint(connection, NFT_MINT),
    connection.getAccountInfo(PERSONAL_POSITION),
    connection.getAccountInfo(POSITION_STATE),
    getAccount(connection, STRATEGY_A),
    getAccount(connection, STRATEGY_B),
  ]);

  check(
    positionInfo !== null &&
      positionInfo.owner.equals(VAULT_PROGRAM),
    'Vault CLMM position state not found'
  );

  check(
    personalInfo !== null &&
      personalInfo.owner.equals(PROGRAM_ID),
    'Raydium personal position not found'
  );

  check(
    nftAccount.owner.equals(VAULT),
    'NFT is not owned by Vault PDA'
  );

  check(
    nftAccount.mint.equals(NFT_MINT),
    'NFT mint mismatch'
  );

  check(
    nftAccount.amount === 1n,
    'Vault does not own exactly one NFT'
  );

  check(
    nftMint.decimals === 0,
    'Position NFT must have zero decimals'
  );

  check(
    accountA.owner.equals(VAULT) &&
      accountB.owner.equals(VAULT),
    'Strategy token ownership mismatch'
  );

  check(
    accountA.mint.equals(TOKEN_A) &&
      accountB.mint.equals(TOKEN_B),
    'Strategy mint mismatch'
  );

  const expectedAta = getAssociatedTokenAddressSync(
    NFT_MINT,
    VAULT,
    true
  );

  check(
    expectedAta.equals(NFT_ACCOUNT),
    'NFT ATA address mismatch'
  );

  const [expectedPosition] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from('position'),
        NFT_MINT.toBuffer(),
      ],
      PROGRAM_ID
    );

  check(
    expectedPosition.equals(PERSONAL_POSITION),
    'Personal position PDA mismatch'
  );

  const [expectedState] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from('clmm-position'),
        VAULT.toBuffer(),
      ],
      VAULT_PROGRAM
    );

  check(
    expectedState.equals(POSITION_STATE),
    'Vault position PDA mismatch'
  );

  const data = personalInfo.data;

  check(
    data.length >= 145,
    'Invalid Raydium position data size'
  );

  const stateMint = new PublicKey(
    data.subarray(9, 41)
  );

  const statePool = new PublicKey(
    data.subarray(41, 73)
  );

  const lowerTick = data.readInt32LE(73);
  const upperTick = data.readInt32LE(77);
  const liquidity = readU128LE(data, 81);

  const feesA = data.readBigUInt64LE(129);
  const feesB = data.readBigUInt64LE(137);

  check(
    stateMint.equals(NFT_MINT),
    'On-chain NFT mint mismatch'
  );

  check(
    statePool.equals(POOL_ID),
    'On-chain pool mismatch'
  );

  check(
    liquidity > 0n,
    'No liquidity available to withdraw'
  );

  console.log('NFT mint:', NFT_MINT.toBase58());
  console.log('NFT owner:', nftAccount.owner.toBase58());
  console.log('Pool:', statePool.toBase58());
  console.log('Lower tick:', lowerTick);
  console.log('Upper tick:', upperTick);
  console.log('Liquidity (raw):', liquidity.toString());
  console.log('Fee owed A (raw):', feesA.toString());
  console.log('Fee owed B (raw):', feesB.toString());

  console.log(
    'Strategy A before:',
    accountA.amount.toString()
  );

  console.log(
    'Strategy B before:',
    accountB.amount.toString()
  );

  const commonAccounts: Record<string, PublicKey> = {
    admin: owner.publicKey,
    vault: VAULT,
    clmm_position: POSITION_STATE,

    nft_account: NFT_ACCOUNT,
    position_nft_account: NFT_ACCOUNT,
    position_nft_mint: NFT_MINT,

    personal_position: PERSONAL_POSITION,
    pool_state: POOL_ID,
    protocol_position: PROGRAM_ID,

    pool_vault_a: POOL_VAULT_A,
    pool_vault_b: POOL_VAULT_B,

    tick_array_lower: LOWER_ARRAY,
    tick_array_upper: UPPER_ARRAY,

    token_a_mint: TOKEN_A,
    token_b_mint: TOKEN_B,

    strategy_token_a: STRATEGY_A,
    strategy_token_b: STRATEGY_B,

    token_program: TOKEN_PROGRAM_ID,
    token_program_2022: TOKEN_2022_PROGRAM_ID,
    memo_program: MEMO_PROGRAM,
    raydium_program: PROGRAM_ID,
  };

  const decreaseArgs = Buffer.alloc(32);

  decreaseArgs.writeBigUInt64LE(
    liquidity & ((1n << 64n) - 1n),
    0
  );

  decreaseArgs.writeBigUInt64LE(
    liquidity >> 64n,
    8
  );

  decreaseArgs.writeBigUInt64LE(4500n, 16);
  decreaseArgs.writeBigUInt64LE(4500n, 24);

  const decreaseIx = buildInstruction(
    idl,
    'decrease_clmm_liquidity',
    commonAccounts,
    decreaseArgs
  );

  console.log(
    'Decrease instruction accounts:',
    decreaseIx.keys.length
  );

  const closeAccounts = {
    ...commonAccounts,
    system_program: new PublicKey(
      '11111111111111111111111111111111'
    ),
  };

  const closeIx = buildInstruction(
    idl,
    'close_clmm_position',
    closeAccounts,
    Buffer.alloc(0)
  );

  console.log(
    'Close instruction accounts:',
    closeIx.keys.length
  );

  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000,
    }),
    decreaseIx,
    closeIx
  );

  transaction.feePayer = owner.publicKey;

  const { blockhash } =
    await connection.getLatestBlockhash('confirmed');

  transaction.recentBlockhash = blockhash;

  const size = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).length;

  console.log('Transaction bytes:', size);

  check(
    size <= 1232,
    'Transaction exceeds Solana size limit'
  );

  console.log(
    '========== SIMULATE DECREASE + CLOSE =========='
  );

  const simulation =
    await connection.simulateTransaction(
      transaction,
      [owner]
    );

  console.log(
    'Simulation error:',
    JSON.stringify(simulation.value.err)
  );

  console.log(
    'Compute units consumed:',
    simulation.value.unitsConsumed ?? 'unknown'
  );

  console.log(
    simulation.value.logs?.join('\n') ??
      'No simulation logs'
  );

  if (simulation.value.err !== null) {
    throw new Error(
      'Decrease + close simulation failed'
    );
  }

  console.log('SIMULATION SUCCESS');

  if (!EXECUTE_ONCE) {
    console.log('REAL TRANSACTIONS SENT: 0');
    return;
  }

  console.log('Sending ONE Devnet close transaction...');

  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [owner],
    {
      commitment: 'confirmed',
      skipPreflight: false,
    }
  );

  console.log('CLOSE POSITION SUCCESS');
  console.log('Transaction signature:', signature);
  console.log('REAL TRANSACTIONS SENT: 1');
}

main().catch((error: unknown) => {
  console.error(
    'WEEK 13 CLOSE FAILED:',
    error instanceof Error
      ? error.message
      : String(error)
  );

  process.exitCode = 1;
});
