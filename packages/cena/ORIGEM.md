# Origem do pacote `@cyno/cena`

O motor de cena do escritório (agentes que andam, sentam, vão à copa; móveis, dia e noite, vida social) vem do projeto de código aberto **Habblaud**, de Márcio Junior, licença MIT (ver `LICENSE`, texto original).

- Repositório de origem: `marmottajr/habblaud`
- Versão: 1.0.3
- Commit copiado: `faa1a01`
- Data da cópia: 12/11/2026 (Junção V2, fatia F1)

## O que foi copiado (estrutura de pastas preservada)

O motor importa `../../../shared/...` por caminho relativo, então `client/src/...` e `shared/` ficam na mesma posição relativa que no original.

| Pasta | Conteúdo |
|---|---|
| `client/src/world/` | `api`, `assets`, `camera`, `constants`, `debug`, `index`, `input`, `playback`, `sound-cues`, `layout/`, `path/`, `sim/`, `social/`, `render/` e os testes |
| `client/src/art/` | toda a arte procedural (personagens, móveis, superfícies, tema, época, fonte de pixel) e os testes |
| `client/src/audio/` | `board`, `scheduler`, `synth` e o teste |
| `client/src/net/` | só `store.ts` (o `OfficeStore`, que traz o modo demonstração `mock`) e `store.test.ts` |
| `shared/` | `types`, `appearance`, `hash`, `activity`, `answers`, `github`, `messages`, `names`, `world/{api, protocol, traits, appearance-flat, office-from-world, floor-labels, floor-names, visit-sample}`, `demo/{simulator, github, permission}` e os testes |

Cerca de 120 arquivos TypeScript (32 de teste), 27,6 mil linhas fora os testes, 33,5 mil com eles. Dependências npm novas: nenhuma.

## O que ficou de fora

- `client/src/ui/**` (a interface do Habblaud; o Cyno tem a sua) e `client/src/{main, app}.ts`, `index.html`.
- A rede do Habblaud World: `net/{world, world-stream, access, timeline}.ts` e seus testes.
- A visita: `world/visit/**`, `world/visit-social.*`. Da cidade (`world/city/**`) só entrou o subconjunto da fatia F7 (abaixo); ficaram de fora `index.ts` (rede e jogador), `social.ts` e `social.css` (curtir, cumprimentar, teletransporte, denúncia), `cards.ts`, `greetings.ts`, `likes.ts`, `teleport.ts`, `notice.ts`, `resume.ts`, `minimap.ts`, `players.test`-adjacentes de social, e os testes desses arquivos. De `shared/world/` ficou de fora `projection`, `scene`, `schema*`, `names-rules`, `intro`, `labels` etc.
- `world/seasonal-world.test.ts` (testa o servidor do World), `art/preview.ts` (página de prévia).
- `shared/locales/**` e o `shared/i18n.ts` original (substituído: patch 4), `shared/world/{protocol.test.ts (precisa do schema do World), schema*, scene, city, projection, ...}`, `shared/{daystats, timeline}.ts`, `shared/demo/{daystats, terminal}.ts`.
- `server/**`, `mod/**`, `scripts/**`, plugins, hooks e instaladores; `CLAUDE.md` e `AGENTS.md`.
- **O nome e o logo do Habblaud:** nenhum arquivo de `assets/brand/**` nem `og-image.png`. A placa da recepção mostra "Cyno" (imagem gerada por código e, de reserva, o patch 2); o totem da entrada mostra "Cy" (patch 7).

## Imagens

Os quadros, os pôsteres e a ilustração (geradas por IA; uso autorizado pelo dono do Cyno) ficam em `packages/web/public/cena/assets/` (`art/`, `art/framed/`, `illustrations/empty-office.png`). O `manifest.json` é o original sem as chaves `og` e sem as marcas do Habblaud; `brand` traz só a nossa placa `signage.png`. O motor as busca em `/cena/assets/` (patch 1).

## Como atualizar a partir do original

1. No clone do Habblaud, `git diff faa1a01..<novo>` limitado às pastas acima.
2. Aplicar por cima de `packages/cena` (os arquivos novos entram; os que tiverem `CYNO-PATCH` pedem atenção).
3. Conferir `grep -rn "CYNO-PATCH" packages/cena` contra `PATCHES.md`; reaplicar o que o diff desfez.
4. Rodar `npx vitest run packages/cena` e `npm run typecheck`.
5. Atualizar o commit e a data neste arquivo.

## Medidas da fatia F1

- Chunk da cena no build do web (`vite build`): `cena-*.js` 416 kB minificado (147 kB gzip), carregado só com `?cena=demo` (import dinâmico). O chunk principal (`index-*.js`) passou de 1.291,25 kB para 1.291,90 kB (só o ponto de entrada da chave). O `pixi-*.js` não mudou. _(Medida da F1. Desde a F10 o canvas antigo e o `pixi-*.js` saíram do build.)_
- Imagens: 224 kB em disco, buscadas só quando a cena abre.

## A cidade (fatia F7, copiada na mesma versão `faa1a01`)

Copiado: `client/src/world/city/{scene, facade, ground, layout, state, players, tokens-facade, fireworks, input}.ts` e os testes `facade`, `layout`, `state`, `players`, `input`; `shared/world/{city, social-labels}.ts` e `city.test.ts`. A cidade do Cyno é local: sem Habblaud World, sem conta, sem outros jogadores, sem curtidas, cumprimentos, carimbos nem bloqueios (`server/world` não foi tocado). Os módulos copiados que ainda citam o World (o aviso em `shared/world/city.ts`) ficam como vieram: não são usados para enviar nada.

Chunk da cidade (build do web): ver a seção da fatia F7 no `CHANGELOG.md`.
