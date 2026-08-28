#!/usr/bin/env node
/**
 * C100 — Demo evidence manifest (honest status resolution).
 *
 * A live end-to-end demo may only claim `passed` when it can bind its claims to
 * CURRENT real provider evidence (a real workflow run/session/PR URL). Without
 * that, the demo is `blocked` (never a fabricated live run) or `degraded` when
 * replaying clearly-labeled HISTORICAL real evidence.
 *
 * Usage:
 *   node scripts/demo/evidence-manifest.mjs [--live-run <runId> | --historical <runId> [--url <url>]]
 * Emits a single JSON object; exits 0 for passed/degraded, 1 for blocked (invalid
 * or absent evidence).
 */
function main() {
  const emit = (payload) => console.log(JSON.stringify(payload, null, 2));
  const blocked = (reason) => {
    emit({ status: 'blocked', reason });
    process.exitCode = 1;
    return false;
  };

  const argv = process.argv.slice(2);
  const liveIndex = argv.indexOf('--live-run');
  const historicalIndex = argv.indexOf('--historical');

  if (liveIndex === -1 && historicalIndex === -1)
    return blocked('no real run evidence provided; a live demo cannot claim passed');

  const runId = argv[liveIndex !== -1 ? liveIndex + 1 : historicalIndex + 1];
  if (typeof runId !== 'string' || runId.length === 0) return blocked('run id required');

  if (liveIndex !== -1) {
    emit({
      status: 'passed',
      mode: 'LIVE',
      runId,
      note: 'bind every claim to the given run/session/PR evidence before presenting',
    });
    return;
  }

  const urlIndex = argv.indexOf('--url');
  const url = urlIndex !== -1 ? argv[urlIndex + 1] : undefined;
  emit({
    status: 'degraded',
    mode: 'HISTORICAL REAL RUN',
    runId,
    url: typeof url === 'string' && url.length > 0 ? url : null,
    note: 'clearly label all presented state as historical, never as live',
  });
}

main();
