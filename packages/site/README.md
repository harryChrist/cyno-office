# Site do Cyno

Página de apresentação do Cyno, em pt-BR: Vite + React 19 + TypeScript, CSS próprio (tokens `--ui-*` do app), sem biblioteca de UI. No topo, um **escritório de demonstração rodando de verdade**: o motor de cena (`@cyno/cena`) com o simulador dele, que fabrica agentes dentro do próprio navegador (sem servidor, sem rede, sem dado real).

## Rodar

A partir da raiz do repositório:

```bash
npm install
npm run dev -w @cyno/site        # http://127.0.0.1:5480
npm run build -w @cyno/site      # saída em packages/site/dist
npm run preview -w @cyno/site    # serve o build em http://127.0.0.1:5482
npm run typecheck -w @cyno/site
```

## Estrutura

```
index.html                  título, descrição, Open Graph
src/main.tsx, App.tsx       entrada e a ordem das seções
src/secoes/                 Hero, ComoFunciona, OQueTem, Instalar, Faq, Rodape (os textos estão aqui)
src/components/Mapa.tsx     a janela do mapa vivo (poster, carga sob demanda, suspensão fora da tela)
src/components/pequenos.tsx Logo (único lugar), botão de copiar, cabeçalho, revelar ao rolar
src/cena/montarDemo.ts      liga o motor de cena ao simulador (carregado por import dinâmico)
src/styles.css              tokens e estilos
public/brand/               o logo: cyno-mark.svg, cyno-tile.svg, apple-touch-icon.png
public/img/                 mapa.webp (poster da cena) e os prints do app (dados fabricados)
vite.config.ts              react, endereço do og:image e a arte do motor de cena
vercel.json                 instalação pela raiz, saída e cache
```

## O mapa vivo

- **Sob demanda:** o motor fica num chunk próprio (`cena-*.js`, cerca de 420 kB, 150 kB comprimidos), baixado só quando o mapa chega perto da tela. O resto da página pesa cerca de 245 kB de JS (77 kB comprimidos) e 31 kB de CSS.
- **Poster:** `public/img/mapa.webp` (um print da própria cena) aparece até a cena ligar e é tudo que se vê com `prefers-reduced-motion` e no celular (menos de 900 px), onde a cena só liga pelo botão "Ligar o escritório ao vivo".
- **Roda e teclado:** a roda do mouse só mexe no zoom do mapa com Ctrl, e as teclas do motor (setas, WASD) só valem com o foco dentro do mapa; assim a página continua rolando normalmente. Fora da tela, o laço de desenho é suspenso.
- **Arte do motor:** as imagens (`/cena/assets/`) e o texto da licença (`/licencas/cena-LICENSE.txt`) não são copiados para este pacote: `vite.config.ts` as serve (dev e preview) e as emite no build a partir de `packages/web/public`. Por isso o build precisa do repositório inteiro.
- **Licença do motor:** o rodapé credita o Habblaud (MIT, Márcio Junior) e liga ao texto da licença. Detalhes em `THIRD_PARTY/README.md` e `packages/cena/ORIGEM.md`.
- Para trocar o poster: suba o site, role até o mapa, espere alguns segundos e salve um print da janela do mapa em WebP em `public/img/mapa.webp` (ajuste `width`/`height` no `Mapa.tsx`).

## Trocar o logo

O logo só existe como arquivos em `public/brand/` e é usado pelo componente `Logo` (`src/components/pequenos.tsx`, `/brand/cyno-mark.svg`) e pelo ícone da aba (`/brand/cyno-tile.svg`, `favicon.ico`, `apple-touch-icon.png`). Para trocar, substitua esses arquivos mantendo os nomes (SVG quadrado, viewBox 256x256).

## Trocar os prints

Os prints são do app de laboratório com dados fabricados (`LAB_HISTORY_DAYS=21 LAB_SERVER_PORT=3321 LAB_WEB_PORT=5321 LAB_DATA_DIR=/var/tmp/cyno-site node scripts/lab-up.mjs`, a partir da raiz). Tire em 1440x900 com escala 2 e salve em WebP de 2160 px de largura em `public/img/`. Confira que não aparece IP, domínio, caminho do sistema nem nome de pessoa real.

## Publicar na Vercel (plano gratuito)

1. Em vercel.com, **Add New > Project** e importe o repositório `harryChrist/cyno-office` (a conta da Vercel precisa ter acesso ao GitHub; o repositório pode ser privado).
2. Em **Root Directory**, escolha `packages/site`. Deixe ligada a opção **Include source files outside of the Root Directory in the Build Step** (é o padrão): o site importa `@cyno/cena` e a arte de `packages/web/public`.
3. O framework aparece como **Vite**. Confirme (o `vercel.json` já diz o mesmo):
   - Install Command: `cd ../.. && npm ci` (instala pela raiz, como o monorepo de workspaces precisa; instala também o server e o web, o que leva alguns minutos, mas só na instalação)
   - Build Command: `npm run build`
   - Output Directory: `dist`
4. **Deploy**. Depois disso, um push só publica de novo se tiver mudado algo em `packages/site`: o `ignoreCommand` do `vercel.json` compara a pasta com a última publicação e pula o build quando ela está igual. Mudanças no resto do repositório (inclusive no `@cyno/cena`) não republicam o site; para forçar, use **Redeploy** no painel da Vercel.

Mudou em relação à versão anterior do site: antes o pacote era autossuficiente e o `installCommand` era `npm install` só na pasta. Agora o site depende de `@cyno/cena` (workspace), então a instalação tem de ser pela raiz. Foi conferido numa cópia limpa do repositório (`git clone` local, `npm ci` na raiz e `npm run build` dentro de `packages/site`).

As tags Open Graph usam o endereço de produção que a Vercel informa (`VERCEL_PROJECT_PRODUCTION_URL`). Com domínio próprio, defina a variável de ambiente `SITE_URL` (por exemplo `https://cyno.exemplo.com`) no projeto e publique de novo.
