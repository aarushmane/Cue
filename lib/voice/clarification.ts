import { normalize } from "@/lib/search/matchProducts";
import type { SceneItem } from "@/lib/wayfinding/types";

/** Only the offered choices are accepted without a wake phrase after a question. */
export type VoiceClarification = { options: string[] };

export function clarificationAnswer(text: string, clarification: VoiceClarification): string | null {
  const raw = text.trim().replace(/[.!?,]+$/g, "");
  if (/^(?:yes|yeah|yep|correct|right|thats right|that's right|that one|yes please)$/i.test(raw)) {
    return clarification.options.length === 1 ? clarification.options[0] : null;
  }
  if (/^(?:no|nope|neither|none of (?:those|them)|never mind|nevermind)$/i.test(raw)) return "";
  const ordinal = /^(?:the )?(first|second|third|fourth)(?: one)?$/i.exec(raw);
  if (ordinal) return clarification.options[["first", "second", "third", "fourth"].indexOf(ordinal[1].toLowerCase())] ?? null;
  const corrected = raw.replace(/^(?:no[,\s]+)?(?:i (?:said|meant|mean)[,\s]+|actually[,\s]+|it['’]?s\s+)?/i, "");
  const compact = (s: string) => normalize(s).replace(/ /g, "");
  return clarification.options.find((option) => compact(option) === compact(corrected)) ?? null;
}

/** Near matches are questions, never substitutions. No photo/model calls needed. */
export function catalogSuggestions(query: string, items: SceneItem[]): string[] {
  const words = normalize(query).split(" ").filter(Boolean);
  if (words.length < 2) return [];
  const scored = items.flatMap((item) => [item.name, ...(item.aliases ?? [])].map((name) => {
    const candidate = normalize(name).split(" ").filter(Boolean);
    const hits = words.filter((word) => candidate.includes(word)).length;
    return { name, score: hits / Math.max(words.length, candidate.length) };
  })).filter(({ score }) => score >= 0.5 && score < 1).sort((a, b) => b.score - a.score);
  const best = scored[0]?.score;
  return [...new Set(scored.filter(({ score }) => score === best).map(({ name }) => name))].slice(0, 4);
}
