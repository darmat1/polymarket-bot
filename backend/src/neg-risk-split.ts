// backend/src/neg-risk-split.ts
import { loadSettings } from "./config.js";
import { ClobPublicClient } from "./clob.js";
import { createWalletClient, createPublicClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296" as const;
const USDC_ADDRESS     = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;

const ERC20_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner",   type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount",  type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const NEG_RISK_ADAPTER_ABI = [
  {
    name: "splitPosition",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken",    type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId",        type: "bytes32" },
      { name: "partition",          type: "uint256[]" },
      { name: "amount",             type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export interface SplitBin {
  label: string;
  yesTokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
}

export interface SplitAnalysis {
  eventSlug: string;
  eventTitle: string;
  resolutionDate: string;
  isNegRisk: boolean;
  negRiskConditionId: string | null;
  bins: SplitBin[];
  sumYesMid: number;
  arbOpportunity: "split" | "merge" | "none";
  isWeatherMarket: boolean;
}

export function parseEventSlug(url: string): string {
  const match = url.match(/polymarket\.com\/event\/([^/?#]+)/);
  if (!match) throw new Error("Could not parse Polymarket event URL");
  return match[1];
}

export async function analyzeNegRiskEvent(eventUrl: string): Promise<SplitAnalysis> {
  const settings = loadSettings();
  const eventSlug = parseEventSlug(eventUrl);

  const gammaHost = settings.gammaHost;

  const url = new URL("/events", gammaHost);
  url.searchParams.set("slug", eventSlug);
  url.searchParams.set("limit", "1");
  const eventsRes = await fetch(url.toString());
  if (!eventsRes.ok) throw new Error(`Gamma API error: ${eventsRes.status}`);
  const events = await eventsRes.json() as any[];
  if (!events || events.length === 0) throw new Error(`Event not found: ${eventSlug}`);

  const event = events[0];
  const markets: any[] = event.markets ?? [];
  const negRiskConditionId: string | null = event.negRiskMarketID ?? event.negRiskId ?? null;
  const isNegRisk = (event.negRisk === true || !!negRiskConditionId) && markets.length > 1;

  const clobHost = settings.polymarketHost;
  const clob = new ClobPublicClient(clobHost);

  const bins: SplitBin[] = await Promise.all(
    markets.map(async (m: any) => {
      const rawTokenIds = m.clobTokenIds;
      let tokenIds: string[] = [];
      if (Array.isArray(rawTokenIds)) {
        tokenIds = rawTokenIds;
      } else if (typeof rawTokenIds === "string") {
        try {
          const parsed = JSON.parse(rawTokenIds);
          tokenIds = Array.isArray(parsed) ? parsed : [];
        } catch {
          tokenIds = [];
        }
      }
      const yesTokenId = tokenIds[0] ?? "";

      let bestBid: number | null = null;
      let bestAsk: number | null = null;
      let midPrice: number | null = null;
      if (yesTokenId) {
        try {
          const top = await clob.getTopOfBook(yesTokenId);
          bestBid = top.bestBid;
          bestAsk = top.bestAsk;
          midPrice = top.midpoint;
        } catch { /* no liquidity */ }
      }

      return {
        label: m.groupItemTitle ?? m.outcomes?.[0] ?? m.question ?? "?",
        yesTokenId,
        bestBid,
        bestAsk,
        midPrice,
      };
    })
  );

  const sumYesMid = bins.reduce((s, b) => s + (b.midPrice ?? 0), 0);
  const ARB_THRESHOLD = 0.02;
  const arbOpportunity =
    sumYesMid < 1.0 - ARB_THRESHOLD ? "merge" :
    sumYesMid > 1.0 + ARB_THRESHOLD ? "split" : "none";

  const titleLower = (event.title ?? eventSlug).toLowerCase();
  const isWeatherMarket = titleLower.includes("temperature") ||
    titleLower.includes("highest temp") ||
    titleLower.includes("weather");

  return {
    eventSlug,
    eventTitle: event.title ?? eventSlug,
    resolutionDate: event.endDate ?? "",
    isNegRisk,
    negRiskConditionId,
    bins,
    sumYesMid,
    arbOpportunity,
    isWeatherMarket,
  };
}

export interface SplitResult {
  approveTxHash: string | null;
  splitTxHash: string;
  amountUsdc: number;
  binCount: number;
}

export async function executeNegRiskSplit(
  negRiskConditionId: string,
  amountUsdc: number,
  binCount: number,
): Promise<SplitResult> {
  const settings = loadSettings();
  if (!settings.privateKey) throw new Error("No private key configured");

  if (settings.dryRun) {
    console.log(`[DryRun] Would split $${amountUsdc} USDC for conditionId ${negRiskConditionId}`);
    return { approveTxHash: null, splitTxHash: "dry-run-no-tx", amountUsdc, binCount };
  }

  const rpcUrl = process.env.POLYGON_RPC_URL ?? "https://polygon.llamarpc.com";
  const normalized = settings.privateKey.startsWith("0x")
    ? settings.privateKey as `0x${string}`
    : `0x${settings.privateKey}` as `0x${string}`;

  const account = privateKeyToAccount(normalized);
  const publicClient  = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  const walletClient  = createWalletClient({ account, chain: polygon, transport: http(rpcUrl) });

  const amountRaw = parseUnits(amountUsdc.toFixed(6), 6);

  // 1. Check allowance
  const allowance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, NEG_RISK_ADAPTER],
  }) as bigint;

  let approveTxHash: string | null = null;
  if (allowance < amountRaw) {
    const MAX = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    const hash = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [NEG_RISK_ADAPTER, MAX],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    approveTxHash = hash;
  }

  // 2. Build partition bitmask: [1, 2, 4, 8, ...] for N bins
  const partition = Array.from({ length: binCount }, (_, i) => BigInt(1) << BigInt(i));

  // 3. Execute splitPosition
  const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
  const splitTxHash = await walletClient.writeContract({
    address: NEG_RISK_ADAPTER,
    abi: NEG_RISK_ADAPTER_ABI,
    functionName: "splitPosition",
    args: [
      USDC_ADDRESS,
      ZERO_BYTES32,
      negRiskConditionId as `0x${string}`,
      partition,
      amountRaw,
    ],
  });

  await publicClient.waitForTransactionReceipt({ hash: splitTxHash });
  return { approveTxHash, splitTxHash, amountUsdc, binCount };
}
