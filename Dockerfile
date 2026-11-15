# Cyno em contêiner: server (Fastify via tsx) + web (vite preview com proxy /api e /ws) no mesmo contêiner.
# Só a porta 5173 (web) precisa ser publicada; o server escuta em 127.0.0.1:3001, dentro do contêiner.
#
#   docker build -t cyno .
#   docker run -d --name cyno -p 5173:5173 -v cyno-data:/data -v cyno-home:/home/node cyno

# ---- 1) dependências e build do web ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# pacotes nativos (node-pty) usam binários prontos; python/make/g++ ficam só como rede de segurança do npm ci
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/cena/package.json packages/cena/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/site/package.json packages/site/
RUN npm ci --no-audit --no-fund

# version.json (opcional) vem de `npm run docker:up`: o .git não entra na imagem, e é por ele que o app mostra o commit e compara com o GitHub
COPY tsconfig.base.json tsconfig.json version.json* ./
COPY packages packages
RUN npm run build -w @cyno/web

# ---- 2) imagem final ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    DATA_DIR=/data \
    HOST=127.0.0.1 \
    PORT=3001 \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=5173
WORKDIR /app

# python3: cerca de arquivos (Landlock); tini: init de verdade (os agentes são processos filhos e terminais pty);
# procps (ps): o concurrently usa para encerrar a árvore de processos; git e ca-certificates: as CLIs dos agentes usam.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 git ca-certificates tini procps \
 && rm -rf /var/lib/apt/lists/*

# CLIs de assinatura. O Claude Code vem na imagem; as outras são opcionais e nunca quebram o build:
#   docker build --build-arg EXTRA_CLIS="@openai/codex opencode-ai" -t cyno .
ARG CLAUDE_CODE_PACKAGE=@anthropic-ai/claude-code
ARG EXTRA_CLIS=""
RUN npm install -g "$CLAUDE_CODE_PACKAGE" \
 && for pkg in $EXTRA_CLIS; do npm install -g "$pkg" || echo "AVISO: não consegui instalar $pkg (siga sem ele)"; done \
 && npm cache clean --force

COPY --from=build --chown=node:node /app /app

# Chromium do Playwright (navegador dos agentes) com as bibliotecas do sistema. O server usa o Chromium
# completo (channel "chromium"), então o headless-shell que vem junto é apagado (-280 MB).
RUN node_modules/.bin/playwright install --with-deps chromium \
 && rm -rf /opt/pw-browsers/chromium_headless_shell-* /var/lib/apt/lists/* /root/.npm

# usuário sem privilégios (uid 1000); /data e o home viram volumes já com o dono certo
RUN mkdir -p /data /home/node/.claude && chown node:node /data /home/node /home/node/.claude
USER node
ENV HOME=/home/node
VOLUME ["/data", "/home/node"]
EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node_modules/.bin/concurrently", "--names", "server,web", "--kill-others-on-fail", "npm run start -w @cyno/server", "npm run preview -w @cyno/web"]
