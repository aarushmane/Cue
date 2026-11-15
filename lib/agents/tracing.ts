import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";

// Same env vars @langchain/core checks before attaching the LangSmith tracer.
const tracingOn = () =>
  ["LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING", "LANGCHAIN_TRACING"].some((k) => process.env[k] === "true");

/**
 * Serverless functions can freeze as soon as the response is sent, losing trace batches still in flight. Drain
 * LangChain's callback queue and the LangSmith client's pending batches before returning, capped so a slow
 * LangSmith never holds up the staff response for long. No-op (and no LangSmith client created) when tracing is off.
 */
export async function flushTraces(timeoutMs = 10_000) {
  if (!tracingOn()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    awaitAllCallbacks().catch(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
}

