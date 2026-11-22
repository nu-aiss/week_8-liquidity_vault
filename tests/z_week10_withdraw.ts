
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { strict as assert } from "assert";
import { LiquidityVault } from "../target/types/liquidity_vault";

describe("Liquidity Vault - Week 10", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program =
    anchor.workspace.liquidityVault as Program<LiquidityVault>;

  const user = provider.wallet.publicKey;

  const UNIT = 1_000_000n;

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
        user.toBuffer(),
      ],
      program.programId
    );

  let depositMint: anchor.web3.PublicKey;
  let userTokenAccount: anchor.web3.PublicKey;
  let userShareAccount: anchor.web3.PublicKey;

  const withdrawAccounts = () => ({
    user,
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

    userTokenAccount = getAssociatedTokenAddressSync(
      depositMint,
      user
    );

    userShareAccount = getAssociatedTokenAddressSync(
      shareMintPda,
      user
    );

    const vaultTokens = await getAccount(
      provider.connection,
      tokenVaultPda
    );

    const shareMint = await getMint(
      provider.connection,
      shareMintPda
    );

    const shares = await getAccount(
      provider.connection,
      userShareAccount
    );

    // Тест запускается один раз после недели 9
    assert.equal(
      vaultTokens.amount,
      121n * UNIT,
      "Unexpected vault balance. Do not rerun blindly."
    );

    assert.equal(
      shareMint.supply,
      110n * UNIT,
      "Unexpected share supply."
    );

    assert.equal(
      shares.amount,
      110n * UNIT,
      "Unexpected user share balance."
    );

    console.log("Vault:", vaultPda.toBase58());
    console.log("Share Mint:", shareMintPda.toBase58());
    console.log("Token Vault:", tokenVaultPda.toBase58());
    console.log(
      "User Token Account:",
      userTokenAccount.toBase58()
    );
    console.log(
      "User Share Account:",
      userShareAccount.toBase58()
    );
  });

  it("Withdraws 11 tokens by burning 10 shares", async () => {
    const userTokensBefore = await getAccount(
      provider.connection,
      userTokenAccount
    );

    const tx = await program.methods
      .withdraw(new anchor.BN(10_000_000))
      .accountsPartial(withdrawAccounts())
      .rpc();

    const userTokensAfter = await getAccount(
      provider.connection,
      userTokenAccount
    );

    const userSharesAfter = await getAccount(
      provider.connection,
      userShareAccount
    );

    const vaultTokensAfter = await getAccount(
      provider.connection,
      tokenVaultPda
    );

    const shareMintAfter = await getMint(
      provider.connection,
      shareMintPda
    );

    assert.equal(
      userTokensAfter.amount - userTokensBefore.amount,
      11n * UNIT
    );

    assert.equal(
      userSharesAfter.amount,
      100n * UNIT
    );

    assert.equal(
      vaultTokensAfter.amount,
      110n * UNIT
    );

    assert.equal(
      shareMintAfter.supply,
      100n * UNIT
    );

    console.log("Withdraw TX:", tx);
    console.log("Shares burned: 10");
    console.log("Tokens received: 11");
    console.log("Remaining Vault tokens: 110");
    console.log("Remaining share supply: 100");
  });

  it("Rejects zero withdrawal", async () => {
    await assert.rejects(async () => {
      await program.methods
        .withdraw(new anchor.BN(0))
        .accountsPartial(withdrawAccounts())
        .rpc();
    });

    console.log("Zero withdrawal correctly rejected");
  });

  it("Rejects withdrawal without enough shares", async () => {
    const shareAccount = await getAccount(
      provider.connection,
      userShareAccount
    );

    const excessiveShares = shareAccount.amount + 1n;

    await assert.rejects(async () => {
      await program.methods
        .withdraw(
          new anchor.BN(excessiveShares.toString())
        )
        .accountsPartial(withdrawAccounts())
        .rpc();
    });

    console.log("Excessive withdrawal correctly rejected");
  });
});
