import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  createContext,
  POOL_ID,
  PROGRAM_ID,
  TOKEN_A,
  TOKEN_B,
} from './config.js';

const MODE: 'prepare' | 'simulate' = 'prepare';

const VAULT_PROGRAM_ID = new PublicKey(
  'DTFgRcxF6KWyrsTqWM9Lpzdtcc6FF7NqePkEMawQ7xBA'
);

const VAULT_PDA = new PublicKey(
  '48rrZWJcu2hV8r9s8PrL7QM1re1LqaCtfsRr7q1LEuwv'
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

const METADATA_PROGRAM = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
);

const TOKEN_A_MAX = 5000n;
const TOKEN_B_MAX = 5653n;

const TICK_LOWER = -1080;
const TICK_UPPER = 960;

type IdlAccount = {
  name: string;
  writable?: boolean;
  signer?: boolean;
  isMut?: boolean;
  isSigner?: boolean;
};

type IdlInstruction = {
  name: string;
  discriminator?: number[];
  accounts: IdlAccount[];
};

function requireCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

function tickArrayStart(tick: number, spacing: number) {
  return Math.floor(tick / (spacing * 60)) * spacing * 60;
}

function deriveTickArray(start: number) {
  const index = Buffer.alloc(4);
  index.writeInt32BE(start);

  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('tick_array'),
      POOL_ID.toBuffer(),
      index,
    ],
    PROGRAM_ID
  )[0];
}

function anchorDiscriminator(name: string): Buffer {
  return createHash('sha256')
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

async function main(): Promise<void> {
  console.log('=== WEEK 13 OPEN POSITION ===');
  console.log('Mode:', MODE);
  console.log('Real transactions sent: 0');

  const { connection, owner, raydium } =
    await createContext();

  const idlPath = new URL(
    '../../target/idl/liquidity_vault.json',
    import.meta.url
  );

  const idl = JSON.parse(
    fs.readFileSync(idlPath, 'utf8')
  ) as { instructions: IdlInstruction[] };

  const instruction = idl.instructions.find(
    ix => ix.name === 'open_clmm_position'
  );

  requireCondition(
    instruction,
    'open_clmm_position missing from IDL'
  );

  const [
    accountA,
    accountB,
    poolAccount,
    rpc,
  ] = await Promise.all([
    getAccount(connection, STRATEGY_A),
    getAccount(connection, STRATEGY_B),
    connection.getAccountInfo(POOL_ID),
    raydium.clmm.getRpcClmmPoolInfo({
      poolId: POOL_ID.toBase58(),
    }),
  ]);

  requireCondition(
    poolAccount !== null &&
      poolAccount.owner.equals(PROGRAM_ID),
    'Invalid Raydium pool'
  );

  requireCondition(
    accountA.owner.equals(VAULT_PDA) &&
      accountB.owner.equals(VAULT_PDA),
    'Strategy authority mismatch'
  );

  requireCondition(
    accountA.mint.equals(TOKEN_A) &&
      accountB.mint.equals(TOKEN_B),
    'Strategy mint mismatch'
  );

  requireCondition(
    accountA.amount >= TOKEN_A_MAX &&
      accountB.amount >= TOKEN_B_MAX,
    'Insufficient strategy balances'
  );

  requireCondition(
    rpc.tickCurrent > TICK_LOWER &&
      rpc.tickCurrent < TICK_UPPER,
    'Pool price moved outside selected range'
  );

  requireCondition(
    TICK_LOWER % rpc.tickSpacing === 0 &&
      TICK_UPPER % rpc.tickSpacing === 0,
    'Tick spacing mismatch'
  );

  const lowerStart = tickArrayStart(
    TICK_LOWER,
    rpc.tickSpacing
  );

  const upperStart = tickArrayStart(
    TICK_UPPER,
    rpc.tickSpacing
  );

  const lowerArray = deriveTickArray(lowerStart);
  const upperArray = deriveTickArray(upperStart);

  const [lowerInfo, upperInfo] =
    await connection.getMultipleAccountsInfo([
      lowerArray,
      upperArray,
    ]);

  requireCondition(
    lowerInfo?.owner.equals(PROGRAM_ID) &&
      upperInfo?.owner.equals(PROGRAM_ID),
    'Required tick arrays are unavailable'
  );

  const [derivedVault] =
    PublicKey.findProgramAddressSync(
      [Buffer.from('vault')],
      VAULT_PROGRAM_ID
    );

  requireCondition(
    derivedVault.equals(VAULT_PDA),
    'Vault PDA mismatch'
  );

  const [clmmPosition] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from('clmm-position'),
        VAULT_PDA.toBuffer(),
      ],
      VAULT_PROGRAM_ID
    );

  requireCondition(
    !(await connection.getAccountInfo(clmmPosition)),
    'Active CLMM position state already exists'
  );

  const nftMint = Keypair.generate();

  const nftAccount = getAssociatedTokenAddressSync(
    nftMint.publicKey,
    VAULT_PDA,
    true
  );

  const [personalPosition] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from('position'),
        nftMint.publicKey.toBuffer(),
      ],
      PROGRAM_ID
    );

  const [metadataAccount] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from('metadata'),
        METADATA_PROGRAM.toBuffer(),
        nftMint.publicKey.toBuffer(),
      ],
      METADATA_PROGRAM
    );

  const addresses: Record<string, PublicKey> = {
    admin: owner.publicKey,
    vault: VAULT_PDA,
    clmm_position: clmmPosition,
    token_a_mint: TOKEN_A,
    token_b_mint: TOKEN_B,
    strategy_token_a: STRATEGY_A,
    strategy_token_b: STRATEGY_B,
    pool_state: POOL_ID,
    pool_vault_a: POOL_VAULT_A,
    pool_vault_b: POOL_VAULT_B,
    position_nft_mint: nftMint.publicKey,
    position_nft_account: nftAccount,
    personal_position: personalPosition,
    protocol_position: PROGRAM_ID,
    tick_array_lower: lowerArray,
    tick_array_upper: upperArray,
    metadata_account: metadataAccount,
    rent: SYSVAR_RENT_PUBKEY,
    system_program: SystemProgram.programId,
    token_program: TOKEN_PROGRAM_ID,
    token_program_2022: TOKEN_2022_PROGRAM_ID,
    associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
    metadata_program: METADATA_PROGRAM,
    raydium_program: PROGRAM_ID,
  };

  const keys = instruction.accounts.map(account => {
    const pubkey = addresses[account.name];

    requireCondition(
      pubkey,
      `Missing account mapping: ${account.name}`
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

  requireCondition(
    keys.some(
      key =>
        key.pubkey.equals(nftMint.publicKey) &&
        key.isSigner
    ),
    'NFT mint must be a transaction signer'
  );

  const discriminator =
    instruction.discriminator
      ? Buffer.from(instruction.discriminator)
      : anchorDiscriminator(instruction.name);

  const data = Buffer.alloc(8 + 4 * 4 + 8 * 2);

  discriminator.copy(data, 0);

  data.writeInt32LE(TICK_LOWER, 8);
  data.writeInt32LE(TICK_UPPER, 12);
  data.writeInt32LE(lowerStart, 16);
  data.writeInt32LE(upperStart, 20);
  data.writeBigUInt64LE(TOKEN_A_MAX, 24);
  data.writeBigUInt64LE(TOKEN_B_MAX, 32);

  const openIx = new TransactionInstruction({
    programId: VAULT_PROGRAM_ID,
    keys,
    data,
  });

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_000_000,
    }),
    openIx
  );

  tx.feePayer = owner.publicKey;

  const { blockhash } =
    await connection.getLatestBlockhash('confirmed');

  tx.recentBlockhash = blockhash;

  console.log('Pool tick:', rpc.tickCurrent);
  console.log('Lower tick:', TICK_LOWER);
  console.log('Upper tick:', TICK_UPPER);
  console.log('Lower array:', lowerArray.toBase58());
  console.log('Upper array:', upperArray.toBase58());

  console.log(
    'NFT mint (temporary):',
    nftMint.publicKey.toBase58()
  );

  console.log('NFT ATA:', nftAccount.toBase58());
  console.log(
    'Position PDA:',
    personalPosition.toBase58()
  );

  console.log(
    'CLMM state:',
    clmmPosition.toBase58()
  );

  console.log(
    'Max TOKEN A:',
    Number(TOKEN_A_MAX) / 1_000_000
  );

  console.log(
    'Max TOKEN B:',
    Number(TOKEN_B_MAX) / 1_000_000
  );

  console.log('Instruction accounts:', keys.length);

  const message = tx.compileMessage();

  requireCondition(
    message.serialize().length <= 1232,
    'Transaction message exceeds packet size'
  );

  console.log(
    'Serialized message bytes:',
    message.serialize().length
  );

  if (MODE === 'simulate') {
    tx.partialSign(owner, nftMint);

    const simulation =
      await connection.simulateTransaction(
        tx,
        [owner, nftMint]
      );

    console.log(
      'Simulation error:',
      JSON.stringify(simulation.value.err)
    );

    console.log(
      simulation.value.logs?.join('\n') ??
      'No simulation logs'
    );

    requireCondition(
      simulation.value.err === null,
      'Open position simulation failed'
    );

    console.log('SIMULATION SUCCESS');
  } else {
    console.log('PREPARATION SUCCESS');
    console.log('Simulation not requested.');
  }

  console.log('REAL TRANSACTIONS SENT: 0');
}

main().catch((error: unknown) => {
  console.error(
    'WEEK 13 OPEN FAILED:',
    error instanceof Error ? error.message : String(error)
  );

  process.exitCode = 1;
});
