import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const children = [];
const stop = () => { for (const child of children) child.kill("SIGTERM"); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.push(child);
  child.on("error", (error) => { console.error(error.message); stop(); process.exitCode = 1; });
  child.on("exit", (code) => { if (code) process.exitCode = code; stop(); });
}

const backend = await fetch("http://127.0.0.1:8000/health", { signal: AbortSignal.timeout(800) })
  .then((response) => response.json()).catch(() => null);
if (backend?.service === "storeguide") console.log("Using voice backend at http://127.0.0.1:8000");
else if (existsSync("backend/.venv/bin/python")) run(".venv/bin/python", ["-m", "uvicorn", "main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"], { cwd: "backend" });
else run("uv", ["run", "uvicorn", "main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"], { cwd: "backend" });
run(process.execPath, ["node_modules/next/dist/bin/next", "dev", ...process.argv.slice(2)]);
