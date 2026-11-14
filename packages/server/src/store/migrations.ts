/**
 * Migrações dos arquivos de dados. Cada passo é explícito e só mexe no formato (nunca apaga
 * dados). Arquivos já no formato atual passam sem mudança.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Troca a chave `from` por `to` (só se `to` ainda não existir). */
function renameKey(item: unknown, from: string, to: string): unknown {
  if (!isObject(item) || !(from in item) || to in item) return item;
  const { [from]: value, ...rest } = item;
  return { ...rest, [to]: value };
}

/**
 * office.json v1 -> v2: o quarto se chamava "workspace" no código.
 * `workspaces` -> `rooms` e, nos times, `workspaceId` -> `roomId`.
 */
function officeV1toV2(data: Json): Json {
  const renamed = renameKey(data, "workspaces", "rooms") as Json;
  const teams = Array.isArray(renamed.teams) ? renamed.teams.map((team) => renameKey(team, "workspaceId", "roomId")) : renamed.teams;
  return { ...renamed, teams, version: 2 };
}

/**
 * office.json v2 -> v3: as portas deixaram de ser configuração (agora são automáticas e todo
 * mundo anda por qualquer lugar) e o compartilhamento do Cérebro virou um campo próprio, com a
 * MESMA semântica de antes (o contexto dos agentes não muda):
 * porta para o lobby aberta (`hasLobbyDoor`) -> `readsGlobalBrain`;
 * conexões com outros quartos (`connections`) -> `readsBrainsOf` (os Cérebros que ele lê).
 */
function migrateRoomV2toV3(room: unknown): unknown {
  if (!isObject(room)) return room;
  const { hasLobbyDoor, connections, ...rest } = room;
  return {
    ...rest,
    readsGlobalBrain: rest.readsGlobalBrain ?? (typeof hasLobbyDoor === "boolean" ? hasLobbyDoor : false),
    readsBrainsOf: rest.readsBrainsOf ?? (Array.isArray(connections) ? connections : []),
  };
}

function officeV2toV3(data: Json): Json {
  const rooms = Array.isArray(data.rooms) ? data.rooms.map(migrateRoomV2toV3) : data.rooms;
  return { ...data, rooms, version: 3 };
}

const OFFICE_STEPS: Record<number, (data: Json) => Json> = { 1: officeV1toV2, 2: officeV2toV3 };

/** Leva um office.json de qualquer versão conhecida até a atual. Devolve `changed` se migrou. */
export function migrateOfficeData(data: unknown): { data: unknown; changed: boolean } {
  let current = data;
  let changed = false;
  while (isObject(current) && typeof current.version === "number" && OFFICE_STEPS[current.version]) {
    current = OFFICE_STEPS[current.version]!(current);
    changed = true;
  }
  return { data: current, changed };
}

/**
 * Tarefa de um arquivo no formato anterior aos projetos: `parentId` -> `projectId` e
 * `plan {planId,ref,step}` -> `work {projectId,ref,step}` (o projectId é o do pai; só vale quando o
 * pai é o pedido). Aceito por uma versão, caso alguém ligue um backup antigo.
 */
export function normalizeTaskCompat(task: unknown): unknown {
  if (!isObject(task)) return task;
  let next: Json = task;
  if ("parentId" in next) {
    const { parentId, ...rest } = next;
    next = "projectId" in rest ? rest : { ...rest, projectId: parentId };
  }
  if ("plan" in next && isObject(next.plan)) {
    const { plan, ...rest } = next;
    const projectId = typeof next.projectId === "string" ? next.projectId : (plan as Json).planId;
    next = "work" in rest ? rest : { ...rest, work: { projectId, ref: (plan as Json).ref, step: (plan as Json).step } };
  }
  return next;
}

/** tasks.json (formato antigo) não tem versão: cada tarefa antiga com `workspaceId` passa a ter `roomId`. */
export function migrateTasksData(data: unknown): { data: unknown; changed: boolean } {
  if (!Array.isArray(data)) return { data, changed: false };
  let changed = false;
  const tasks = data.map((task) => {
    const next = renameKey(task, "workspaceId", "roomId");
    if (next !== task) changed = true;
    return next;
  });
  return { data: tasks, changed };
}
