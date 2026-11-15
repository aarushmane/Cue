"use client";

import { useImperativeHandle, type ReactNode, type RefObject } from "react";
import { AudioLines, LoaderCircle, Mic, MicOff, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AudioWave } from "./AudioWave";
import { useVoice, type VoiceBridge } from "./useVoice";
import { useVoicePreferences } from "./useVoicePreferences";
import { VoiceSettings } from "./VoiceSettings";

export function VoicePanel({ bridge, interruptRef, search, activity }: { bridge: VoiceBridge; interruptRef: RefObject<(() => void) | null>; search: ReactNode; activity?: string | null }) {
  const { preferences, update } = useVoicePreferences();
  const voice = useVoice(bridge, preferences);
  useImperativeHandle(interruptRef, () => voice.interrupt, [voice.interrupt]);
  const { start, stop } = voice;
  const active = ["listening", "thinking", "speaking"].includes(voice.phase);
  const pending = voice.phase === "connecting";
  const label = pending ? "Cancel microphone request" : active ? "Disable microphone" : "Enable microphone";
  const status = pending ? "Connecting" : voice.phase === "thinking" ? "Working" : voice.phase === "speaking" ? "Speaking" : active ? voice.interrupted ? "Stopped" : voice.navigation === "guiding" ? "Guiding" : voice.navigation === "arrived" ? "Arrived" : !voice.listeningOpen ? "Say Hey Cue" : "Listening" : "Off";
  const listeningStatus = voice.phase === "thinking" || voice.phase === "speaking" ? "Say Hey Cue or Stop to interrupt."
    : voice.listeningOpen ? "Listening for your request." : "Say Hey Cue for a request.";

  return (
    <aside className="voice-panel" aria-label="Voice">
      <div className="panel-search-toolbar">{search}</div>
      <header className="voice-heading">
        <AudioLines className="size-4 text-primary" aria-hidden="true" />
        <h2 className="text-sm font-medium">Voice</h2>
        <span className="voice-connection ml-auto text-xs text-muted-foreground" data-active={active}>
          <span className="voice-connection-dot" aria-hidden="true" />{status}
        </span>
      </header>
      <div className="voice-main">
        <div className="voice-activity" data-working={pending || voice.phase === "thinking" || Boolean(activity)}>
          <AudioWave analyser={voice.analyser} mode={active && (voice.interrupted || voice.navigation === "arrived") ? "stopped" : voice.phase === "connecting" ? "off" : voice.phase} />
          {(pending || voice.phase === "thinking" || activity) && <div className="voice-working" role="status">
            <span className="voice-progress-ring motion-reduce:animate-none" aria-hidden="true" />
            <span>{voice.progress?.label ?? activity ?? "Connecting voice"}</span>
          </div>}
        </div>
        <div className="flex items-center gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-11" aria-label="Replay response" disabled={!active || !voice.reply || !preferences.spokenResponses}
              onClick={() => void voice.replay()}><Play className="size-4" aria-hidden="true" /></Button>
          </TooltipTrigger>
          <TooltipContent>Replay response</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant={active ? "default" : "outline"} size="icon" className="voice-toggle size-12" aria-label={label}
              aria-pressed={active} aria-busy={pending} aria-describedby="microphone-status"
              onClick={() => active || pending ? stop() : void start()}>
              {pending ? <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : active ? <Mic className="size-5" aria-hidden="true" /> : <MicOff className="size-5" aria-hidden="true" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant={voice.interrupted ? "secondary" : "ghost"} size="icon" className="size-11" aria-label="Stop speech and movement" aria-pressed={voice.interrupted} onClick={voice.interrupt}>
              <Square className="size-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Stop speech and movement</TooltipContent>
        </Tooltip>
        </div>
        <p id="microphone-status" role="status" className={voice.error ? "voice-error text-destructive" : "sr-only"}>
          {voice.error ?? (pending ? "Connecting microphone to ElevenLabs." : active ? `${status}. ${listeningStatus} Microphone audio is sent to ElevenLabs for transcription.` : "Microphone off.")}
        </p>
        <div className="w-full space-y-2 px-6 text-sm" aria-label="Conversation">
          {voice.transcript && <p className="m-0 break-words text-muted-foreground" aria-label="You">{voice.transcript}</p>}
          {voice.reply && <p className="m-0 break-words" aria-label="Response">{voice.reply}</p>}
        </div>
      </div>
      <footer className="voice-footer">
        <VoiceSettings preferences={preferences} onPreview={voice.interrupt} onChange={(next) => {
          if (next.voiceId !== preferences.voiceId || next.speed !== preferences.speed || next.spokenResponses !== preferences.spokenResponses) voice.interrupt();
          update(next);
        }} />
      </footer>
    </aside>
  );
}
