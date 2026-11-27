# Como rodar

## Requisitos
Node >= 22.12 e npm. O Node 20 não serve, porque o Vite 8 e o Vitest 5 exigem 22.12+.

## Desenvolvimento
```bash
npm install
npm run dev
```
- O server roda com `tsx watch` em 127.0.0.1:3068, e o web com Vite em 0.0.0.0:3067.
- Abra `http://<ip-do-servidor>:3067`. Por exemplo: http://192.168.1.20:3067.
- O Vite serve **HTTP** por padrão. O ditado por voz precisa de contexto seguro (o microfone não funciona em `http://<ip-da-rede>`): rode com `WEB_HTTPS=1 npm run dev` para HTTPS com certificado autoassinado (`@vitejs/plugin-basic-ssl`, cobrindo `localhost` e os IPs da máquina; na primeira visita "Avançado" → "Continuar") ou libere o endereço no Chrome em `chrome://flags/#unsafely-treat-insecure-origin-as-secure`. O proxy de `/api` e `/ws` é o mesmo nos dois modos.
- Encerre com Ctrl+C (SIGINT). O server fecha as filas e os sockets.
- O `npm install` não deve avisar de vulnerabilidades nem do script de instalação do esbuild: o `package.json` tem `overrides` do `minimatch` (`^11.0.5`, que zerou o `npm audit`) e `allowScripts` liberando só o esbuild (npm 11).

### Primeiro acesso (criar a senha)
1. Suba o app (`npm run dev`, pm2 ou Docker). Sem senha, o server escreve no log, a cada subida, um quadro como este:
   ```
   CYNO: falta criar a senha de acesso
   Abra o Cyno e use o código  K7QM-4TXH-R9NB  para criar a senha.
   ```
   Para ver só o código: `npm run auth:code` (no Docker: `docker compose exec cyno npm run auth:code`). Ele também aparece no terminal do `npm run dev`, em `pm2 logs maestri-server` e em `docker compose logs cyno`.
2. Abra o Cyno no navegador: aparece **Criar a senha**. Digite o código, a senha e a confirmação. O código vale uma vez e muda se o server reiniciar antes de você usá-lo (olhe o log de novo). Errar o código conta no bloqueio por IP.
3. Pronto: a senha fica em `DATA_DIR/auth.json` (0600) e você já entra. Alternativa sem a tela: `npm run auth:set-password -w @cyno/server` (no Docker: `docker compose exec cyno npm run auth:set-password -w @cyno/server`).
- **Bloqueio por IP:** 5 senhas ou códigos errados bloqueiam o IP por 15 min; cada novo bloqueio em 24 h dobra o tempo (até 24 h). Sobrevive a reiniciar. Em Configurações > Acesso você vê os IPs bloqueados e as últimas tentativas, e pode desbloquear.
- **Verificação em duas etapas (opcional):** Configurações > Acesso > "Ativar verificação em duas etapas" (QR para um app autenticador, mais 10 códigos de recuperação). Perdeu o celular e os códigos? No servidor: `npm run auth:reset-2fa -w @cyno/server` (Docker: `docker compose exec cyno npm run auth:reset-2fa -w @cyno/server`).
- **`CYNO_AUTH=off`:** só para desenvolvimento e testes. Sem senha, o app fica **aberto** (como antes), com aviso no log. O `lab:up` e o Playwright ligam sozinhos; o `npm run dev` não.
- **Atrás de proxy:** o IP do bloqueio vem do salto que o proxy do Vite acrescenta no `x-forwarded-for`; proxies na mesma máquina (cloudflared, nginx, Caddy) são entendidos pelo `cf-connecting-ip` ou pelo salto anterior. Um proxy em OUTRA máquina fica de fora: nesse caso todos parecem vir do IP dele.

### O que aparece na tela
- O escritório vivo no canvas: lobby e salas flutuando, com os agentes andando, sentando para trabalhar, acenando e levando papéis ao quadro.
- Por cima: a barra superior (conexão, Mapa/Lobby/salas, "+ Sala", contadores e zoom), a caixa de tarefa embaixo, o feed de atividade à esquerda (aberto a partir de 1600 px de largura) e o painel lateral quando algo está selecionado. Como usar: [usando-o-escritorio.md](usando-o-escritorio.md).
- O zoom inicial é o maior em que o escritório inteiro cabe na área livre (com o seed, 1x em 1280×800).
- `?cena=demo` abre só a cena com dados de mentira e `?demo=1` abre o app inteiro de demonstração (sem servidor de agentes e sem IA).
- Quando o `tsx watch` reinicia o server (ao salvar um arquivo), a barra mostra "Reconectando…" e volta a "Ao vivo" sozinha, sem erros no console. O cliente só reabre o WebSocket depois que `GET /__backend-health` (rota do Vite, fora do proxy) responde `{ "up": true }`. Abrir ou recarregar a página com o server fora também não chama `GET /api/w/<ws>/office` (nada de 502): o snapshot do WS carrega o escritório quando ele sobe.
- Recarregar a página mantém o progresso e a pergunta de aprovação das tarefas ativas (vêm no snapshot). Reiniciar o server não: esse progresso fica só em memória.

### Acesso pela rede (servidor headless)
- O Vite escuta em `0.0.0.0` e repassa `/api` e `/ws` para o server, que só escuta em loopback.
- **A senha é obrigatória** (veja "Primeiro acesso" abaixo e "Senha de acesso" em [decisoes-e-limitacoes.md](decisoes-e-limitacoes.md)): sem `auth.json` o app fica fechado até a senha ser criada. A segurança vive no próprio app; não depende de túnel nem de proxy. Para nem expor a porta na rede, use `WEB_HOST=127.0.0.1` e acesse por túnel SSH: `ssh -L 3067:127.0.0.1:3067 servidor` (e abra `http://localhost:3067`).
- A porta é fixa (`strictPort`). Se a 3067 estiver ocupada, o Vite falha em vez de trocar de porta.

## No Windows
O Cyno roda em Linux (e em macOS). No Windows há dois caminhos:
- **Docker Desktop (recomendado):** `npm run docker:up` (ou `docker compose up -d --build`) e abra `http://localhost:3067`. Veja "Com Docker" abaixo.
- **WSL2 com Ubuntu:** instale o Ubuntu (`wsl --install -d Ubuntu`), clone o projeto **dentro** do Ubuntu e rode os comandos desta página no terminal dele.

Um aplicativo instalável para Windows (sem Docker, com ícone na bandeja) está em proposta: veja `docs/empacotamento-windows.md`.

O `npm run dev`, o `npm start` e o pm2 **direto no Windows** (PowerShell ou CMD) não funcionam: o server abre terminais e CLIs de Linux para os agentes. O `npm run pm2:start` recusa o Windows com um aviso. Se uma versão anterior deixou o pm2 abrindo e fechando uma janela sem parar (erro `execvpe(/bin/bash) failed` do WSL), pare com `npx pm2 delete maestri-server maestri-web`.

## Com pm2
O `ecosystem.config.cjs` já define dois processos: `maestri-server` (o server, sem watch) e `maestri-web` (compila a web e serve a versão compilada com `vite preview`, com o mesmo proxy e porta do dev). Ele lê um `.env` opcional na raiz e põe `~/.local/bin` no `PATH` (é onde ficam `claude` e `agy`).
```bash
npm install
npm i -g pm2             # uma vez
npm run pm2:start        # = pm2 start ecosystem.config.cjs
npm run pm2:logs         # pm2 logs (ou: pm2 logs maestri-server / maestri-web)
npm run pm2:restart      # depois de atualizar o código (a web recompila ao reiniciar)
npm run pm2:stop
pm2 save && pm2 startup  # opcional: subir junto com a máquina
```
**Atualizar:** quando a etiqueta da versão na barra lateral virar **Atualizar**, rode na pasta do projeto `git pull`, `npm install` (se as dependências mudaram) e `npm run pm2:restart`. Ou clique em **Baixar atualização** em Configurações > Versão e atualizações (baixa o código e instala as dependências, mas o reinício é com você; veja "Versão e atualizações" abaixo).

Para reiniciar só uma parte: `pm2 restart maestri-server` ou `pm2 restart maestri-web`. Os dados ficam em `./data` (ou `DATA_DIR`). As CLIs dos agentes (`claude` etc.) precisam estar instaladas e logadas no usuário que roda o pm2.

## Com Docker
A imagem (`Dockerfile`, Node 22 Debian slim) traz o server, o web já compilado, `python3` (cerca de arquivos), o Chromium do Playwright com as bibliotecas dele (navegador dos agentes) e o Claude Code. Um contêiner roda os dois processos (`concurrently`: server via `tsx` em `127.0.0.1:3068` e `vite preview` em `0.0.0.0:3067`, que faz proxy de `/api` e `/ws`). **Só a porta 3067 é publicada**; o server nunca fica exposto. Roda como o usuário `node` (uid 1000), com `tini` como init.

```bash
docker compose up -d --build     # http://localhost:3067
docker compose logs -f cyno
docker compose ps                # STATUS "healthy" (HEALTHCHECK em /api/health do server)
```
Sem Compose: `docker build -t cyno . && docker run -d --name cyno -p 3067:3067 -e PUID=$(id -u) -e PGID=$(id -g) -v /onde/quiser/data:/data -v /onde/quiser/home:/home/node cyno`.

- **Dados (você escolhe onde):** tudo o que é seu fica FORA da imagem, em pastas do seu computador. No `.env` ao lado do `docker-compose.yml`: `CYNO_DATA_DIR` (padrão `./data`) vira o `DATA_DIR=/data` do contêiner (workspaces, projetos, `auth.json`, contas dos motores e os motores que o app instala) e `CYNO_HOME_DIR` (padrão `./data-home`) vira o `/home/node` (login da conta padrão do Claude e do Antigravity). Ex.: `CYNO_DATA_DIR=/mnt/disco/cyno/data`. Reiniciar, recriar ou atualizar o contêiner mantém tudo. Backup: copie as duas pastas com o contêiner parado. `./data` também é a pasta padrão do app rodando fora do Docker (`npm run dev`): não rode os dois ao mesmo tempo sobre ela.
- **Dono das pastas (`PUID`/`PGID`):** o app nunca roda como root. O contêiner sobe, acerta o dono das pastas de dados (uma vez) e vira o usuário `PUID:PGID` do `.env` (padrão 1000:1000; rode `id -u` e `id -g` e ponha os seus). Assim a pasta que o Docker cria sozinho (como root) também funciona, e os arquivos ficam seus no computador.
- **Mais volumes (seus projetos, vault, backups):** copie `docker-compose.override.example.yml` para `docker-compose.override.yml` (o Compose lê sozinho; fica fora do git) e ajuste os caminhos do lado esquerdo, por exemplo `/home/voce/projetos:/projects`. No app, adicione `/projects/meu-site` em Configurações > Pastas de trabalho. O dono dessas pastas é o seu: o Cyno não troca.
- **Configuração:** um `.env` na raiz (opcional; veja `.env.example`) é lido pelo Compose. Domínio de túnel ou proxy reverso: `WEB_ALLOWED_HOSTS=app.exemplo.com`. Para trocar a porta, mude `WEB_PORT` no `.env` (o Compose publica a mesma porta).
- **Senha:** no primeiro acesso, veja o código de configuração com `docker compose exec cyno npm run auth:code` (ele também aparece em `docker compose logs cyno`); abra `http://localhost:3067` e crie a senha pela tela. Alternativas: `docker compose exec cyno npm run auth:set-password -w @cyno/server` (sem eco; precisa de terminal), `... auth:clear ...` para voltar ao primeiro acesso e `... auth:reset-2fa ...` para desligar o 2FA. O server relê o arquivo sozinho. O app nunca fica aberto sem senha; `CYNO_AUTH=off` não é para o contêiner.
- **Login das CLIs:** nada do seu `~/.claude` do host é montado. Entre uma vez no contêiner: `docker compose exec cyno claude` (siga o login da sua assinatura e saia). O login fica em `./data-home` (`/home/node`), então sobrevive a reinícios e atualizações. Confira com `docker compose exec cyno claude auth status`.
- **Outras CLIs:** só o Claude Code vem na imagem. Para Codex e OpenCode, construa com `docker compose build --build-arg EXTRA_CLIS="@openai/codex opencode-ai"` (ou `build.args` no compose); um pacote que falhar só gera um aviso e o build segue. Quem tem instalador próprio (Antigravity `agy`, Freebuff, Hermes, OpenClaw) pode ser instalado dentro do contêiner (`docker compose exec cyno ...`, indo para o home (`./data-home`), em `~/.local/bin`; acrescente-o ao `PATH` com `PATH` no `.env`/`environment` se preciso) e logado do mesmo jeito. `GET /api/engines` mostra o que o server achou.
- **Atualizar:** `git pull && npm run docker:up`. As pastas `./data` e `./data-home` continuam. O `npm run docker:up` grava o `version.json` (commit, data, ramo e número de commits) e depois roda `docker compose up -d --build`; a imagem não leva a pasta `.git`, e é esse arquivo que faz a tela mostrar o commit e comparar com o GitHub. Sem ele (por exemplo, com `docker compose up --build` direto), a tela mostra só a versão do package.json e a verificação fica como "não foi possível verificar". Para atualizar só o Claude Code, `docker compose build --no-cache` refaz a camada.
- **Tamanho:** cerca de 2,4 GB (Chromium e bibliotecas ~0,7 GB, Claude Code ~0,35 GB, dependências do projeto ~0,25 GB).

Limitações honestas:
- **Cerca de arquivos (Landlock):** é usada só pelos agentes OpenClaw e Hermes. Ela depende do kernel do host e do filtro seccomp do Docker liberarem as chamadas do Landlock; num host com Docker recente e kernel >= 5.13 funcionou nos testes, mas num Docker/kernel mais antigo (ou com `--security-opt seccomp=...` mais restrito) a detecção (`detectFence`) devolve "sem cerca": **não dá erro**, os agentes rodam sem a cerca e a tela do app avisa que ela não existe. `CYNO_FENCE=off` desliga de vez.
- **Navegador dos agentes:** o Chromium roda com `--disable-dev-shm-usage` (sem depender do `/dev/shm` de 64 MB do Docker). Se ele cair em páginas pesadas, suba o `shm_size` do serviço.
- **Rede local:** o navegador dos agentes bloqueia endereços da rede local; dentro do Docker isso inclui a própria bridge. Acesso a serviços do host exige `host.docker.internal`/IP e pode ficar bloqueado por essa regra.
- **Ditado por voz** continua pedindo HTTPS ou `localhost` (`WEB_HTTPS=1` no `.env` liga o certificado autoassinado).
- Os agentes só enxergam arquivos dentro do contêiner (`/data/workspaces/...`); para dar acesso a pastas do host, monte-as com um `volumes` extra no compose.
- Os logins das CLIs ficam em texto em `./data-home`; trate a pasta como segredo.

## Versão e atualizações
O app mostra a versão (`v0.2.0 · build 3`: versão do package.json e número de commits) e avisa quando o ramo estável do GitHub tem novidades; veja [usando-o-escritorio.md](usando-o-escritorio.md). O botão **Baixar atualização** baixa o código com um clique (e instala as dependências se mudaram), mas **nunca reinicia nada**: a tela mostra o comando de reinício do seu jeito de rodar. Nada baixa sozinho.
- **Com pm2 ou `npm run dev`:** a versão vem do `git` do próprio clone, sem rede. A verificação usa `git ls-remote origin refs/heads/main` (sem `fetch`, o clone não muda) e precisa de acesso ao `origin` sem digitar senha (chave ssh ou repositório público por https).
- **Com Docker:** a imagem não leva a pasta `.git`. `npm run docker:up` grava antes o `version.json` da raiz, que a imagem leva junto; é dele que vêm o commit e o endereço do `origin`.
- **O botão e o reinício:** o botão só vale para clone no ramo estável (`main`), com a pasta sem mudanças em arquivos versionados, e faz `git fetch` e `git merge --ff-only` (mais `npm install` se o `package-lock.json` mudou). Depois, reinicie você: com pm2, `npm run pm2:restart`; com `npm start`, pare o processo e rode de novo; com `npm run dev`, ele reinicia sozinho (se a tela não mudar, pare e rode de novo); com Docker, no computador hospedeiro, `git pull` e `npm run docker:up` (o botão não existe no Docker). Reiniciar interrompe os agentes que estiverem trabalhando.
- **Variáveis:** `CYNO_UPDATE_CHECK=off` (ou `0`) desliga a verificação automática (a de Configurações continua); `CYNO_UPDATE_BRANCH` troca o ramo comparado (padrão `main`); `CYNO_UPDATE_APPLY=off` (ou `0`) desliga o botão **Baixar atualização** (o aviso continua).

## Seed
- No primeiro boot, o seed roda sozinho se `data/office.json` não existir.
- `npm run seed` recria `data/` (com `--force`) e **apaga o estado atual**.
- O seed tem 2 salas (ProjetoX e ProjetoY), 4 times, 10 agentes, o Cérebro global e notas de exemplo.

## Agentes reais (Laboratório)
Agentes com `engine: "claude"` rodam no **Claude Code logado com a sua assinatura** (o `claude` do `PATH`, ou `CLAUDE_BIN`). Nada de API paga, chave de API, Anthropic SDK ou Agent SDK: o server tira `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, as outras `ANTHROPIC_*`, as variáveis de Bedrock/Vertex e as chaves de outros provedores do ambiente de cada processo, e para o terminal se a CLI disser que ia usar uma chave de API. O login fica no `~/.claude` (o mesmo do seu `claude` interativo); confira com `claude auth status` ou entrando uma vez no `claude`.

0. **App de teste isolado (recomendado; é o que os subagentes usam).** O app real tem senha e o `lab:setup` não tem sessão: contra ele, falhava com 401 (a causa: `/api/health` é isento da senha, então o `lab:setup` achava o server no ar e todas as outras rotas respondiam 401; agora ele para com a mensagem "exige senha (401)"). Em vez disso:
   ```bash
   npm run lab:up
   ```
   Sobe server (`127.0.0.1:3101`) e web (`127.0.0.1:5273`) com `DATA_DIR` temporário em `/tmp/cyno-lab-*`, **aberto** (`CYNO_AUTH=off`; um `DATA_DIR` novo não tem `auth.json`), com cotas, Chromium (ligue com `LAB_BROWSER=1`: o perfil nasce novo dentro do `DATA_DIR` de teste) e Remote Control desligados, e roda o setup contra ele. Ctrl+C derruba tudo e apaga a pasta (`LAB_KEEP=1` mantém; `LAB_SERVER_PORT`, `LAB_WEB_PORT` e `LAB_DATA_DIR` mudam portas e pasta; 3068 e 3067 são recusadas). Em segundo plano, guarde o PID e derrube com `kill -TERM <pid>` (nunca `pkill`). Os `curl` abaixo funcionam trocando 3068 por 3101. Não depende do app real nem da senha dele.
1. Crie o workspace de teste (idempotente; com o server no ar vai pela API, parado abre os dados direto; não mexe no "Principal"). Com `lab:up` isto já foi feito; à mão, contra um server sem senha:
   ```bash
   LAB_API_URL=http://127.0.0.1:3101 npm run lab:setup
   ```
   Ele cria **Laboratório** (`laboratorio`): Sala do Maestro com o Maestro em motor `claude`, a sala/time **Conteúdo** com o agente **Redator** (motor `claude`, foco "escrever textos curtos") e a sala/time **Pesquisa** com o agente **Pesquisador** (motor `gemini`, no Antigravity, modelo `gemini-3.8-flash-medium`; veja abaixo).
2. Suba o app (`npm run dev`) e mande um pedido ao Maestro do Laboratório (pela caixa "Peça ao Maestro…" no workspace Laboratório, ou):
   ```bash
   curl -s -X POST http://127.0.0.1:3068/api/w/laboratorio/tasks -H 'content-type: application/json' \
     -d '{"prompt":"Escreva um slogan curto para uma pizzaria"}'
   ```
3. O que deve acontecer: o terminal do Maestro sobe (`claude -p … stream-json`, na pasta `data/workspaces/laboratorio/agents/maestro/`), ele chama `get_team` e `delegate_task` pelo MCP, o terminal do Redator sobe e chama `submit_result`, o resultado volta para a sessão do Maestro e ele fecha com `concluir_pedido`. Tudo aparece no log de trabalho (Ctrl/⌘+K no app, ou `GET /api/w/laboratorio/tasks/<id>/log`), com `provider: "claude"` no que veio da CLI.
4. Conferências do smoke test: a primeira linha `raw` de cada terminal é o `[init]` com modelo, ferramentas (só `Read, Write, Edit, Glob, Grep` e `mcp__office__*`), `MCP: office: connected` e o `auth` (não pode ser chave de API); nenhum hook/plugin do seu `~/.claude` deve aparecer; `data/workspaces/laboratorio/agents/<id>/session.json` guarda a sessão.
5. Ligar/parar à mão: `POST /api/w/laboratorio/agents/<id>/terminal/start` e `/terminal/stop` (a sessão continua salva; a próxima ordem retoma com `--resume`). Ocioso por `TERMINAL_IDLE_MS` (15 min) o processo para sozinho.

Qualquer agente vira real com `PATCH /api/w/:ws/agents/:id` `{ "engine": "claude", "model": "sonnet", "effort": "low" }` (`model`/`effort` opcionais; `null` volta ao padrão), ou no app: painel do agente → **Editar** → **Motor** (Claude Code / Antigravity, só as CLIs instaladas no server; agente antigo gravado como simulado aparece como "Sem motor" até você escolher um) e **Modelo**. `GET /api/engines` diz quais CLIs o server achou (`?refresh=1` procura de novo depois de instalar uma). Os testes automáticos nunca chamam o `claude` nem o `agy` de verdade: usam as CLIs falsas `packages/server/src/engines/terminals/fake-cli.mjs` e `fake-agy.mjs`.

### Teste real com Haiku no app de teste
Autorizado: UMA tarefa trivial por vez, só no app de teste (`lab:up`), nunca no app real; gasta um pouco da cota da assinatura. Não mexa em `~/.claude` nem `~/.gemini` (o server cuida da config isolada dos agentes).
1. `npm run lab:up` (noutro terminal ou em segundo plano). Confirme o login com `claude auth status` (a CLI fica em `~/.local/bin`).
2. Configure o Redator para o Haiku:
   ```bash
   curl -s -X PATCH http://127.0.0.1:3101/api/w/laboratorio/agents/redator -H 'content-type: application/json' \
     -d '{"engine":"claude","model":"haiku","effort":"low"}'
   ```
3. Mande a tarefa direto ao time (sem passar pelo Maestro, que gastaria mais):
   ```bash
   curl -s -X POST http://127.0.0.1:3101/api/w/laboratorio/tasks -H 'content-type: application/json' \
     -d '{"prompt":"Responda só: ok","roomId":"conteudo","teamId":"conteudo-conteudo"}'
   ```
4. Confira `GET /api/w/laboratorio/tasks`: `status: "done"`, `ranWith: {engine: "claude", model: "haiku", ...}` e `result: "ok"`. Em 11/11/2026 concluiu em cerca de 3 s.
5. Derrube o app de teste (Ctrl+C ou `kill -TERM` no PID do `lab:up`).

### Antigravity (motor `gemini`)
Agentes com `engine: "gemini"` rodam no **Google Antigravity CLI** (`agy`, do `PATH` ou `AGY_BIN`) logado com a sua conta Google (a cota da assinatura; nunca `GEMINI_API_KEY`, Vertex nem créditos pagos). Confira antes: `agy --version` e `agy models` (lista os modelos que a sua conta pode usar, ex.: `gemini-3.8-flash-medium`, `gemini-4-argon-low`). O nível de raciocínio vem no nome do modelo (`-low`/`-medium`/`-high`); `effort` só se você escolher.

O server nunca mexe na sua configuração do agy: o MCP do escritório vai em `data/workspaces/<ws>/agents/<id>/.agents/mcp_config.json` (com o token do agente) e as instruções em `GEMINI.md`, na pasta do agente; as permissões vão por `--settings`, só para aquela sessão (MCP do escritório e arquivos da pasta liberados; terminal, internet e navegador negados; nada fora da pasta). Detalhes e ressalvas em `docs/arquitetura.md` ("Antigravity").

**Smoke test supervisionado (Maestro no Claude Code → Pesquisador no Antigravity)** — gasta um pouco das duas assinaturas:
1. `npm run lab:setup` (cria ou acerta o Pesquisador) e `npm run dev`.
2. Opcional: `curl -s http://127.0.0.1:3068/api/engines` deve mostrar Claude Code e Antigravity com `"available": true`.
3. Ligue o Pesquisador sozinho primeiro (sobe o `agy` e não gasta nada até a primeira mensagem): `curl -s -X POST http://127.0.0.1:3068/api/w/laboratorio/agents/<id do Pesquisador>/terminal/start` → `"status":"idle"` (o id sai no fim do `lab:setup`).
4. Mande o pedido: pela caixa "Peça ao Maestro…" do Laboratório, ou
   ```bash
   curl -s -X POST http://127.0.0.1:3068/api/w/laboratorio/tasks -H 'content-type: application/json' \
     -d '{"prompt":"Peça ao Pesquisador 3 curiosidades curtas sobre pizza"}'
   ```
5. O que deve acontecer: o Maestro chama `get_team` e `delegate_task` para o Pesquisador; o terminal dele mostra `[init] conversa <id> · modelo gemini-3.8-flash-medium · permissões: request-review`, às vezes um `read_file` do esquema da ferramenta (em `~/.gemini/antigravity-cli/mcp/office/`), depois `mcp__office__submit_result` "ok"; o resultado volta ao Maestro, que fecha com `complete_request`. No app, a tela de trabalho do Pesquisador mostra o selo "Antigravity".
6. Confira: `data/workspaces/laboratorio/agents/<id>/session.json` com `"provider":"gemini"` e o `conversation_id`; `~/.gemini/config/mcp_config.json` e `~/.gemini/antigravity-cli/settings.json` iguais a antes; linhas `[negado] …` no log só se o modelo tentou algo fora da política. Se o Pesquisador terminar o turno sem chamar `submit_result`, o texto final do turno vira o resultado.

## Testes
```bash
npm run typecheck
npm run lint            # --max-warnings 0
npm test                # Vitest
npx playwright install chromium   # uma vez
npm run test:e2e        # Playwright
```
- O e2e sobe o server (3068) e o Vite (3067, só em 127.0.0.1) com `DATA_DIR` temporário em `$TMPDIR/cyno-e2e`. O e2e liga o modo simulado (`AGENT_RUNNER=mock`, só ele usa agentes simulados). As tarefas ficam rápidas (`MOCK_MIN_MS=50`, `MOCK_MAX_MS=150`) e não há sorteio de aprovação (`MOCK_APPROVAL_RATE=0`). As portas 3068 e 3067 precisam estar livres.
- O Chromium headless roda com `--use-angle=swiftshader --enable-unsafe-swiftshader` (WebGL por software, sem warning no console). Use as mesmas flags em scripts próprios.
- O Playwright **tira `DISPLAY`** do ambiente do Chromium (`browserEnv()` em `playwright.config.ts`). Numa sessão SSH com X11, o ANGLE tentava Vulkan via XCB, falhava e o WebGL sumia.
- Scripts próprios de navegador não passam por essa config: rode-os com `env -u DISPLAY` (por exemplo `env -u DISPLAY node meu-script.mjs`).
- São 26 testes e2e, em 9 arquivos (`npx playwright test --list` conta):
  - `smoke.spec.ts` (2): barra, caixa de tarefa e cena sem erros no console; zoom pelos botões e pelas teclas;
  - `cena-mapa.spec.ts` (10): a cena monta com todos os agentes, clicar no personagem, selecionar pela interface, criar e apagar sala, mover agente de time, mão levantada, "Ver no mapa", arrastar a câmera, zoom pela roda e uma medida folgada de quadros desenhados (por `window.__cena`);
  - `backend-flow.spec.ts` (3): tarefa pela caixa até concluída, recusa da aprovação e portas pelo painel chegando a outra aba;
  - `ui-tasks.spec.ts` (2), `ui-create.spec.ts` (2) e `ui-room.spec.ts` (2): aprovação pela UI, recarregar com aprovação pendente, criar e editar pelas telas;
  - `ui-teams.spec.ts` (2): editar e excluir time (a confirmação lista agentes e tarefas) e mudar agente de time, para outra sala, com o campo travado durante uma tarefa ativa;
  - `ui-a11y.spec.ts` (1): axe-core (`@axe-core/playwright`) com as regras WCAG 2.1 A/AA nas telas e janelas. O canvas fica de fora;
  - `ui-screenshots.spec.ts` (2): prints da UI em 1280×800 e 1920×1080.
- Os testes usam hooks que só existem em dev: `window.__agentOffice` (os stores `office` e `view`) e `window.__cena` (o mundo da cena: seleção, posição na tela, `probe()` e `extras`). O build de produção não tem nenhum dos dois.

## Variáveis de ambiente
Todas são opcionais. Copie o `.env.example` para `.env` na raiz (`cp .env.example .env`) e ajuste: o bloco do começo traz o principal já com os padrões, e o resto fica comentado. O `.env` vale para `npm run dev`, `npm start`, pm2 e Docker; uma variável definida no ambiente vale sobre o arquivo.

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | 3068 | porta do server (o Vite usa para o proxy) |
| `HOST` | 127.0.0.1 | host do server |
| `DATA_DIR` | `./data` | estado e Cérebros (relativo à raiz do repo) |
| `LOG_LEVEL` | info | nível do pino |
| `AGENT_RUNNER` | (vazio) | `mock` liga o modo simulado (runner falso, Maestro simulado, motor "mock"; marcadores `[aprovar]`/`[falhar]`/`[plano]`), SÓ para testes e e2e. Vazio = produção: só agentes e Maestro reais; agente antigo sem motor falha a tarefa com mensagem clara |
| `MOCK_MIN_MS` / `MOCK_MAX_MS` (só com `AGENT_RUNNER=mock`) | 3000 / 8000 | duração de uma tarefa simulada |
| `MOCK_APPROVAL_RATE` (só com `AGENT_RUNNER=mock`) | 0.2 | chance de pedir aprovação sem o marcador `[aprovar]` |
| `MOCK_SUBAGENT_RATE` (só com `AGENT_RUNNER=mock`) | 0.4 | chance de o agente simulado dividir um passo entre 2–3 subagentes em paralelo (cada um com a própria thread no log) |
| `DONE_LINGER_MS` | 5000 | tempo em `done` antes de voltar a `idle` |
| `APPROVAL_PARK_MS` | 120000 | quanto uma tarefa esperando o usuário segura a vaga do agente antes de soltá-la (0 = solta na hora; se há outra tarefa na fila, solta sempre) |
| `WS_HEARTBEAT_MS` | 30000 | intervalo do ping do WS |
| `CLAUDE_BIN` | claude | executável do Claude Code dos agentes com motor `claude` |
| `CLAUDE_EFFORT` | low | `--effort` dos agentes `claude` sem `effort` próprio (`none` = não passa, fica o da CLI) |
| `AGY_BIN` | agy | executável do Google Antigravity CLI dos agentes com motor `gemini` |
| `TERMINAL_IDLE_MS` | 900000 (15 min) | terminal ocioso por tanto tempo é parado; a próxima ordem retoma a sessão (`0` = nunca para) |
| `TERMINAL_MAX_RETRIES` | 3 | quedas seguidas do processo antes de desistir (as mensagens pendentes falham) |
| `CLAUDE_USAGE_POLL_MS` | 180000 (3 min) | intervalo da consulta do uso da **conta** Claude (com o login do Claude Code em `~/.claude/.credentials.json`; `0` = desligada). Veja "Uso da assinatura" em `docs/arquitetura.md` |
| `OFFICE_MCP_URL` | `http://127.0.0.1:<PORT>/mcp` | URL do servidor MCP "office" que vai no `mcp.json` (Claude Code) ou `.agents/mcp_config.json` (Antigravity) dos agentes |
| `CLAUDE_AUTOCOMPACT` | auto | `--autocompact` dos agentes `claude` (`auto`, `none` ou 100000-1000000 tokens) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | pasta de config do Claude Code (a retenção limpa as conversas em `<ela>/projects`) |
| `MAESTRO_TERMINAL` | pty | Maestro de Claude Code como terminal interativo (`pty`) ou `headless` (`claude -p`) |
| `MAESTRO_REMOTE_CONTROL` | 1 | Remote Control do terminal do Maestro (`0` desliga) |
| `MAESTRO_ROTATE_TOKENS` | 0 | renova a conversa do Maestro de CLI acima desse total de tokens (`0` = nunca) |
| `ANTIGRAVITY_USAGE_POLL_MS` | 300000 (5 min) | intervalo da consulta da cota Google no Antigravity (`0` = desliga) |
| `CONNECTORS_STDIO` | 0 | `1` libera conectores que rodam um comando local. É o **padrão**: o dono pode ligar ou desligar em Configurações > Conectores locais (grava em `data/platform/settings/connectors.json` e passa a valer sobre o `.env`; "Voltar ao padrão do servidor" apaga a escolha) |
| `CYNO_REQUIRE_APPROVAL` | 0 | `1` faz as ações perigosas do Cyno (apagar, acesso, conectores, comando na máquina) e `propose_workspace` pedirem OK num cartão no chat; padrão `0`: executam na hora com registro na Atividade |
| `CYNO_IDLE_MS` | (vazio) | **só para teste**: ociosidade do Cyno em ms antes de dormir; vazio = o que está em Configurações > Cyno (padrão 10 min) |
| `CYNO_UPDATE_CHECK` | on | `off` ou `0` desliga a verificação automática de atualização (1 min depois da subida e a cada 6 h); o botão **Verificar agora** continua. Veja "Versão e atualizações" |
| `CYNO_UPDATE_BRANCH` | main | ramo do `origin` com que a instalação é comparada |
| `CYNO_UPDATE_APPLY` | on | `off` ou `0` desliga o botão **Baixar atualização** (o aviso e o **Verificar agora** continuam). O app nunca reinicia sozinho |
| `RETENTION_AUTO` | 1 | limpeza automática do histórico (boot + diária); `0` desliga. Vale também para a limpeza do armazenamento dos motores (que só age no que o dono ligou) |
| `ANTIGRAVITY_HOME` | `~/.gemini/antigravity-cli` | pasta de dados do Antigravity, lida pelo armazenamento dos motores (medir e limpar logs) |
| `FREEBUFF_HOME` | `~/.config/manicode` | pasta de dados do Freebuff (chats `fb-*` dos agentes do Cyno) |
| `BROWSER` / `BROWSER_IDLE_MS` | 1 / 600000 | navegador compartilhado dos agentes e ociosidade até fechar (`0` = nunca) |
| `ROUTINE_TICK_MS` | 600000 (10 min) | **só para teste**: intervalo do vigia das rotinas (mínimo 1000); a primeira passada vem depois de um intervalo |
| `BROWSER_BLOCKED_HOSTS` | (vazio) | domínios que o navegador nunca abre (vírgulas) |
| `CYNO_MIGRATE_NO_GROUP` | (desligada) | `1` = a migração para projetos não agrupa os pedidos "N/M" (só vale no primeiro boot de um workspace antigo) |
| `SYSTEM_LOG` / `SYSTEM_LOG_SAMPLE_MS` | 1 / 60000 | atividade do servidor em `DATA_DIR/activity` e intervalo da amostra (`0` desliga) |
| `WEB_HOST` / `WEB_PORT` | 0.0.0.0 / 3067 | Vite |
| `WEB_ALLOWED_HOSTS` | (vazio) | domínios extras aceitos no cabeçalho Host da UI (túnel, proxy reverso; vírgulas). Sem ela vale o padrão do Vite |
| `WEB_HTTPS` | 0 | `1` serve HTTPS autoassinado |
| `LAB_SERVER_PORT` / `LAB_WEB_PORT` / `LAB_DATA_DIR` / `LAB_KEEP` / `LAB_API_URL` | 3101 / 5273 / temporária / 0 / server local | só do `lab:up` e `lab:setup` |
| `LAB_UPDATE_CHECK` | 0 | só do `lab:up`: `1` liga a verificação automática de atualização (desligada no laboratório, como as outras consultas externas) |
| `LAB_UPDATE_APPLY` | 0 | só do `lab:up`: `1` liga o botão **Baixar atualização** (desligado: o laboratório roda a partir do repositório real, e o botão mexeria nele) |
| `LAB_BROWSER` / `LAB_CONNECTORS_STDIO` | 0 / 0 | só do `lab:up`: `1` liga o navegador dos agentes / libera conectores stdio no app de teste |
| `LAB_USAGE` | 0 | só do `lab:up`: `1` liga a consulta do uso do plano (Claude e Antigravity) no app de teste, para testar a pausa por limite com o uso de verdade |
