import { getChainFacts } from "./facts.js";

// `tx <hash>` — read-only cross-VM diagnosis. Rome has no debug_trace*; the substitute
// is the EVM receipt + `rome_solanaTxForEvmTx` (EVM hash → the Solana settlement tx(s),
// raw JSON-RPC, no SDK wrapper) + a Via explorer link. One injectable RpcCall keeps it
// testable without a network.

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export interface TxDiagnosis {
  chainId: number;
  hash: string;
  status: "success" | "reverted" | "pending";
  receipt: { blockNumber: string; gasUsed: string; from: string; to: string | null } | null;
  solanaSettlement: string[];
  explorer: string;
  note: string;
}

function realRpcCall(rpcUrl: string): RpcCall {
  return async (method, params) => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (j.error) throw new Error(j.error.message ?? "rpc error");
    return j.result;
  };
}

export async function diagnoseTx(chain: string | number, hash: string, call?: RpcCall): Promise<TxDiagnosis> {
  const c = getChainFacts(chain);
  const rpc = call ?? realRpcCall(c.rpcUrl);

  const receiptRaw = (await rpc("eth_getTransactionReceipt", [hash])) as Record<string, string> | null;

  // Tolerate the method being unavailable on a given proxy (→ []).
  let solanaSettlement: string[] = [];
  try {
    const sol = await rpc("rome_solanaTxForEvmTx", [hash]);
    if (Array.isArray(sol)) solanaSettlement = sol as string[];
  } catch {
    solanaSettlement = [];
  }

  const status: TxDiagnosis["status"] = !receiptRaw ? "pending" : receiptRaw.status === "0x1" ? "success" : "reverted";
  const receipt = receiptRaw
    ? { blockNumber: receiptRaw.blockNumber, gasUsed: receiptRaw.gasUsed, from: receiptRaw.from, to: receiptRaw.to ?? null }
    : null;

  const explorerBase = ((c as { explorerUrl?: string }).explorerUrl ?? "").replace(/\/?$/, "/");
  const explorer = explorerBase ? `${explorerBase}tx/${hash}` : hash;
  const note =
    status === "pending"
      ? "No receipt yet — the tx may still be settling (Rome indexes the EVM block after the Solana tx lands)."
      : status === "reverted"
        ? "Reverted. Rome has no debug_trace*; re-run the same inputs via rome_emulateTx to see the failure."
        : "Confirmed. solanaSettlement lists the Solana tx(s) that settled this EVM tx.";

  return { chainId: c.chainId, hash, status, receipt, solanaSettlement, explorer, note };
}
