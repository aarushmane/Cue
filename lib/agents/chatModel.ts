// Chat model shared by the LangChain deep agents (onboarding, wayfinding). Same provider rules as lib/ai/provider.
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { CLAUDE_MODEL } from "../ai/claude";
import { GEMINI_AGENT_MODEL, geminiModels } from "../ai/gemini";
import { toGeminiParameters } from "../ai/geminiSchema";
import { aiProvider } from "../ai/provider";

/** Gemini rejects parts of JSON Schema that deepagents' built-in tools use; rewrite every tool schema on bind. */
export class GeminiChat extends ChatGoogleGenerativeAI {
  override bindTools(...[tools, kwargs]: Parameters<ChatGoogleGenerativeAI["bindTools"]>) {
    const cleaned = tools.map((t) => {
      const oa = convertToOpenAITool(t);
      return { ...oa, function: { ...oa.function, parameters: toGeminiParameters(oa.function.parameters) } };
    });
    return super.bindTools(cleaned, kwargs);
  }
}

export function agentChatModel(limits: { geminiMaxOutputTokens: number; anthropicMaxTokens: number }) {
  return aiProvider() === "gemini"
    // Start on a model that still has quota (free-tier limits are per model).
    ? new GeminiChat({ model: geminiModels(GEMINI_AGENT_MODEL)[0], apiKey: process.env.GEMINI_API_KEY, maxOutputTokens: limits.geminiMaxOutputTokens })
    : new ChatAnthropic({ model: CLAUDE_MODEL, maxTokens: limits.anthropicMaxTokens });
}
