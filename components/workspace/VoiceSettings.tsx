"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Settings2, Square, Volume2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { STANDARD_VOICES, type VoicePreferences } from "@/lib/voice/preferences";
import { playSpeech } from "@/lib/voice/playback";
import { voiceSocket } from "@/lib/voice/socket";

export function VoiceSettings({ preferences, onChange, onPreview }: {
  preferences: VoicePreferences; onChange: (settings: VoicePreferences) => void; onPreview: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState(STANDARD_VOICES);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const preview = useRef<{ abort: AbortController; context: AudioContext } | null>(null);
  const stopPreview = () => { preview.current?.abort.abort(); void preview.current?.context.close().catch(() => {}); preview.current = null; setPreviewing(false); };

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    voiceSocket.request<{ voices: { id: string; name: string }[]; warning?: string }>("voices", {}, abort.signal).then((data) => {
      const items = [{ id: "", name: "Server default" }, ...data.voices] as { id: string; name: string }[];
      setVoices(items);
      setNotice(data.warning ?? "");
    }).catch((error: unknown) => { if (!abort.signal.aborted) setNotice(error instanceof Error ? error.message : "Could not load voices."); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [open]);

  useEffect(() => () => { preview.current?.abort.abort(); void preview.current?.context.close().catch(() => {}); }, []);

  async function previewVoice() {
    if (preview.current) { stopPreview(); return; }
    onPreview();
    const current = { abort: new AbortController(), context: new AudioContext() };
    preview.current = current;
    setPreviewing(true);
    try { await playSpeech("This is your selected voice.", current.context, current.abort.signal, () => {}, preferences); }
    catch (error) { if (!current.abort.signal.aborted) setNotice(error instanceof Error ? error.message : "Voice preview failed."); }
    finally { if (preview.current === current) { preview.current = null; setPreviewing(false); } if (current.context.state !== "closed") void current.context.close(); }
  }

  const update = (patch: Partial<VoicePreferences>) => { stopPreview(); onChange({ ...preferences, ...patch }); };
  const selected = preferences.voiceId || "server-default";
  const options = [...voices.filter((v) => v.id), ...(!voices.some((v) => v.id === preferences.voiceId) && preferences.voiceId ? [{ id: preferences.voiceId, name: "Custom voice" }] : [])];
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); setLoading(next); if (!next) stopPreview(); }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild><Button variant="ghost" size="icon" className="size-11" aria-label="Voice settings"><Settings2 className="size-4" aria-hidden="true" /></Button></PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Settings</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="start" sideOffset={10} className="voice-settings w-[304px] max-w-[calc(100vw-24px)] gap-4 p-4" aria-label="Voice settings">
        <div className="flex items-center justify-between">
          <h2 className="m-0 text-sm font-medium">Settings</h2>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Close settings" onClick={() => { stopPreview(); setOpen(false); }}><X className="size-4" aria-hidden="true" /></Button>
        </div>
        <div className="space-y-2">
          <label htmlFor="elevenlabs-voice" className="text-xs text-muted-foreground">ElevenLabs voice</label>
          <div className="flex gap-2">
            <Select value={selected} onValueChange={(voiceId) => update({ voiceId: voiceId === "server-default" ? "" : voiceId })}>
              <SelectTrigger id="elevenlabs-voice" className="h-10 min-w-0 flex-1" aria-label="ElevenLabs voice"><SelectValue /></SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="server-default">Server default</SelectItem>
                {options.map((voice) => <SelectItem key={voice.id} value={voice.id}>{voice.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" className="size-10" aria-label={previewing ? "Stop voice preview" : "Preview voice"} onClick={() => void previewVoice()}>
              {previewing ? <Square className="size-4" aria-hidden="true" /> : <Volume2 className="size-4" aria-hidden="true" />}
            </Button>
          </div>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer py-1">Use voice ID</summary>
            <Input className="mt-2 h-9 font-mono text-xs" aria-label="Custom voice ID" placeholder="Voice ID" value={preferences.voiceId}
              onChange={(event) => { if (/^[a-zA-Z0-9_-]{0,80}$/.test(event.target.value)) update({ voiceId: event.target.value }); }} />
          </details>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs"><label id="voice-speed-label">Speed</label><output className="tabular-nums text-muted-foreground">{preferences.speed.toFixed(2)}×</output></div>
          <Slider aria-labelledby="voice-speed-label" value={[preferences.speed]} min={0.7} max={1.2} step={0.05} onValueChange={([speed]) => update({ speed })} />
        </div>
        <Separator />
        {([
          ["spokenResponses", "Voice responses"], ["guidance", "Spoken directions"],
        ] as const).map(([key, label]) => <div key={key} className="flex min-h-9 items-center justify-between gap-4">
          <label htmlFor={`voice-${key}`} className="text-sm">{label}</label>
          <Switch id={`voice-${key}`} checked={preferences[key]} onCheckedChange={(checked) => update({ [key]: checked })} />
        </div>)}
        {loading && <LoaderCircle className="size-3 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Loading voices" />}
        {notice && <p className="m-0 text-xs leading-relaxed text-muted-foreground" role="status">{notice}</p>}
      </PopoverContent>
    </Popover>
  );
}
