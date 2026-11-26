import fs from "node:fs";
import path from "node:path";

import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import * as RaydiumSdk from "@raydium-io/raydium-sdk-v2";

import {
  createContext,
  POOL_ID,
  PROGRAM_ID,
  TOKEN_A,
  TOKEN_B,
} from "./config";

const AMOUNT_IN = new BN(10_000); // 0.01 TOKEN A
const SLIPPAGE = 0.01; // 1%

const STRATEGY_A = new PublicKey(
  "CSpHNCRPicoADCGW9ikbeCTiM1mFAVV6rCm4vL9SUvrE"
);

function printable(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => {
      if (typeof item === "bigint") {
        return item.toString();
      }
      if (BN.isBN(item)) {
        return item.toString();
      }
      return item;
    },
    2
  );
}

async function main() {
  console.log("=== WEEK 12 CLMM QUOTE ===");
  console.log("READ ONLY — NO TRANSACTIONS");

  const { connection, raydium } =
    await createContext();

  const balance =
    await connection.getTokenAccountBalance(STRATEGY_A);

  console.log("Vault TOKEN A:", balance.value.uiAmountString);

  if (new BN(balance.value.amount).lt(AMOUNT_IN)) {
    throw new Error("Insufficient TOKEN A");
  }

  const poolAccount =
    await connection.getAccountInfo(POOL_ID);

  if (!poolAccount ||
      !poolAccount.owner.equals(PROGRAM_ID)) {
    throw new Error("Raydium pool owner mismatch");
  }

  const rpc = await raydium.clmm.getRpcClmmPoolInfo({
    poolId: POOL_ID.toBase58(),
  });

  if (
    !rpc.mintA.equals(TOKEN_A) ||
    !rpc.mintB.equals(TOKEN_B)
  ) {
    throw new Error("Pool token mints mismatch");
  }

  console.log("Pool ID:", POOL_ID.toBase58());
  console.log("Pool liquidity:", rpc.liquidity.toString());
  console.log("Current tick:", rpc.tickCurrent);
  console.log("Tick spacing:", rpc.tickSpacing);
  console.log("Current sqrt price:", rpc.sqrtPriceX64.toString());

  if (rpc.liquidity.isZero()) {
    console.log("POOL HAS ZERO ACTIVE LIQUIDITY");
    console.log("A->B swap is not ready");
    return;
  }

  console.log("Fetching Raydium CLMM tick arrays...");

  let data: Awaited<
    ReturnType<typeof raydium.clmm.getPoolInfoFromRpc>
  >;

  try {
    data = await raydium.clmm.getPoolInfoFromRpc(
      POOL_ID.toBase58()
    );
  } catch (error) {
    console.error("POOL TICK DATA UNAVAILABLE");
    console.error(
      error instanceof Error ? error.message : error
    );
    console.log(
      "Do not send swap: SDK cannot build " +
      "the required CLMM account list."
    );
    return;
  }

  const tickArrayCache =
    data.tickData?.[POOL_ID.toBase58()];

  const tickCount = tickArrayCache
    ? Object.keys(tickArrayCache).length
    : 0;

  console.log("Loaded tick arrays:", tickCount);

  if (!tickArrayCache || tickCount === 0) {
    console.log("NO INITIALIZED TICK ARRAYS");
    console.log("Swap cannot be quoted safely");
    return;
  }

  const PoolUtils = (RaydiumSdk as any).PoolUtils;

  if (
    !PoolUtils ||
    typeof PoolUtils.computeAmountOut !== "function"
  ) {
    console.log(
      "PoolUtils.computeAmountOut is not exported " +
      "by installed Raydium SDK."
    );
    return;
  }

  const epochInfo = await connection.getEpochInfo();

  const quote = PoolUtils.computeAmountOut({
    poolInfo: data.computePoolInfo,
    tickArrayCache,
    baseMint: TOKEN_A,
    token2022Infos: {},
    epochInfo,
    amountIn: AMOUNT_IN,
    slippage: SLIPPAGE,
  });

  console.log("=== QUOTE ===");
  console.log(printable(quote));

  const reportPath = path.resolve(
    process.cwd(),
    "week12-swap-quote.json"
  );

  const report = {
    network: "devnet",
    poolId: POOL_ID.toBase58(),
    inputMint: TOKEN_A.toBase58(),
    outputMint: TOKEN_B.toBase58(),
    inputAmountRaw: AMOUNT_IN.toString(),
    slippageBps: 100,
    quote,
  };

  fs.writeFileSync(
    reportPath,
    printable(report)
  );

  console.log("QUOTE SAVED");
  console.log("TRANSACTIONS SENT: 0");
}

main().catch(error => {
  console.error("WEEK 12 ERROR:");
  console.error(error);
  process.exitCode = 1;
});
