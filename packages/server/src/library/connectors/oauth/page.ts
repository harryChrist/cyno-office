/**
 * Página que o navegador mostra no fim do login (retorno do OAuth). Simples, escura, em pt-BR; todo
 * texto vindo de fora passa por `escapeHtml`. No sucesso, tenta fechar a aba (só funciona se o app a
 * abriu) e sempre oferece o link de volta aos conectores.
 */

export const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function oauthResultPage(result: { ok: true; name: string } | { ok: false; message: string }): string {
  const ok = result.ok;
  const title = ok ? "Conectado" : "Não foi possível entrar";
  const text = ok ? `${escapeHtml(result.name)} agora está conectado. Pode fechar esta aba e voltar ao Cyno Office.` : escapeHtml(result.message);
  const icon = ok
    ? '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
    : '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} | Cyno Office</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e8eaf6; background-color: #0b0d1a; background-image: radial-gradient(900px 600px at 12% -10%, rgba(109,92,245,.2), transparent 60%), radial-gradient(700px 500px at 100% 110%, rgba(56,120,255,.14), transparent 60%); background-attachment: fixed; }
  main { width: min(440px, 100%); padding: 32px 28px; text-align: center; border-radius: 18px; background: rgba(22,25,48,.78); border: 1px solid rgba(255,255,255,.1); box-shadow: 0 20px 60px rgba(0,0,0,.45); }
  .icon { width: 64px; height: 64px; margin: 0 auto 18px; display: grid; place-items: center; border-radius: 50%; color: ${ok ? "#3ddc97" : "#ff6b81"}; background: ${ok ? "rgba(61,220,151,.12)" : "rgba(255,107,129,.12)"}; box-shadow: 0 0 0 1px ${ok ? "rgba(61,220,151,.35)" : "rgba(255,107,129,.35)"}; }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 650; }
  p { margin: 0 0 22px; color: #b4b8d4; line-height: 1.5; font-size: 15px; overflow-wrap: anywhere; }
  a { display: inline-block; padding: 10px 18px; border-radius: 10px; background: #6d5cf5; color: #fff; text-decoration: none; font-weight: 600; font-size: 14px; }
  a:hover { background: #7d6ef7; }
  a:focus-visible { outline: 2px solid #8b7cff; outline-offset: 3px; }
</style>
</head>
<body>
<main data-testid="oauth-result" data-ok="${ok}">
  <div class="icon">${icon}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${text}</p>
  <a href="/#/biblioteca/conectores">Voltar aos conectores</a>
</main>
${ok ? "<script>setTimeout(function () { try { window.close(); } catch (e) {} }, 1500);</script>" : ""}
</body>
</html>`;
}
