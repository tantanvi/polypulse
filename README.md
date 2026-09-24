# PolyPulse

Open-source anomaly monitor for [Polymarket](https://polymarket.com). It polls the top ~500 active markets by volume every 5 minutes, flags sudden price moves or volume jumps, and posts alerts to a Discord channel via webhook. Runs entirely on GitHub Actions — no server, no hosting cost.

## What it flags

- **Price move**: an outcome's price shifts by ≥8 percentage points, or ≥50% relatively, between two consecutive polls.
- **Volume jump**: 24hr trading volume jumps by ≥2.5x *and* by at least $10k versus the previous poll (5 minutes prior) — this looks at rate of change, not just "high volume," so markets that are just normally busy (e.g. a sports game near kickoff) don't spam alerts.

Each market has a 4-hour cooldown per alert type, so a market that's actively moving doesn't flood the channel every 5 minutes.

Markets under $5,000 in 24hr volume are skipped — too illiquid for the price/volume signals to mean much.

## Setup

1. Fork or clone this repo.
2. Create a Discord webhook: Server Settings → Integrations → Webhooks → New Webhook → copy the URL.
3. In your repo: Settings → Secrets and variables → Actions → New repository secret → name it `DISCORD_WEBHOOK_URL`, paste the webhook URL.
4. The workflow in `.github/workflows/monitor.yml` runs automatically every 5 minutes once it's on the default branch. You can also trigger it manually from the Actions tab (`workflow_dispatch`).

## Run locally

```bash
npm install # no dependencies currently, but keeps the lockfile-free setup explicit
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... node src/monitor.js
```

Without `DISCORD_WEBHOOK_URL` set, alerts print to stdout instead of posting (dry-run mode) — useful for tuning thresholds locally.

## Tuning

All thresholds live in `THRESHOLDS` at the top of `src/monitor.js`. Notable ones:

- `minVolume24hr` — liquidity floor to bother watching a market at all.
- `priceMoveAbs` / `priceMoveRel` — price move sensitivity.
- `volumeJumpMultiple` / `volumeJumpMinAbs` — volume jump sensitivity.
- `alertCooldownMs` — minimum gap between repeat alerts on the same market+type.
- `pagesToScan` / `pageSize` — how many markets to scan per run (currently top 500 by 24hr volume).

## How it works

- Market data comes from Polymarket's public Gamma API (`/markets/keyset`) — no API key required.
- State (last-seen prices/volume per market, plus per-alert-type cooldown timestamps) is persisted to `state.json`, committed back to the repo by the GitHub Action after each run. This is what makes the "did this change since last poll" comparison possible across runs.
- No trading, no wallet, no funds at risk — this is a read-only observer.

## License

MIT
