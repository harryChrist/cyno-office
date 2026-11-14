#!/usr/bin/env node
// Servidor MCP stdio falso (só nos testes do gateway): initialize, tools/list e tools/call "eco"
// em linhas JSON. A ferramenta "segredo" diz se a variável FAKE_TOKEN chegou (sem mostrar o valor).
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
process.stdout.write("log solto que não é JSON\n");
process.stderr.write("servidor falso subiu\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  const ok = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return ok({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-stdio", version: "1" } });
    case "tools/list":
      return ok({
        tools: [
          { name: "eco", description: "Devolve o texto", inputSchema: { type: "object", properties: { texto: { type: "string" } } } },
          { name: "segredo", description: "Diz se o token chegou", inputSchema: { type: "object", properties: {} } },
          { name: "morrer", description: "Sai do processo", inputSchema: { type: "object", properties: {} } },
        ],
      });
    case "tools/call": {
      const { name, arguments: args } = message.params;
      if (name === "eco") return ok({ content: [{ type: "text", text: `eco: ${args?.texto ?? ""}` }] });
      if (name === "segredo") return ok({ content: [{ type: "text", text: process.env.FAKE_TOKEN === "tok-stdio-123456" ? "token ok" : "sem token" }] });
      if (name === "morrer") {
        process.stderr.write("falha com tok-stdio-123456 no meio\n");
        process.exit(3);
      }
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `ferramenta desconhecida: ${name}` } });
    }
    default:
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "método" } });
  }
});
