# Como instalar e testar o Cyno Office no Windows

Este guia foi feito para testar o aplicativo **Cyno Office** no Windows 11 (64 bits), passo a passo, mesmo que você não trabalhe com programação.

Existem dois caminhos:
- **Caminho A (recomendado e rápido):** baixar o instalador pronto gerado pelo GitHub — não precisa instalar nenhuma ferramenta de programação.
- **Caminho B (para quem quer compilar no próprio computador):** montar o instalador do zero usando PowerShell.

---

## Caminho A — Rápido (sem instalar Rust nem compilar nada)

### 1. Baixar o instalador no GitHub

1. Abra o repositório do projeto no GitHub pelo navegador.
2. Clique na aba **Actions** (no menu superior).
3. Na coluna da esquerda, clique em **Desktop Windows (Tauri)**.
4. Clique na execução mais recente marcada com um sinal verde (**✓**).
   - Se ainda não houver uma execução verde, peça para quem mantém o projeto rodar o botão **Run workflow** nessa mesma tela.
5. Role até o fim da página, na seção **Artifacts**, e clique em **`cyno-office-windows-x64`** para baixar um arquivo `.zip`.
   - *(Opcional: se existir uma Release em rascunho na aba **Releases**, o instalador `.exe` também aparece lá.)*
6. Abra o arquivo `.zip` baixado e extraia o instalador que termina em **`-setup.exe`** (ou o arquivo `.msi`).

### 2. Instalar no Windows

1. Dê duplo clique no instalador **`Cyno Office_..._x64-setup.exe`**.
2. **Se aparecer uma tela azul do Windows ("O Windows protegeu o computador" / SmartScreen):**
   - Isso é normal nesta fase de testes, porque o instalador ainda não tem certificado pago de assinatura da Microsoft.
   - Clique em **Mais informações** e depois em **Executar assim mesmo**.
3. Siga o assistente (Avançar → Instalar → Concluir). Ele instala só para o seu usuário, sem pedir senha de administrador.

### 3. O que deve acontecer ao abrir

- **Janela abre sozinha:** ao iniciar pelo Menu Iniciar, pode levar alguns segundos (até ~10 s na primeira vez) enquanto o servidor interno liga; depois a janela do **Cyno Office** abre sem barra de endereço de navegador.
- **Ícone na bandeja:** no canto inferior direito do Windows (perto do relógio; talvez dentro da setinha `^`), aparece o ícone do Cyno Office.
- **Fechar no "X" só esconde:** clicar no `X` da janela **não** encerra o programa — os agentes continuam rodando em segundo plano. Clicar no ícone da bandeja (ou abrir pelo Menu Iniciar de novo) traz a janela de volta.
- **Encerrar de verdade:** clique com o botão direito no ícone da bandeja e escolha **Sair**.
- **Iniciar com o Windows:** no mesmo menu da bandeja, você pode marcar ou desmarcar **Iniciar com o Windows** (quando marcado, ele inicia já escondido na bandeja ao ligar o PC).

---

## Caminho B — Compilar no próprio Windows (PowerShell)

Use este caminho apenas se você quiser gerar o instalador diretamente na sua máquina Windows.

### Pré-requisitos

Instale estes três itens (todos gratuitos) e reinicie o PowerShell depois:
1. **Node.js 22 (x64):** baixe em [nodejs.org](https://nodejs.org/) (versão 22 LTS).
2. **Rust estável:** baixe o `rustup-init.exe` em [rustup.rs](https://rustup.rs/) e aceite a instalação padrão (`x86_64-pc-windows-msvc`).
3. **Visual Studio Build Tools (C++):** baixe em [visualstudio.microsoft.com/visual-cpp-build-tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) e marque a carga de trabalho **Desenvolvimento para desktop com C++** (MSVC + SDK do Windows).

### Comandos exatos no PowerShell

Abra o **PowerShell** na pasta raiz do repositório e rode, na ordem:

```powershell
# 1. Instalar dependências e compilar a interface web e os pacotes
npm ci
npm run build

# 2. Montar o pacote autônomo do servidor + web + node-pty para Windows x64
node packages/desktop/scripts/build-resources.mjs --platform win32-x64

# 3. Baixar o Node.js portátil (sidecar) e conferir a assinatura SHA256 oficial
$ver = "22.15.0"
$dest = "packages/desktop/src-tauri/binaries/node-x86_64-pc-windows-msvc.exe"
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
Invoke-WebRequest -Uri "https://nodejs.org/dist/v$ver/win-x64/node.exe" -OutFile $dest
$sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/v$ver/SHASUMS256.txt" -UseBasicParsing).Content
$expected = (($sums -split "`r?`n" | Where-Object { $_ -match 'win-x64/node\.exe$' }) -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "SHA256 divergente! Esperado $expected, obtido $actual" }
Write-Host "SHA256 OK: $actual"

# 4. Instalar a CLI do Tauri e gerar os instaladores (.exe e .msi)
cd packages/desktop
npm install
npm run tauri build
```

Quando terminar, os instaladores estarão em:
- `packages\desktop\src-tauri\target\release\bundle\nsis\` (arquivo `-setup.exe`)
- `packages\desktop\src-tauri\target\release\bundle\msi\` (arquivo `.msi`)

---

## Onde ficam os dados e logs no Windows

Antes de começar os testes, vale saber onde o Cyno guarda tudo no seu computador.
Para abrir rapidamente, aperte **`Win + R`**, cole o caminho abaixo e aperte **Enter**:

```text
%LOCALAPPDATA%\CynoOffice\data
```

Dentro dessa pasta você encontra:
- `auth-setup-code.txt` — código temporário para criar a senha na primeira vez (some depois que a senha é criada).
- `activity\` — registro diário do servidor (erros de início, quedas, eventos do sistema).
- `platform\` — configurações dos motores, contas e instalações.
- `workspaces\` — dados dos seus escritórios e logs das tarefas.
- Uma pasta acima (`%LOCALAPPDATA%\CynoOffice\backups\`) — cópias de segurança criadas automaticamente antes de aplicar uma atualização.

> **Importante sobre privacidade:** ao enviar logs para investigação, **nunca** envie `auth.json`, chaves SSH, tokens de acesso (GitHub/OpenRouter) nem arquivos de credenciais dentro de `platform\engines\`. Envie apenas o texto do erro ou o arquivo de atividade pedido em cada item.

### Como capturar a saída do sidecar (se o app não abrir ou fechar sozinho)

Se a janela ficar branca, demorar mais de 30 segundos ou não abrir, abra o **PowerShell** e rode o aplicativo pelo terminal para ver as mensagens `[cyno-desktop]` e `[cyno-server]`:

```powershell
& "$env:LOCALAPPDATA\Cyno Office\Cyno Office.exe" 2>&1 | Tee-Object -FilePath "$env:USERPROFILE\Desktop\cyno-log.txt"
```

Espere ~30 segundos, feche pelo ícone da bandeja (ou `Ctrl + C`) e me mande o arquivo `cyno-log.txt` que apareceu na sua Área de Trabalho (lembre de conferir se não há nenhuma senha ou token nele).

---

## Roteiro de testes (marque cada caixa conforme testar)

### 1. Abrir o app e criar a senha inicial
- [ ] Abri o **Cyno Office**, a janela carregou normalmente e apareceu a tela para criar a senha inicial.
- [ ] Se a tela pedir um **código de configuração**, abri `%LOCALAPPDATA%\CynoOffice\data\auth-setup-code.txt`, copiei o código (formato `XXXX-XXXX-XXXX`), criei minha senha e consegui entrar no escritório.
- **Se der errado, copie isto para me mandar:** print da tela + conteúdo de `cyno-log.txt` (usando o comando da seção anterior) + o arquivo mais recente dentro de `%LOCALAPPDATA%\CynoOffice\data\activity\`.

### 2. Instalar o Claude Code pela plataforma e fazer login
- [ ] Fui em **Configurações → Motores**, cliquei para instalar o **Claude Code** pela própria plataforma e a instalação concluiu sem erro.
- [ ] Abri o login pelo **mini terminal** dentro do Cyno, completei a autenticação no navegador e o motor apareceu como autenticado/pronto.
- **Se der errado, copie isto para me mandar:** o texto exibido dentro do mini terminal/log de instalação (selecione e copie, sem incluir tokens ou códigos de sessão) + print do cartão do Claude em **Configurações → Motores** + o último arquivo em `%LOCALAPPDATA%\CynoOffice\data\activity\`.

### 3. Instalar o Antigravity (`agy`) pela plataforma
- [ ] Em **Configurações → Motores**, cliquei para instalar o **Antigravity** e a instalação terminou com sucesso (o motor passou a aparecer como instalado).
- **Se der errado, copie isto para me mandar:** o texto de saída da instalação na tela de Motores + print do erro + a saída de `cyno-log.txt`.

### 4. Logar 2 contas do Antigravity e conferir a cota de cada uma
- [ ] Na tela de **Configurações → Motores → Antigravity**, adicionei **duas contas Google diferentes** (usando o mini terminal em cada uma).
- [ ] Conferi se o app mostra as **duas contas separadas** e se a **cota / uso** exibida em cada conta corresponde realmente àquela conta (sem uma sobrescrever o login da outra).
- **Se der errado, copie isto para me mandar:** print das duas contas na tela de Motores (pode borrar o e-mail se preferir) + descreva se a segunda conta desconectou a primeira + o arquivo mais recente em `%LOCALAPPDATA%\CynoOffice\data\activity\`.

### 5. Escolher uma pasta usando o seletor nativo do Windows
- [ ] Em um projeto ou workspace, cliquei em adicionar/escolher pasta e abriu a **janela nativa do Explorador de Arquivos do Windows** (não apenas um campo de texto).
- [ ] Escolhi uma pasta comum (por exemplo em `C:\Users\<você>\Documents\...`) e o caminho foi salvo corretamente.
- **Se der errado, copie isto para me mandar:** print da tela + diga exatamente qual botão clicou + as linhas recentes de `cyno-log.txt`.

### 6. Clonar um repositório pela plataforma (HTTPS com token e SSH)
- [ ] **HTTPS com token:** clonei um repositório privado informando URL HTTPS e token de acesso; os arquivos apareceram na pasta escolhida.
- [ ] **SSH:** clonei um repositório usando URL `git@...` com chave SSH configurada; o clone concluiu sem travar pedindo confirmação no terminal escondido.
- **Se der errado, copie isto para me mandar:** a mensagem exata de erro exibida na interface (remova qualquer token antes de enviar!) + o resultado do comando `git --version` no PowerShell + o arquivo mais recente de `%LOCALAPPDATA%\CynoOffice\data\activity\`.

### 7. Criar um agente e ver o terminal funcionando
- [ ] Criei um agente (Claude ou Antigravity) apontando para uma pasta de trabalho e enviei uma tarefa simples (ex.: "liste os arquivos desta pasta").
- [ ] O agente respondeu, o terminal ao vivo mostrou a saída sem caracteres quebrados e a tarefa concluiu.
- **Se der errado, copie isto para me mandar:** print da tela do terminal do agente + o texto de erro da tarefa + as linhas com `[cyno-server]` de `cyno-log.txt` + o arquivo mais recente de `%LOCALAPPDATA%\CynoOffice\data\activity\`.

### 8. Notificação nativa do Windows
- [ ] Com a janela do Cyno minimizada ou fechada para a bandeja, fiz um agente terminar uma tarefa ou pedir aprovação.
- [ ] Apareceu uma **notificação nativa do Windows** no canto inferior direito (Central de Notificações).
- **Se der errado, copie isto para me mandar:** confira em **Configurações do Windows → Sistema → Notificações** se o **Cyno Office** aparece listado e ativado; me mande um print dessa tela e o trecho de `cyno-log.txt`.

### 9. Fechar para a bandeja e encerrar pelo menu "Sair"
- [ ] Cliquei no **X** da janela: a janela sumiu, mas o ícone continuou na bandeja e clicar nele reabriu a janela no mesmo estado.
- [ ] Cliquei com o botão direito no ícone da bandeja → **Sair**: o ícone sumiu e, abrindo o **Gerenciador de Tarefas** (`Ctrl + Shift + Esc`), não ficou nenhum processo `Cyno Office.exe` nem `node.exe` do Cyno sobrando em segundo plano.
- **Se der errado, copie isto para me mandar:** print do Gerenciador de Tarefas mostrando o processo que ficou aberto + o conteúdo de `cyno-log.txt`.

### 10. Atualização pelo aplicativo
- [ ] Cliquei com o botão direito na bandeja → **Verificar atualização**.
- [ ] Quando houver uma versão mais nova publicada e assinada: o download acontece em segundo plano sem atrapalhar, o item **Sair e atualizar** fica ativo na bandeja e, ao clicar, o app cria um backup em `%LOCALAPPDATA%\CynoOffice\backups\` antes de instalar a nova versão.
- **Se der errado, copie isto para me mandar:** print da notificação/menu da bandeja + as linhas com `[cyno-updater]` de `cyno-log.txt` + a lista de pastas dentro de `%LOCALAPPDATA%\CynoOffice\backups\`.

---

## O que ainda NUNCA rodou no Windows real (transparência)

Até este momento, todo o desenvolvimento e os testes automatizados foram feitos no **Linux** (incluindo simulação de `win32` nos testes unitários e teste de fumaça do pacote autônomo no Node do Linux). As partes abaixo ainda dependem da primeira rodada em uma máquina **Windows 11 real**:

1. **Compilação Rust / Tauri 2 no Windows** (`cargo`, geradores NSIS `.exe` e `.msi`) e download real do `node.exe` + `@lydell/node-pty-win32-x64` no workflow do GitHub Actions.
2. **Terminais reais no Windows (ConPTY via `@lydell/node-pty-win32-x64`)** e encerramento completo da árvore de processos via `taskkill /T /F` e fechamento de `stdin`.
3. **Renderização e interação no WebView2** (teclado/cores no terminal xterm.js, WebSockets locais, seletor nativo de pastas e notificações nativas do Windows).
4. **Isolamento de múltiplas contas do Antigravity (`agy`) no Windows:** já isolamos `USERPROFILE`, `APPDATA` e `LOCALAPPDATA` por conta, mas ainda não foi confirmado se o `agy` no Windows salva o login no Gerenciador de Credenciais do Windows (o que poderia misturar as contas).
5. **Instalação e login do Claude Code no Windows:** confirmar comportamento real do script `claude.ai/install.ps1`, uso de `CLAUDE_CONFIG_DIR` e necessidade do Git para Windows.
6. **Symlinks sem Modo Desenvolvedor no Windows:** o código ignora falhas `EPERM` em links simbólicos de arquivos de conta (`.gitconfig`, `.npmrc`), mas isso ainda não foi exercitado numa conta comum do Windows 11.
7. **Atualizador assinado ponta a ponta:** exige gerar o par de chaves (`npx tauri signer generate`), colocar a chave pública real em `packages/desktop/src-tauri/tauri.conf.json` e publicar duas versões em sequência para testar o fluxo de download + backup + instalação.
8. **Navegador integrado (`playwright-core`):** propositalmente deixado fora do instalador autônomo para manter o pacote enxuto; tentar abrir o navegador integrado dos agentes nesse modo deve informar que o módulo não está incluído.
