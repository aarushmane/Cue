// Interactive work must settle even when an upstream client ignores cancellation.
export const WAYFINDING_TIMEOUT_MS = 25_000;
export const WAYFINDING_TIMEOUT_MESSAGE = "The search took too long. Try again or choose an item from the catalogue.";

export function withAbort<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
