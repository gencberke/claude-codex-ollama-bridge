import { listenGateway } from "./codex/gateway.js";
import { createServer, type AddressInfo } from "node:net";

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT", error);
  process.exit(2);
});
process.on("unhandledRejection", (error) => {
  console.error("UNHANDLED", error);
  process.exit(3);
});

async function main(): Promise<void> {
  const port = await freePort();
  const server = await listenGateway({
    port,
    catalog: {
      models: [{ slug: "o3" }, { slug: "ollama/x" }],
    },
    nativeFetch: async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          let ticks = 0;
          const timer = setInterval(() => {
            ticks += 1;
            controller.enqueue(encoder.encode(`data: {"ok":"native","n":${ticks}}\n\n`));
            if (ticks >= 8) {
              clearInterval(timer);
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            }
          }, 25);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
    ollamaFetch: async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"partial":true}\n\n'));
          queueMicrotask(() => controller.error(new Error("upstream boom")));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });

  const native = fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "o3", input: "hi", stream: true }),
  });

  const ollama = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "ollama/x", input: "hi", stream: true }),
  });
  await ollama.text().catch(() => "");

  const nativeRes = await native;
  const nativeText = await nativeRes.text();
  if (!nativeText.includes("native")) {
    console.error("native stream died", nativeRes.status, nativeText);
    process.exit(4);
  }

  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  if (!health.ok) process.exit(5);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(addr.port)));
    });
    server.on("error", reject);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
