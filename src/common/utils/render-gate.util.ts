import { Logger } from "@nestjs/common";

/**
 * A ceiling on how many headless browsers run at once.
 *
 * Invoice and statement rendering each launch a full Chromium **per request**
 * and there was no cap anywhere. A single authenticated customer refreshing
 * their invoice could start as many as the request rate allowed — each one
 * hundreds of megabytes — and take the API down without anything resembling
 * an attack. It only needs to happen once, by accident, on a busy day.
 *
 * Deliberately a small semaphore rather than a queue with unlimited depth:
 * waiting forever for a PDF is its own failure. Past `MAX_WAIT_MS` the caller
 * is told the renderer is busy and can retry, which is a far better outcome
 * than the process dying and taking every other request with it.
 */
const MAX_CONCURRENT = Number(process.env.PDF_MAX_CONCURRENCY ?? 2);
/*
 * Long enough to queue behind one slow render, short enough that a caller
 * gets an answer. A render is ~10s here and slower in the container, so a
 * 20s ceiling meant the third concurrent request was refused while the two
 * ahead of it were still perfectly healthy.
 */
const MAX_WAIT_MS = Number(process.env.PDF_MAX_WAIT_MS ?? 45_000);

const logger = new Logger("RenderGate");

let active = 0;
const waiting: Array<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];

function release(): void {
  const next = waiting.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
    return;
  }
  active = Math.max(0, active - 1);
}

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const entry = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const i = waiting.indexOf(entry);
        if (i >= 0) waiting.splice(i, 1);
        reject(new Error("PDF renderer is busy — try again in a moment"));
      }, MAX_WAIT_MS),
    };
    waiting.push(entry);
  });
}

/**
 * Run `fn` with a rendering slot held, releasing it however `fn` ends.
 *
 * Every Puppeteer launch in the codebase should go through this. The browser
 * itself is still each caller's responsibility to close — this only bounds how
 * many exist at once.
 */
export async function withRenderSlot<T>(label: string, fn: () => Promise<T>): Promise<T> {
  await acquire();
  const started = Date.now();
  try {
    return await fn();
  } finally {
    release();
    const ms = Date.now() - started;
    if (ms > 10_000) logger.warn(`${label} render took ${ms}ms (slots in use: ${active})`);
  }
}
