import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { createMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { strict as assert } from "assert";
import { LiquidityVault } from "../target/types/liquidity_vault";

describe("Liquidity Vault - Week 8", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .liquidityVault as Program<LiquidityVault>;

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
        vaultPda.toBuffer()
      ],
      program.programId
    );

  const [tokenVaultPda] =
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("token_vault"),
        vaultPda.toBuffer()
      ],
      program.programId
    );

  const [positionPda] =
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("position"),
        vaultPda.toBuffer(),
        admin.toBuffer()
      ],
      program.programId
    );

  let depositMint: anchor.web3.PublicKey;

  it("Initializes the Vault", async () => {
    depositMint = await createMint(
      provider.connection,
      payer,
      admin,
      null,
      6
    );

    const tx = await program.methods
      .initializeVault()
      .accountsPartial({
        admin: admin,
        vault: vaultPda,
        depositMint: depositMint,
        shareMint: shareMintPda,
        tokenVault: tokenVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .rpc();

    const vault = await program.account
      .vaultState.fetch(vaultPda);

    assert.equal(
      vault.admin.toBase58(),
      admin.toBase58()
    );

    assert.equal(
      vault.depositMint.toBase58(),
      depositMint.toBase58()
    );

    assert.equal(
      vault.shareMint.toBase58(),
      shareMintPda.toBase58()
    );

    assert.equal(
      vault.tokenVault.toBase58(),
      tokenVaultPda.toBase58()
    );

    assert.equal(
      vault.totalDeposited.toNumber(),
      0
    );

    console.log("Vault:", vaultPda.toBase58());
    console.log("Deposit Mint:", depositMint.toBase58());
    console.log("Share Mint:", shareMintPda.toBase58());
    console.log("Token Vault:", tokenVaultPda.toBase58());
    console.log("Initialize TX:", tx);
  });

  it("Opens User Position", async () => {
    const tx = await program.methods
      .openPosition()
      .accountsPartial({
        user: admin,
        vault: vaultPda,
        position: positionPda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .rpc();

    const position = await program.account
      .userPosition.fetch(positionPda);

    assert.equal(
      position.owner.toBase58(),
      admin.toBase58()
    );

    assert.equal(
      position.vault.toBase58(),
      vaultPda.toBase58()
    );

    assert.equal(
      position.depositedAmount.toNumber(),
      0
    );

    console.log(
      "User Position:",
      positionPda.toBase58()
    );

    console.log("Open Position TX:", tx);
  });
});
