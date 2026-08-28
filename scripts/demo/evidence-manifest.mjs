#!/usr/bin/env node
function main() {
  const emit = (payload) => console.log(JSON.stringify(payload, null, 2));
  const blocked = (reason) => {
    emit({ status: 'blocked', reason });
    process.exitCode = 1;
  };
  const argv = process.argv.slice(2),
    live = argv.indexOf('--live-run'),
    historical = argv.indexOf('--historical');
  if ((live !== -1 && historical !== -1) || (live === -1 && historical === -1))
    return blocked('exactly one evidence mode is required');
  const index = live !== -1 ? live : historical;
  const runId = argv[index + 1];
  if (!/^[A-Za-z0-9_-]+$/.test(runId ?? '')) return blocked('valid run id required');
  if (live !== -1) return blocked('live evidence requires provider-authenticated verification');
  const urlIndex = argv.indexOf('--url'),
    url = urlIndex !== -1 ? argv[urlIndex + 1] : undefined;
  if (urlIndex !== -1 && (!url || !/^https:\/\//.test(url)))
    return blocked('historical URL must be HTTPS');
  emit({
    status: 'degraded',
    mode: 'HISTORICAL REAL RUN',
    runId,
    url: url ?? null,
    note: 'clearly label all presented state as historical, never as live',
  });
}
main();
