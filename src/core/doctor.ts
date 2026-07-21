import { getChainFacts } from "./facts.js";
import { defaultDeps, type Deps } from "./deps.js";

// `doctor` — a read-only preflight. Composes registry facts + a live RPC ping so a
// builder (or agent) can confirm the environment is sane before deploying/sending.
// No key: the optional funded check takes a plain address.

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  chain: { id: number; name: string; network: string; status: string };
  checks: DoctorCheck[];
  ok: boolean;
}

export async function doctor(
  chain: string | number,
  address: string | undefined,
  deps: Deps = defaultDeps,
): Promise<DoctorResult> {
  const c = getChainFacts(chain); // throws "Unknown chain …" on a bad chain
  const status = (c as { status?: string }).status ?? "unknown";
  const network = (c as { network?: string }).network ?? "";
  const checks: DoctorCheck[] = [
    { name: "chain-live", ok: status === "live", detail: `status=${status}` },
    { name: "program-configured", ok: Boolean(c.romeEvmProgramId), detail: c.romeEvmProgramId || "(none)" },
  ];

  // rpc-reachable: a live gas-price ping proves the configured RPC actually answers.
  const rpc = deps.makeRpc(c.rpcUrl);
  try {
    const gp = await rpc.getGasPrice();
    checks.push({ name: "rpc-reachable", ok: true, detail: `${c.rpcUrl} (gasPrice ${gp.toString()} wei)` });
  } catch (e) {
    checks.push({ name: "rpc-reachable", ok: false, detail: `${c.rpcUrl} unreachable: ${(e as Error).message}` });
  }

  if (address) {
    try {
      const bal = await rpc.getBalance(address);
      checks.push({ name: "wallet-funded", ok: bal > 0n, detail: `${bal.toString()} wei (${c.nativeCurrency.symbol})` });
    } catch (e) {
      checks.push({ name: "wallet-funded", ok: false, detail: `balance check failed: ${(e as Error).message}` });
    }
  }

  return { chain: { id: c.chainId, name: c.name, network, status }, checks, ok: checks.every((x) => x.ok) };
}
