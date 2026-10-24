// Serializes apply() calls within one storage instance (one process / one isolate). This protects
// the instance's own connection or map from interleaved transactions. It is not a distributed lock;
// cross-process safety comes from the provider transaction plus the expected-version checks.
export function createLock(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}
