// Inside a contained Worker (contain.ts): the bridge, then the harness.
//
//   node containBridge.ts -- claude <args...>
//
// The sandbox has no network at all. This listens on 127.0.0.1:8899 (its own
// port on macOS), the address ANTHROPIC_BASE_URL and HTTPS_PROXY name, and
// carries each connection to the Worker's socket into the agent
// (/run/cobra/agent.sock), which decides what goes further. Then it runs the harness on the terminal
// and exits as it does.
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";

// Its own port on macOS, where Workers share the loopback (contain.ts insidePort).
const PORT = Number(process.env.COBRA_BRIDGE_PORT) || 8899;
const SOCKET = process.env.COBRA_AGENT_SOCKET ?? "/run/cobra/agent.sock";

const at = process.argv.indexOf("--");
const command = at === -1 ? [] : process.argv.slice(at + 1);
if (command.length === 0) {
  console.error("usage: node containBridge.ts -- <command...>");
  process.exit(2);
}

const server = createServer((client) => {
  const upstream = connect(SOCKET);
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
});

server.listen(PORT, "127.0.0.1", () => {
  const [name, ...args] = command as [string, ...string[]];
  const child = spawn(name, args, { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    server.close();
    process.exit(code ?? (signal ? 128 : 1));
  });
  child.on("error", (error) => {
    console.error(`cobra: could not start ${name}: ${error.message}`);
    process.exit(127);
  });
});
server.on("error", (error) => {
  console.error(`cobra: the bridge could not listen: ${error.message}`);
  process.exit(1);
});
