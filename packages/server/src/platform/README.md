# platform/

O que vale para a instalação inteira, não para um workspace só: autenticação (`auth/`), modelos padrão
globais (`models/`), o gerenciador de workspaces (`workspaces/`), o ciclo de vida do processo e as
métricas (`activity/`), o hub de eventos (`events/`), erros HTTP (`http/`), a retenção (`retention/`), a
agenda do dono (`agenda/`) e o agente da plataforma (`cyno/`).

- `cyno/`: o **Cyno**, a CLI acima de todos os Maestros (`CynoService`, instruções em `cyno-prompt.ts`).
  Dados em `data/platform/`. Veja `docs/arquitetura.md`, "Cyno, o agente da plataforma".

- `agenda/`: a **Sua agenda**, o tempo do dono, uma só para a plataforma (`AgendaService`; dados em
  `data/platform/agenda/`). O choque é conferido por código (`shared/src/agenda-slots.ts`).

O mural nasce aqui na próxima fatia do Cyno; ainda não existe.
