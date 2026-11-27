# Cyno no Windows: proposta de aplicativo instalável

Estado: **proposta** (nada disso foi construído). Trabalho na branch `windows-app`, a partir de `dev`. O Docker já está pronto (veja "Com Docker" em `como-rodar.md`) e fica como opção para servidor.

## O que foi pedido
- Um instalador `.exe` (sem Docker, sem terminal): abre, instala, escolhe onde ficam os dados.
- Inicia junto com o computador e vive no ícone da bandeja (canto inferior direito).
- Fechar a janela **não** encerra: continua em segundo plano; só "Sair" pelo ícone encerra.
- Janela própria, como um PWA, com os mesmos motores (Claude e Antigravity, contas isoladas).
- Notificações **do aplicativo** (nativas do Windows), no lugar das do navegador.
- Atualização: aplicar ao fechar e abrir de novo.
- Rodar **igual ao Linux**: o servidor é um processo separado, e a casca só abre a URL.

## Decisão: nativo no Windows, sem WSL
Rodar o servidor direto no Windows, como roda no Linux. Motivos: o usuário escolhe qualquer pasta sem tradução de caminho, sem lentidão do acesso `/mnt/c` em repositórios grandes e sem exigir virtualização. Tudo roda localmente e só o próprio usuário acessa, então a segurança é equivalente a ele abrir um terminal e rodar o comando.

O WSL fica só como **opção avançada** (para quem já o usa), nunca como base. O Maestri (concorrente) faz o mesmo: interface em Electron, motor nativo, PowerShell no Windows e WSL/SSH/Docker como escolha do usuário.

## A casca: Tauri com o servidor como processo separado
O Tauri não conhece o Cyno. Ele só:
1. inicia o servidor (um Node empacotado junto, como "sidecar") quando o app abre;
2. mostra uma janela (WebView2) em `http://localhost:3067`, sem barra de endereço;
3. mantém o ícone na bandeja: Abrir, Atualizar e **Sair** (encerra o servidor);
4. inicia com o Windows (entrada de inicialização do usuário, sem serviço de administrador), direto para a bandeja;
5. atualiza (atualizador assinado, abaixo);
6. mostra **notificações nativas** (abaixo).

Por que Tauri e não Electron: instalador de poucos MB (usa o WebView2 do Windows), menos memória parado na bandeja e plugins prontos de bandeja, início com o sistema e atualizador. O Electron só traria vantagem se o servidor rodasse dentro do app, o que não é o desenho. Se o WebView2 se comportar mal com o terminal, trocar para Electron é barato porque o servidor e a interface não mudam. Precisa de um binário do Node e do módulo de terminal (`node-pty`) para Windows x64 no pacote.

## Notificações nativas
- O serviço de atenção do servidor (`AttentionService`) já sabe quando um agente terminou, travou ou precisa de uma decisão, e isso já chega à tela por WebSocket.
- A casca ouve os mesmos eventos e dispara a **notificação do Windows** (também na central de notificações), mesmo com a janela fechada. Clicar abre a janela já no agente ou projeto certo.
- Marca o ícone da bandeja quando há algo esperando o usuário.
- Escolha de quais avisos notificar e modo "não perturbe". Se a janela está em foco, não duplica.
- Fora do aplicativo (Linux, Docker, navegador), continua a notificação do navegador.

## Pastas de trabalho
- **"Adicionar pasta"** abre a janela normal do sistema; o usuário adiciona quantas quiser, em qualquer disco. No Linux nativo, o app tem o seletor de pastas próprio (navega pelo disco do servidor).
- **Clonar pela plataforma:** colar a URL do repositório e o app clona nos dados. Exige uma tela para credenciais do git (chave SSH ou token), que também resolve repositório privado.
- **Docker** (servidor): um único volume grande (`CYNO_PROJECTS_DIR=~`) e o seletor do app navega dentro dele. Não é o caminho do usuário comum.

## O que muda no servidor para rodar no Windows
A camada de terminais é a mesma (`@lydell/node-pty` usa o ConPTY no Windows 10 recente e no 11). O trabalho está em:
- **Shell:** trechos que chamam `bash` (executor de scripts, receitas de instalação do `agy` e do Hermes, lista de binários proibidos) ganham versão para PowerShell; o Claude Code costuma exigir o Git para Windows. O agente é avisado de qual shell usar.
- **Encerrar processos:** hoje usa grupos de processo do Linux (cerca de 46 pontos para revisar); no Windows, `taskkill` ou Job Objects.
- **Cerca de arquivos (Landlock):** só existe no Linux. No Windows fica **opcional**: o agente roda com confirmação para escrever fora do projeto, em vez de bloqueio total.
- **Caminhos:** `C:\...`, finais de linha, e isolamento de contas por `USERPROFILE`/`APPDATA` no lugar de `HOME`.
- **Perfis de conta:** continuam dentro dos dados do Cyno (`<dados>/platform/engines/<motor>/accounts/<id>/`). Claude usa `CLAUDE_CONFIG_DIR` (arquivo de credenciais na pasta). O Antigravity precisa de teste: se guardar o login no gerenciador de credenciais do Windows, as contas dele se misturariam.
- **A confirmar antes de prometer:** se o `agy` tem versão para Windows e como guarda o login (maior incógnita); se o login do `claude` com `CLAUDE_CONFIG_DIR` se comporta igual.

## Instalação e atualização
- **Instalador** NSIS/MSI, mais uma versão portátil. Pergunta a pasta de dados. Começar só por **Windows 11 x64**.
- **Aviso do Windows:** sem certificado de assinatura, o SmartScreen e o "Controle inteligente de aplicativos" podem bloquear o instalador. Documentar a saída e, quando possível, assinar (certificado pago, anual).
- **Atualizador assinado**, pacotes das Releases do GitHub. Ao abrir, verifica; baixa em segundo plano; **aplica ao fechar e abrir**, nunca no meio de um trabalho. Antes, copia a pasta de dados e volta sozinho se a versão nova não subir. Canais "estável" e "dev".
- As CLIs (`claude`, `agy`) podem ser instaladas e logadas pela própria plataforma (mini terminal no navegador), diferente do Maestri, que exige que o usuário já as tenha.

## Alternativas descartadas
- **WSL2 privado como base:** funciona, mas exige virtualização, pode pedir reinício, o `/mnt/c` é lento em repositório grande (git e instalação de dependências costumam ficar de 3 a 10 vezes mais lentos) e as pastas precisam de tradução.
- **Docker Desktop:** licença, instalação e WSL visível; é a dor que o aplicativo quer evitar. Continua sendo opção para servidor.
- **Electron:** instalador de 100 MB ou mais e mais memória; fica de plano B para a casca.

## Riscos
- O `agy` pode não existir ou não isolar contas no Windows.
- Sem a cerca de arquivos, um erro do agente pode apagar algo fora do projeto (mitigado por confirmação).
- WebView2 pode se comportar diferente do Chrome no terminal (testar cedo).
- Windows em ARM e Windows 10 antigo: fora do primeiro corte.

## Ordem sugerida
1. Levantamento do `agy` e do `claude` no Windows (sem código). 2. Servidor subindo no Windows com CLI falsa (shell, processos, caminhos). 3. Seletor de pastas no app e clone pela plataforma. 4. Protótipo Tauri: bandeja, janela, iniciar e parar o servidor. 5. Notificações nativas. 6. Instalador, início com o Windows e atualizador assinado. 7. Teste em Windows de verdade (máquina limpa) antes de publicar.

## Estado do servidor no Windows

### O que já foi preparado (`packages/server`)
- **Módulo de plataforma injetável** (`src/platform/os.ts`, coberto por `os.test.ts` simulando `win32` e `linux`): centraliza detecção de Windows, encerramento de árvore de processos (`process.kill(-pid)` no Linux; `taskkill /pid <pid> /T /F` sem shell no Windows), checagem de processo vivo (`isProcessAlive`), shell padrão (`bash` vs `powershell.exe -NoLogo -NoProfile`), isolamento de pasta pessoal (`homeEnvFor` com `USERPROFILE`/`HOME`/`APPDATA`/`LOCALAPPDATA`), chave/separador de `PATH`, `PATHEXT`, junção (`junction`) para symlinks de pasta e contenção de caminhos case-insensitive (`isPathInside` / `samePath` via `path.relative`).
- **Processos e scripts:** `workspace/scripts/service.ts`, `library/apps/tool-runner.ts`, `engines/terminals/one-shot-terminal.ts` e `engines/install/installer.ts` trocam `detached: true` por `windowsHide: true` (sem `detached`) no Windows e encerram árvores via `killProcessTree`; o executor de scripts usa `powershell.exe` no Windows.
- **Receitas de instalação (`engines/install/recipes.ts`):** variantes PowerShell (`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ...`) para Claude (`irm https://claude.ai/install.ps1 | iex`) e Antigravity (`irm https://antigravity.google/cli/install.ps1 | iex`) com `USERPROFILE` isolado; Hermes marcado como indisponível no Windows nativo (recusado também pelo `EngineInstaller`).
- **Contas, caminhos e binários:** `EngineAccountStore.profileEnv` usa `homeEnvFor` no Antigravity e cria junções (`junction`) para diretórios (como `.local`); `login-status.ts`, `config.ts`, `account-poller.ts`, `freebuff/files.ts` e `antigravity-adapter.ts` (`readAgyTranscript`) respeitam `USERPROFILE` / perfil da conta; `findExecutable`, `resolveEngineBinary` e `whichInPath` consideram `;` e `PATHEXT` (`.exe`, `.cmd`, `.bat`); comparações de prefixo de pasta passaram a usar `path.relative` normalizado.
- **Requisitos, cerca e comandos do host:** `library/apps/requirements.ts` usa `os.freemem()` no Windows sem tentar `/proc/meminfo`; `engines/terminals/fence.ts` devolve `available: false` ("Não existe no Windows") sem tentar `python3` ou `/proc`; `host-command.ts` inclui `powershell`, `pwsh`, `cmd`, `wsl` e `bash.exe` como wrappers monitorados e `mcp/cyno/structure-tools.ts` exemplifica `powershell -Command` no Windows.

### O que continua pendente / depende de teste real em Windows 11
- **Teste em máquina Windows 11 real:** todas as mudanças foram validadas no Linux com simulação de `win32`; falta subir o servidor num Windows 11 nativo (incluindo `@lydell/node-pty` com ConPTY).
- **Antigravity (`agy`) com várias contas:** o `profileEnv` já isola `USERPROFILE`/`APPDATA`/`LOCALAPPDATA`, mas se o `agy` guardar o login no Gerenciador de Credenciais do Windows, as contas podem se misturar — depende de teste real.
- **Claude Code no Windows:** confirmar comportamento real de `CLAUDE_CONFIG_DIR`, dependência de Git para Windows e localização exata do binário instalado por `claude.ai/install.ps1`.
- **Symlinks de arquivos sem Modo Desenvolvedor:** em `EngineAccountStore` (`.gitconfig`, `.npmrc`), symlinks de arquivo podem retornar `EPERM` sem Modo Desenvolvedor (hoje são ignorados silenciosamente no Windows para não travar a criação da conta).
- **Runtimes da Biblioteca de Apps e métricas `/proc`:** download de runtimes (`library/apps/runtimes.ts`) ainda só lista alvos Linux (`x64`/`arm64`), e amostragem de processos em `platform/activity/sampler.ts` e `engines/freebuff/files.ts` degrada sem `/proc`.
- **Hermes:** mantido propositalmente indisponível no Windows nativo.

## Pacote autônomo

O instalador do Windows não leva `npm`, `tsx` nem Vite. Em vez disso, o script `packages/desktop/scripts/build-resources.mjs` monta tudo dentro de `packages/desktop/src-tauri/resources/`:

- **Bundle único do servidor (`resources/server/entry.mjs`):** gerado com `esbuild` (`platform: node`, `target: node22`, ESM) a partir de `packages/server/src/desktop-entry.ts`, embutindo os workspaces `@cyno/*` e dependências puras em JS.
- **Dependências externas:** apenas `@lydell/node-pty` (mais o binário nativo da plataforma: `@lydell/node-pty-win32-x64` no alvo `--platform win32-x64` via `npm pack` + `tar`, ou o pacote local no alvo `--platform host`) e `playwright-core` (carregado sob demanda via import dinâmico em `workspace/browser/playwright.ts`; quando ausente, o navegador integrado informa a indisponibilidade sem impedir o servidor de subir).
- **Gateway web embutido (`packages/server/src/desktop-gateway.ts`):** substitui o `vite preview` usando só `node:http` e `node:net`, escutando exclusivamente em `127.0.0.1:<WEB_PORT>` (nunca `0.0.0.0`). Serve os arquivos compilados de `resources/web/` (com MIME, cache imutável para assets com hash, `no-cache` para `index.html`/`sw.js`, fallback de SPA e bloqueio de path traversal/`..`/symlinks), responde `/__backend-health` e faz proxy HTTP + WebSocket upgrade de `/api` e `/ws` para `127.0.0.1:<PORT>` com `x-forwarded-*`.
- **Padrões exclusivos do modo desktop:** `CYNO_UPDATE_CHECK=off` e `CYNO_UPDATE_APPLY=off` (quem atualiza é o atualizador da casca Tauri, não o botão baseado em git), `HOST=127.0.0.1`, pasta web em `../web` relativo ao `entry.mjs` (com override `CYNO_WEB_DIR`) e encerramento limpo em `SIGINT`/`SIGTERM` ou quando o `stdin` do processo pai fecha (evitando processo órfão no Windows).
- **Validação local:** testes unitários do gateway em `packages/server/src/desktop-gateway.test.ts` e teste de fumaça em `packages/desktop/scripts/smoke.mjs` (`npm run smoke` dentro de `packages/desktop`).

## Estado da casca
O esqueleto completo da casca Tauri 2 já existe em `packages/desktop/` (fora dos `workspaces` raiz para não exigir Rust no CI Linux), acompanhado da ponte no web (`packages/web/src/desktop/desktopBridge.ts`, integrada a `packages/web/src/attention/notify.ts`), do pacote autônomo (`packages/desktop/scripts/build-resources.mjs` + `packages/server/src/desktop-entry.ts`) e do workflow manual/tag `.github/workflows/desktop.yml` em `windows-latest` (com verificação de SHA256 do `node.exe` oficial e upload dos instaladores como artefato). Ainda faltam: compilar e testar pela primeira vez em uma máquina Windows real com Rust + MSVC, gerar o par de chaves do atualizador (`REPLACE_WITH_PUBLIC_KEY` → chave pública real + segredos no GitHub) e validar o comportamento do WebView2, ConPTY e contas do `agy`/`claude` no Windows 11. Veja o passo a passo técnico em `packages/desktop/README.md` e o roteiro de testes para Windows em `docs/testando-no-windows.md`.
