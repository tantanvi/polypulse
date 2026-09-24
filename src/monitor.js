#!/usr/bin/env node
// PolyPulse — Polymarket anomaly monitor. Polls Gamma API, flags price/volume
// spikes, pushes alerts to Discord, and persists seen-state to avoid repeats.
import fs from 'node:fs';

const GAMMA_URL = 'https://gamma-api.polymarket.com/markets/keyset';
const STATE_PATH = new URL('../state.json', import.meta.url);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Thresholds — tuned conservatively for a first pass, adjust after seeing real alert volume.
const THRESHOLDS = {
  minVolume24hr: 5000,       // ignore illiquid markets — noise, not signal
  priceMoveAbs: 0.08,        // 8 percentage points absolute move in the outcome price
  priceMoveRel: 0.5,         // OR a 50% relative move (catches long-shot markets, e.g. 0.02 -> 0.03)
  volumeJumpMultiple: 2.5,   // 24hr volume vs the SAME metric at the last poll (rate of change, not vs. weekly average)
  volumeJumpMinAbs: 10000,   // ...and the jump itself must be at least $10k, so tiny markets don't trip on noise
  alertCooldownMs: 4 * 60 * 60 * 1000, // don't re-alert the same market+type within 4 hours
  pagesToScan: 5,            // 5 pages x 100 = 500 highest-volume active markets
  pageSize: 100,
};

async function fetchActiveMarkets() {
  const markets = [];
  let cursor = null;
  for (let page = 0; page < THRESHOLDS.pagesToScan; page++) {
    const params = new URLSearchParams({
      limit: String(THRESHOLDS.pageSize),
      closed: 'false',
      order: 'volume24hr',
      ascending: 'false',
    });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${GAMMA_URL}?${params}`);
    if (!res.ok) throw new Error(`Gamma API ${res.status}: ${await res.text()}`);
    const body = await res.json();
    markets.push(...(body.markets ?? []));
    cursor = body.next_cursor;
    if (!cursor || cursor === 'LTE=') break;
  }
  return markets;
}

function parseJsonArray(str, fallback = []) {
  try {
    return JSON.parse(str ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { markets: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function detectAnomalies(market, prevSnapshot, now) {
  const anomalies = [];
  const outcomes = parseJsonArray(market.outcomes, []);
  const prices = parseJsonArray(market.outcomePrices, []).map(Number);
  const volume24hr = market.volume24hr ?? 0;

  if (volume24hr < THRESHOLDS.minVolume24hr) return anomalies;

  // No baseline yet (first time we've seen this market) — nothing to diff against, so skip.
  // Without this, every market alerts on its very first poll using absolute volume, which is meaningless.
  if (!prevSnapshot) return anomalies;

  const lastAlerted = prevSnapshot.lastAlertedAt ?? {};
  const cooledDown = (type) => {
    const last = lastAlerted[type];
    return !last || now - new Date(last).getTime() >= THRESHOLDS.alertCooldownMs;
  };

  // Price move: compare current outcome prices against the previous poll.
  if (prevSnapshot.prices && cooledDown('price_move')) {
    outcomes.forEach((label, i) => {
      const prev = prevSnapshot.prices[i];
      const curr = prices[i];
      if (prev == null || curr == null) return;
      const abs = Math.abs(curr - prev);
      const rel = prev > 0 ? abs / prev : 0;
      if (abs >= THRESHOLDS.priceMoveAbs || rel >= THRESHOLDS.priceMoveRel) {
        anomalies.push({
          type: 'price_move',
          detail: `"${label}" ${prev.toFixed(3)} → ${curr.toFixed(3)} (${curr > prev ? '+' : ''}${(rel * 100).toFixed(0)}%)`,
        });
      }
    });
  }

  // Volume jump: rate of change in 24hr volume since the last poll, not vs. a slow-moving weekly average —
  // avoids flagging markets that are just normally ramping up (e.g. sports games near kickoff).
  const prevVolume = prevSnapshot.volume24hr ?? 0;
  const volumeDelta = volume24hr - prevVolume;
  if (
    cooledDown('volume_jump') &&
    prevVolume > 0 &&
    volumeDelta >= THRESHOLDS.volumeJumpMinAbs &&
    volume24hr >= prevVolume * THRESHOLDS.volumeJumpMultiple
  ) {
    anomalies.push({
      type: 'volume_jump',
      detail: `24hr volume $${prevVolume.toFixed(0)} → $${volume24hr.toFixed(0)} (+$${volumeDelta.toFixed(0)} since last check)`,
    });
  }

  return anomalies;
}

function formatDiscordMessage(market, anomalies) {
  const url = `https://polymarket.com/event/${market.slug}`;
  const lines = anomalies.map((a) => `• **${a.type === 'price_move' ? 'Price move' : 'Volume jump'}**: ${a.detail}`);
  return {
    content: null,
    embeds: [
      {
        title: market.question,
        url,
        description: lines.join('\n'),
        color: anomalies.some((a) => a.type === 'price_move') ? 0xe74c3c : 0xf39c12,
        footer: { text: 'PolyPulse — Polymarket anomaly monitor' },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function sendDiscordAlert(payload) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('[dry-run, no webhook set]', JSON.stringify(payload, null, 2));
    return;
  }
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const state = loadState();
  const markets = await fetchActiveMarkets();
  const now = Date.now();
  console.log(`Scanned ${markets.length} active markets.`);

  let alertCount = 0;
  for (const market of markets) {
    const prices = parseJsonArray(market.outcomePrices, []).map(Number);
    const prevSnapshot = state.markets[market.id];
    const anomalies = detectAnomalies(market, prevSnapshot, now);

    const lastAlertedAt = { ...(prevSnapshot?.lastAlertedAt ?? {}) };
    if (anomalies.length > 0) {
      alertCount++;
      await sendDiscordAlert(formatDiscordMessage(market, anomalies));
      for (const a of anomalies) lastAlertedAt[a.type] = new Date(now).toISOString();
    }

    // Always refresh the snapshot so the next run diffs against current state.
    state.markets[market.id] = {
      prices,
      volume24hr: market.volume24hr ?? 0,
      lastAlertedAt,
      seenAt: new Date(now).toISOString(),
    };
  }

  // Prune snapshots for markets no longer in the top scan window, so state.json doesn't grow forever.
  const activeIds = new Set(markets.map((m) => m.id));
  for (const id of Object.keys(state.markets)) {
    if (!activeIds.has(id)) delete state.markets[id];
  }

  saveState(state);
  console.log(`Done. ${alertCount} alert(s) sent.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
