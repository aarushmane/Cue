import { describe, expect, it } from "vitest";
import { recognitionError } from "@/components/shopper/speech";

describe("recognitionError", () => {
  it("stays silent when the shopper stopped listening themselves", () => {
    expect(recognitionError("aborted", true)).toBeNull();
  });
  it("explains an interruption (iOS audio session taken, page hidden)", () => {
    expect(recognitionError("aborted", false)).toEqual({ state: "error", msg: expect.stringContaining("interrupted") });
  });
  it("points iPhone users at Dictation for service-not-allowed", () => {
    const r = recognitionError("service-not-allowed", false)!;
    expect(r.state).toBe("denied");
    expect(r.msg).toContain("Dictation");
  });
  it("separates permission, no speech, no mic, network and language", () => {
    expect(recognitionError("not-allowed", false)!.msg).toContain("permission");
    expect(recognitionError("no-speech", false)!.state).toBe("error");
    expect(recognitionError("audio-capture", false)!.msg).toContain("No microphone");
    expect(recognitionError("network", false)!.msg).toContain("internet");
    expect(recognitionError("language-not-supported", false)!.state).toBe("unsupported");
    expect(recognitionError("weird", false)!.msg).toContain("weird");
  });
});
