import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Exercise the actual standalone Node script. Inject fetch so no credentials or provider quota are needed.
function check(mode: "ok" | "errors" | "denied") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "costar-check-"));
  const secret = "TEST-SECRET-NEVER-PRINT";
  try {
    writeFileSync(path.join(dir, "index.csv"), "model_id\n6FNMVoyPrL1\nbP9oEnqmeie\n");
    const preload = path.join(dir, "mock.mjs");
    writeFileSync(preload, `globalThis.fetch = async (url, opts) => {
      if (${JSON.stringify(mode)} === "errors") throw new Error(${JSON.stringify(secret)});
      if (String(url).includes("vexcel")) return new Response("image", {status: ${mode === "denied" ? 403 : 200}, headers: {"content-type":"image/jpeg"}});
      const query = JSON.parse(opts.body).query;
      const model = query.includes("locations") ? {locations:[{id:"a",neighbors:["b"],floor:{id:"f"}}]} : {assets:{floorplans:[{format:"jpg",flags:["photogramy","extra"],url:"https://private.example/plan",width:100,height:100,resolution:10,origin:{x:0,y:0}}]}};
      return Response.json({data:{model}});
    };`);
    return spawnSync(process.execPath, ["--import", preload, "scripts/check-costar.mts", "--strict"], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env,
        MATTERPORT_API_KEY: secret, MATTERPORT_API_TOKEN: secret, VEXCEL_API_KEY: secret,
        GEMINI_API_KEY: secret, ANTHROPIC_API_KEY: "", LANGSMITH_API_KEY: secret,
        LANGSMITH_TRACING: "true", MATTERPORT_INDEX_CSV: path.join(dir, "index.csv"),
      },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("CoStar preflight", () => {
  it("passes usable neighbor, floor plan and aerial checks without printing secrets or signed URLs", () => {
    const result = check("ok");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All checks passed");
    expect(result.stdout).toContain("georeferenced floor plan");
    expect(result.stdout).not.toMatch(/TEST-SECRET|private.example/);
  });
  it("reports upstream failures safely and still attempts floor plan checks", () => {
    const result = check("errors");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("floor plan query failed");
    expect(result.stdout).toContain("Verify Vexcel access");
    expect(result.stdout + result.stderr).not.toContain("TEST-SECRET");
  });
  it("does not claim all checks passed when Vexcel denies coverage or permissions", () => {
    const result = check("denied");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("coverage AND key permissions");
    expect(result.stdout).not.toContain("All checks passed");
  });
});
