import * as anchor from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RPC_URL = "https://api.devnet.solana.com";

const DEVNET_GENESIS =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const VAULT_PROGRAM = new PublicKey(
  "DTFgRcxF6KWyrsTqWM9Lpzdtcc6FF7NqePkEMawQ7xBA"
);

const ADMIN = new PublicKey(
  "6AafER3aefcKUgQacaqLWXor5CbDruAMNM8j9prbggfb"
);

const RAYDIUM_PROGRAM = new PublicKey(
  "DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH"
);

const POOL = new PublicKey(
  "BLpJrvf6CYTAkMXg4S3xQrtSssh9b3uhMrUNk94KHD8R"
);

const CONFIG = new PublicKey(
  "CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu"
);

const TOKEN_A = new PublicKey(
  "BbGbr6kU99qrS5oiNpPTBwC4mpw84wuN6ugVRQpA9Mii"
);

const TOKEN_B = new PublicKey(
  "ENbngk26rEp1PJ2yoSo6ufvUXiwWjEte3ZqNPVTAdMqb"
);

const STRATEGY_A = new PublicKey(
  "CSpHNCRPicoADCGW9ikbeCTiM1mFAVV6rCm4vL9SUvrE"
);

const STRATEGY_B = new PublicKey(
  "4CpFyaoqvh2jaruuxmwL4e5BcL5FeCrzCVGrJZkhRATa"
);

const POOL_VAULT_A = new PublicKey(
  "GhZ2VTpzXXmGAbxWKNZ4wFtYyC42WhvcYpsEwU1w3yqL"
);

const POOL_VAULT_B = new PublicKey(
  "AEhnX24oC7fuUeQe3sH8ByXAupEw2ryxW4jjWV3Sh6qZ"
);

const MEMO_PROGRAM = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

const QUOTE_FILE =
  "clmm-tools/week12-swap-quote.json";

async function main() {
  console.log("=== WEEK 12 CPI SWAP SIMULATION ===");
  console.log("Mode: SIMULATION ONLY");
  console.log("Transactions sent: 0");

  const connection = new Connection(
    RPC_URL,
    "confirmed"
  );

  const genesis = await connection.getGenesisHash();

  if (genesis !== DEVNET_GENESIS) {
    throw new Error("Expected Devnet");
  }

  const secretPath = path.join(
    os.homedir(),
    ".config",
    "solana",
    "id.json"
  );

  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync(secretPath, "utf8"))
    )
  );

  if (!payer.publicKey.equals(ADMIN)) {
    throw new Error("Wrong admin wallet");
  }

  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(payer),
    { commitment: "confirmed" }
  );

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

  if (!program.programId.equals(VAULT_PROGRAM)) {
    throw new Error("Incorrect Vault program");
  }

  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    VAULT_PROGRAM
  );

  const quote = JSON.parse(
    fs.readFileSync(QUOTE_FILE, "utf8")
  );

  if (
    quote.network !== "devnet" ||
    quote.poolId !== POOL.toBase58() ||
    quote.inputMint !== TOKEN_A.toBase58() ||
    quote.outputMint !== TOKEN_B.toBase58()
  ) {
    throw new Error("Quote does not match our pool");
  }

  const amountIn = new anchor.BN(
    quote.inputAmountRaw,
    10
  );

  const minOut = process.argv.includes("--test-slippage")
  ? new anchor.BN(20000)
  : new anchor.BN(
      quote.quote.minAmountOut.amount,
      16
    );

  if (
    !amountIn.eq(new anchor.BN(10000)) ||
    minOut.lte(new anchor.BN(0)) ||
    minOut.gt(amountIn.muln(2))
  ) {
    throw new Error("Unexpected quote amounts");
  }

  const remainingAddresses:
    string[] = quote.quote.remainingAccounts;

  if (
    !Array.isArray(remainingAddresses) ||
    remainingAddresses.length === 0
  ) {
    throw new Error("Missing tick arrays");
  }

  const remainingAccounts = remainingAddresses.map(
    address => ({
      pubkey: new PublicKey(address),
      isWritable: true,
      isSigner: false,
    })
  );

  for (const item of remainingAccounts) {
    const info = await connection.getAccountInfo(
      item.pubkey
    );

    if (!info || !info.owner.equals(RAYDIUM_PROGRAM)) {
      throw new Error(
        "Invalid tick-array account: " +
        item.pubkey.toBase58()
      );
    }
  }

  const poolInfo = await connection.getAccountInfo(POOL);

  if (
    !poolInfo ||
    !poolInfo.owner.equals(RAYDIUM_PROGRAM)
  ) {
    throw new Error("Invalid Raydium pool");
  }

  const strategyBalance =
    await connection.getTokenAccountBalance(STRATEGY_A);

  if (
    new anchor.BN(strategyBalance.value.amount)
      .lt(amountIn)
  ) {
    throw new Error("Insufficient strategy TOKEN A");
  }

  const { Raydium } = await import(
    "@raydium-io/raydium-sdk-v2"
  );

  const raydium = await Raydium.load({
    connection,
    owner: payer,
    cluster: "devnet",
    disableLoadToken: true,
  });

  const rpcPool = await raydium.clmm.getRpcClmmPoolInfo({
    poolId: POOL.toBase58(),
  });

  const observation = new PublicKey(
    rpcPool.observationId
  );

  console.log("Vault:", vault.toBase58());
  console.log("Pool:", POOL.toBase58());
  console.log("Observation:", observation.toBase58());
  console.log("Amount in raw:", amountIn.toString());
  console.log("Minimum out raw:", minOut.toString());
  console.log(
    "Remaining accounts:",
    remainingAccounts.map(
      item => item.pubkey.toBase58()
    )
  );

  const tx = await program.methods
    .swapClmm(amountIn, minOut)
    .accountsPartial({
      admin: payer.publicKey,
      vault,

      tokenAMint: TOKEN_A,
      tokenBMint: TOKEN_B,

      strategyTokenA: STRATEGY_A,
      strategyTokenB: STRATEGY_B,

      ammConfig: CONFIG,
      poolState: POOL,
      poolVaultA: POOL_VAULT_A,
      poolVaultB: POOL_VAULT_B,
      observationState: observation,

      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM,

      raydiumProgram: RAYDIUM_PROGRAM,
    })
    .remainingAccounts(remainingAccounts)
    .transaction();

  tx.feePayer = payer.publicKey;

  const latest = await connection.getLatestBlockhash(
    "confirmed"
  );

  tx.recentBlockhash = latest.blockhash;

  const simulated = await connection.simulateTransaction(
    tx,
    [payer]
  );

  console.log("\n=== SIMULATION RESULT ===");
  console.log(
    "Compute units:",
    simulated.value.unitsConsumed ?? "not reported"
  );

  console.log("\n=== PROGRAM LOGS ===");

  for (const line of simulated.value.logs ?? []) {
    console.log(line);
  }

  console.log("\nSimulation error:");
  console.log(
    simulated.value.err === null
      ? "NONE"
      : JSON.stringify(simulated.value.err)
  );

  const report = {
    simulatedAt: new Date().toISOString(),
    network: "devnet",
    vault: vault.toBase58(),
    pool: POOL.toBase58(),
    amountIn: amountIn.toString(),
    minimumAmountOut: minOut.toString(),
    remainingAccounts: remainingAddresses,
    computeUnits: simulated.value.unitsConsumed,
    error: simulated.value.err,
    logs: simulated.value.logs,
  };

  fs.writeFileSync(
    "clmm-tools/week12-simulation.json",
    JSON.stringify(report, null, 2)
  );

  if (simulated.value.err !== null) {
    console.log("\nSIMULATION FAILED");
    process.exitCode = 1;
    return;
  }

  
  console.log("\nSIMULATION SUCCESS");

  const send = process.argv.includes("--send");

  if (!send) {
    console.log("TRANSACTIONS SENT: 0");
    return;
  }

  if (process.env.WEEK12_CONFIRM_SWAP !== "YES") {
    throw new Error(
      "Real swap requires WEEK12_CONFIRM_SWAP=YES"
    );
  }

  console.log("\n=== REAL DEVNET CPI SWAP ===");

  const beforeA =
    await connection.getTokenAccountBalance(STRATEGY_A);

  const beforeB =
    await connection.getTokenAccountBalance(STRATEGY_B);

  console.log(
    "Before TOKEN A:",
    beforeA.value.uiAmountString
  );

  console.log(
    "Before TOKEN B:",
    beforeB.value.uiAmountString
  );

  const freshBlockhash =
    await connection.getLatestBlockhash("confirmed");

  tx.recentBlockhash = freshBlockhash.blockhash;

  let signature: string;

  try {
    signature = await connection.sendTransaction(
      tx,
      [payer],
      {
        skipPreflight: false,
        maxRetries: 0,
      }
    );
  } catch (error) {
    console.error("SWAP SUBMISSION FAILED");
    console.error(error);
    console.error(
      "Check on-chain balances before any retry."
    );
    throw error;
  }

  console.log("\nSWAP TX:", signature);
  console.log(
    `https://explorer.solana.com/tx/${signature}?cluster=devnet`
  );

  const confirmation =
    await connection.confirmTransaction(
      {
        signature,
        blockhash: freshBlockhash.blockhash,
        lastValidBlockHeight:
          freshBlockhash.lastValidBlockHeight,
      },
      "confirmed"
    );

  if (confirmation.value.err !== null) {
    throw new Error(
      "Swap transaction failed: " +
      JSON.stringify(confirmation.value.err)
    );
  }

  const afterA =
    await connection.getTokenAccountBalance(STRATEGY_A);

  const afterB =
    await connection.getTokenAccountBalance(STRATEGY_B);

  console.log("\n=== VERIFIED BALANCES ===");

  console.log(
    "TOKEN A:",
    beforeA.value.uiAmountString,
    "->",
    afterA.value.uiAmountString
  );

  console.log(
    "TOKEN B:",
    beforeB.value.uiAmountString,
    "->",
    afterB.value.uiAmountString
  );

  const spentA = BigInt(beforeA.value.amount) -
    BigInt(afterA.value.amount);

  const receivedB = BigInt(afterB.value.amount) -
    BigInt(beforeB.value.amount);

  console.log("Spent TOKEN A (raw):", spentA.toString());
  console.log("Received TOKEN B (raw):", receivedB.toString());

  if (
    spentA !== BigInt(amountIn.toString()) ||
    receivedB < BigInt(minOut.toString())
  ) {
    throw new Error(
      "Swap confirmed but balance changes " +
      "do not meet expected conditions."
    );
  }

  console.log("\nREAL CPI SWAP SUCCESS");
}

main().catch(error => {
  console.error("\nSIMULATION SCRIPT ERROR:");
  console.error(error);
  process.exitCode = 1;
});
