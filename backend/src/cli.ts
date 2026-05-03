import { Command } from "commander";
import { type TickSize } from "@polymarket/clob-client-v2";

import { deriveApiCreds, evaluateMarket, placeLimitOrder, scanMarkets } from "./app.js";

function buildProgram(): Command {
  const program = new Command();
  program.name("polymarket-weather-bot").description("Polymarket weather bot");

  program
    .command("scan")
    .option("--limit <number>", "Number of markets", "10")
    .action(async (options) => {
      const markets = await scanMarkets({
        limit: Number(options.limit),
      });

      if (markets.length === 0) {
        console.log("No markets found for the selected filters.");
        return;
      }

      for (const market of markets) {
        console.log(`${market.slug} | ${market.question}`);
        for (const outcome of market.outcomes) {
          console.log(`  - ${outcome.label}: ${outcome.tokenId}`);
        }
      }
    });

  program
    .command("derive-api-creds")
    .action(async () => {
      const creds = await deriveApiCreds();
      console.log(JSON.stringify(creds, null, 2));
    });

  program
    .command("evaluate")
    .requiredOption("--market-slug <slug>", "Market slug")
    .option("--outcome <label>", "Outcome label")
    .requiredOption("--fair-probability <number>", "Fair probability")
    .action(async (options) => {
      const payload = await evaluateMarket({
        marketSlug: options.marketSlug,
        outcome: options.outcome,
        fairProbability: Number(options.fairProbability),
      });
      console.log(JSON.stringify(payload, null, 2));
    });

  program
    .command("place-limit")
    .requiredOption("--token-id <tokenId>", "Token ID")
    .requiredOption("--side <side>", "buy or sell")
    .requiredOption("--price <number>", "Price")
    .requiredOption("--size <number>", "Size")
    .option("--tick-size <tickSize>", "Tick size", "0.01")
    .action(async (options) => {
      if (options.side !== "buy" && options.side !== "sell") {
        throw new Error("side must be 'buy' or 'sell'");
      }

      const response = await placeLimitOrder({
        tokenId: options.tokenId,
        side: options.side,
        price: Number(options.price),
        size: Number(options.size),
        tickSize: parseTickSize(options.tickSize),
      });
      console.log(JSON.stringify(response, null, 2));
    });

  return program;
}

function parseTickSize(value: string): TickSize {
  if (value === "0.1" || value === "0.01" || value === "0.001" || value === "0.0001") {
    return value;
  }
  throw new Error("tick-size must be one of: 0.1, 0.01, 0.001, 0.0001");
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
