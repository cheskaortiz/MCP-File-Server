const tails = new Map<string, Promise<void>>();

/**
 * Serialize async work per key (we use the absolute file path). This makes
 * "check if_version, then write" atomic among all sessions served by THIS process.
 * It does not protect against other processes editing the files directly.
 */
export async function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate);
  tails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
