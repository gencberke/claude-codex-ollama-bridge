import type { IncomingMessage, ServerResponse } from "node:http";

export function attachCancellation(req: IncomingMessage, res: ServerResponse): AbortController {
  const abort = new AbortController();
  const trip = (): void => {
    if (!abort.signal.aborted) abort.abort();
  };
  req.once("aborted", trip);
  req.once("close", () => {
    if (!req.complete) trip();
  });
  res.once("close", () => {
    if (!res.writableEnded) trip();
  });
  abort.signal.addEventListener(
    "abort",
    () => {
      req.destroy();
    },
    { once: true },
  );
  return abort;
}
