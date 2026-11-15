import { normalize } from "../search/matchProducts";

const COMMAND = /\b(?:(?:search|check|scan|inspect)(?:\s+(?:the|scene|store|scan|all|these|those))*\s+(?:photos?|pictures?|images?)|look\s+(?:in|at|through)(?:\s+(?:the|scene|store|scan|all|these|those))*\s+(?:photos?|pictures?|images?)|look\s+(?:more\s+closely|again)|(?:take|have)\s+(?:a\s+)?closer\s+look)\b/i;

/** null means no explicit photo request; an empty target needs the preceding item request. */
export function photoSearchQuery(query: string, previousQuery = ""): string | null {
  if (/\b(?:don['’]?t|do not|no need to)\s+(?:search|check|scan|inspect|look)\b/i.test(query)) return null;
  const command = COMMAND.exec(query);
  if (!command) return null;
  const rest = query.slice(command.index + command[0].length).replace(/^\s*(?:again\s+)?(?:for|to find|to locate|for signs of)?\s*/i, "");
  const target = normalize(rest);
  return !target || /^(?:it|that|them|that item|that product|again)$/.test(target) ? normalize(previousQuery) : target;
}
