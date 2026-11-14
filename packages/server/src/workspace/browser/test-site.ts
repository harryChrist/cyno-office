import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Site de teste do navegador (só nos testes, em 127.0.0.1: o navegador dos testes libera a rede
 * local). Páginas: `/` (formulário de post com "Publicar", busca GET e links), `/login` (grava o
 * cookie de sessão), `/whoami` (mostra os cookies que chegaram), `/upload` (campo de arquivo que mostra o que recebeu no título), `/b` (outra página) e `/popup` e `/feed` (post com data-urn, botões que copiam e um link comprido).
 */
export async function startTestSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    const html = (status: number, content: string, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      response.end(content);
    };
    switch (url.pathname) {
      case "/":
        return html(
          200,
          page(
            "Início",
            `<h1>Rede de teste</h1>
            <form method="post" action="/posted"><label>Texto do post <textarea name="t"></textarea></label><button>Publicar</button></form>
            <form method="get" action="/b" role="search"><label>Buscar <input name="q"></label><button>Buscar</button></form>
            <a href="/b">Ir para B</a>
            <a href="/popup" target="_blank">Abrir em outra aba</a>
            <button onclick="document.title='clicado'">Ver mais</button>`,
          ),
        );
      case "/upload":
        return html(
          200,
          page(
            "Upload",
            `<input type="file" id="f" multiple onchange="document.title = [...this.files].map((f) => f.name + ':' + f.size + ':' + f.type).join('|')">
            <input type="text" id="t">`,
          ),
        );
      case "/feed":
        return html(
          200,
          page(
            "Feed",
            `<div data-urn="urn:li:activity:7390000000000000001" role="article" aria-label="Post da Ana">
              <p>Post da Ana sobre Go</p>
              <button onclick="navigator.clipboard.writeText('https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000001/').then(() => { document.title = 'copiado' })">Copiar link</button>
              <button onclick="const put = (e) => { e.preventDefault(); e.clipboardData.setData('text/plain', 'texto via execCommand') }; document.addEventListener('copy', put, { once: true }); document.execCommand('copy')">Copiar texto</button>
            </div>
            <div role="listitem" aria-label="Post do Lucas">
              <div componentkey="expandedurn%3Ali%3Aactivity%3A7390000000000000002FeedType_MAIN">
                <p>Post do Lucas sobre NestJS</p>
                <button aria-label="Open control menu for post by Lucas" aria-haspopup="menu" onclick="document.title='menu aberto'">…</button>
                <input type="hidden" name="csrfToken" value="segredo-csrf">
                <label>Comentário <input name="c" value="rascunho digitado"></label>
                <script>window.x = "codigo"</script>
              </div>
            </div>
            <a href="/b?${"x".repeat(200)}=1">Link comprido</a>`,
          ),
        );
      case "/login":
        return html(200, page("Login", "<p>Logado</p>"), { "set-cookie": "session=abc123; Path=/; Max-Age=86400; HttpOnly" });
      case "/whoami":
        return html(200, page("Quem sou", `<p>cookies: ${(request.headers.cookie ?? "nenhum").replace(/[<>&]/g, "")}</p>`));
      case "/b":
        return html(200, page("Página B", `<p>Busca: ${(url.searchParams.get("q") ?? "").replace(/[<>&]/g, "")}</p>`));
      case "/popup":
        return html(200, page("Pop-up", "<p>outra aba</p>"));
      case "/posted":
        return html(200, page("Publicado", "<p>post publicado</p>"));
      default:
        return html(404, page("404", "nada"));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
