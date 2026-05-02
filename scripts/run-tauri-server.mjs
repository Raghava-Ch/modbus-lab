import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const serverDevPort = 1421;

function isDevCommand(argv) {
  return argv.length === 0 || argv.includes("dev");
}

function canConnect(port, host) {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    const done = (result) => {
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(400);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

async function isPortInUse(port) {
  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    if (await canConnect(port, host)) {
      return true;
    }
  }
  return false;
}

function isServerBinaryRunning() {
  if (process.platform === "win32") {
    return false;
  }

  const result = spawnSync("pgrep", ["-f", "modbus-lab-server"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

async function main() {
  if (isDevCommand(args) && await isPortInUse(serverDevPort) && isServerBinaryRunning()) {
    console.log(
      `[tauri:server] Reusing existing server dev instance on http://localhost:${serverDevPort} .`,
    );
    process.exit(0);
  }

  const child = spawn(
    "npm",
    ["run", "tauri", "--workspace", "@modbus-lab/server", ...args],
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
}

void main();