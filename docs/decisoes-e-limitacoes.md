# Decisões, limitações e referências

Material que morava no README e foi movido para cá para o README ficar curto. O histórico de etapas (2 a 5 e polimento) já está no [CHANGELOG](../CHANGELOG.md); aqui ficam as decisões, as limitações e os detalhes de operação. Uso do dia a dia: [usando-o-escritorio.md](usando-o-escritorio.md). Como rodar: [como-rodar.md](como-rodar.md).

## Operação

### Senha de acesso
A segurança está no próprio app (nada depende de Cloudflare, nginx ou outro proxy) e **o app nunca fica aberto por esquecimento**. Cada instalação tem uma senha única (sem contas), criada no primeiro acesso:

1. Sem `auth.json`, o server gera um **código de configuração** (`XXXX-XXXX-XXXX`, alfabeto sem 0/O/1/I/L) a cada subida e o escreve no log, num quadro bem visível: `Abra o Cyno e use o código XXXX-XXXX-XXXX para criar a senha`. Até a senha existir, todas as rotas e WebSockets respondem 401, menos `GET /api/auth/status`, `POST /api/auth/setup` e `/api/health`.
2. A tela "Criar a senha" pede o código, a senha (mínimo 8 caracteres) e a confirmação. Acertar grava `DATA_DIR/auth.json` (0600), invalida o código e já abre a sessão. O código errado conta no bloqueio por IP.
3. Alternativa pelo terminal do servidor: `npm run auth:set-password -w @cyno/server`.

| Comando | O que faz |
|---|---|
| `npm run auth:set-password -w @cyno/server` | pede a senha duas vezes (sem eco, mínimo 8 caracteres) e grava o hash scrypt em `DATA_DIR/auth.json`; trocar a senha derruba todas as sessões e **mantém** o 2FA |
| `npm run auth:clear -w @cyno/server` | remove a senha (com confirmação): o app volta ao estado de primeira instalação (código no log ao reiniciar) |
| `npm run auth:reset-2fa -w @cyno/server` | desliga a verificação em duas etapas (quem perdeu o celular e os códigos de recuperação) |

- **`CYNO_AUTH=off`** (só desenvolvimento e testes): mantém o comportamento antigo, sem senha o app fica aberto, com aviso no log. O `lab:up` e o `playwright.config.ts` ligam. O `npm run dev` comum **não** liga: a primeira vez pede o código do terminal do server (depois de criada, a senha fica no `DATA_DIR`).
- O server relê `auth.json` sozinho: não precisa reiniciar. Com senha, **toda** rota `/api` e os WebSockets exigem a sessão (cookie `ao_session`, HttpOnly, 30 dias deslizantes, `Secure` quando a requisição veio por https). Exceções: `/api/auth/status|login|login/2fa|setup`, `/api/health` e o MCP dos agentes (`/mcp`, que segue só com o token de cada agente, de 127.0.0.1).
- **IP real:** os proxies confiáveis são só os de loopback (o proxy do Vite, cloudflared, nginx ou Caddy na mesma máquina). O Vite acrescenta o IP de quem falou com ele no fim do `x-forwarded-for`; o server lê esse salto, e se ele for loopback (há outro proxy local na frente) usa o `cf-connecting-ip` ou o salto anterior. O que o cliente forja à esquerda é ignorado. Se o socket não é loopback (porta do server exposta direto), nenhum cabeçalho vale. Limitação: IPv6 é contado por endereço (não por /64).
- **Bloqueio por IP:** 5 senhas ou códigos errados bloqueiam o IP por 15 min; cada novo bloqueio do mesmo IP em 24 h dobra (15 min, 30, 1 h, 2 h… até 24 h). Acertar zera as falhas, não o histórico de bloqueios. Resposta 429 com `retry-after` e `retryAfterSeconds`; a tela de login mostra a contagem. Gravado em `DATA_DIR/auth-blocks.json` (0600): reiniciar não libera. Não há freio global que tranque todo mundo (com o IP real confiável ele só serviria para trancar o dono); uma onda de falhas de muitos IPs só vira aviso no log, e as verificações de senha rodam no máximo 2 por vez. Falhas e bloqueios vão para o log do server (nunca a senha).
- **Verificação em duas etapas (TOTP, opcional):** Configurações > Acesso > "Ativar verificação em duas etapas" mostra o QR e o segredo e liga só depois de confirmar um código; gera 10 códigos de recuperação de uso único (mostrados uma vez, guardados só como hash). Login: senha certa, depois o código (ou um de recuperação); o passo do meio usa um token de 5 min, não uma sessão. Desativar pede a senha e um código.
- Sessões em `DATA_DIR/auth-sessions.json` (só o hash do token). Em Configurações > Acesso: sair, sair de todos os aparelhos, trocar a senha, 2FA, IPs bloqueados (com "Desbloquear") e as últimas tentativas erradas.
- O `lab:setup` fala com a API do server no ar e não tem sessão: contra um app com senha (o real) ele para com a mensagem "exige senha (401)". Para testar, use `npm run lab:up`, que sobe um app isolado e aberto (`CYNO_AUTH=off`).

### Chromium headless (servidor sem GPU)
- O Playwright abre o Chromium com `--use-angle=swiftshader --enable-unsafe-swiftshader`. Assim o WebGL roda por software (SwiftShader) e o console não mostra o aviso de "fallback automático".
- O `playwright.config.ts` **remove `DISPLAY`** do ambiente do navegador. Numa sessão SSH com X11 (`DISPLAY=localhost:10.0`), o ANGLE tentava Vulkan via XCB, falhava, e o WebGL sumia. Headless não precisa de X.
- Em scripts próprios de navegador, use as mesmas flags e rode sem `DISPLAY`: `env -u DISPLAY node meu-script.mjs`.


### Desempenho
- O mapa desenha sob demanda e para quando a página do Escritório não está aberta (a cena fica suspensa atrás das outras páginas). O e2e `e2e/cena-mapa.spec.ts` confere que a cena desenha quadros sem parar (medida folgada, pensada para o Chromium headless com WebGL por software).
- O motor de cena e a cidade são carregados sob demanda, cada um num chunk próprio (`cena-*.js`, `cidade-*.js`).


## Referência de uso do Escritório

> Escrito para as etapas iniciais do escritório. Os comportamentos de câmera, seleção e status valem, mas os detalhes de desenho (isométrico, PixiJS) foram trocados pelo motor de cena de `packages/cena`; veja "Decisões" e o CHANGELOG.

### Como usar a UI
Guia completo, com prints: [docs/usando-o-escritorio.md](docs/usando-o-escritorio.md).

A tela tem quatro partes por cima do canvas:
- **Barra superior:** seletor de workspace (lista e **+ Novo workspace**), estado da conexão ("Ao vivo", "Reconectando…"), botões **Mapa**, **Lobby** e um por quarto (focam a câmera), **+ Quarto**, contadores e zoom (− 1x/2x/3x +).
- **Caixa de tarefa** (embaixo): só o pedido ("Peça ao Maestro…"). O **Maestro** faz a triagem (1–3 s), escolhe o time e cria uma subtarefa para ele; a caixa diz "Enviado ao Maestro" e depois "Maestro mandou para o time X (motivo)". Quando o time entrega, o Maestro revisa e conclui o pedido, com uma nota no Cérebro do lobby. Sem time no workspace, o pedido fica "esperando você": crie um quarto e um time e aprove para ele tentar de novo.
- **Painel lateral** (direita): abre ao selecionar um agente, um quarto ou o lobby.
- **Feed de atividade** (esquerda): o Maestro recebendo, analisando e delegando (com o motivo), e as tarefas dos times: recebeu, começou, pede aprovação, concluiu, falhou. Mostra "N aguardando" quando há aprovações pendentes. Começa aberto em janelas com 1600 px ou mais e recolhido nas menores.

### Mouse e teclado
| Ação | Resultado |
|---|---|
| Clique num agente | seleciona o agente (contorno destacado) e abre o painel dele, depois de 250 ms (espera para ver se vira duplo clique) |
| Clique num quarto ou no lobby | seleciona e abre o painel do quarto, também depois de 250 ms. Se o quarto ficou sob o painel, a câmera anda até ele aparecer |
| **Duplo clique** num quarto ou agente | foca o quarto (enquadra com o maior zoom inteiro em que ele cabe) |
| Clique no fundo | desfaz a seleção |
| Arrastar | move a câmera (com limite) e desliga o enquadramento automático |
| **Esc** | fecha o painel e volta ao mapa. Com uma janela modal aberta (confirmação, criação), fecha só a janela e a câmera fica onde está. Num campo do painel, o 1º Esc só sai do campo |
| **Enter** na caixa de tarefa | envia. **Shift+Enter** quebra a linha |
| − / + | zoom 1x, 2x ou 3x |

**As portas são automáticas e não mudam o que os agentes leem.** O que cada quarto lê vem da seção **Cérebro** do painel do quarto: "Lê o Cérebro global" (`readsGlobalBrain`) e "Lê também os Cérebros de" (`readsBrainsOf`). Veja [`buildContext`](docs/arquitetura.md#buildcontext).

### Para você
A aba **Para você** (com o número de pendentes na barra, em qualquer página) junta tudo que precisa de você. Cada pedido de aprovação de um agente vira um item (`A-0001`, `A-0002`…) com o tipo (pergunta, perfil, convite, boas-vindas, mensagem, resposta, comentário, post ou outro), o "por quê" e o **texto que vai sair**, editável e com contador de limite por tipo (convite 200, boas-vindas 300, mensagem e resposta 1000; no perfil, headline 220, Sobre 2600, experiência e projeto 2000).
- **Aprovar** (Ctrl/⌘+Enter) faz a tarefa seguir com o texto final; **Rejeitar** faz a tarefa falhar, com a **nota para o time** como motivo; numa pergunta, **Responder** exige a resposta e a tarefa segue com ela.
- **Reabrir** volta o item para pendente, mas **não reabre a tarefa**: se ela já seguiu, decidir de novo só muda o item (o card avisa).
- Lateral com Pendentes/Decididos e filtro por tipo; **J/K** andam entre os cards e **Esc** sai do campo. "Copiar texto", "Desfazer edição" e avisos com **Desfazer** (só quando a decisão não mexeu na tarefa).
- Os botões rápidos **Aprovar/Recusar** do painel do agente e das Tarefas continuam: decidem o item sem editar o texto. Ao lado, **Abrir em Para você** leva ao card.

### Times e agentes
- **Time:** no painel do quarto, cada time tem **+ Agente**, **Editar** (nome e foco, no próprio bloco do time) e **Excluir**. A confirmação de exclusão lista os agentes que saem junto e quantas tarefas ativas serão canceladas.
- **Mover agente de time:** no painel do agente, **Editar** tem o campo **Time**, com os times agrupados por quarto. Escolher um time de outro quarto muda o agente de quarto (ele ganha mesa no pod do time novo). Enquanto o agente tem uma tarefa ativa, o campo fica travado, porque a API responderia 409.

### Recarregar a página
- A barra de progresso e a **pergunta de aprovação** continuam no painel do agente: o `office:snapshot` traz o último progresso de cada tarefa ativa. Isso vale para recarregar, mas **não para um restart do server**: esse progresso fica só na memória do orquestrador, e depois do restart uma aprovação pendente aparece com 0% e a mensagem genérica até o próximo progresso.
- O **feed de atividade** é reconstruído a partir das tarefas: "recebeu" (na hora da criação) e o status atual de cada uma, até 40 entradas. Os passos do meio (por exemplo, o "começou" de uma tarefa já concluída) não aparecem, porque não têm horário guardado.
- A simulação recomeça: cada agente nasce na pose do status, e os ociosos são reposicionados.

### Marcadores do pedido (só no MockRunner)
- `[aprovar]` faz a tarefa pedir aprovação, com um rascunho simulado do tipo deduzido do pedido (ex.: "convite para Ana" gera um convite curto para Ana). Decida em **Para você** ou no painel do agente.
- `[falhar]` simula uma falha.

### O que cada status mostra
| Status | No canvas | No painel |
|---|---|---|
| `idle` (ocioso) | passeia pelo quarto: sofá, café, estante, quadro, janela ou perto da mesa. Às vezes vai ao lazer do lobby (games, copa, leitura, recepção) ou visita outro quarto. Dois ociosos próximos às vezes trocam balões de fala | "Livre" |
| `working` (trabalhando) | vai até a própria mesa, senta e digita, com o PC aceso | tarefa atual com barra de progresso |
| `waiting_approval` (aguardando aprovação) | levanta, fica em pé perto da mesa e acena, com o balão "!" (que aparece assim que o status muda, mesmo a caminho) | pergunta e os botões Aprovar e Recusar |
| `done` (concluiu) | pega o papel na mesa e leva ao quadro do **lobby** se o quarto lê o Cérebro global, ou ao quadro do **próprio quarto** se não lê. O quadro brilha na entrega | resultado no histórico |

Regras das portas:
- As portas são automáticas: todo quarto tem porta para o lobby, e quartos vizinhos no grid ganham uma porta entre eles. Não há o que configurar.
- Todo agente anda para qualquer quarto, a qualquer hora (pelos vizinhos ou pelo lobby).
- As portas ficam sempre fechadas. Quando alguém passa, a porta abre, ele atravessa (some andando para dentro da parede e reaparece do outro lado) e ela fecha de novo. Vários em fila mantêm a porta aberta.


### O mapa do Escritório
- O mapa é o motor de cena de `packages/cena` (Canvas 2D), alimentado pelo adaptador de `packages/web/src/cena/`: salas, mesas, agentes, bichos (gato, cachorro e calopsita, que se ligam em Configurações > Aparência) e a cidade da página do Cyno. Os dados do escritório (`office.json`) continuam os mesmos; campos antigos, como móveis e tamanho das salas, ficam guardados sem uso.
- **Câmera:** arrastar move, a roda do mouse (ou os botões e as teclas + e −) dá zoom, 0 enquadra tudo; selecionar um agente enquadra o personagem na área livre da tela.
- **Safe area:** a barra, a caixa de tarefa e o painel lateral informam quanto da tela cobrem (`useOverlayInsets`), e a câmera enquadra o escritório só no que sobra.
- `?cena=demo` abre a cena com dados de mentira (sem servidor) e `?demo=1` abre o app inteiro de demonstração, sem servidor de agentes e sem IA.


## Decisões

> As decisões das etapas 4, 5 e do polimento falam do mapa antigo (PixiJS, isométrico), removido na Junção V2. Ficam como histórico; o mapa de hoje está em "O mapa do Escritório".

### Etapas 2 a 4
- **Node 22.12+** em vez de Node 20, por causa do Vite 8 e do Vitest 5.
- **Server só em loopback, UI exposta pelo Vite.** Há um único ponto de entrada na rede, e o proxy cuida de `/api` e `/ws`.
- **Persistência em JSON** (`office.json` e `tasks.json`), com escrita atômica (arquivo temporário, fsync e rename) e fila serializada. Ao carregar, os dados são validados com zod e com `findOfficeRuleViolations`.
- **Delete de quarto em cascata.** Remove times, agentes, tarefas, conexões e o Cérebro. As tarefas ativas são marcadas `failed` ("Cancelada: o quarto foi removido") e emitidas antes de sair. Depois vem um `office:snapshot`, porque não existe evento `task:deleted`.
- **Tarefa órfã no boot.** Uma tarefa `queued` cujo agente não existe mais vira `failed`.
- **Mudar time ou quarto com tarefas ativas** devolve 409, para que a fila não cruze quartos.
- **Aprovação pendente sobrevive ao restart.** A tarefa continua `waiting_approval` e nada roda até o usuário decidir. Aprovar executa a tarefa de novo já aprovada; recusar marca `failed`.
- **Ids legíveis.** São gerados por slug do nome, com sufixo `-2`, `-3`… em caso de colisão. O id `global` é reservado para o lobby.
- **Marcadores do MockRunner.** `[aprovar]` no pedido sempre pede aprovação, e `[falhar]` força uma falha. Sem marcador, a aprovação é sorteada com `MOCK_APPROVAL_RATE`.
- **Zoom do canvas só em 1x, 2x e 3x**, para manter o pixel art nítido. A posição do mundo é sempre arredondada para pixel inteiro.
- **Sprites gerados em código, sem arquivos de imagem.** Tudo sai da `PALETTE`, é determinístico e tem cache. Trocar uma cor ou um tema não exige redesenhar arquivos.
- **Projeção isométrica 2:1**, tile de 32×16 px. Os móveis são modelados em 3D simples (caixas e cilindros) e amostrados no centro do pixel, então faces vizinhas se encaixam sem buraco.
- **Luz fixa vindo da esquerda:** topo claro, face esquerda no tom base e face direita no tom escuro, com contorno `ink` de 1 px.
- **Só as paredes de trás são desenhadas.** Por isso as portas ficam sempre nas paredes de trás: a porta para um vizinho a oeste fica na parede nw e a para um vizinho ao norte, na parede ne; o vizinho do outro lado não ganha porta visível.
- **Vão de 5 tiles entre quartos**, calculado da geometria (`ROOM_GAP_TILES` em `shellGeometry.ts`: altura da parede + espessura + espessura do piso + 8 px de folga, dividido por 16). Assim a parede de um quarto nunca tampa o piso do quarto de trás.
- **Profundidade fatiada:** móveis de vários tiles são cortados em colunas de 16 px, e cada coluna usa a profundidade do tile que ela cobre. Um agente atrás de uma mesa comprida fica atrás, e um na frente fica na frente.
- **Uma textura estática por quarto** (piso, paredes, tapetes e móveis já ordenados). Por cima vão só os agentes e os recortes de móvel que ficam na frente de cada um.
- **Render sob demanda.** O Pixi só redesenha quando o estado, a câmera ou um quadro de animação mudam. As trocas de quadro parado caem numa grade de 200 ms; com tudo parado, o loop dorme (via `setTimeout`) até a próxima mudança prevista pela simulação.
- **Agente em pé só em tile "limpo":** que dá para pisar, não é soleira de porta e não tem móvel logo na frente. Assim o papel de `done` e as mãos não somem atrás de uma mesa.
- **Câmera respeitando a área coberta pelos painéis** (safe area). O Painel de debug (`?debug=1`) começa recolhido abaixo de 1600 px.

### Etapa 5
- **Simulação no cliente.** O server só manda o status de cada agente. Onde ele anda, senta ou entrega o papel é decidido no navegador (`office/sim/`), e nada disso é persistido. A simulação é pura (sem Pixi) e determinística dada a semente e a sequência de chamadas, o que permite testá-la no Vitest.
- **A\* em 4 direções.** No isométrico cada passo de tile é uma diagonal da tela, e o avatar só tem sprites para 4 direções. Virar custa um pouco mais, para os caminhos terem menos curvas.
- **Porta fechada impede sair, nunca voltar.** Fechar uma porta com alguém do outro lado não pode deixar o agente preso: ele volta para casa pela porta fechada, que abre só no desenho durante a passagem. Foi a falha 1 do QA da rodada 1.
- **Passar pela porta é sumir e reaparecer** (280 ms cada metade), andando para dentro da parede de um lado e saindo da parede do outro. O lobby e os quartos ficam longe no mapa, então não há caminhada "por fora".
- **`done` leva o papel ao quadro do lobby** quando o quarto tem a porta do lobby aberta, e ao quadro do próprio quarto quando não tem, espelhando o que vai para qual Cérebro.
- **Duplo clique detectado pelos `pointerup`** (limiar de 250 ms), e não pelo evento `dblclick`. O 1º clique pode abrir o painel bem embaixo do cursor, e aí o 2º nem chega ao canvas. Por isso o clique simples em quarto **ou agente** espera 250 ms antes de selecionar (no agente, desde a correção da rodada 2 do QA). Clique em porta nunca vira duplo clique.
- **Sem GET inicial com o backend fora.** Se `/__backend-health` diz que o server está fora, o web não chama `GET /api/office` (evita o 502 no console); o snapshot do WS preenche o escritório quando o server sobe.
- **Clique na porta chama a API**, e não só muda o desenho. É a mesma ação do interruptor do painel do quarto. Enquanto a requisição de uma porta não volta, novos cliques nela são ignorados. _(Substituído em 2026-11-08: as portas agora são automáticas e não se clicam; o Cérebro compartilhado tem a própria seção no painel.)_
- **A câmera revela o quarto selecionado.** Se o quarto clicado fica sob o painel, a câmera anda (no mesmo zoom) até ele aparecer na área livre. Ao desfazer a seleção, volta ao mapa enquadrado se a câmera só tinha andado por isso.
- **Canvas na resolução da arte.** Com zoom Z, o buffer do WebGL tem 1/Z da resolução da tela e o navegador amplia com `image-rendering: pixelated`. A imagem é idêntica, mas a GPU pinta Z² vezes menos pixels.
- **Redesenho parcial com scissor.** O buffer é preservado entre quadros (`preserveDrawingBuffer`). Com a câmera parada, só os retângulos sujos são redesenhados. Se eles somam mais da metade da tela, redesenha tudo.
- **Caches com limite (LRU)** para imagens de quartos, cascas, portas, móveis e quadros de avatar, e liberação explícita das texturas de avatares que saíram da cena.
- **Reconexão do WS guiada por `/__backend-health`.** Antes de abrir o WebSocket, o cliente pergunta ao Vite se o server está de pé. Com o server fora (reinício do `tsx watch`), não há tentativa de WS falhando, nem erro no console do navegador ou no log do Vite.
- **A UI nova substitui o Painel de debug**, que (removido na Junção V2).
- **Quarto criado pela UI** ganha uma célula livre do grid escolhida pelo server e nasce com a porta do lobby fechada (padrão da API). O tema sugerido é o primeiro ainda não usado.
- **Hooks de teste só em dev:** `window.__agentOffice` (stores) e `window.__officeCanvas` (estado dos agentes, pontos para clicar, estatísticas de render, modo inquieto) não existem no build de produção.

### Polimento
- **Progresso no snapshot, só em memória.** O `office:snapshot` ganhou o campo opcional `progress` (por id de tarefa: agente, progresso 0..1 e última mensagem), vindo de `Orchestrator.progressSnapshot()`. Não foi para o `tasks.json`: é estado de execução, que um restart perde de qualquer jeito (a tarefa volta para a fila ou continua esperando a aprovação). O campo é opcional para não quebrar clientes antigos, e sem ele o cliente mantém o que já tinha.
- **Feed reconstruído das tarefas**, e não guardado em lugar nenhum. "recebeu" usa `createdAt` e o status atual usa `updatedAt`; os passos intermediários não têm horário e ficam de fora. Empates de horário seguem a ordem do ciclo de vida.
- **Excluir time pela UI segue a cascata da API:** os agentes do time saem junto e as tarefas ativas são canceladas. A confirmação diz exatamente quem e quantas, e lembra que o histórico continua.
- **Mover agente de time pelo Editar do agente**, com um seletor de times agrupados por quarto, em vez de arrastar no canvas. O campo trava com tarefa ativa (a regra do 409 já existia na API) e mostra o motivo.
- **Desvio local na simulação, sem coordenação central.** Quem está parado no caminho é contornado na hora; quem está andando provoca espera de 1 s e depois replanejamento; frente a frente, cede o id maior; anéis de espera (A espera B, B espera C, C espera A) andam juntos; na porta, espera na soleira até a chegada do outro lado ficar livre. Ninguém espera mais de 3 s somados numa viagem: depois disso segue, mesmo sobrepondo por um instante. Isso garante que nada trava.
- **Simulação e cena em módulos menores.** `office/sim/` foi dividido em `agent`, `walking`, `occupancy`, `destinations`, `placement` e `chat` (além de `simulation`, `astar` e `navigation`), e `pixi/officeScene.ts` em `clicks`, `doorToggle`, `debugTools` e `escape`.
- **Zoom da animação de foco sempre inteiro.** O zoom fracionário fazia o pixel art tremer durante a animação. Agora o zoom troca de nível em degraus iguais e a posição fica na grade de pixels em todos os quadros.
- **Esc com janela modal aberta não volta ao mapa** (`escapeReturnsToMap`): o Esc fecha só a janela, como no `SidePanel`.
- **Balão "!" que desvia de cabeças** (`alertPlacement.ts`): como ele fica por cima de tudo, primeiro anda para o lado, depois vira o balão compacto e, sem saída limpa, fica compacto e levemente transparente.
- **Arte:** digitar com 2 quadros bem distintos (uma mão sobe e a outra desce), sentar de frente no sofá com o template `SEATED_LEGS`, rosto em 3/4 (orelha, nariz e sombra no queixo) e, no lobby, onde as duas paredes têm o mesmo tom, um vinco de 1 px no canto em vez de uma faixa escura.
- **Dependências:** `overrides` do `minimatch` (`^11.0.5`) zerou o `npm audit`; `allowScripts` autoriza só o script de instalação do esbuild (npm 11); `@axe-core/playwright` roda o e2e `ui-a11y` (WCAG 2.1 A/AA), que achou o contraste baixo do texto secundário do feed (agora `cloud` em vez de `stone`).
- **Galeria e Painel de debug sob demanda** (`React.lazy`): quem abre só a UI não baixa esse código.


## Licenças de terceiros
- **Motor de cena e arte do mapa (MIT).** `packages/cena` e as imagens de `packages/web/public/cena/` vêm de um projeto de código aberto, copiado com a licença MIT (Copyright (c) 2026 Márcio Junior); partes de `packages/shared/src/secrets.ts` e `work-phrase.ts` também. A licença exige o aviso nas cópias, e o `vite build` tira os comentários do código, então o texto da licença é servido pelo próprio site em **`/licencas/cena-LICENSE.txt`**, com um link em Configurações > Aparência. Um teste (`packages/web/src/licencaDaCena.test.ts`) confere que esse arquivo é igual ao `packages/cena/LICENSE`. Origem, versão e o que foi copiado: `packages/cena/ORIGEM.md`; texto original: `THIRD_PARTY/habblaud-LICENSE.txt`.
- **Ícones dos conectores (CC0).** `packages/web/public/conectores/`, do Simple Icons; veja `packages/web/public/conectores/LICENSE.md`.
- O índice destes avisos fica em [`THIRD_PARTY/README.md`](THIRD_PARTY/README.md).

## Limitações conhecidas
- **Motores:** os agentes reais rodam no Claude Code (`engine: "claude"`) e no Google Antigravity (`engine: "gemini"`). Codex e OpenCode ainda não têm adaptador. O `MockRunner` só simula narração, ferramentas, subagentes, progresso, aprovação e um resultado de exemplo (agentes sem motor real).
- **O app só abre com senha** (veja "Senha de acesso"): na primeira instalação ele fica fechado até alguém criar a senha com o código do log. Só `CYNO_AUTH=off` (desenvolvimento/testes) o deixa aberto.
- **Cada aba tem a sua simulação.** O status é o mesmo em todas, mas a posição de um agente ocioso, as conversas e o caminho podem ser diferentes entre duas abas. Recarregar a página reposiciona todo mundo.
- **O progresso não sobrevive a um restart do server.** Sobrevive ao recarregar a página, mas depois de um restart uma aprovação pendente aparece com 0% e a mensagem genérica "O agente quer sua aprovação para continuar". Aprovar e recusar funcionam.
- **O feed perde os passos do meio ao recarregar.** Fica só "recebeu" e o status atual de cada tarefa, até 40 entradas.
- **Workspaces só se criam e trocam pela UI.** Renomear e excluir existem na API (`PATCH`/`DELETE /api/workspaces/:ws`), ainda sem botão.
- **A triagem do Maestro é por palavras.** Ele pontua os times pelas palavras do pedido (nome do time, foco, nome do quarto, papel e instruções dos agentes) e manda o pedido inteiro para um time só; ainda não divide em partes nem encadeia times.
- **Não dá para mudar um quarto de lugar no grid pela UI.** Use a API (`gridPosition`, veja [docs/como-criar-agentes-e-workspaces.md](docs/como-criar-agentes-e-workspaces.md)). Também não dá para mover um time inteiro de quarto pela UI.
- **QA final incompleto na última rodada:** a rodada 4 foi interrompida a pedido do usuário, depois que as rodadas 1 a 3 e a verificação manual passaram.
- **Easter eggs:** os do mapa antigo foram removidos e não voltam; só os bichos (gato, cachorro e calopsita) seguem no mapa novo.

