/**
 * Bound a third-party call in time.
 *
 * SDKs without a timeout of their own (Firebase Admin, among others) can hang
 * indefinitely, holding an Express worker — and any lock the caller took —
 * until the process restarts. The underlying request is not aborted, but the
 * caller stops waiting and gets an error it can answer with.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
