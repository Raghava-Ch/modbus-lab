import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const child = spawn(
  npmCmd,
  ["run", "tauri", "--workspace", "@modbus-lab/client", "--", ...args],
  {
    stdio: "inherit",
    shell: false,
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
