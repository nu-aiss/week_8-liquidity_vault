import React, { useMemo } from "react";
import ReactDOM from "react-dom/client";

import {
  ConnectionProvider,
  WalletProvider
} from "@solana/wallet-adapter-react";

import {
  WalletModalProvider
} from "@solana/wallet-adapter-react-ui";

import {
  PhantomWalletAdapter
} from "@solana/wallet-adapter-phantom";

import App from "./App";

import "./styles.css";
import "./operations.css";
import "@solana/wallet-adapter-react-ui/styles.css";

const DEVNET_RPC = "https://api.devnet.solana.com";

function SolanaProviders() {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider
      endpoint={DEVNET_RPC}
      config={{ commitment: "confirmed" }}
    >
      <WalletProvider
        wallets={wallets}
        autoConnect={false}
        onError={(error) => {
          console.error("Wallet error:", error);
        }}
      >
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

ReactDOM.createRoot(
  document.getElementById("root")!
).render(
  <SolanaProviders />
);
