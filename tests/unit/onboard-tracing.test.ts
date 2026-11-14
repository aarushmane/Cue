import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), stream: vi.fn(), flush: vi.fn(), finish: vi.fn(),
}));
vi.mock("@langchain/anthropic", () => ({ ChatAnthropic: class {} }));
vi.mock("deepagents", () => ({ createDeepAgent: () => ({ invoke: mocks.invoke, stream: mocks.stream }) }));
vi.mock("@langchain/core/callbacks/promises", () => ({ awaitAllCallbacks: mocks.flush }));
vi.mock("@/lib/costar", () => ({ getDataLayers: () => ({ source: "fixture" }) }));
vi.mock("@/lib/agents/onboarding/tools", () => ({ onboardingTools: () => ({ main: [], shelf: [] }) }));
vi.mock("@/lib/db/writes", () => ({ startAgentRun: async () => "run-test", finishAgentRun: mocks.finish }));
vi.mock("@/lib/ai/provider", () => ({ aiProvider: () => "anthropic" }));

import { runOnboarding, runOnboardingStream } from "@/lib/agents/onboarding/agent";

const config = {
  runName: "onboard fixture-property-1", tags: ["storeguide", "onboarding", "fixture"],
  metadata: { run_id: "run-test", property_id: "fixture-property-1" }, recursionLimit: 60,
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING", "LANGCHAIN_TRACING_V2"]) vi.stubEnv(name, "false");
  mocks.invoke.mockResolvedValue({ messages: [{ content: "Draft ready" }], todos: [] });
  mocks.stream.mockImplementation(async function* () { yield { agent: { messages: [{ content: "Draft ready" }] } }; });
  mocks.flush.mockResolvedValue(undefined);
  mocks.finish.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("onboarding trace lifecycle", () => {
  it("labels invoke runs and waits for callback delivery before returning", async () => {
    vi.stubEnv("LANGSMITH_TRACING", "true");
    let release!: () => void;
    mocks.flush.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    let done = false;
    const result = runOnboarding("fixture-property-1", null).then((r) => { done = true; return r; });
    await vi.waitFor(() => expect(mocks.flush).toHaveBeenCalledOnce());
    expect(done).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith(expect.anything(), config);
    release();
    expect((await result).report).toBe("Draft ready");
  });

  it("labels streaming runs without losing stream or abort options", async () => {
    vi.stubEnv("LANGSMITH_TRACING", "true");
    const signal = new AbortController().signal;
    await runOnboardingStream("fixture-property-1", null, {}, { signal, onEvent: () => {} });
    expect(mocks.stream).toHaveBeenCalledWith(expect.anything(), { ...config, streamMode: "updates", signal });
    expect(mocks.flush).toHaveBeenCalledOnce();
  });

  it("flushes failed runs and preserves the original error", async () => {
    vi.stubEnv("LANGSMITH_TRACING", "true");
    mocks.invoke.mockRejectedValue(new Error("model unavailable"));
    mocks.flush.mockRejectedValue(new Error("trace delivery unavailable"));
    await expect(runOnboarding("fixture-property-1", null)).rejects.toThrow("model unavailable");
    expect(mocks.finish).toHaveBeenCalledWith("run-test", "FAILED", [], expect.any(Array));
    expect(mocks.flush).toHaveBeenCalledOnce();
  });

  it("does not create callback work when tracing is off", async () => {
    await runOnboarding("fixture-property-1", null);
    expect(mocks.flush).not.toHaveBeenCalled();
  });
});
