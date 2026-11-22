import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  getMint,
  mintTo,
} from "@solana/spl-token";
import { strict as assert } from "assert";
import { LiquidityVault } from "../target/types/liquidity_vault";

describe("Liquidity Vault - Week 9", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program =
    anchor.workspace.liquidityVault as Program<LiquidityVault>;

  const admin = provider.wallet.publicKey;
  const payer = (provider.wallet as any)
    .payer as anchor.web3.Keypair;

  const [vaultPda] =
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      program.programId
    );

  const [shareMintPda] =
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("share_mint"),
        vaultPda.toBuffer(),
      ],
      program.programId
    );

  const [tokenVaultPda] =
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("token_vault"),
        vaultPda.toBuffer(),
      ],
      program.programId
    );

  const [positionPda] =
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("position"),
        vaultPda.toBuffer(),
        admin.toBuffer(),
      ],
      program.programId
    );

  const UNIT = 1_000_000;

  let depositMint: anchor.web3.PublicKey;
  let userTokenAccount: anchor.web3.PublicKey;
  let userShareAccount: anchor.web3.PublicKey;

  const depositAccounts = () => ({
    user: admin,
    vault: vaultPda,
    position: positionPda,
    depositMint,
    shareMint: shareMintPda,
    tokenVault: tokenVaultPda,
    userTokenAccount,
    userShareAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  before(async () => {
    const vault =
      await program.account.vaultState.fetch(vaultPda);

    depositMint = vault.depositMint;

    const mintState = await getMint(
      provider.connection,
      shareMintPda
    );

    const vaultState = await getAccount(
      provider.connection,
      tokenVaultPda
    );

    assert.equal(
      mintState.supply,
      0n,
      "Vault already has shares. Do not rerun this test."
    );

    assert.equal(
      vaultState.amount,
      0n,
      "Vault already has tokens. Do not rerun this test."
    );

    const userDepositAta =
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        depositMint,
        admin
      );

    const userShareAta =
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        shareMintPda,
        admin
      );

    userTokenAccount = userDepositAta.address;
    userShareAccount = userShareAta.address;

    await mintTo(
      provider.connection,
      payer,
      depositMint,
      userTokenAccount,
      payer,
      111 * UNIT
    );

    console.log(
      "Deposit Mint:",
      depositMint.toBase58()
    );
    console.log(
      "User Token Account:",
      userTokenAccount.toBase58()
    );
    console.log(
      "User Share Account:",
      userShareAccount.toBase58()
    );
  });

  it("Deposits 100 tokens and receives 100 shares", async () => {
    const tx = await program.methods
      .deposit(new anchor.BN(100 * UNIT))
      .accountsPartial(depositAccounts())
      .rpc();

    const userShares = await getAccount(
      provider.connection,
      userShareAccount
    );

    const vaultTokens = await getAccount(
      provider.connection,
      tokenVaultPda
    );

    const vault =
      await program.account.vaultState.fetch(vaultPda);

    assert.equal(
      userShares.amount,
      BigInt(100 * UNIT)
    );

    assert.equal(
      vaultTokens.amount,
      BigInt(100 * UNIT)
    );

    assert.equal(
      vault.totalDeposited.toNumber(),
      100 * UNIT
    );

    console.log("First Deposit TX:", tx);
    console.log("Shares after first deposit: 100");
  });

  it("Calculates proportional shares after yield", async () => {
    const yieldTx = await mintTo(
      provider.connection,
      payer,
      depositMint,
      tokenVaultPda,
      payer,
      10 * UNIT
    );

    console.log("Simulated Yield TX:", yieldTx);

    const tx = await program.methods
      .deposit(new anchor.BN(11 * UNIT))
      .accountsPartial(depositAccounts())
      .rpc();

    const shares = await getAccount(
      provider.connection,
      userShareAccount
    );

    const vaultTokens = await getAccount(
      provider.connection,
      tokenVaultPda
    );

    const shareMint = await getMint(
      provider.connection,
      shareMintPda
    );

    const position =
      await program.account.userPosition.fetch(positionPda);

    assert.equal(
      shares.amount,
      BigInt(110 * UNIT)
    );

    assert.equal(
      shareMint.supply,
      BigInt(110 * UNIT)
    );

    assert.equal(
      vaultTokens.amount,
      BigInt(121 * UNIT)
    );

    assert.equal(
      position.depositedAmount.toNumber(),
      111 * UNIT
    );

    console.log("Second Deposit TX:", tx);
    console.log("New shares minted: 10");
    console.log("Total shares: 110");
    console.log("Vault tokens: 121");
  });

  it("Rejects zero deposit", async () => {
    await assert.rejects(async () => {
      await program.methods
        .deposit(new anchor.BN(0))
        .accountsPartial(depositAccounts())
        .rpc();
    });

    console.log("Zero deposit correctly rejected");
  });
});
