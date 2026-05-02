import net from "node:net";
import { spawn } from "node:child_process";

const [portArg, command, ...commandArgs] = process.argv.slice(2);
const port = Number(portArg);

function canConnect(portNumber, host) {
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
    socket.connect(portNumber, host);
  });
}

async function isPortInUse(portNumber) {
  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    if (await canConnect(portNumber, host)) {
      return true;
    }
  }
  return false;
}

async function main() {
  if (!Number.isFinite(port) || !command) {
    console.error("Usage: node run-vite-or-reuse.mjs <port> <command> [args...]");
    process.exit(1);
  }

  if (await isPortInUse(port)) {
    console.log(`[vite] Reusing existing dev server on http://localhost:${port} .`);
    process.exit(0);
  }

  const child = spawn(command, commandArgs, {
    stdio: "inherit",
    shell: false,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

void main();