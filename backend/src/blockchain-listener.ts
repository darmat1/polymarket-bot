import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { WebSocket } from "ws";

dotenv.config();

// Polymarket Conditional Tokens Framework (CTF) Address on Polygon
const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097cae4b54fafa76";

// Minimal ABI for ConditionPreparation event (emitted when a new market is initialized)
const CTF_ABI = [
  "event ConditionPreparation(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint outcomeSlotCount)"
];

async function main() {
  console.log("Starting Polymarket Blockchain Listener...");

  // In Docker, 'bot' is the service name for the main server
  const wsUrl = process.env.WS_SERVER_URL || "ws://bot:3001";
  console.log(`Connecting to WebSocket server: ${wsUrl}`);
  
  let ws: WebSocket;
  let statusInterval: NodeJS.Timeout | null = null;

  function sendListenerStatus(connected: boolean) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "scanner_listener_status",
        connected,
        timestamp: Date.now(),
      }));
    }
  }

  function connectWS() {
    ws = new WebSocket(wsUrl);
    ws.on("open", () => {
      console.log("Connected to main server WebSocket");
      sendListenerStatus(true);
      if (statusInterval) {
        clearInterval(statusInterval);
      }
      statusInterval = setInterval(() => sendListenerStatus(true), 15000);
    });
    ws.on("error", (err) => console.error("WS Error:", err.message));
    ws.on("close", () => {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
      console.log("WS connection closed, retrying in 5s...");
      setTimeout(connectWS, 5000);
    });
  }
  connectWS();

  // Use an RPC URL from env, or a stable public fallback for Polygon
  const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";
  console.log(`Connecting to Polygon RPC: ${rpcUrl}`);

  // Manually specify network to avoid detection errors
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, {
    name: "polygon",
    chainId: 137,
  });
  const ctfContract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

  // Immediate connectivity check
  provider.getNetwork()
    .then(n => console.log(`✅ Network connected: ${n.name} (${n.chainId})`))
    .catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("❌ Network connection failed:", msg);
    });

  // Periodically log current block to show it's working
  setInterval(async () => {
    try {
      const block = await provider.getBlockNumber();
      console.log(`📡 Listener heartbeat: Current Polygon block ${block}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Heartbeat error:", msg);
    }
  }, 30000); // Check every 30s for faster debugging

  console.log("Listening for new ConditionPreparation events (New Markets)...");

  // Subscribe to the event
  ctfContract.on("ConditionPreparation", (conditionId, oracle, questionId, outcomeSlotCount, event) => {
    console.log("========================================");
    console.log("🔥 NEW MARKET DETECTED ON BLOCKCHAIN 🔥");
    console.log("========================================");
    
    const data = {
      type: "scanner_event",
      conditionId,
      oracle,
      questionId,
      outcomeSlotCount: outcomeSlotCount.toString(),
      txHash: event.transactionHash,
      blockNumber: event.blockNumber,
      timestamp: Date.now()
    };

    console.log(JSON.stringify(data, null, 2));

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  });

  // Keep process alive
  process.on('SIGINT', () => {
    console.log("Shutting down listener...");
    process.exit();
  });
}

main().catch(console.error);
