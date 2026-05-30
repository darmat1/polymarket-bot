import { randomUUID } from "node:crypto";
import { PolymarketMarketWs, type PolymarketMarketWsEvent } from "./polymarket-market-ws.js";

export interface ArbWatchHoldBin {
  label: string;
  yesTokenId: string;
  heldShares: number;
  currentBid: number | null;
  currentAsk: number | null;
  lastUpdateAt: string | null;
}

export interface ArbWatchPosition {
  id: string;
  eventSlug: string;
  eventTitle: string;
  polymarketUrl: string;
  status: "watching" | "breakeven_hit" | "target_hit" | "stopped";
  createdAt: string;
  updatedAt: string;
  inputUsd: number;
  immediateReturnUsd: number;
  bufferUsd: number;
  targetProfitUsd: number;
  breakEvenFutureReturnUsd: number;
  targetFutureReturnUsd: number;
  requiredAvgFutureBid: number | null;
  targetAvgFutureBid: number | null;
  heldShares: number;
  currentHeldValueUsd: number;
  currentExitValueUsd: number;
  currentNetUsd: number;
  maxNetUsd: number;
  minNetUsd: number;
  maxNetAt: string;
  minNetAt: string;
  lastEvent: string;
  bins: ArbWatchHoldBin[];
  logs: Array<{ at: string; message: string; netUsd: number }>;
}

export interface CreateArbWatchInput {
  eventSlug: string;
  eventTitle: string;
  inputUsd: number;
  immediateReturnUsd: number;
  bufferUsd: number;
  targetProfitUsd: number;
  breakEvenFutureReturnUsd: number;
  targetFutureReturnUsd: number;
  requiredAvgFutureBid: number | null;
  targetAvgFutureBid: number | null;
  heldShares: number;
  heldBins: Array<{
    label: string;
    yesTokenId: string;
    heldShares: number;
    currentBid: number | null;
    currentBidSize: number | null;
  }>;
}

let marketWs: PolymarketMarketWs | null = null;
let broadcaster: ((payload: unknown) => void) | null = null;
const positions = new Map<string, ArbWatchPosition>();

export function setArbWatchBroadcaster(fn: (payload: unknown) => void): void {
  broadcaster = fn;
}

export function createArbWatchPosition(input: CreateArbWatchInput): ArbWatchPosition {
  if (!input.eventSlug || !input.eventTitle) {
    throw new Error("eventSlug and eventTitle are required");
  }
  if (!Array.isArray(input.heldBins) || input.heldBins.length === 0) {
    throw new Error("heldBins are required for watch mode");
  }

  const now = new Date().toISOString();
  const bins = input.heldBins
    .filter((bin) => bin.yesTokenId && bin.heldShares > 0)
    .map((bin) => ({
      label: bin.label,
      yesTokenId: bin.yesTokenId,
      heldShares: roundShares(bin.heldShares),
      currentBid: bin.currentBid,
      currentAsk: null,
      lastUpdateAt: null,
    }));

  if (bins.length === 0) {
    throw new Error("No valid held bins to monitor");
  }

  const currentHeldValueUsd = computeHeldValue(bins);
  const currentExitValueUsd = input.immediateReturnUsd + currentHeldValueUsd;
  const currentNetUsd = currentExitValueUsd - input.inputUsd - input.bufferUsd;
  const position: ArbWatchPosition = {
    id: randomUUID(),
    eventSlug: input.eventSlug,
    eventTitle: input.eventTitle,
    polymarketUrl: `https://polymarket.com/event/${input.eventSlug}`,
    status: statusForNet(currentNetUsd, input.targetProfitUsd),
    createdAt: now,
    updatedAt: now,
    inputUsd: roundUsd(input.inputUsd),
    immediateReturnUsd: roundUsd(input.immediateReturnUsd),
    bufferUsd: roundUsd(input.bufferUsd),
    targetProfitUsd: roundUsd(input.targetProfitUsd),
    breakEvenFutureReturnUsd: roundUsd(input.breakEvenFutureReturnUsd),
    targetFutureReturnUsd: roundUsd(input.targetFutureReturnUsd),
    requiredAvgFutureBid: input.requiredAvgFutureBid,
    targetAvgFutureBid: input.targetAvgFutureBid,
    heldShares: roundShares(input.heldShares),
    currentHeldValueUsd: roundUsd(currentHeldValueUsd),
    currentExitValueUsd: roundUsd(currentExitValueUsd),
    currentNetUsd: roundUsd(currentNetUsd),
    maxNetUsd: roundUsd(currentNetUsd),
    minNetUsd: roundUsd(currentNetUsd),
    maxNetAt: now,
    minNetAt: now,
    lastEvent: "watch created",
    bins,
    logs: [{ at: now, message: "watch created", netUsd: roundUsd(currentNetUsd) }],
  };

  positions.set(position.id, position);
  rebuildSubscriptions();
  publish(position, "created");
  return position;
}

export function listArbWatchPositions(): ArbWatchPosition[] {
  return Array.from(positions.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function stopArbWatchPosition(id: string): ArbWatchPosition {
  const position = positions.get(id);
  if (!position) {
    throw new Error(`Watch position not found: ${id}`);
  }
  position.status = "stopped";
  position.updatedAt = new Date().toISOString();
  position.lastEvent = "stopped";
  pushLog(position, "stopped");
  rebuildSubscriptions();
  publish(position, "stopped");
  return position;
}

function ensureMarketWs(): PolymarketMarketWs {
  if (!marketWs) {
    marketWs = new PolymarketMarketWs(handleMarketWsEvent);
  }
  return marketWs;
}

function rebuildSubscriptions(): void {
  const tokenIds = new Set<string>();
  for (const position of positions.values()) {
    if (position.status === "stopped") continue;
    for (const bin of position.bins) {
      tokenIds.add(bin.yesTokenId);
    }
  }

  if (tokenIds.size === 0) {
    marketWs?.setTrackedAssets([]);
    return;
  }

  ensureMarketWs().setTrackedAssets(Array.from(tokenIds));
}

function handleMarketWsEvent(event: PolymarketMarketWsEvent): void {
  if (event.kind !== "book") return;
  const now = new Date(event.timestamp || Date.now()).toISOString();

  for (const position of positions.values()) {
    if (position.status === "stopped") continue;
    let touched = false;
    for (const bin of position.bins) {
      if (bin.yesTokenId !== event.assetId) continue;
      bin.currentBid = event.bestBid;
      bin.currentAsk = event.bestAsk;
      bin.lastUpdateAt = now;
      touched = true;
    }
    if (!touched) continue;

    updatePositionValue(position, now);
    publish(position, "price_update");
  }
}

function updatePositionValue(position: ArbWatchPosition, now: string): void {
  const currentHeldValueUsd = computeHeldValue(position.bins);
  const currentExitValueUsd = position.immediateReturnUsd + currentHeldValueUsd;
  const currentNetUsd = currentExitValueUsd - position.inputUsd - position.bufferUsd;
  const nextStatus = statusForNet(currentNetUsd, position.targetProfitUsd);
  const wasTarget = position.status === "target_hit";
  const wasBreakeven = position.status === "breakeven_hit";

  position.currentHeldValueUsd = roundUsd(currentHeldValueUsd);
  position.currentExitValueUsd = roundUsd(currentExitValueUsd);
  position.currentNetUsd = roundUsd(currentNetUsd);
  position.updatedAt = now;
  position.status = nextStatus;
  position.lastEvent = "price update";

  if (position.currentNetUsd > position.maxNetUsd) {
    position.maxNetUsd = position.currentNetUsd;
    position.maxNetAt = now;
  }
  if (position.currentNetUsd < position.minNetUsd) {
    position.minNetUsd = position.currentNetUsd;
    position.minNetAt = now;
  }

  if (nextStatus === "target_hit" && !wasTarget) {
    pushLog(position, "target hit");
  } else if (nextStatus === "breakeven_hit" && !wasBreakeven && !wasTarget) {
    pushLog(position, "breakeven hit");
  } else {
    pushLog(position, "price update");
  }
}

function computeHeldValue(bins: ArbWatchHoldBin[]): number {
  return bins.reduce((sum, bin) => sum + bin.heldShares * (bin.currentBid ?? 0), 0);
}

function statusForNet(netUsd: number, targetProfitUsd: number): ArbWatchPosition["status"] {
  if (netUsd >= targetProfitUsd) return "target_hit";
  if (netUsd >= 0) return "breakeven_hit";
  return "watching";
}

function pushLog(position: ArbWatchPosition, message: string): void {
  position.logs = [
    { at: new Date().toISOString(), message, netUsd: position.currentNetUsd },
    ...position.logs,
  ].slice(0, 50);
}

function publish(position: ArbWatchPosition, reason: string): void {
  broadcaster?.({ type: "arb_watch_update", reason, position });
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundShares(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
