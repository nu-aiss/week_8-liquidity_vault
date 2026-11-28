import { useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction
} from "@solana/spl-token";

import idl from "./idl/liquidity_vault.json";

const PROGRAM_ID = new PublicKey(
  "DTFgRcxF6KWyrsTqWM9Lpzdtcc6FF7NqePkEMawQ7xBA"
);

const VAULT_PDA = new PublicKey(
  "48rrZWJcu2hV8r9s8PrL7QM1re1LqaCtfsRr7q1LEuwv"
);

const BASE58 =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

type Action = "open_position" | "deposit" | "withdraw";
type ResultKind = "success" | "failed" | "pending";

type SavedTransaction = {
  action: Action;
  signature: string;
  amount: string;
};

type Result = {
  kind: ResultKind;
  title: string;
  message: string;
  signature?: string;
  units?: number | null;
  logs?: string[];
};

type Props = {
  depositMint: string;
  shareMint: string;
  tokenVault: string;
  depositDecimals: number;
  shareDecimals: number;
  userTokensRaw: string;
  userSharesRaw: string;
  positionExists: boolean;
  onRefresh: () => void;
};

function storageKey(wallet: string) {
  return `liquidity-vault:devnet:pending:${wallet}`;
}

function legacyStorageKey(wallet: string) {
  return `liquidity-vault:devnet:open-position:${wallet}`;
}

function getExplorerUrl(signature: string) {
  return (
    `https://explorer.solana.com/tx/${signature}` +
    "?cluster=devnet"
  );
}

function encodeBase58(bytes: Uint8Array) {
  let zeros = 0;

  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros++;
  }

  let value = 0n;

  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let output = "";

  while (value > 0n) {
    const digit = Number(value % 58n);
    output = BASE58[digit] + output;
    value /= 58n;
  }

  return "1".repeat(zeros) + output;
}

function signedSignature(transaction: VersionedTransaction) {
  const bytes = transaction.signatures[0];

  if (
    !bytes ||
    bytes.length !== 64 ||
    !bytes.some((byte) => byte !== 0)
  ) {
    throw new Error("Phantom не вернул подпись.");
  }

  return encodeBase58(bytes);
}

function getPositionPda(wallet: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      VAULT_PDA.toBuffer(),
      wallet.toBuffer()
    ],
    PROGRAM_ID
  )[0];
}

function parseAmount(value: string, decimals: number) {
  const cleaned = value.trim().replace(",", ".");

  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error("Введи корректное количество токенов.");
  }

  const [whole, fraction = ""] = cleaned.split(".");

  if (fraction.length > decimals) {
    throw new Error(
      `Максимум ${decimals} знаков после запятой.`
    );
  }

  const multiplier = 10n ** BigInt(decimals);

  const result =
    BigInt(whole) * multiplier +
    BigInt(fraction.padEnd(decimals, "0") || "0");

  if (result <= 0n) {
    throw new Error("Количество должно быть больше нуля.");
  }

  if (result > 18446744073709551615n) {
    throw new Error("Количество превышает u64.");
  }

  return result;
}

function u64Bytes(amount: bigint) {
  const bytes = new Uint8Array(8);

  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(amount & 255n);
    amount >>= 8n;
  }

  return bytes;
}

function anchorInstruction(
  action: Action,
  accounts: Record<string, PublicKey>,
  amount?: bigint
) {
  const definition = idl.instructions.find(
    (item) => item.name === action
  );

  if (!definition) {
    throw new Error(`Инструкция ${action} отсутствует в IDL.`);
  }

  if (
    !Array.isArray(definition.discriminator) ||
    definition.discriminator.length !== 8
  ) {
    throw new Error(`Неверный discriminator: ${action}.`);
  }

  const hasAmount = action !== "open_position";

  if (
    definition.args.length !== (hasAmount ? 1 : 0)
  ) {
    throw new Error(`Неверные аргументы IDL: ${action}.`);
  }

  if (hasAmount) {
    const expectedName =
      action === "deposit" ? "amount" : "shares";

    const arg = definition.args[0];

    if (
      amount === undefined ||
      arg.name !== expectedName ||
      arg.type !== "u64"
    ) {
      throw new Error(
        `Аргумент инструкции ${action} не совпадает с IDL.`
      );
    }
  }

  const keys = definition.accounts.map((account) => {
    const pubkey = accounts[account.name];

    if (!pubkey) {
      throw new Error(
        `Не передан аккаунт ${account.name}.`
      );
    }

    return {
      pubkey,
      isSigner: account.signer === true,
      isWritable: account.writable === true
    };
  });

  const data = Buffer.from([
    ...definition.discriminator,
    ...(amount === undefined
      ? []
      : Array.from(u64Bytes(amount)))
  ]);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data
  });
}

function friendlyError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  if (/429|too many requests|rate limit/i.test(message)) {
    return (
      "Devnet RPC временно ограничил запросы (429). " +
      "Не отправляй операцию повторно, " +
      "пока не проверишь её статус."
    );
  }

  if (/user rejected|user declined|rejected/i.test(message)) {
    return "Операция отклонена в Phantom.";
  }

  return message;
}

function actionTitle(action: Action) {
  if (action === "open_position") return "Create Position";
  if (action === "deposit") return "Deposit";
  return "Withdraw";
}

export default function UserOperations({
  depositMint,
  shareMint,
  tokenVault,
  depositDecimals,
  shareDecimals,
  userTokensRaw,
  userSharesRaw,
  positionExists,
  onRefresh
}: Props) {
  const { connection } = useConnection();

  const {
    publicKey,
    connected,
    signTransaction
  } = useWallet();

  const walletAddress = publicKey?.toBase58() ?? "";

  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const [result, setResult] = useState<Result | null>(null);

  const [simulation, setSimulation] = useState<{
    action: Action;
    amount: string;
  } | null>(null);

  const [pending, setPending] =
    useState<SavedTransaction | null>(null);

  const lock = useRef(false);

  useEffect(() => {
    setSimulation(null);
    setResult(null);
    setDepositAmount("");
    setWithdrawAmount("");

    if (!walletAddress) {
      setPending(null);
      return;
    }

    const current = localStorage.getItem(
      storageKey(walletAddress)
    );

    if (current) {
      try {
        const parsed = JSON.parse(current) as SavedTransaction;

        if (
          ["open_position", "deposit", "withdraw"].includes(
            parsed.action
          ) &&
          typeof parsed.signature === "string"
        ) {
          setPending(parsed);
          return;
        }
      } catch {

      }
    }

    const legacy = localStorage.getItem(
      legacyStorageKey(walletAddress)
    );

    if (legacy && !positionExists) {
      setPending({
        action: "open_position",
        signature: legacy,
        amount: ""
      });
    } else {
      setPending(null);
    }
  }, [walletAddress, positionExists]);

  async function positionOnChain(wallet: PublicKey) {
    const account = await connection.getAccountInfo(
      getPositionPda(wallet),
      "confirmed"
    );

    if (!account) return false;

    if (!account.owner.equals(PROGRAM_ID)) {
      throw new Error(
        "User Position принадлежит другой программе."
      );
    }

    return true;
  }

  function getActionAmount(action: Action) {
    if (action === "deposit") return depositAmount;
    if (action === "withdraw") return withdrawAmount;
    return "";
  }

  async function prepare(action: Action) {
    if (!connected || !publicKey) {
      throw new Error("Подключи Phantom.");
    }

    const exists = await positionOnChain(publicKey);
    const position = getPositionPda(publicKey);

    const instructions: TransactionInstruction[] = [];

    if (action === "open_position") {
      if (exists) {
        throw new Error("User Position уже существует.");
      }

      instructions.push(
        anchorInstruction("open_position", {
          user: publicKey,
          vault: VAULT_PDA,
          position,
          system_program: SystemProgram.programId
        })
      );
    } else {
      if (!exists) {
        throw new Error(
          "Сначала создай User Position."
        );
      }

      const depositKey = new PublicKey(depositMint);
      const shareKey = new PublicKey(shareMint);
      const tokenVaultKey = new PublicKey(tokenVault);

      const tokenAta = getAssociatedTokenAddressSync(
        depositKey,
        publicKey
      );

      const shareAta = getAssociatedTokenAddressSync(
        shareKey,
        publicKey
      );

      const decimals =
        action === "deposit"
          ? depositDecimals
          : shareDecimals;

      const amount = parseAmount(
        getActionAmount(action),
        decimals
      );

      const available = BigInt(
        action === "deposit"
          ? userTokensRaw
          : userSharesRaw
      );

      if (amount > available) {
        throw new Error(
          action === "deposit"
            ? "Недостаточно депозитных токенов."
            : "Недостаточно shares."
        );
      }

      const [tokenInfo, shareInfo] =
        await connection.getMultipleAccountsInfo(
          [tokenAta, shareAta],
          "confirmed"
        );

      if (action === "deposit" && !tokenInfo) {
        throw new Error(
          "У Phantom отсутствует депозитный токен-аккаунт."
        );
      }

      if (action === "withdraw" && !shareInfo) {
        throw new Error(
          "У Phantom отсутствует share-токен-аккаунт."
        );
      }

      if (action === "deposit" && !shareInfo) {
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            shareAta,
            publicKey,
            shareKey
          )
        );
      }

      if (action === "withdraw" && !tokenInfo) {
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            tokenAta,
            publicKey,
            depositKey
          )
        );
      }

      instructions.push(
        anchorInstruction(
          action,
          {
            user: publicKey,
            vault: VAULT_PDA,
            position,
            deposit_mint: depositKey,
            share_mint: shareKey,
            token_vault: tokenVaultKey,
            user_token_account: tokenAta,
            user_share_account: shareAta,
            token_program: TOKEN_PROGRAM_ID
          },
          amount
        )
      );
    }

    const latest = await connection.getLatestBlockhash(
      "confirmed"
    );

    const message = new TransactionMessage({
      payerKey: publicKey,
      recentBlockhash: latest.blockhash,
      instructions
    }).compileToV0Message();

    return new VersionedTransaction(message);
  }

  async function simulateTx(
    transaction: VersionedTransaction
  ) {
    const response = await connection.simulateTransaction(
      transaction,
      {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed"
      }
    );

    return response.value;
  }

  async function simulate(action: Action) {
    if (lock.current || pending) return;

    lock.current = true;
    setBusy(true);
    setStatus(`Симуляция ${actionTitle(action)}...`);
    setResult(null);
    setSimulation(null);

    try {
      const transaction = await prepare(action);
      const simulated = await simulateTx(transaction);

      if (simulated.err) {
        setResult({
          kind: "failed",
          title: "Simulation Failed",
          message: JSON.stringify(simulated.err),
          units: simulated.unitsConsumed ?? null,
          logs: simulated.logs ?? []
        });
      } else {
        setSimulation({
          action,
          amount: getActionAmount(action)
        });

        setResult({
          kind: "success",
          title: "Simulation Passed",
          message:
            `${actionTitle(action)} успешно прошёл симуляцию. ` +
            "Токены и SOL пока не списаны.",
          units: simulated.unitsConsumed ?? null,
          logs: simulated.logs ?? []
        });
      }
    } catch (error) {
      setResult({
        kind: "failed",
        title: "Simulation Failed",
        message: friendlyError(error)
      });
    } finally {
      lock.current = false;
      setBusy(false);
      setStatus("");
    }
  }

  async function submit(action: Action) {
    if (
      lock.current ||
      !publicKey ||
      !walletAddress ||
      !connected ||
      pending
    ) {
      return;
    }

    if (
      !simulation ||
      simulation.action !== action ||
      simulation.amount !== getActionAmount(action)
    ) {
      setResult({
        kind: "failed",
        title: "Simulation Required",
        message:
          "Сначала выполни симуляцию именно этой суммы."
      });
      return;
    }

    if (!signTransaction) {
      setResult({
        kind: "failed",
        title: "Phantom Signing Unavailable",
        message:
          "Кошелёк не поддерживает signTransaction."
      });
      return;
    }

    lock.current = true;
    setBusy(true);
    setSimulation(null);
    setResult(null);

    let signature: string | undefined;

    try {
      setStatus("Повторная симуляция перед подписью...");

      const transaction = await prepare(action);
      const simulated = await simulateTx(transaction);

      if (simulated.err) {
        setResult({
          kind: "failed",
          title: "Preflight Simulation Failed",
          message: JSON.stringify(simulated.err),
          units: simulated.unitsConsumed ?? null,
          logs: simulated.logs ?? []
        });

        return;
      }

      setStatus("Подтверди транзакцию в Phantom...");

      const signed = await signTransaction(transaction);
      signature = signedSignature(signed);

      const saved: SavedTransaction = {
        action,
        signature,
        amount: getActionAmount(action)
      };

      localStorage.setItem(
        storageKey(walletAddress),
        JSON.stringify(saved)
      );

      setPending(saved);

      setStatus("Отправка подписанной транзакции в Devnet...");

      const returned =
        await connection.sendRawTransaction(
          signed.serialize(),
          {
            skipPreflight: false,
            preflightCommitment: "confirmed",
            maxRetries: 2
          }
        );

      if (returned !== signature) {
        throw new Error(
          "RPC вернул другую подпись. " +
          "Повторная отправка заблокирована."
        );
      }

      setResult({
        kind: "pending",
        title: `${actionTitle(action)} Submitted`,
        message:
          "Транзакция отправлена. " +
          "Нажми «Проверить статус транзакции». " +
          "Не подписывай повторно.",
        signature,
        units: simulated.unitsConsumed ?? null
      });
    } catch (error) {
      setResult({
        kind: signature ? "pending" : "failed",
        title: signature
          ? "Submission Status Unknown"
          : "Signing Failed",
        message:
          friendlyError(error) +
          (signature
            ? " Подпись сохранена. " +
              "Повторно отправлять операцию нельзя " +
              "до выяснения результата."
            : " Подписанная транзакция не получена."),
        signature
      });
    } finally {
      lock.current = false;
      setBusy(false);
      setStatus("");
    }
  }

  async function checkPending() {
    if (
      !pending ||
      !publicKey ||
      lock.current
    ) {
      return;
    }

    lock.current = true;
    setBusy(true);
    setStatus("Проверка статуса в Devnet...");

    try {
      const response =
        await connection.getSignatureStatuses(
          [pending.signature],
          {
            searchTransactionHistory: true
          }
        );

      const tx = response.value[0];

      if (tx?.err) {
        setResult({
          kind: "failed",
          title: `${actionTitle(pending.action)} Failed`,
          message:
            "Блокчейн вернул ошибку. " +
            "Подпись оставлена для проверки: " +
            JSON.stringify(tx.err),
          signature: pending.signature
        });
        return;
      }

      if (
        tx?.confirmationStatus === "confirmed" ||
        tx?.confirmationStatus === "finalized"
      ) {
        if (pending.action === "open_position") {
          const exists = await positionOnChain(publicKey);

          if (!exists) {
            setResult({
              kind: "pending",
              title: "Position Verification Pending",
              message:
                "Транзакция подтверждена, но PDA пока " +
                "не виден через текущий RPC.",
              signature: pending.signature
            });
            return;
          }
        }

        setResult({
          kind: "success",
          title: `${actionTitle(pending.action)} Confirmed`,
          message:
            "Транзакция подтверждена сетью. " +
            "Обновляем данные Vault. " +
            "Для новой операции сначала очисти " +
            "завершённую проверку.",
          signature: pending.signature
        });

        onRefresh();
      } else {
        setResult({
          kind: "pending",
          title: "Transaction Pending",
          message:
            "Подтверждение пока не найдено. " +
            "Это не причина отправлять транзакцию ещё раз.",
          signature: pending.signature
        });
      }
    } catch (error) {
      setResult({
        kind: "pending",
        title: "Verification Unavailable",
        message:
          friendlyError(error) +
          " Подпись сохранена.",
        signature: pending.signature
      });
    } finally {
      lock.current = false;
      setBusy(false);
      setStatus("");
    }
  }

  function clearCompleted() {
    if (
      !pending ||
      busy ||
      result?.kind !== "success"
    ) {
      return;
    }

    localStorage.removeItem(
      storageKey(walletAddress)
    );

    if (pending.action === "open_position") {
      localStorage.removeItem(
        legacyStorageKey(walletAddress)
      );
    }

    setPending(null);
    setSimulation(null);
    setResult(null);
    onRefresh();
  }

  const canCreate =
    !positionExists &&
    simulation?.action === "open_position" &&
    !pending &&
    !busy;

  const canDeposit =
    positionExists &&
    simulation?.action === "deposit" &&
    simulation.amount === depositAmount &&
    !pending &&
    !busy;

  const canWithdraw =
    positionExists &&
    simulation?.action === "withdraw" &&
    simulation.amount === withdrawAmount &&
    !pending &&
    !busy;

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Vault Operations</h2>
          <p>Anchor Instructions · Solana Devnet</p>
        </div>
        <span className="section-symbol">◈</span>
      </div>

      <div className="transaction-notice">
        <strong>Transaction Safety</strong>
        <p>
          Все реальные операции требуют успешной
          симуляции и подтверждения в Phantom.
          Подпись сохраняется до подтверждения сети.
          Автоматическая повторная отправка отключена.
        </p>
      </div>

      {!connected || !publicKey ? (
        <div className="empty-state">
          <h3>Подключи Phantom</h3>
          <p>
            Для операций необходим кошелёк
            в сети Solana Devnet.
          </p>
        </div>
      ) : (
        <>
          <div className="portfolio-details">
            <div className="portfolio-row">
              <span>User Position</span>
              <strong>
                {positionExists
                  ? "Created"
                  : "Not created"}
              </strong>
            </div>

            <div className="portfolio-row">
              <span>Available Tokens</span>
              <strong>
                {userTokensRaw} raw units
              </strong>
            </div>

            <div className="portfolio-row">
              <span>Available Shares</span>
              <strong>
                {userSharesRaw} raw units
              </strong>
            </div>
          </div>

          {pending && (
            <div className="operation-form">
              <h3>
                Последняя подписанная транзакция
              </h3>

              <p>
                Operation: {actionTitle(pending.action)}
              </p>

              {pending.amount && (
                <p>Amount: {pending.amount}</p>
              )}

              <p>
                Подпись сохранена. Новая транзакция
                блокируется до проверки текущей.
              </p>

              <p>
                <a
                  href={getExplorerUrl(pending.signature)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Открыть в Solana Explorer ↗
                </a>
              </p>

              <button
                className="refresh-button"
                disabled={busy}
                onClick={() => void checkPending()}
              >
                Проверить статус транзакции
              </button>

              {result?.kind === "success" && (
                <div style={{ marginTop: 12 }}>
                  <button
                    className="refresh-button"
                    disabled={busy}
                    onClick={clearCompleted}
                  >
                    Очистить завершённую проверку
                  </button>
                </div>
              )}
            </div>
          )}

          {!positionExists && (
            <div className="operation-form">
              <h3>1. Create User Position</h3>

              <p>
                Создание пользовательского PDA.
              </p>

              <button
                className="refresh-button"
                disabled={busy || !!pending}
                onClick={() =>
                  void simulate("open_position")
                }
              >
                Симулировать создание позиции
              </button>

              {canCreate && (
                <div style={{ marginTop: 12 }}>
                  <button
                    className="refresh-button"
                    disabled={busy}
                    onClick={() =>
                      void submit("open_position")
                    }
                  >
                    Создать позицию через Phantom
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="operation-form">
            <h3>2. Deposit Tokens</h3>

            <p>
              Внесение депозитных токенов
              и выпуск share-токенов.
            </p>

            <input
              className="operation-input"
              type="text"
              inputMode="decimal"
              placeholder="Количество токенов"
              value={depositAmount}
              disabled={busy || !!pending}
              onChange={(event) => {
                setDepositAmount(event.target.value);
                setSimulation(null);
                setResult(null);
              }}
            />

            <button
              className="refresh-button"
              disabled={
                busy ||
                !!pending ||
                !positionExists
              }
              onClick={() =>
                void simulate("deposit")
              }
            >
              Симулировать Deposit
            </button>

            {canDeposit && (
              <div style={{ marginTop: 12 }}>
                <button
                  className="refresh-button"
                  disabled={busy}
                  onClick={() =>
                    void submit("deposit")
                  }
                >
                  Deposit через Phantom
                </button>
              </div>
            )}
          </div>

          <div className="operation-form">
            <h3>3. Withdraw Shares</h3>

            <p>
              Сжигание shares и возврат
              депозитных токенов из Vault.
            </p>

            <input
              className="operation-input"
              type="text"
              inputMode="decimal"
              placeholder="Количество shares"
              value={withdrawAmount}
              disabled={busy || !!pending}
              onChange={(event) => {
                setWithdrawAmount(event.target.value);
                setSimulation(null);
                setResult(null);
              }}
            />

            <button
              className="refresh-button"
              disabled={
                busy ||
                !!pending ||
                !positionExists
              }
              onClick={() =>
                void simulate("withdraw")
              }
            >
              Симулировать Withdraw
            </button>

            {canWithdraw && (
              <div style={{ marginTop: 12 }}>
                <button
                  className="refresh-button"
                  disabled={busy}
                  onClick={() =>
                    void submit("withdraw")
                  }
                >
                  Withdraw через Phantom
                </button>
              </div>
            )}
          </div>

          {busy && (
            <div className="loading-panel">
              <div className="spinner" />
              <p>
                {status || "Выполняется операция..."}
              </p>
            </div>
          )}

          {result && (
            <div
              className={
                result.kind === "success"
                  ? "simulation-result success-result"
                  : result.kind === "failed"
                    ? "simulation-result error-result"
                    : "transaction-notice"
              }
              role="status"
            >
              <strong>{result.title}</strong>
              <p>{result.message}</p>

              {result.units !== undefined &&
                result.units !== null && (
                  <p>
                    Compute Units: {result.units}
                  </p>
                )}

              {result.signature && (
                <p>
                  <a
                    href={getExplorerUrl(result.signature)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Открыть транзакцию в Explorer ↗
                  </a>
                </p>
              )}

              {result.logs && result.logs.length > 0 && (
                <details>
                  <summary>Показать логи Solana</summary>
                  <pre>
                    {result.logs.join("\n")}
                  </pre>
                </details>
              )}
            </div>
          )}

          <div className="operation-form">
            <button
              className="refresh-button"
              disabled={busy}
              onClick={onRefresh}
            >
              ↻ Обновить балансы
            </button>
          </div>
        </>
      )}
    </section>
  );
}
