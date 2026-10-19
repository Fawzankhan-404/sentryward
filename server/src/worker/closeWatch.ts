// Notices a review being cancelled, or its PR/MR being closed or merged, while
// it runs, so the worker can stop spending model calls on it and skip publishing. Checks are chained
// rather than on an interval so a slow forge never has two in flight.

export interface CloseWatch {
  // Fires once the review is found cancelled or the change closed; model calls made through
  // abortableGenerate stop with it.
  signal: AbortSignal;
  // Checks once more, now: the last chance before anything is published.
  closedNow(): Promise<boolean>;
  stop(): void;
}

export const CLOSE_CHECK_INTERVAL_MS = 15_000;

// `isClosed` is any check that can say the review should stop. A failed check
// counts as open: a flaky forge must not cancel reviews.
export function watchForClose(isClosed: () => Promise<boolean>, intervalMs = CLOSE_CHECK_INTERVAL_MS): CloseWatch {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const check = async (): Promise<boolean> => {
    if (controller.signal.aborted) return true;
    const closed = await isClosed().catch(() => false);
    if (closed) controller.abort(new Error("Review cancelled"));
    return closed;
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void check().then((closed) => !closed && schedule()), intervalMs);
    timer.unref();
  };
  schedule();

  return {
    signal: controller.signal,
    closedNow: check,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
