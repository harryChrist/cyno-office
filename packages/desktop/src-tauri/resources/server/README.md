# Recursos do servidor Cyno

Durante o empacotamento (`.github/workflows/desktop.yml` ou build manual no Windows), o servidor compilado do Cyno e a interface estática (`packages/web/dist`) são copiados para esta pasta, tendo `entry.mjs` como ponto de entrada padrão do sidecar `binaries/node`.

Em desenvolvimento local, você pode apontar para outro script definindo a variável de ambiente `CYNO_SERVER_ENTRY`.
