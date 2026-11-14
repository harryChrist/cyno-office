import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { imageSize } from "../media/sniff";
import { renderHtml } from "./render";
import { UrlPolicy } from "./url-policy";

describe("renderHtml (Chromium de verdade, contexto novo)", () => {
  it("renderiza o HTML no tamanho pedido (png e escala 2), sem JavaScript e sem tocar a rede local", async () => {
    let hits = 0;
    const lan = createServer((_request, response) => {
      hits++;
      response.writeHead(200, { "content-type": "image/png" });
      response.end();
    });
    await new Promise<void>((resolve) => lan.listen(0, "127.0.0.1", resolve));
    const lanUrl = `http://127.0.0.1:${(lan.address() as AddressInfo).port}/x.png`;
    try {
      // Política padrão: rede local bloqueada (o HTML tenta carregar uma imagem de 127.0.0.1).
      const policy = new UrlPolicy({});
      const html = `<!doctype html><body style="margin:0;background:#1a73e8"><img src="${lanUrl}"><script>document.body.style.background='red'</script><h1>Oi</h1></body>`;
      const png = await renderHtml({ html, width: 600, height: 315, format: "png", scale: 1 }, policy);
      expect(imageSize(png)).toEqual({ width: 600, height: 315 });
      expect(hits).toBe(0);
      const big = await renderHtml({ html: "<body>x</body>", width: 300, height: 100, format: "png", scale: 2 }, policy);
      expect(imageSize(big)).toEqual({ width: 600, height: 200 });
    } finally {
      await new Promise((resolve) => lan.close(resolve));
    }
  }, 60_000);
});
