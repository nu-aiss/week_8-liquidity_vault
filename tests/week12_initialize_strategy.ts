import * as anchor from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RPC_URL = "https://api.devnet.solana.com";

const GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const PROGRAM_ID = new PublicKey(
  "DTFgRcxF6KWyrsTqWM9Lpzdtcc6FF7NqePkEMawQ7xBA"
);

const EXPECTED_ADMIN = new PublicKey(
  "6AafER3aefcKUgQacaqLWXor5CbDruAMNM8j9prbggfb"
);

const TOKEN_A = new PublicKey(
  "BbGbr6kU99qrS5oiNpPTBwC4mpw84wuN6ugVRQpA9Mii"
);

const TOKEN_B = new PublicKey(
  "ENbngk26rEp1PJ2yoSo6ufvUXiwWjEte3ZqNPVTAdMqb"
);

async function main() {
  const send = process.argv.includes("--send");

  const connection = new Connection(
    RPC_URL,
    "confirmed"
  );

  const genesis = await connection.getGenesisHash();

  if (genesis !== GENESIS_HASH) {
    throw new Error("Wrong network: expected Devnet");
  }

  const walletPath = path.join(
    os.homedir(),
    ".config",
    "solana",
    "id.json"
  );

  const secret = JSON.parse(
    fs.readFileSync(walletPath, "utf8")
  ) as number[];

  const payer = Keypair.fromSecretKey(
    Uint8Array.from(secret)
  );

  if (!payer.publicKey.equals(EXPECTED_ADMIN)) {
    throw new Error("Unexpected admin wallet");
  }

  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(payer),
    { commitment: "confirmed" }
  );

  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(
      "target/idl/liquidity_vault.json",
      "utf8"
    )
  ) as anchor.Idl;

  const program = new anchor.Program(
    idl,
    provider
  );

  if (!program.programId.equals(PROGRAM_ID)) {
    throw new Error("IDL program ID mismatch");
  }

  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    PROGRAM_ID
  );

  const tokenAAccount = getAssociatedTokenAddressSync(
    TOKEN_A,
    vault,
    true
  );

  const tokenBAccount = getAssociatedTokenAddressSync(
    TOKEN_B,
    vault,
    true
  );

  console.log("=== WEEK 12 STRATEGY ===");
  console.log("Network: Devnet");
  console.log("Admin:", payer.publicKey.toBase58());
  console.log("Vault PDA:", vault.toBase58());
  console.log("TOKEN A ATA:", tokenAAccount.toBase58());
  console.log("TOKEN B ATA:", tokenBAccount.toBase58());

  const vaultInfo = await connection.getAccountInfo(vault);

  if (!vaultInfo || !vaultInfo.owner.equals(PROGRAM_ID)) {
    throw new Error("Existing Vault PDA not found");
  }

  const aInfo = await connection.getAccountInfo(tokenAAccount);
  const bInfo = await connection.getAccountInfo(tokenBAccount);

  console.log("TOKEN A exists:", Boolean(aInfo));
  console.log("TOKEN B exists:", Boolean(bInfo));

  if (aInfo || bInfo) {
    throw new Error(
      "At least one strategy ATA already exists. " +
      "Initialization requires separate handling; " +
      "do not send a duplicate transaction."
    );
  }

  const instruction = await program.methods
    .initializeStrategy()
    .accountsPartial({
      admin: payer.publicKey,
      vault,
      tokenAMint: TOKEN_A,
      tokenBMint: TOKEN_B,
      strategyTokenA: tokenAAccount,
      strategyTokenB: tokenBAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram:
        ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  console.log(
    "Instruction program:",
    instruction.programId.toBase58()
  );

  console.log(
    "Accounts prepared:",
    instruction.keys.length
  );

  if (!send) {
    console.log("PREVIEW COMPLETED");
    console.log("Transactions sent: 0");
    return;
  }

  if (process.env.WEEK12_CONFIRM_SEND !== "YES") {
    throw new Error(
      "Sending requires WEEK12_CONFIRM_SEND=YES"
    );
  }

  const tx = await program.methods
    .initializeStrategy()
    .accountsPartial({
      admin: payer.publicKey,
      vault,
      tokenAMint: TOKEN_A,
      tokenBMint: TOKEN_B,
      strategyTokenA: tokenAAccount,
      strategyTokenB: tokenBAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram:
        ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("INITIALIZE TX:", tx);
  console.log(
    `https://explorer.solana.com/tx/${tx}?cluster=devnet`
  );

  const afterA = await connection.getAccountInfo(
    tokenAAccount
  );
  const afterB = await connection.getAccountInfo(
    tokenBAccount
  );

  if (!afterA || !afterB) {
    throw new Error(
      "Transaction returned, but strategy ATAs " +
      "were not both confirmed. Do not resend."
    );
  }

  console.log("STRATEGY INITIALIZED");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
