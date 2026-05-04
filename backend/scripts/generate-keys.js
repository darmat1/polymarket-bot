const { ClobClient } = require("@polymarket/clob-client");
const { ethers } = require("ethers");

async function generateKeys() {
    // Вставьте ваш приватный ключ
    const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;

    try {
        const wallet = new ethers.Wallet(PRIVATE_KEY);
        console.log(`Подключен кошелек: ${wallet.address}`);

        const client = new ClobClient(
            "https://clob.polymarket.com",
            137, // Chain ID для Polygon
            wallet
        );

        console.log("Получаем API-ключи...");

        // 🔥 ИСПОЛЬЗУЕМ УМНУЮ ФУНКЦИЮ:
        const credentials = await client.createOrDeriveApiKey();

        console.log("\n✅ УСПЕХ! Вот ваши ключи (скопируйте их в .env):\n");

        // Библиотека может возвращать ключ как apiKey или как key, учтем оба варианта:
        const finalKey = credentials.apiKey || credentials.key;

        console.log(`POLYMARKET_API_KEY=${finalKey}`);
        console.log(`POLYMARKET_API_SECRET=${credentials.secret}`);
        console.log(`POLYMARKET_API_PASSPHRASE=${credentials.passphrase}`);

    } catch (error) {
        console.error("\n❌ Ошибка:", error.message);
        if (error.response) {
            console.error("Детали:", error.response.data);
        }
    }
}

generateKeys();