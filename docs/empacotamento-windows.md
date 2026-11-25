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

## Estado da casca
O esqueleto completo da casca Tauri 2 já existe em `packages/desktop/` (fora dos `workspaces` raiz para não exigir Rust no CI Linux), acompanhado da ponte no web (`packages/web/src/desktop/desktopBridge.ts`, integrada a `packages/web/src/attention/notify.ts`) e do workflow manual/tag `.github/workflows/desktop.yml` (rascunho em `windows-latest`). Ainda faltam: compilar e testar pela primeira vez em uma máquina Windows com Rust + MSVC, gerar o par de chaves do atualizador (`REPLACE_WITH_PUBLIC_KEY` → chave pública real + segredos no GitHub), empacotar o ponto de entrada autônomo (`resources/server/entry.mjs`) do servidor+web e validar o comportamento do WebView2 com os terminais. Veja o passo a passo em `packages/desktop/README.md`.
