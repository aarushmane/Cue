// Runs a real deepagents graph (no network: a scripted chat model) through both invoke() and
// stream({ streamMode: "updates" }), and checks the stream path rebuilds the same plan, tool calls and report.
// Guards the assumptions in createUpdatesAccumulator about the installed deepagents/langgraph update shapes.
import { describe, expect, it } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { todoListMiddleware, tool } from "langchain";
import { createDeepAgent } from "deepagents";
import { z } from "zod";
import { createUpdatesAccumulator, type OnboardEvent } from "@/lib/agents/onboarding/progress";
import { extractPlan } from "@/lib/agents/onboarding/view";

class ScriptedChat extends BaseChatModel {
  private i = 0;
  constructor(private script: AIMessage[]) {
    super({});
  }
  _llmType() {
    return "scripted";
  }
  bindTools() {
    return this as never;
  }
  async _generate(): Promise<ChatResult> {
    const message = this.script[Math.min(this.i++, this.script.length - 1)];
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
  }
}

const plan = (s1: string, s2: string) => [
  { content: "Look up property", status: s1 },
  { content: "Save draft", status: s2 },
];
const script = () => [
  new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "write_todos", args: { todos: plan("in_progress", "pending") } }] }),
  new AIMessage({ content: "", tool_calls: [{ id: "c2", name: "lookup_property", args: { property_id: "p1" } }] }),
  new AIMessage({ content: "", tool_calls: [{ id: "c3", name: "write_todos", args: { todos: plan("completed", "in_progress") } }] }),
  new AIMessage({ content: "", tool_calls: [{ id: "c4", name: "save_draft", args: {} }] }),
  new AIMessage({ content: "", tool_calls: [{ id: "c5", name: "write_todos", args: { todos: plan("completed", "completed") } }] }),
  new AIMessage("Imported fixture data. Staff must walk the routes."),
];

function agent() {
  const lookup = tool(async () => JSON.stringify({ found: true }), { name: "lookup_property", description: "x", schema: z.object({ property_id: z.string() }) });
  const save = tool(async () => JSON.stringify({ draft_id: "d1" }), { name: "save_draft", description: "x", schema: z.object({}) });
  // Same middleware as lib/agents/onboarding/agent.ts: deepagents 1.16 has no built-in write_todos.
  return createDeepAgent({ model: new ScriptedChat(script()), tools: [lookup, save], systemPrompt: "test", middleware: [todoListMiddleware()] });
}
const input = { messages: [{ role: "user" as const, content: "Onboard CoStar property p1." }] };
const reportOf = (messages: unknown[] | undefined) => (messages?.at(-1) as { content?: unknown } | undefined)?.content;

describe("invoke vs stream on a real deepagents graph", () => {
  it("stream updates rebuild the same plan, tool calls and report as invoke", { timeout: 20_000 }, async () => {
    const invoked = await agent().invoke(input, { recursionLimit: 30 });

    const acc = createUpdatesAccumulator();
    const events: OnboardEvent[] = [];
    const stream = await agent().stream(input, { recursionLimit: 30, streamMode: "updates" });
    for await (const chunk of stream) events.push(...acc.push(chunk));
    const streamed = acc.state();

    // The plan is real agent state now, not extractPlan's fallback from failed write_todos calls.
    expect(invoked.todos).toEqual(plan("completed", "completed"));
    expect(streamed.todos).toEqual(plan("completed", "completed"));
    expect(extractPlan(streamed)).toEqual(extractPlan(invoked));
    expect(extractPlan(streamed).todos).toEqual(plan("completed", "completed"));
    expect(reportOf(streamed.messages)).toBe("Imported fixture data. Staff must walk the routes.");
    expect(reportOf(streamed.messages)).toEqual(reportOf(invoked.messages));

    expect(events).toEqual([
      { type: "tool", name: "write_todos" },
      { type: "todos", todos: plan("in_progress", "pending") },
      { type: "tool", name: "lookup_property" },
      { type: "tool", name: "write_todos" },
      { type: "todos", todos: plan("completed", "in_progress") },
      { type: "tool", name: "save_draft" },
      { type: "tool", name: "write_todos" },
      { type: "todos", todos: plan("completed", "completed") },
    ]);
  });
});
