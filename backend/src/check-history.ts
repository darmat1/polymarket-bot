import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097CAe4B54fafa76";
const CTF_ABI = [
  "event ConditionPreparation(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint outcomeSlotCount)"
];

async function main() {
  const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon.llamarpc.com";
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

  console.log("Checking last 5 ConditionPreparation events on Polymarket CTF...");
  
  const currentBlock = await provider.getBlockNumber();
  // Look back ~24 hours (approx 40,000 blocks on Polygon)
  const filter = contract.filters.ConditionPreparation();
  const events = await contract.queryFilter(filter, currentBlock - 40000, currentBlock);

  const lastEvents = events.slice(-5).reverse();
  
  if (lastEvents.length === 0) {
    console.log("No events found in the last 24 hours.");
    return;
  }

  for (const event of lastEvents) {
    const block = await event.getBlock();
    const time = new Date(block.timestamp * 1000).toLocaleString();
    console.log(`- Time: ${time} | Block: ${event.blockNumber} | Tx: ${event.transactionHash}`);
  }
}

main().catch(console.error);
