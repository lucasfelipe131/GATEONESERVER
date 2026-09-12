// One in-flight batch per process; database leases handle hard process death.
export function startOutboxRuntime({ dispatcher, intervalMs = 1000, logger = console }) {
  let stopped = false, timer, active = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    active = dispatcher.dispatchBatch().catch(() => {
      logger.error('OUTBOX_BATCH_FAILED');
    }).finally(() => {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    });
  };
  tick();
  return { async stop() { stopped = true; clearTimeout(timer); await active; } };
}
