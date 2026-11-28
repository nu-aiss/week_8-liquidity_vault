import { useCallback, useEffect, useRef, useState } from "react";
import { BorshAccountsCoder } from "@anchor-lang/core";
import type { Idl } from "@anchor-lang/core";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  PublicKey,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";

import UserOperations from "./UserOperations";
import idlJson from "./idl/liquidity_vault.json";

const PROGRAM_ID = new PublicKey(
  "DTFgRcxF6KWyrsTqWM9Lpzdtcc6FF7NqePkEMawQ7xBA"
);

const POOL_ID = new PublicKey(
  "BLpJrvf6CYTAkMXg4S3xQrtSssh9b3uhMrUNk94KHD8R"
);

const encoder = new TextEncoder();
const coder = new BorshAccountsCoder(idlJson as Idl);

const [VAULT_PDA] = PublicKey.findProgramAddressSync(
  [encoder.encode("vault")],
  PROGRAM_ID
);

const [CLMM_PDA] = PublicKey.findProgramAddressSync(
  [encoder.encode("clmm-position"), VAULT_PDA.toBuffer()],
  PROGRAM_ID
);

type Data = {
  admin: string;
  depositMint: string;
  shareMint: string;
  tokenVault: string;
  depositDecimals: number;
  shareDecimals: number;
  vaultTokens: string;
  shareSupply: string;
  totalDeposited: string;
  userTokens: string | null;
  userShares: string | null;
  userTokensRaw: string;
  userSharesRaw: string;
  walletSol: string | null;
  positionExists: boolean;
  clmmActive: boolean;
};

function getField(
  source: Record<string, unknown>,
  camel: string,
  snake: string
): unknown {
  const value = source[camel] ?? source[snake];

  if (value === undefined || value === null) {
    throw new Error(`Поле ${camel} отсутствует в аккаунте.`);
  }

  return value;
}

function getKey(
  source: Record<string, unknown>,
  camel: string,
  snake: string
): PublicKey {
  const value = getField(source, camel, snake);

  if (value instanceof PublicKey) {
    return value;
  }

  if (typeof value === "string" || value instanceof Uint8Array) {
    return new PublicKey(value);
  }

  throw new Error(`Некорректный адрес: ${camel}`);
}

function formatUnits(
  amount: bigint,
  decimals: number
): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;

  const fraction = (amount % divisor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");

  const formattedWhole = whole.toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return fraction
    ? `${formattedWhole}.${fraction}`
    : formattedWhole;
}

function short(address: string): string {
  return `${address.slice(0, 5)}...${address.slice(-5)}`;
}

function rpcErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : String(error);

  if (/429|too many requests|rate limit/i.test(message)) {
    return (
      "Публичный Solana Devnet RPC временно ограничил запросы " +
      "(ошибка 429). Не нажимай «Обновить» многократно. " +
      "Данные можно повторно запросить позже. " +
      "Это не означает, что транзакция не прошла."
    );
  }

  return message;
}

function DetailLink({
  label,
  address
}: {
  label: string;
  address: string;
}) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <a
        href={`https://explorer.solana.com/address/${address}?cluster=devnet`}
        target="_blank"
        rel="noopener noreferrer"
        title={address}
      >
        {short(address)} ↗
      </a>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  hint
}: {
  icon: string;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="metric-card">
      <div className="metric-heading">
        <span>{label}</span>
        <span className="metric-icon">{icon}</span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-hint">{hint}</div>
    </div>
  );
}

export default function App() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();

  const walletAddress = publicKey?.toBase58() ?? null;

  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "admin">(
    "overview"
  );
  const [lastRefresh, setLastRefresh] = useState("—");

  const requestId = useRef(0);
  const loadingRef = useRef(false);

  const isAdmin =
    connected &&
    walletAddress !== null &&
    data !== null &&
    walletAddress === data.admin;

  const refresh = useCallback(async () => {
    if (loadingRef.current) return;

    loadingRef.current = true;
    const currentRequest = ++requestId.current;

    setLoading(true);
    setError(null);

    try {
      const vaultInfo = await connection.getAccountInfo(
        VAULT_PDA,
        "confirmed"
      );

      if (!vaultInfo) {
        throw new Error("Vault PDA не найден в Devnet.");
      }

      if (!vaultInfo.owner.equals(PROGRAM_ID)) {
        throw new Error("Vault принадлежит другой программе.");
      }

      const vault = coder.decode(
        "VaultState",
        Buffer.from(vaultInfo.data)
      ) as Record<string, unknown>;

      const admin = getKey(vault, "admin", "admin");
      const depositMint = getKey(
        vault, "depositMint", "deposit_mint"
      );
      const shareMint = getKey(
        vault, "shareMint", "share_mint"
      );
      const tokenVault = getKey(
        vault, "tokenVault", "token_vault"
      );

      const totalDeposited = BigInt(
        String(getField(
          vault, "totalDeposited", "total_deposited"
        ))
      );

      const addresses: PublicKey[] = [
        depositMint,
        shareMint,
        tokenVault,
        CLMM_PDA
      ];

      let userKey: PublicKey | null = null;

      if (walletAddress) {
        userKey = new PublicKey(walletAddress);

        const [position] = PublicKey.findProgramAddressSync(
          [
            encoder.encode("position"),
            VAULT_PDA.toBuffer(),
            userKey.toBuffer()
          ],
          PROGRAM_ID
        );

        addresses.push(
          position,
          getAssociatedTokenAddressSync(depositMint, userKey),
          getAssociatedTokenAddressSync(shareMint, userKey)
        );
      }

      const accounts = await connection.getMultipleAccountsInfo(
        addresses,
        "confirmed"
      );

      const [depositInfo, shareInfo, tokenVaultInfo, clmmInfo] =
        accounts;

      if (!depositInfo || !shareInfo || !tokenVaultInfo) {
        throw new Error(
          "Один из основных токен-аккаунтов Vault отсутствует."
        );
      }

      const depositMintData = unpackMint(
        depositMint, depositInfo, TOKEN_PROGRAM_ID
      );

      const shareMintData = unpackMint(
        shareMint, shareInfo, TOKEN_PROGRAM_ID
      );

      const tokenVaultData = unpackAccount(
        tokenVault, tokenVaultInfo, TOKEN_PROGRAM_ID
      );

      if (!tokenVaultData.mint.equals(depositMint)) {
        throw new Error("Неверный депозитный Mint Vault.");
      }

      if (clmmInfo) {
        if (!clmmInfo.owner.equals(PROGRAM_ID)) {
          throw new Error("Неверная программа CLMM-позиции.");
        }

        const clmm = coder.decode(
          "ClmmPositionState",
          Buffer.from(clmmInfo.data)
        ) as Record<string, unknown>;

        if (
          !getKey(clmm, "vault", "vault").equals(VAULT_PDA) ||
          !getKey(clmm, "pool", "pool").equals(POOL_ID)
        ) {
          throw new Error("CLMM-позиция не соответствует Vault.");
        }
      }

      let userTokensRaw = "0";
      let userSharesRaw = "0";
      let walletSol: string | null = null;
      let positionExists = false;

      if (userKey) {
        const [
          positionInfo,
          tokenAccountInfo,
          shareAccountInfo
        ] = accounts.slice(4);

        if (positionInfo && !positionInfo.owner.equals(PROGRAM_ID)) {
          throw new Error("Неверный владелец User Position.");
        }

        positionExists = positionInfo !== null;

        if (tokenAccountInfo) {
          userTokensRaw = unpackAccount(
            addresses[5],
            tokenAccountInfo,
            TOKEN_PROGRAM_ID
          ).amount.toString();
        }

        if (shareAccountInfo) {
          userSharesRaw = unpackAccount(
            addresses[6],
            shareAccountInfo,
            TOKEN_PROGRAM_ID
          ).amount.toString();
        }

        const lamports = await connection.getBalance(
          userKey,
          "confirmed"
        );

        walletSol = (lamports / LAMPORTS_PER_SOL).toFixed(4);
      }

      if (currentRequest !== requestId.current) return;

      setData({
        admin: admin.toBase58(),
        depositMint: depositMint.toBase58(),
        shareMint: shareMint.toBase58(),
        tokenVault: tokenVault.toBase58(),
        depositDecimals: depositMintData.decimals,
        shareDecimals: shareMintData.decimals,
        vaultTokens: formatUnits(
          tokenVaultData.amount,
          depositMintData.decimals
        ),
        shareSupply: formatUnits(
          shareMintData.supply,
          shareMintData.decimals
        ),
        totalDeposited: formatUnits(
          totalDeposited,
          depositMintData.decimals
        ),
        userTokens: userKey
          ? formatUnits(
              BigInt(userTokensRaw), depositMintData.decimals
            )
          : null,
        userShares: userKey
          ? formatUnits(
              BigInt(userSharesRaw), shareMintData.decimals
            )
          : null,
        userTokensRaw,
        userSharesRaw,
        walletSol,
        positionExists,
        clmmActive: clmmInfo !== null
      });

      setLastRefresh(
        new Date().toLocaleTimeString("ru-RU")
      );
    } catch (caught) {
      if (currentRequest === requestId.current) {
        console.error("Devnet read error:", caught);
        setError(rpcErrorMessage(caught));
      }
    } finally {
      loadingRef.current = false;

      if (currentRequest === requestId.current) {
        setLoading(false);
      }
    }
  }, [connection, walletAddress]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">◈</div>
          <div>
            <strong>Liquidity Vault</strong>
            <small>SOLANA DEFI</small>
          </div>
        </div>

        <div className="nav-section">WORKSPACE</div>

        <button
          className={`nav-link ${tab === "overview" ? "active" : ""}`}
          onClick={() => setTab("overview")}
        >
          <span>▦</span> Overview
        </button>

        <button
          className={`nav-link ${tab === "admin" ? "active" : ""}`}
          onClick={() => setTab("admin")}
        >
          <span>⚙</span> Administration
        </button>

        <div className="sidebar-bottom">
          <span className="network-dot" />
          Solana Devnet
          <p>AlmaU · IT Startup · Week 14</p>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs">
            Workspace <span>/</span>
            {tab === "overview" ? "Overview" : "Administration"}
          </div>
          <div className="topbar-actions">
            <span className="network-pill">● Devnet</span>
            <WalletMultiButton />
          </div>
        </header>

        <div className="content-container">
          <div className="page-title">
            <div>
              <div className="eyebrow">
                SOLANA · LIQUIDITY MANAGEMENT
              </div>
              <h1>
                {tab === "overview"
                  ? "Vault Overview"
                  : "Vault Administration"}
              </h1>
              <p>Управление ликвидностью на Solana Devnet</p>
            </div>

            <button
              className="refresh-button"
              disabled={loading}
              onClick={() => void refresh()}
            >
              {loading ? "Загрузка..." : "↻ Обновить"}
            </button>
          </div>

          {error && (
            <div className="alert alert-error" role="alert">
              <strong>Ошибка Devnet</strong>
              <p>{error}</p>
              <button
                disabled={loading}
                onClick={() => void refresh()}
              >
                Повторить запрос
              </button>
            </div>
          )}

          {loading && !data && (
            <div className="loading-panel">
              <div className="spinner" />
              <p>Загружаем данные Devnet...</p>
            </div>
          )}

          {data && (
            <>
              <div className="metrics-grid">
                <Metric
                  icon="◈"
                  label="Vault Assets"
                  value={data.vaultTokens}
                  hint="Баланс депозитного хранилища"
                />
                <Metric
                  icon="◇"
                  label="Share Supply"
                  value={data.shareSupply}
                  hint="Все выпущенные shares"
                />
                <Metric
                  icon="◎"
                  label="Your Tokens"
                  value={data.userTokens ?? "—"}
                  hint="Твои депозитные токены"
                />
                <Metric
                  icon="▣"
                  label="Your Shares"
                  value={data.userShares ?? "—"}
                  hint="Твои share-токены"
                />
              </div>

              {tab === "overview" ? (
                <>
                  <div className="dashboard-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Your Portfolio</h2>
                          <p>Подключённый кошелёк</p>
                        </div>
                        <span className="section-symbol">◈</span>
                      </div>

                      {!connected ? (
                        <div className="empty-state">
                          <div className="empty-icon">◎</div>
                          <h3>Подключи Phantom</h3>
                          <p>
                            Подключи кошелёк, чтобы увидеть
                            балансы и операции.
                          </p>
                          <WalletMultiButton />
                        </div>
                      ) : (
                        <div className="portfolio-details">
                          <div className="portfolio-row">
                            <span>Wallet</span>
                            <strong>
                              {walletAddress
                                ? short(walletAddress)
                                : "—"}
                            </strong>
                          </div>
                          <div className="portfolio-row">
                            <span>SOL Balance</span>
                            <strong>{data.walletSol ?? "—"} SOL</strong>
                          </div>
                          <div className="portfolio-row">
                            <span>User Position</span>
                            <strong>
                              {data.positionExists
                                ? "Активирована"
                                : "Не создана"}
                            </strong>
                          </div>
                          <div className="portfolio-row">
                            <span>Access Level</span>
                            <strong>
                              {isAdmin ? "Administrator" : "User"}
                            </strong>
                          </div>
                        </div>
                      )}
                    </section>

                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Vault Information</h2>
                          <p>Адреса Solana Devnet</p>
                        </div>
                        <span className="section-symbol">⌁</span>
                      </div>

                      <div className="details-list">
                        <DetailLink
                          label="Vault PDA"
                          address={VAULT_PDA.toBase58()}
                        />
                        <DetailLink
                          label="Program"
                          address={PROGRAM_ID.toBase58()}
                        />
                        <DetailLink
                          label="Deposit Mint"
                          address={data.depositMint}
                        />
                        <DetailLink
                          label="Share Mint"
                          address={data.shareMint}
                        />
                        <DetailLink
                          label="Admin"
                          address={data.admin}
                        />
                        <DetailLink
                          label="Raydium Pool"
                          address={POOL_ID.toBase58()}
                        />
                      </div>

                      <div className="info-strip">
                        Последнее обновление: {lastRefresh}
                      </div>
                    </section>
                  </div>

                  <div className="operations-section">
                    <UserOperations
                      depositMint={data.depositMint}
                      shareMint={data.shareMint}
                      tokenVault={data.tokenVault}
                      depositDecimals={data.depositDecimals}
                      shareDecimals={data.shareDecimals}
                      userTokensRaw={data.userTokensRaw}
                      userSharesRaw={data.userSharesRaw}
                      positionExists={data.positionExists}
                      onRefresh={() => void refresh()}
                    />
                  </div>
                </>
              ) : (
                <div className="dashboard-grid">
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Strategy Controls</h2>
                        <p>Raydium CLMM</p>
                      </div>
                      <span className="section-symbol">⚙</span>
                    </div>

                    {!isAdmin && (
                      <div className="alert alert-warning">
                        Требуется кошелёк администратора Vault.
                      </div>
                    )}

                    <div className="status-row">
                      <span>CLMM Position</span>
                      <span className={
                        data.clmmActive
                          ? "status-active"
                          : "status-inactive"
                      }>
                        {data.clmmActive
                          ? "Active"
                          : "No active position"}
                      </span>
                    </div>

                    <div className="transaction-notice">
                      <strong>Admin Operations</strong>
                      <p>
                        Swap, Open Position, Collect Fees
                        и Close Position пока не отправляются
                        из Web UI. Существующие инструкции
                        Anchor остаются без изменений.
                      </p>
                    </div>
                  </section>

                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Strategy Overview</h2>
                        <p>Реальные данные Vault</p>
                      </div>
                      <span className="section-symbol">◇</span>
                    </div>

                    <div className="portfolio-details">
                      <div className="portfolio-row">
                        <span>Net Deposited Counter</span>
                        <strong>{data.totalDeposited}</strong>
                      </div>
                      <div className="portfolio-row">
                        <span>Current Vault Assets</span>
                        <strong>{data.vaultTokens}</strong>
                      </div>
                      <div className="portfolio-row">
                        <span>Total Shares</span>
                        <strong>{data.shareSupply}</strong>
                      </div>
                    </div>

                    <p className="small-note">
                      Это учётные значения, не APY и не TVL.
                    </p>
                  </section>
                </div>
              )}
            </>
          )}

          <footer className="footer">
            <span>Liquidity Vault · AlmaU IT Startup</span>
            <span>Solana Devnet · Week 14</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
