import { describe, expect, it } from "vitest";
import { toGeminiParameters } from "@/lib/ai/geminiSchema";
import { SHOPPER_TOOLS } from "@/lib/agents/shopper/tools";

const BANNED = ["exclusiveMinimum", "exclusiveMaximum", "const", "$schema", "additionalProperties", "oneOf"];
function walk(s: unknown, visit: (o: Record<string, unknown>) => void) {
  if (!s || typeof s !== "object") return;
  visit(s as Record<string, unknown>);
  for (const v of Object.values(s)) walk(v, visit);
}

describe("toGeminiParameters", () => {
  it("rewrites nullable type arrays, null enums and exclusive bounds", () => {
    const out = toGeminiParameters({
      type: "object",
      additionalProperties: false,
      properties: {
        a: { type: ["string", "null"], enum: ["x", "y", null] },
        b: { anyOf: [{ type: "integer", exclusiveMinimum: 0 }, { type: "null" }] },
        type: { type: "string", description: "a property literally named type" },
      },
      required: ["a"],
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        a: { type: "string", enum: ["x", "y"], nullable: true },
        b: { type: "integer", minimum: 0, nullable: true },
        type: { type: "string", description: "a property literally named type" },
      },
      required: ["a"],
    });
  });

  it("leaves no unsupported keywords or type arrays in any shopper tool schema", () => {
    for (const t of SHOPPER_TOOLS) {
      walk(toGeminiParameters(t.input_schema), (o) => {
        for (const k of BANNED) expect(o, `${t.name}.${k}`).not.toHaveProperty(k);
        if ("type" in o && typeof o.type !== "object") expect(Array.isArray(o.type)).toBe(false);
      });
    }
  });
});
