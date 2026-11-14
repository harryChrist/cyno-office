# Contribuindo com o Cyno

Obrigado por querer ajudar. Este guia é curto: o essencial para rodar, mudar e enviar uma contribuição.

## Rodando localmente

Requisitos: Node 22.12 ou mais novo e npm.

```bash
npm ci            # ou npm install
npm run dev       # server (3001, só loopback) e web (5173)
```

Na primeira visita o app pede a criação da senha com um código que aparece no log (`npm run auth:code` mostra de novo). Todos os caminhos de execução (pm2, Docker, variáveis) estão em [docs/como-rodar.md](docs/como-rodar.md).

### O laboratório (recomendado para testar)

```bash
npm run lab:up
```

Sobe um app isolado (portas 3101 e 5273), com dados fabricados em pasta temporária, **sem senha** e sem tocar no seu `data/`. Os dados fabricados nunca disparam os motores de IA; só um pedido que você mesmo enviar a um agente usa a sua CLI de verdade. `Ctrl+C` derruba tudo e apaga os dados. Detalhes no topo de `scripts/lab-up.mjs`.

## Branches e fluxo

- `main`: estável; é o que o site publica. Só recebe mudanças por PR vindo do `dev` (ou uma correção urgente).
- `dev`: integração. **Seu PR aponta para o `dev`.**

1. Faça um fork e clone.
2. Crie a branch a partir do `dev`, com o nome `tipo/descricao-curta`: `feat/...`, `fix/...`, `docs/...`.
3. Faça a mudança, rode as checagens (abaixo) e abra o PR para o `dev`.

## Commits

Padrão [Conventional Commits](https://www.conventionalcommits.org/pt-br/), em português ou inglês: `feat(web): ...`, `fix(server): ...`, `docs: ...`, `test: ...`, `refactor: ...`, `chore: ...`. Um commit por mudança lógica.

## Antes de abrir o PR

```bash
npm run typecheck
npm run lint
npm test
```

O CI roda esses três mais o build do web e do site; PR com falha não é revisado. Os testes e2e (Playwright) são opcionais e não rodam no CI: `npx playwright install chromium` uma vez e depois `npm run test:e2e`. Rode só os testes dos arquivos que você tocou enquanto desenvolve (`npx vitest run caminho/do/arquivo.test.ts`). Se a mudança aparece na interface, anexe prints (do laboratório) ao PR. Atualize a documentação em `docs/` e uma linha no `CHANGELOG.md` quando fizer sentido.

## Convenções do projeto

- **Idioma:** interface, mensagens ao usuário, documentação e comentários em pt-BR. Nomes de ferramentas MCP, parâmetros, enums e descrições delas em **inglês**.
- **Agentes sem API paga:** os agentes rodam por CLIs de assinatura (Claude Code, Antigravity, Codex, OpenCode...) como terminais de fundo, conversando com o app pelo MCP do Cyno. Não adicione chave de API paga nem chamada direta a provedores. A única exceção documentada é o OpenRouter nos agentes OpenClaw e Hermes.
- **Sem dados pessoais:** nenhum e-mail, IP, domínio, nome ou caminho `/home/...` reais em código, testes, docs ou prints. Use dados fabricados e domínios de exemplo (`exemplo.com`).
- **Código copiado em `packages/cena`:** vem do Habblaud (MIT). Cada alteração em arquivo copiado leva o comentário `// CYNO-PATCH <n>: motivo` e entra em `packages/cena/PATCHES.md`; o aviso de licença (`packages/cena/LICENSE`, `THIRD_PARTY/`) deve ser mantido.
- **Testes:** use `AGENT_RUNNER=mock` (só para testes) e dados temporários; nunca aponte um teste para o seu `data/` real.

## Mudanças grandes

Abra uma issue antes (modelo "Ideia") descrevendo o problema e a proposta, e espere uma resposta. Isso evita trabalho perdido em algo que não cabe no projeto.

## Relatando um bug

Use o modelo "Bug" em Issues: o que aconteceu, o que esperava, passos para reproduzir, a versão (commit), como você roda (dev, pm2 ou Docker) e o motor do agente. Cole logs **sem segredos** (senhas, tokens, códigos, IPs). Falhas de segurança não vão em issue pública: veja [SECURITY.md](SECURITY.md).

Ao participar, você concorda com o [Código de Conduta](CODE_OF_CONDUCT.md). Contribuições são licenciadas sob a [MIT](LICENSE).
