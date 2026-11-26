import {
    Connection,
    PublicKey,
  } from '@solana/web3.js';
  
  import {
    getAccount,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
  } from '@solana/spl-token';
  
  import {
    RPC_URL,
    POOL_ID,
    PROGRAM_ID,
    CONFIG_ID,
    TOKEN_A,
    TOKEN_B,
  } from './config.js';
  
  const VAULT_PROGRAM_ID = new PublicKey(
    'DTFgRcxF6KWyrsTqWM9Lpzdtcc6FF7NqePkEMawQ7xBA'
  );
  
  const POOL_VAULT_A = new PublicKey(
    'GhZ2VTpzXXmGAbxWKNZ4wFtYyC42WhvcYpsEwU1w3yqL'
  );
  
  const POOL_VAULT_B = new PublicKey(
    'AEhnX24oC7fuUeQe3sH8ByXAupEw2ryxW4jjWV3Sh6qZ'
  );
  
  const DEPOSIT_MINT = new PublicKey(
    '2TZLrS3GzRhhXHMECLmqz68wKienQVvUUQ2c83UwRy2r'
  );
  
  async function main(): Promise<void> {
    console.log('=== WEEK 12 PREFLIGHT ===');
    console.log('READ ONLY: no transactions');
  
    const connection = new Connection(
      RPC_URL,
      'confirmed'
    );
  
    const genesis = await connection.getGenesisHash();
  
    if (
      genesis !==
      'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
    ) {
      throw new Error('Wrong network: Devnet required');
    }
  
    console.log('Network: Devnet VERIFIED');
  
    const [vaultPda, vaultBump] =
      PublicKey.findProgramAddressSync(
        [Buffer.from('vault')],
        VAULT_PROGRAM_ID
      );
  
    const expectedVault = new PublicKey(
      '48rrZWJcu2hV8r9s8PrL7QM1re1LqaCtfsRr7q1LEuwv'
    );
  
    if (!vaultPda.equals(expectedVault)) {
      throw new Error('Vault PDA mismatch');
    }
  
    const vaultInfo = await connection.getAccountInfo(
      vaultPda
    );
  
    if (
      !vaultInfo ||
      !vaultInfo.owner.equals(VAULT_PROGRAM_ID)
    ) {
      throw new Error('Invalid Vault account owner');
    }
  
    console.log('Vault PDA:', vaultPda.toBase58());
    console.log('Vault bump:', vaultBump);
  
    const clmmProgram = await connection.getAccountInfo(
      PROGRAM_ID
    );
  
    if (!clmmProgram?.executable) {
      throw new Error('Raydium program not executable');
    }
  
    const poolInfo = await connection.getAccountInfo(
      POOL_ID
    );
  
    if (
      !poolInfo ||
      !poolInfo.owner.equals(PROGRAM_ID)
    ) {
      throw new Error('Invalid CLMM pool owner');
    }
  
    console.log('CLMM pool:', POOL_ID.toBase58());
    console.log('CLMM program: VERIFIED');
  
    const configInfo = await connection.getAccountInfo(
      CONFIG_ID
    );
  
    if (
      !configInfo ||
      !configInfo.owner.equals(PROGRAM_ID)
    ) {
      throw new Error('Invalid CLMM config');
    }
  
    console.log('CLMM config: VERIFIED');
  
    for (const [name, address, mint] of [
      ['Pool Vault A', POOL_VAULT_A, TOKEN_A],
      ['Pool Vault B', POOL_VAULT_B, TOKEN_B],
    ] as const) {
      const account = await getAccount(
        connection,
        address,
        'confirmed',
        TOKEN_PROGRAM_ID
      );
  
      if (!account.mint.equals(mint)) {
        throw new Error(`${name}: mint mismatch`);
      }
  
      if (!account.owner.equals(POOL_ID)) {
        throw new Error(`${name}: authority mismatch`);
      }
  
      console.log(
        `${name}: ${Number(account.amount) / 1e6}`
      );
    }
  
    console.log('Deposit Mint:', DEPOSIT_MINT.toBase58());
  
    if (
      DEPOSIT_MINT.equals(TOKEN_A) ||
      DEPOSIT_MINT.equals(TOKEN_B)
    ) {
      throw new Error(
        'Unexpected deposit mint configuration'
      );
    }
  
    console.log(
      'Deposit mint is separate from CLMM tokens: VERIFIED'
    );
  
    console.log('=== STRATEGY ACCOUNTS ===');
  
    for (const [name, mint] of [
      ['TOKEN A', TOKEN_A],
      ['TOKEN B', TOKEN_B],
    ] as const) {
      const address = getAssociatedTokenAddressSync(
        mint,
        vaultPda,
        true,
        TOKEN_PROGRAM_ID
      );
  
      const info = await connection.getAccountInfo(
        address
      );
  
      console.log(`${name} strategy ATA:`, address.toBase58());
  
      if (!info) {
        console.log('Status: NOT CREATED');
        continue;
      }
  
      const account = await getAccount(
        connection,
        address,
        'confirmed',
        TOKEN_PROGRAM_ID
      );
  
      if (
        !account.owner.equals(vaultPda) ||
        !account.mint.equals(mint)
      ) {
        throw new Error(`${name}: invalid strategy account`);
      }
  
      console.log(
        'Status: EXISTS; balance:',
        Number(account.amount) / 1e6
      );
    }
  
    console.log('=== PREFLIGHT COMPLETED ===');
  }
  
  main().catch((error: unknown) => {
    console.error('PREFLIGHT FAILED:', error);
    process.exitCode = 1;
  });
  