"use client";

import { useImperativeHandle, type ReactNode, type RefObject } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AudioWave } from "./AudioWave";
import { DemoItems } from "./DemoItems";
import { useVoice, type VoiceBridge } from "./useVoice";
import { useVoicePreferences } from "./useVoicePreferences";
import { VoiceSettings } from "./VoiceSettings";

export function VoicePanel({ bridge, interruptRef, search, activity, modelId, onPickItem }: {
  bridge: VoiceBridge; interruptRef: RefObject<(() => void) | null>; search: ReactNode; activity?: string | null;
  modelId: string; onPickItem: (name: string) => void;
}) {
  const { preferences, update } = useVoicePreferences();
  const voice = useVoice(bridge, preferences);
  useImperativeHandle(interruptRef, () => voice.interrupt, [voice.interrupt]);
  const { start, stop, phase } = voice;
  const on = phase !== "off";
  const listening = phase === "listening";
  const pending = phase === "connecting";
  const working = phase === "thinking";
  const label = !on ? "Talk" : listening ? "Stop listening" : pending ? "Cancel" : "Stop";
  const status = pending ? "Connecting." : listening ? "Listening. Microphone audio is sent to ElevenLabs for transcription."
    : working ? "Working." : phase === "speaking" ? "Speaking." : voice.navigation === "guiding" ? "Guiding." : "Microphone off.";
  const waveMode = phase === "listening" || phase === "speaking" ? phase : phase === "thinking" ? "thinking" : voice.interrupted ? "stopped" : "off";

  return (
    <aside className="voice-panel" aria-label="Voice">
      <div className="panel-search-toolbar">{search}</div>
      <div className="voice-main">
        <div className="voice-controls">
          <VoiceSettings preferences={preferences} onPreview={voice.interrupt} onChange={(next) => {
            if (next.voiceId !== preferences.voiceId || next.speed !== preferences.speed || next.spokenResponses !== preferences.spokenResponses) voice.interrupt();
            update(next);
          }} />
          <div className="voice-activity" data-working={working || Boolean(activity)}>
            <AudioWave analyser={voice.analyser} mode={waveMode} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant={on ? "default" : "outline"} size="icon" className="voice-toggle size-14 rounded-full" aria-label={label}
                  aria-pressed={listening} aria-busy={pending || working} aria-describedby="microphone-status"
                  onClick={() => on ? stop() : void start()}>
                  {pending || working ? <LoaderCircle className="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    : on && !listening ? <Square className="size-5" aria-hidden="true" />
                    : <Mic className="size-6" aria-hidden="true" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          </div>
          <DemoItems modelId={modelId} onPick={onPickItem} />
        </div>
        {(working || activity) && <p className="voice-working" role="status">{voice.progress?.label ?? activity}</p>}
        <p id="microphone-status" role="status" className={voice.error ? "voice-error text-destructive" : "sr-only"}>
          {voice.error ?? status}
        </p>
        <div className="w-full space-y-2 text-sm" aria-label="Conversation">
          {voice.transcript && <p className="m-0 break-words text-muted-foreground" aria-label="You">{voice.transcript}</p>}
          {voice.reply && <p className="m-0 break-words" aria-label="Response">{voice.reply}</p>}
        </div>
      </div>
    </aside>
  );
}
