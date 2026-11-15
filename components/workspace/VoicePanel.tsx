"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, type ReactNode, type RefObject } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AudioWave } from "./AudioWave";
import { DemoItems } from "./DemoItems";
import { useVoice, type VoiceBridge } from "./useVoice";
import { useWakeWord } from "./useWakeWord";
import { useVoicePreferences } from "./useVoicePreferences";
import { VoiceSettings } from "./VoiceSettings";

export type Announce = (text: string, query?: string) => void;

export function VoicePanel({ bridge, interruptRef, announceRef, search, activity, modelId, onPickItem }: {
  bridge: VoiceBridge; interruptRef: RefObject<(() => void) | null>; announceRef: RefObject<Announce | null>; search: ReactNode; activity?: string | null;
  modelId: string; onPickItem: (name: string) => void;
}) {
  const { preferences, update } = useVoicePreferences();
  const voice = useVoice(bridge, preferences);
  useImperativeHandle(interruptRef, () => voice.interrupt, [voice.interrupt]);
  const { announce } = voice;
  useImperativeHandle(announceRef, () => (text: string, query?: string) => void announce(text, query), [announce]);
  const logBox = useRef<HTMLOListElement>(null);
  const live = voice.phase === "listening" && voice.transcript ? voice.transcript : "";
  // Keep the newest line in view.
  useEffect(() => { logBox.current?.scrollTo({ top: logBox.current.scrollHeight }); }, [voice.log, live]);
  const { start, stop, phase } = voice;
  const on = phase !== "off";
  // "Hey Cue" opens the microphone hands-free while it is off (the browser's speech recognition listens for it).
  const onWake = useCallback((heard: string) => { void start(heard); }, [start]);
  const waiting = useWakeWord(preferences.wakeWord && phase === "off", onWake);
  const listening = phase === "listening";
  const pending = phase === "connecting";
  const working = phase === "thinking";
  const label = !on ? waiting ? "Talk, or say “Hey Cue”" : "Talk" : listening ? "Stop listening" : pending ? "Cancel" : "Stop";
  const status = pending ? "Connecting." : listening ? "Listening. Microphone audio is sent to ElevenLabs for transcription."
    : working ? "Working." : phase === "speaking" ? "Speaking." : voice.navigation === "guiding" ? "Guiding." : waiting ? "Say “Hey Cue” to talk." : "Microphone off.";
  const waveMode = phase === "listening" || phase === "speaking" ? phase : phase === "off" && voice.analyser ? "speaking" : phase === "thinking" ? "thinking" : voice.interrupted ? "stopped" : "off";

  return (
    <aside className="voice-panel shadow-sm" aria-label="Voice">
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
        {(voice.log.length > 0 || live) && (
          <ol ref={logBox} className="voice-log" aria-label="Conversation" aria-live="polite">
            {voice.log.map((entry) => (
              <li key={entry.id} className={entry.role === "you" ? "text-muted-foreground" : undefined}>
                <span className="sr-only">{entry.role === "you" ? "You: " : "Cue: "}</span>{entry.text}
              </li>
            ))}
            {live && <li className="text-muted-foreground italic"><span className="sr-only">You (speaking): </span>{live}</li>}
          </ol>
        )}
      </div>
    </aside>
  );
}
