// Gemini's function-declaration `parameters` field accepts only an OpenAPI-style subset of JSON Schema:
// no type arrays (["string","null"]), no exclusiveMinimum, no const, no $ref. deepagents' built-in tools and
// our own nullable fields use those, so we rewrite schemas into the subset before sending them. Pure.

const KEEP = new Set([
  "type", "format", "description", "nullable", "enum", "items", "properties", "required", "anyOf",
  "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "pattern", "title",
]);

type Schema = Record<string, unknown>;

export function toGeminiParameters(input: unknown): Schema {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const s = input as Schema;
  const out: Schema = {};
  let nullable = s.nullable === true;

  // Nullable spellings → nullable: true
  let type = s.type;
  if (Array.isArray(type)) {
    const real = type.filter((t) => t !== "null");
    if (real.length !== type.length) nullable = true;
    if (real.length === 1) type = real[0];
    else {
      out.anyOf = real.map((t) => ({ type: t }));
      type = undefined;
    }
  }
  if (type !== undefined && type !== "null") out.type = type;

  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const options = ((s.anyOf ?? s.oneOf) as unknown[]).filter((o) => {
      const isNull = !!o && typeof o === "object" && (o as Schema).type === "null";
      if (isNull) nullable = true;
      return !isNull;
    });
    if (options.length === 1) Object.assign(out, toGeminiParameters(options[0]));
    else if (options.length > 1) out.anyOf = options.map(toGeminiParameters);
  }

  if (Array.isArray(s.enum)) {
    const values = s.enum.filter((v) => v !== null);
    if (values.length !== s.enum.length) nullable = true;
    if (values.length) out.enum = values.map(String);
  }
  if (s.const !== undefined && s.const !== null) out.enum = [String(s.const)];
  if (typeof s.exclusiveMinimum === "number") out.minimum = s.exclusiveMinimum;
  if (typeof s.exclusiveMaximum === "number") out.maximum = s.exclusiveMaximum;

  for (const [k, v] of Object.entries(s)) {
    if (!KEEP.has(k) || k in out || k === "type" || k === "anyOf" || k === "enum" || k === "nullable") continue;
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v as Schema).map(([name, sub]) => [name, toGeminiParameters(sub)]));
    } else if (k === "items") {
      out.items = toGeminiParameters(v);
    } else {
      out[k] = v;
    }
  }
  if (out.enum && !out.type) out.type = "string";
  if (nullable) out.nullable = true;
  return out;
}
