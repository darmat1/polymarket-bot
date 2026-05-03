import { updateRuntimeAllowance, updateTokenAllowance } from "../src/app.js";

async function main() {
  console.log("🛠  Starting wallet setup...");
  
  try {
    console.log("⏳ Step 1: Approving USDC (collateral)...");
    await updateRuntimeAllowance();
    console.log("✅ USDC approved.");

    console.log("⏳ Step 2: Approving Polymarket Tokens (ERC1155)...");
    await updateTokenAllowance();
    console.log("✅ Tokens approved.");

    console.log("\n🎉 Wallet setup complete! Your wallet is now ready for automated trading.");
  } catch (error) {
    console.error("\n❌ Setup failed:", error);
    process.exit(1);
  }
}

main();
