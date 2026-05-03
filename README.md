# Polymarket Weather Bot

A fully containerized bot for monitoring and trading on Polymarket weather markets.

## Quick Start

1. **Clone the repository**
2. **Setup environment variables**:
   Create a `.env` file in the `backend` directory (see `backend/.env.example` for reference).
   ```bash
   cp backend/.env.example backend/.env
   ```
3. **Fill in the variables**:
   See the **Environment Variables** section below for details.

4. **Run with Docker**:
   ```bash
   docker-compose up --build -d
   ```
   The application will be available at `http://localhost:3001`.

## Environment Variables (.env)

The following variables should be set in `backend/.env`:

### Authentication

- `POLYMARKET_PRIVATE_KEY`: Your wallet's private key (Required for L1 auth).
- `GROQ_API_KEY`: Your API key for Groq (Required for weather analysis).

### L2 Credentials (Optional / Fallback)

If the bot cannot derive keys automatically due to Cloudflare (403 error), provide these manually:

- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`
- `POLYMARKET_API_PASSPHRASE`

### Advanced

- `POLYMARKET_FUNDER_ADDRESS`: Address of the funder wallet (if different from signer).
- `RELAYER_API_KEY` & `RELAYER_API_KEY_ADDRESS`: Used if you are using a custom relayer.

## Docker Troubleshooting (macOS)

If you encounter an error like `ERROR: load metadata for docker.io/library/node:22-slim` during build on Mac:

1. Open `~/.docker/config.json`.
2. **Delete** the line containing `"credsStore": "desktop"`.
3. Save the file and **Restart Docker Desktop**.

## Cloudflare / 403 Forbidden

If you see a `403 Forbidden` error during startup:

1. Go to Polymarket.com -> Settings -> API Keys.
2. Create a new API Key.
3. Manually fill in the `POLYMARKET_API_KEY`, `SECRET`, and `PASSPHRASE` in your `.env`.
