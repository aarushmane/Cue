import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { referenceImage } from "@/lib/vision/matchLandmark";

describe("referenceImage", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "sg-refs-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LANDMARK_REFERENCE_IMAGES;
  });

  it("returns null for a missing photo and warns once", async () => {
    expect(await referenceImage("/L01.jpg", root)).toBeNull();
    expect(await referenceImage("/L01.jpg", root)).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("returns a data URL with the right MIME type", async () => {
    writeFileSync(path.join(root, "a.png"), Buffer.from([1, 2, 3]));
    writeFileSync(path.join(root, "b.JPG"), Buffer.from([4, 5]));
    expect(await referenceImage("/a.png", root)).toBe("data:image/png;base64,AQID");
    expect(await referenceImage("/b.JPG", root)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("skips unsupported types, oversized files and path traversal", async () => {
    writeFileSync(path.join(root, "c.gif"), Buffer.from([1]));
    writeFileSync(path.join(root, "big.jpg"), Buffer.alloc(1_600_000));
    expect(await referenceImage("/c.gif", root)).toBeNull();
    expect(await referenceImage("/big.jpg", root)).toBeNull();
    expect(await referenceImage("/../etc/passwd.jpg", root)).toBeNull();
    expect(await referenceImage("relative.jpg", root)).toBeNull();
  });

  it("can be switched off to save quota", async () => {
    writeFileSync(path.join(root, "d.jpg"), Buffer.from([1]));
    process.env.LANDMARK_REFERENCE_IMAGES = "off";
    expect(await referenceImage("/d.jpg", root)).toBeNull();
  });

  it("drops a remote reference whose host isn't allowed instead of throwing", async () => {
    expect(await referenceImage("https://example.com/x.jpg", root)).toBeNull();
  });
});
