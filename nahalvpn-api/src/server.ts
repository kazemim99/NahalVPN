import { loadConfig } from "./config.js";
import { compose } from "./compose.js";

const config = loadConfig();
const { app, provisioning, usage, health } = compose(config, { logLevel: process.env.LOG_LEVEL ?? "warn" });

/** Runs `job` every `ms`, never overlapping itself; errors are logged, not fatal. */
function every(name: string, ms: number, job: () => Promise<unknown>): void {
  if (ms <= 0) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await job();
    } catch (err) {
      console.error(`[nahalvpn-api] ${name} failed:`, err);
    } finally {
      running = false;
    }
  };
  setInterval(tick, ms).unref();
  void tick();
}

async function start(): Promise<void> {
  // The gateway xray keeps runtime users in memory only; this service restarts with it (PartOf=) and re-adds them.
  const r = await provisioning.resync();
  console.log(`[nahalvpn-api] gateway resync: ${r.added} added, ${r.failed} failed`);
  const addr = await app.listen({ host: config.host, port: config.port });
  console.log(`[nahalvpn-api] listening on ${addr}`);
  every("health", config.healthIntervalMs, () => health.tick());
  every("usage", config.usageIntervalMs, async () => {
    await provisioning.retryPendingRemovals();
    await usage.tick();
  });
}

start().catch((err) => {
  console.error("[nahalvpn-api] failed to start:", err);
  process.exit(1);
});
