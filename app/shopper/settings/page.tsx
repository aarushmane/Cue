"use client";
import { useShopper, type Prefs } from "@/components/shopper/ShopperProvider";
import { sBtn } from "@/components/shopper/ShopperShell";
import { useFocusOnMount } from "@/components/shopper/useFocusOnMount";

type Opt = { label: string; on: boolean; pick: () => void };

export default function SettingsPage() {
  const s = useShopper();
  const h1 = useFocusOnMount<HTMLHeadingElement>();
  const { prefs, setPrefs, t } = s;
  const opt = <K extends keyof Prefs>(k: K, v: Prefs[K], label: string): Opt => ({ label, on: prefs[k] === v, pick: () => setPrefs({ [k]: v } as Partial<Prefs>) });
  const setContrib = (v: "allowed" | "declined") => {
    // Choosing Not allowed ends any scan: the scan only runs on the contribute screen, which stops the camera on leave.
    setPrefs({ contributions: v });
    s.say(v === "allowed" ? "Product contributions allowed. Nothing is sent until you start a scan and choose Submit." : "Product contributions are off. Search and help still work.");
  };

  const groups: { label: string; cols: number; help: string; opts: Opt[] }[] = [
    { label: "Contrast", cols: 1, help: "High-contrast modes override the brand colors.", opts: [opt("contrast", "comfortable", "Comfortable"), opt("contrast", "dark", "High contrast dark"), opt("contrast", "light", "High contrast light")] },
    { label: "Text size", cols: 3, help: "Browser zoom up to 200% also works.", opts: [opt("scale", 1, "100%"), opt("scale", 1.3, "130%"), opt("scale", 1.6, "160%")] },
    { label: "App voice", cols: 2, help: "Turn off if you prefer VoiceOver or TalkBack to read everything.", opts: [opt("speak", true, "On"), opt("speak", false, "Off")] },
    { label: "Speech speed", cols: 3, help: "Applies to the app voice.", opts: [opt("rate", 0.8, "Slower"), opt("rate", 1, "Normal"), opt("rate", 1.3, "Faster")] },
    { label: "Directions", cols: 2, help: "Concise keeps speech short so you can hear your surroundings.", opts: [opt("detail", "concise", "Concise"), opt("detail", "detailed", "Detailed")] },
    {
      label: "Product contributions", cols: 2,
      help: prefs.contributions === null
        ? "Not chosen yet. Nothing is collected."
        : prefs.contributions === "allowed"
          ? "Allowed. Observations are only sent during a scan you start. Camera permission is separate."
          : "Off. Search, directions and help work the same.",
      opts: [
        { label: "Allowed", on: prefs.contributions === "allowed", pick: () => setContrib("allowed") },
        { label: "Not allowed", on: prefs.contributions === "declined", pick: () => setContrib("declined") },
      ],
    },
  ];

  return (
    <>
      <button type="button" onClick={s.back} className={sBtn.back}>‹ Back</button>
      <h1 ref={h1} tabIndex={-1} className={sBtn.h1}>Accessibility and privacy</h1>
      {groups.map((g) => (
        <fieldset key={g.label} className="m-0 flex flex-col gap-[0.5em] border-0 p-0">
          <legend className="mb-[0.5em] p-0 text-[1.1em] font-extrabold">{g.label}</legend>
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${g.cols}, minmax(0, 1fr))` }}>
            {g.opts.map((o) => (
              <button
                key={o.label}
                type="button"
                aria-pressed={o.on}
                onClick={o.pick}
                className="min-h-14 rounded-full border-[3px] border-(--s-text) px-3 text-[1em] font-extrabold"
                style={{ background: o.on ? t.primary : t.surface, color: o.on ? t.onPrimary : t.text }}
              >
                {o.on ? "✓ " : ""}
                {o.label}
              </button>
            ))}
          </div>
          <p className="m-0 text-[0.9em] text-(--s-muted)">{g.help}</p>
        </fieldset>
      ))}
    </>
  );
}
