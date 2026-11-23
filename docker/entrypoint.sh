#!/bin/sh
# Entrada do contêiner do Cyno.
#
# Sobe como root só para arrumar o dono das pastas montadas (o Docker cria pastas que não existem no
# computador como root, e o app não conseguiria gravar nelas) e então vira um usuário comum
# (PUID/PGID, padrão 1000:1000) com setpriv. O app nunca roda como root.
#
#   PUID / PGID        quem o app vira (use o seu: `id -u` e `id -g`). Padrão 1000:1000.
#   CYNO_CHOWN_DIRS    pastas cujo dono é acertado quando não é o PUID. Padrão: "/data /home/node".
#                      Só mexe se o DONO DA PASTA DE CIMA estiver diferente (uma vez; depois é instantâneo).
#                      Pastas extras montadas por você (ex.: /projects) NÃO entram: o dono delas é seu.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  for dir in ${CYNO_CHOWN_DIRS:-/data /home/node}; do
    [ -d "$dir" ] || continue
    if [ "$(stat -c %u:%g "$dir")" != "$PUID:$PGID" ]; then
      echo "cyno: acertando o dono de $dir para $PUID:$PGID (uma vez)…" >&2
      chown -R "$PUID:$PGID" "$dir"
    fi
  done
  export HOME=/home/node
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
fi

# Já rodando como usuário comum (docker run --user ...): não há o que arrumar.
exec "$@"
