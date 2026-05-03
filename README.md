# Polymarket Weather Bot

A fully containerized bot for monitoring and trading on Polymarket weather markets.

## Quick Start

1. **Clone the repository**
2. **Setup environment variables**:
   Create a `.env` file in the `backend` directory (see `backend/.env.example` for reference).
   ```bash
   cp backend/.env.example backend/.env
   ```
   Fill in your `POLYMARKET_PRIVATE_KEY` or manual API keys.

3. **Run with Docker**:
   ```bash
   docker-compose up --build -d
   ```
   The application will be available at `http://localhost:3001`.

## Docker Troubleshooting (macOS)

If you encounter an error like `ERROR: load metadata for docker.io/library/node:22-slim` during build on Mac, it is likely an issue with the Docker credential helper.

**Fix**:
1. Open `~/.docker/config.json` in a text editor.
2. Find the `"credsStore"` field.
3. Change its value from `desktop` to `osxkeychain` (or vice versa, or remove the line if it persists).
   ```json
   {
     "credsStore": "osxkeychain"
   }
   ```
4. Restart Docker Desktop.

## Cloudflare / 403 Forbidden

If the bot fails to start with a `403 Forbidden` error from Cloudflare, it means automatic API key derivation is blocked.

**Fix**:
Generate your API keys manually on the Polymarket website (Settings -> API Keys) and add them to `backend/.env`:
```env
POLYMARKET_API_KEY=your_key
POLYMARKET_API_SECRET=your_secret
POLYMARKET_API_PASSPHRASE=your_passphrase
```

## Development

To run locally without Docker:
```bash
pnpm install
pnpm dev
```
