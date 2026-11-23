# Cyno no Windows: proposta de aplicativo instalável

Estado: **proposta** (nada disso foi construído). Primeiro vem o Docker (já pronto, veja "Com Docker" em `como-rodar.md`); o Windows reaproveita a mesma ideia.

## O que você pediu
- Um instalador `.exe` (sem Docker, sem terminal): abre, instala, escolhe onde ficam os dados.
- Inicia junto com o computador, vive no ícone da bandeja (canto inferior direito).
- Fechar a janela **não** encerra: continua em segundo plano; só "Sair" pelo ícone da bandeja encerra.
- Janela própria, como um PWA, e os mesmos motores (Claude e Antigravity, com contas isoladas).
- Atualização: aplicar ao fechar e abrir de novo.

## O obstáculo
O Cyno foi feito para Linux: terminais de agente em pty, `bash`, cerca de arquivos (Landlock) e as CLIs rodando como num servidor. Portar tudo para o Windows nativo é grande e arriscado (caminhos, shell, segurança dos agentes). Por isso a rota recomendada **não porta**: leva o Linux junto, escondido.

## Caminho recomendado: Tauri + WSL2 privado
1. **Instalador (Tauri, formato NSIS/MSI).** Pequeno (poucos MB), usa o WebView2 que já vem no Windows 10/11. Pergunta a pasta de dados e instala.
2. **Linux privado dentro do Windows (WSL2).** O instalador liga o WSL2 (uma vez; pode pedir permissão de administrador e um reinício) e importa uma distro **só do Cyno** (`wsl --import CynoOffice <pasta escolhida>`) já com Node, o app e as dependências. Ela não aparece como "Ubuntu" para o usuário, não mexe nas outras distros e não abre terminal. Os dados (equivalente ao `/data` do Docker) ficam nessa pasta escolhida.
3. **Bandeja e janela.** O app Tauri sobe a distro, inicia o servidor dentro dela e abre uma janela (WebView2) apontando para `http://localhost:3067`, sem barra de endereço, como um PWA. Fechar a janela só a esconde; o menu da bandeja tem Abrir, Atualizar e **Sair** (para o servidor e a distro). Uma instância só.
4. **Iniciar com o Windows.** Entrada de inicialização do usuário (sem serviço de administrador): sobe direto para a bandeja, sem janela.
5. **Pastas de trabalho.** Projetos do Windows (`C:\Users\...`) aparecem como `/mnt/c/...` dentro da distro, e a tela traduz o caminho para o usuário. Acesso por `/mnt/c` é mais lento que o disco do Linux; projetos grandes rendem mais dentro da pasta de dados do Cyno.
6. **Motores e contas.** Igual ao Docker/Linux: instalar e logar `claude`/`agy` pela plataforma (mini terminal no navegador), cada conta numa pasta isolada, agente fixo na conta.
7. **Atualização.** O Tauri tem atualizador próprio com pacotes **assinados** baixados das Releases do GitHub. Ao abrir, verifica; baixa em segundo plano; **aplica ao fechar e abrir**, nunca no meio de um trabalho. Antes de aplicar, faz cópia da pasta de dados (e volta sozinho se a versão nova não subir). Canais "estável" e "dev".

## Alternativas descartadas (por ora)
- **Windows nativo (sem WSL):** menor, mas exige portar pty, shell, cerca de arquivos e o comportamento das CLIs; meses de trabalho e segurança menor para os agentes.
- **Docker Desktop:** é exatamente a dor que o aplicativo quer evitar (licença, instalação, WSL visível). Continua sendo opção para quem quiser.
- **Electron:** funciona igual, mas o instalador passa de 100 MB e consome mais memória parado na bandeja.

## Riscos e custos
- **WSL2 exige virtualização ligada na BIOS** e Windows 10 2004+ ou 11 (inclui Home). O instalador precisa detectar e explicar quando falta.
- **Assinatura do instalador:** sem certificado de assinatura, o Windows mostra o aviso do SmartScreen. O certificado é pago (anual).
- **Primeira instalação** pode pedir reinício (ativar o WSL2).
- **Memória:** a distro usa RAM; dá para limitar (`.wslconfig`) e o app pode parar a distro ao Sair.
- Windows em ARM: precisa de imagem arm64 (fica para depois).

## Ordem sugerida
1. Docker (pronto). 2. Atualização do Docker (botão "Atualizar agora" com cópia e volta automática). 3. Pacote da distro (`rootfs`) gerado por uma ação no GitHub a cada release. 4. Protótipo Tauri só com bandeja + janela + iniciar/parar a distro. 5. Instalador, início com o Windows e atualizador assinado. 6. Teste em Windows de verdade (máquina limpa) antes de publicar.
