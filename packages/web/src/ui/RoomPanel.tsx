import { isMaestroRoom, isRoomThemeId, type OfficeState, type Room, type RoomDeletionPreview } from "@cyno/shared";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { indiceDoTema } from "../cena/adaptador/temas";
import { nomeDoTemaNoMotor } from "../cena/adaptador/temasDoMotor";
import { useViewStore } from "../store/viewStore";
import { BrainPreview } from "./BrainPreview";
import { CreateTeamDialog } from "./CreateDialogs";
import { countLabel, roomDeletionParts } from "./format";
import { toggledReads, roomFootprint, roomTeams } from "./selectors";
import { TeamBlock } from "./TeamBlock";
import { newLayoutSeed } from "./RoomLayoutPickers";
import { RoomForm } from "./EntityForms";
import { isEmptyPatch, roomPatch, roomValues, type RoomFormValues } from "./formModels";
import { useWidePanel } from "./panelWidth";
import { ThemeChip } from "./ThemePicker";
import { useAsyncAction } from "./useAsyncAction";
import { AsyncSwitch, ConfirmDialog, ErrorText } from "./widgets";

/**
 * O que o quarto lê do Cérebro além do próprio: o Cérebro global e os Cérebros de outros quartos
 * (só leitura, não simétrico). Não tem nada a ver com portas: as portas são automáticas e todo
 * agente anda por qualquer lugar. A Sala do Maestro já lê todos os quartos.
 */
function RoomBrainSharing({ room, office }: { room: Room; office: OfficeState }) {
  const others = office.rooms.filter((other) => other.id !== room.id);
  return (
    <div className="brain-sharing" data-testid="room-brain-sharing">
      <AsyncSwitch
        label="Lê o Cérebro global"
        description={room.readsGlobalBrain ? "Os agentes leem as notas do lobby." : "As notas do lobby ficam de fora."}
        checked={room.readsGlobalBrain}
        testId="brain-global"
        onToggle={(on) => api.updateBrainSharing(room.id, { readsGlobalBrain: on })}
      />
      {isMaestroRoom(room) ? null : (
        <div className="brain-sharing__rooms" role="group" aria-labelledby={`brain-reads-${room.id}`}>
          <p id={`brain-reads-${room.id}`} className="brain-sharing__label">
            Lê também os Cérebros de:
          </p>
          {others.length === 0 && <p className="ui-muted ui-empty">Crie outra sala para compartilhar.</p>}
          {others.map((other) => (
            <AsyncSwitch
              key={other.id}
              label={other.name}
              checked={room.readsBrainsOf.includes(other.id)}
              testId={`brain-reads-${other.id}`}
              onToggle={(on) => api.updateBrainSharing(room.id, { readsBrainsOf: toggledReads(room, other.id, on) })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Editar o quarto: o mesmo formulário da janela "Novo quarto". Enquanto está aberto, o painel
 * lateral alarga. Cérebro, "Gerar outro layout" e excluir continuam fora dele (só existem depois
 * de criado).
 */
function RoomEditForm({ room, onDone }: { room: Room; onDone: () => void }) {
  const [initial] = useState(() => roomValues(room));
  useWidePanel(true);
  const submit = async (values: RoomFormValues) => {
    const patch = roomPatch(initial, values);
    if (!isEmptyPatch(patch)) await api.updateRoom(room.id, patch);
    onDone();
  };
  return (
    <section className="panel-section" aria-labelledby="room-edit-title">
      <h3 id="room-edit-title" className="panel-section__title">
        Editar sala
      </h3>
      <RoomForm
        mode="edit"
        initial={initial}
        label={`Editar ${room.name}`}
        onSubmit={submit}
        onCancel={onDone}
        testId="room-edit-form"
        submitTestId="room-edit-save"
      />
    </section>
  );
}

/**
 * "Variar a sala": grava uma semente nova e a sala do prédio muda de planta (espelhada, outros cantos); os agentes
 * continuam nos times e voltam para a mesa nova. Não há mais editor de móveis (saiu com o mapa novo).
 */
function RerollButton({ room }: { room: Room }) {
  const { pending, error, run } = useAsyncAction();
  return (
    <>
      <button
        type="button"
        className="ui-button ui-button--secondary ui-button--small"
        disabled={pending}
        title="Sorteia outra planta para a sala (espelhada, outros cantos), sem tirar ninguém dela"
        onClick={() => void run(() => api.updateRoom(room.id, { layoutSeed: newLayoutSeed(room.layoutSeed) }))}
        data-testid="room-reroll"
      >
        🎲 Variar a sala
      </button>
      <ErrorText>{error}</ErrorText>
    </>
  );
}

/** "a, b e c" */
function joinParts(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} e ${parts.at(-1)}`;
}

/**
 * Texto da confirmação de excluir quarto: pede ao server tudo o que some junto (times, agentes,
 * tarefas, notas do Cérebro, aprovações, eventos, logs). Enquanto carrega (ou se falhar), mostra
 * o que o web já sabe (times, agentes e tarefas ativas).
 */
function RoomDeletionMessage({ room, footprint }: { room: Room; footprint: { teams: number; agents: number; activeTasks: number } }) {
  const [preview, setPreview] = useState<RoomDeletionPreview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getRoomDeletionPreview(room.id).then(
      (result) => alive && setPreview(result),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [room.id]);

  if (!preview) {
    return (
      <p data-testid="room-deletion-preview" aria-busy={!failed}>
        Excluir <strong>{room.name}</strong>? Somem junto {countLabel(footprint.teams, "time", "times")} e {countLabel(footprint.agents, "agente", "agentes")}
        {footprint.activeTasks > 0 ? `, e ${countLabel(footprint.activeTasks, "tarefa ativa é cancelada", "tarefas ativas são canceladas")}` : ""}
        {failed ? ", além do Cérebro, das aprovações, dos eventos e dos logs da sala" : ""}. Isso não pode ser desfeito.
      </p>
    );
  }
  const parts = roomDeletionParts(preview);
  return (
    <p data-testid="room-deletion-preview">
      Excluir <strong>{room.name}</strong>?{" "}
      {parts.length > 0 ? (
        <>
          Isso apaga para sempre: <strong>{joinParts(parts)}</strong>
          {preview.activeTasks > 0 ? ` (as tarefas ativas são canceladas)` : ""}.
        </>
      ) : (
        "A sala está vazia: só ela some."
      )}{" "}
      Não dá para desfazer.
    </p>
  );
}

function Section({ title, id, children, action }: { title: string; id: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="panel-section" aria-labelledby={id}>
      <div className="panel-section__head">
        <h3 id={id} className="panel-section__title">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Painel do quarto: tema, times e agentes, Cérebro (o que lê + preview), editar e excluir. */
export function RoomPanel({ office, roomId }: { office: OfficeState; roomId: string }) {
  const room = office.rooms.find((current) => current.id === roomId);
  const select = useViewStore((state) => state.select);
  const setFocus = useViewStore((state) => state.setFocus);
  const [editing, setEditing] = useState(false);
  const [addingTeam, setAddingTeam] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (!room) return <p className="ui-muted ui-empty">Esta sala não existe mais (ou ainda está chegando).</p>;
  const teams = roomTeams(office, room.id);
  const footprint = roomFootprint(office, room.id);
  const theme = isRoomThemeId(room.theme) ? room.theme : "mint";
  // A Sala do Maestro não é excluída nem ganha times normais (o server também recusa).
  const isMaestro = isMaestroRoom(room);

  return (
    <div className="room-panel" data-testid="room-panel" data-room-id={room.id}>
      <div className="room-hero">
        <ThemeChip theme={theme} />
        <div>
          <h2 className="panel-title" data-testid="room-name">
            {room.name}
          </h2>
          <p className="ui-muted">
            Tema {nomeDoTemaNoMotor(indiceDoTema(theme))} · {countLabel(footprint.teams, "time", "times")} · {countLabel(footprint.agents, "agente", "agentes")}
          </p>
        </div>
      </div>
      <div className="ui-actions ui-actions--start">
        <button type="button" className="ui-button ui-button--small" onClick={() => setFocus({ kind: "room", id: room.id })} data-testid="room-enter">
          Entrar
        </button>
        <button type="button" className="ui-button ui-button--secondary ui-button--small" aria-pressed={editing} onClick={() => setEditing((on) => !on)} data-testid="room-edit">
          Editar
        </button>
        {!isMaestro && <RerollButton room={room} />}
        {!isMaestro && (
          <button type="button" className="ui-button ui-button--danger ui-button--small" onClick={() => setConfirming(true)} data-testid="room-delete">
            Excluir
          </button>
        )}
      </div>
      {isMaestro && (
        <p className="ui-muted" data-testid="room-maestro-hint">
          Sala do Maestro: ele conhece o Cérebro de todas as salas deste workspace.
        </p>
      )}

      {editing && <RoomEditForm key={room.id} room={room} onDone={() => setEditing(false)} />}

      <Section
        title="Times"
        id="room-teams-title"
        action={
          isMaestro ? undefined : (
            <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setAddingTeam(true)} data-testid="add-team">
              + Time
            </button>
          )
        }
      >
        {teams.length === 0 ? (
          <p className="ui-muted ui-empty">Nenhum time ainda. Crie um para poder mandar tarefas.</p>
        ) : (
          <ul className="team-list">
            {teams.map((entry) => (
              <TeamBlock key={entry.team.id} entry={entry} office={office} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Cérebro" id="room-brain-title">
        <RoomBrainSharing room={room} office={office} />
        <BrainPreview room={room} office={office} />
      </Section>

      {addingTeam && <CreateTeamDialog roomId={room.id} roomName={room.name} onClose={() => setAddingTeam(false)} />}
      {confirming && (
        <ConfirmDialog
          title="Excluir sala"
          testId="confirm-delete-room"
          message={<RoomDeletionMessage room={room} footprint={footprint} />}
          confirmLabel="Excluir sala"
          onConfirm={async () => {
            await api.deleteRoom(room.id);
            select(null);
            setFocus({ kind: "map" });
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

/** Painel do lobby: explica o Cérebro global e controla quais quartos o leem. */
export function LobbyPanel({ office }: { office: OfficeState }) {
  const setFocus = useViewStore((state) => state.setFocus);
  const select = useViewStore((state) => state.select);
  return (
    <div className="room-panel" data-testid="lobby-panel">
      <div className="room-hero">
        <ThemeChip theme="lobby" />
        <div>
          <h2 className="panel-title">Lobby</h2>
          <p className="ui-muted">Guarda o Cérebro global.</p>
        </div>
      </div>
      <div className="ui-actions ui-actions--start">
        <button type="button" className="ui-button ui-button--small" onClick={() => setFocus({ kind: "room", id: "lobby" })}>
          Entrar
        </button>
      </div>
      <Section title="Quem lê o Cérebro global" id="lobby-brain-title">
        <p className="ui-muted">Só as salas marcadas leem as notas do Cérebro global. As portas não mudam isso: todo mundo anda por qualquer lugar.</p>
        {office.rooms.map((room) => (
          <div key={room.id} className="lobby-door">
            <AsyncSwitch label={room.name} checked={room.readsGlobalBrain} testId={`lobby-brain-${room.id}`} onToggle={(on) => api.updateBrainSharing(room.id, { readsGlobalBrain: on })} />
            <button type="button" className="ui-link" onClick={() => select({ kind: "room", id: room.id })} aria-label={`Abrir a sala ${room.name}`}>
              abrir
            </button>
          </div>
        ))}
      </Section>
    </div>
  );
}
