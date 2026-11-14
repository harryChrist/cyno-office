import { ROOM_THEME_IDS, type OfficeState } from "@cyno/shared";
import { useState, type FormEvent } from "react";
import { api } from "../api/client";
import { useOfficeStore } from "../store/officeStore";
import { useViewStore } from "../store/viewStore";
import { randomAvatar } from "./avatarOptions";
import { AgentForm, RoomForm, TeamForm } from "./EntityForms";
import {
  agentCreateBody,
  newAgentValues,
  newRoomValues,
  newTeamValues,
  roomCreateBody,
  teamCreateBody,
  type AgentFormValues,
  type RoomFormValues,
  type TeamFormValues,
} from "./formModels";
import { useAsyncAction } from "./useAsyncAction";
import { useNavStore } from "../store/navStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { hasErrors, LIMITS, validateWorkspaceForm, type FieldErrors } from "./validation";
import { ErrorText, Field, Modal } from "./widgets";
import { WorkspaceForm } from "./WorkspaceForm";

/** Modelos padrão do workspace atual (preenchem o agente novo). */
function workspaceModels() {
  const id = useNavStore.getState().workspaceId;
  return useWorkspaceStore.getState().workspaces?.find((ws) => ws.id === id)?.models;
}

/** Primeiro tema ainda não usado por nenhum quarto (para variar as cores do escritório). */
function suggestTheme(office: OfficeState | null): string {
  const used = new Set(office?.rooms.map((room) => room.theme));
  return ROOM_THEME_IDS.find((theme) => !used.has(theme)) ?? ROOM_THEME_IDS[0];
}

function FormActions({ pending, submitLabel, onCancel, testId }: { pending: boolean; submitLabel: string; onCancel: () => void; testId: string }) {
  return (
    <div className="ui-actions">
      <button type="button" className="ui-button ui-button--secondary" onClick={onCancel}>
        Cancelar
      </button>
      <button type="submit" className="ui-button" disabled={pending} data-testid={testId}>
        {pending ? "Salvando…" : submitLabel}
      </button>
    </div>
  );
}

/** Novo workspace: o nome e (opcional) o Maestro dele. Criado, a UI já abre o workspace novo. */
export function CreateWorkspaceDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Novo workspace" onClose={onClose} testId="create-workspace-dialog" wide>
      <WorkspaceForm
        variant="dialog"
        onCancel={onClose}
        onCreated={(created) => {
          useNavStore.getState().setWorkspace(created.id);
          onClose();
        }}
      />
    </Modal>
  );
}

/** Renomear workspace: o nome novo chega a todos pelo WebSocket (`workspaces:list`). */
export function RenameWorkspaceDialog({ workspace, onClose }: { workspace: { id: string; name: string }; onClose: () => void }) {
  const [name, setName] = useState(workspace.name);
  const [errors, setErrors] = useState<FieldErrors<"name">>({});
  const { pending, error, run } = useAsyncAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateWorkspaceForm({ name });
    setErrors(found);
    if (hasErrors(found)) return;
    const trimmed = name.trim();
    if (trimmed === workspace.name) return onClose();
    const renamed = await run(() => api.renameWorkspace(workspace.id, { name: trimmed }));
    if (renamed) onClose();
  };

  return (
    <Modal title="Renomear workspace" onClose={onClose} testId="rename-workspace-dialog">
      <form className="ui-form" aria-label="Renomear workspace" noValidate onSubmit={(e) => void submit(e)}>
        <Field label="Nome" error={errors.name}>
          {(props) => <input {...props} className="ui-input" value={name} maxLength={LIMITS.workspaceName + 10} autoFocus onChange={(e) => setName(e.currentTarget.value)} />}
        </Field>
        <ErrorText>{error}</ErrorText>
        <FormActions pending={pending} submitLabel="Salvar" onCancel={onClose} testId="rename-workspace-submit" />
      </form>
    </Modal>
  );
}

/** Novo quarto: o mesmo formulário de "Editar quarto" do painel lateral. */
export function CreateRoomDialog({ onClose }: { onClose: () => void }) {
  const [initial] = useState(() => newRoomValues(suggestTheme(useOfficeStore.getState().office)));
  const submit = async (values: RoomFormValues) => {
    const created = await api.createRoom(roomCreateBody(values));
    const view = useViewStore.getState();
    view.select({ kind: "room", id: created.id });
    view.setFocus({ kind: "room", id: created.id });
    onClose();
  };
  return (
    <Modal title="Nova sala" onClose={onClose} testId="create-room-dialog" wide>
      <RoomForm mode="create" initial={initial} label="Nova sala" onSubmit={submit} onCancel={onClose} submitTestId="create-room-submit" />
    </Modal>
  );
}

/** Novo time: o mesmo formulário de "Editar" do time no painel. */
export function CreateTeamDialog({ roomId, roomName, onClose }: { roomId: string; roomName: string; onClose: () => void }) {
  const [initial] = useState(newTeamValues);
  const submit = async (values: TeamFormValues) => {
    await api.createTeam(teamCreateBody(roomId, values));
    onClose();
  };
  return (
    <Modal title={`Novo time em ${roomName}`} onClose={onClose} testId="create-team-dialog">
      <TeamForm mode="create" initial={initial} label="Novo time" onSubmit={submit} onCancel={onClose} submitTestId="create-team-submit" />
    </Modal>
  );
}

/** Novo agente: o mesmo formulário de "Editar agente" do painel (o time já vem escolhido). */
export function CreateAgentDialog({ teamId, onClose }: { teamId: string; onClose: () => void }) {
  const office = useOfficeStore((state) => state.office);
  // Motor, modelo e esforço já vêm com o padrão de agentes do workspace (dá para trocar antes de criar).
  const [initial] = useState(() => newAgentValues(teamId, randomAvatar(), workspaceModels()?.agentes));
  const submit = async (values: AgentFormValues) => {
    const created = await api.createAgent(agentCreateBody(values));
    useViewStore.getState().select({ kind: "agent", id: created.id });
    onClose();
  };
  return (
    <Modal title="Novo agente" onClose={onClose} testId="create-agent-dialog" wide>
      <AgentForm mode="create" initial={initial} office={office} label="Novo agente" onSubmit={submit} onCancel={onClose} submitTestId="create-agent-submit" />
    </Modal>
  );
}
