import { z } from "zod";

export const VoicePreferencesSchema = z.object({
  voiceId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).or(z.literal("")).default(""),
  speed: z.number().min(0.7).max(1.2).default(1),
  spokenResponses: z.boolean().default(true),
  wakeWord: z.boolean().default(true),
  guidance: z.boolean().default(true),
});
export type VoicePreferences = z.infer<typeof VoicePreferencesSchema>;
export const DEFAULT_VOICE_PREFERENCES = VoicePreferencesSchema.parse({});
// Published replacement voices: https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-default-voices
export const STANDARD_VOICES = [
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George" },
  { id: "6WwXjDDEMyNmFG95zycZ", name: "Eldrin" },
  { id: "OZ0L6eISlOejga3XjDFt", name: "Talia" },
];

/** Transcript-based wake detection. Scribe commonly spells Cue as queue or Q. */
export function wakeCommand(text: string): { wake: boolean; command: string } {
  const match = /^\s*hey[\s,]+(?:cue|queue|q|kew)(?=[\s,.!?:;]|$)[\s,.!?:;]*/i.exec(text);
  return { wake: Boolean(match), command: match ? text.slice(match[0].length).trim() : text.trim() };
}
