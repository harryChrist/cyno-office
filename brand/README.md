# Cyno — marca

**Conceito: "Sala C".** O C de Cyno é a planta isométrica de uma sala do escritório, com a porta aberta à direita.
Dentro dela, um cubo verde: um agente trabalhando. O símbolo é desenhado sobre linhas de pixel art isométrica
(inclinação 2:1), num grid de 256, e as paredes do fundo mostram a face interna, para a sala ter profundidade.
Ele herda da marca anterior do app (Agent Office, "Sala Viva") o violeta, o verde "agente ativo" e o sabor isométrico.

- Conferência de tudo (escada de 16 a 512 px, assinatura no escuro e no claro, ícone do app, pixels ampliados, uma
  cor, cores): `cyno/final/folha-final.png`.
- Prints do app com a logo: `cyno/final/prints/app-login.png` e `cyno/final/prints/app-app.png`.

## Arquivos (`cyno/final/`)

| Arquivo | Uso |
|---|---|
| `cyno-mark.svg` | **Mestre.** O símbolo colorido para fundo claro |
| `cyno-mark-escuro.svg` | O símbolo colorido para fundo escuro: paredes `#8B7CFF` e faces internas mais claras |
| `cyno-mark-mono.svg` | Uma cor, `currentColor`: herda a cor do texto quando usado inline no HTML. As faces do cubo são separadas por vãos |
| `cyno-mark-small.svg` | Corte pequeno desenhado pixel a pixel (grid 16, `crispEdges`), para 16 a 24 px. Abaixo de 32 px o cubo vetorial some; aqui ele vira um bloco 4×4 em três verdes |
| `cyno-lockup.svg` | Assinatura "Cyno" para **fundo escuro**: símbolo escuro + texto `#E8EAF6` |
| `cyno-lockup-claro.svg` | Assinatura "Cyno" para **fundo claro**: símbolo mestre + texto `#14162B` |
| `cyno-tile.svg` | Ícone do app: azulejo violeta com cantos arredondados (raio de 56/256), símbolo branco a 82 % |
| `cyno-tile-square.svg` | O mesmo ícone sem cantos, para plataformas que aplicam máscara própria (iOS) |
| `cyno-tile-small.svg` | Ícone de 16 px desenhado pixel a pixel (usado no favicon) |
| `favicon.ico` | 16 (pixel a pixel), 32 e 48 |
| `png/cyno-tile-{16,32,48,180,192,512}.png` | O ícone do app em PNG. O de 16 sai da versão pixel a pixel |
| `png/cyno-tile-32-pixel.png` | Alternativa de 32 px com o desenho pixel a pixel ampliado 2× |
| `png/apple-touch-icon.png` | 180 px, quadrado e opaco (o iOS arredonda sozinho) |
| `png/cyno-mark-512.png`, `png/cyno-mark-escuro-512.png`, `png/cyno-mark-small-16.png` | O símbolo em PNG transparente |
| `folha-final.png` | Folha de conferência |
| `prints/` | O app com a logo (tela de login e barra lateral) |

O logotipo "Cyno" foi desenhado à mão como paths (geométrico arredondado, haste de 28/256, mesmo raio de canto da
UI). Não depende de fonte e não tem `<text>`.

## No app (`packages/web`)

| Onde | Arquivo |
|---|---|
| Aba do navegador | `public/favicon.ico` (16/32/48) via `<link rel="icon">` no `index.html` |
| iOS / tela inicial | `public/apple-touch-icon.png` (180) |
| PWA | `public/manifest.webmanifest`, com nome Cyno, `theme_color` `#0b0d1a` e ícones `public/icon-192.png`, `public/icon-512.png` e `public/cyno-tile.svg` |
| Barra lateral, topo do HUD, login, tela sem workspace | `public/cyno-tile.svg` (`hud/AppNav.tsx`, `hud/Hud.tsx`, `auth/LoginScreen.tsx`, `ui/NoWorkspace.tsx`) |

Para regenerar tudo: `bash cyno/fonte/build_kit.sh`. Os scripts usam o Chromium do Playwright do repositório para os
PNG; o `.ico` é montado em Python, sem dependências.

## Cores

| Cor | Hex | Papel |
|---|---|---|
| Violeta sólido | `#6D5CF5` | Paredes no fundo claro; azulejo do ícone (o `--ui-accent-solid` da UI) |
| Violeta acento | `#8B7CFF` | Paredes no fundo escuro (o `--ui-accent`); face interna direita no claro |
| Face interna (claro) | `#AB9FFF` | Face interna esquerda das paredes no fundo claro |
| Face interna (escuro/azulejo) | `#D6D0FF` / `#B4A9FF` | Faces internas no fundo escuro e no azulejo |
| Verde "agente ativo" | `#3DDC97` | Topo do cubo (é o verde de sucesso da UI) |
| Verde médio / escuro | `#2FBF80` / `#1F9E68` | Faces esquerda e direita do cubo |
| Tinta | `#14162B` | Texto da assinatura no fundo claro |
| Texto no escuro | `#E8EAF6` | Texto da assinatura no fundo escuro (o `--ui-text`) |
| Branco | `#FFFFFF` | Paredes no azulejo |
| Fundo do app | `#0B0D1A` | Fundo de referência do modo escuro |

## Uso

- **Tamanho mínimo:**
  - símbolo vetorial a partir de 32 px;
  - de 16 a 24 px, use `cyno-mark-small.svg` ou o favicon.
- **Na UI:** o ícone (azulejo) entre 28 e 32 px na barra lateral e 64 px no login.
- **Respiro:** em volta do símbolo, deixe pelo menos a espessura de uma parede (34/256 da altura).
- **Não faça:**
  - não gire nem distorça;
  - não troque o verde por outra cor de status;
  - não aplique sombra nem brilho no desenho (o brilho em volta do azulejo na UI é do CSS).
- **Uma cor só** (impressão, carimbo, marca d'água): use `cyno-mark-mono.svg`.
- **Cores e ângulos:** a versão colorida usa 6 tons (dois matizes × três faces isométricas), de propósito. A geometria
  segue a inclinação 2:1 da pixel art, não 30°.

## Observações

- Desenho original. Antes de qualquer uso público, faça busca de marca registrada para "Cyno" (INPI; USPTO/EUIPO se
  for o caso) e busca reversa de imagem. O nome coincide com um personagem de Genshin Impact, e por isso a marca evita
  qualquer motivo de cão, chacal ou Egito.

## O que ficou nesta pasta

Só o que o app usa e o que regenera isso: o kit final (`cyno/final/`) e os scripts de `cyno/fonte/` que o
`build_kit.sh` chama (`gen.py`, `gen7.py`, `render.cjs`, `make_ico.py`, `folha.py`). A marca anterior (Agent Office,
"Sala Viva"), os conceitos e renders das duas rodadas da logo Cyno, as folhas de teste e o brief saíram em 14/11 a
pedido do dono; estão no histórico do git (commit anterior a esta limpeza).
