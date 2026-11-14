import { SKILL_LIMITS, type LibrarySkillView } from "@cyno/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useLibraryStore } from "../../store/libraryStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ConfirmDialog, ErrorText } from "../../ui/widgets";
import { GrantDialog } from "./GrantDialog";
import { WhoUses } from "./LibraryConnectorsTab";
import { SkillEditorDialog, type SkillEditing } from "./SkillEditorDialog";
import { SkillImportDialog } from "./SkillImportDialog";
import { SkillUploadDialog } from "./SkillUploadDialog";
import { openLibrary } from "./libraryView";
import { filterSkills, formatBytes, readsLabel, SKILL_FILTERS, SKILL_ORIGIN_LABELS, SKILL_ORIGINS, skillFilterCounts, skillUsageLabel, tokensLabel, type SkillFilterId, type SkillOriginFilter } from "./skillsView";
import "./skills.css";

/** Uma skill da Biblioteca: o que faz, de onde vem, o que custa, quem usa e as ações. */
function SkillCard({ skill, onGrant, onEdit, onRemove }: { skill: LibrarySkillView; onGrant: () => void; onEdit: () => void; onRemove: () => void }) {
  const act = useAsyncAction();
  return (
    <li className="lib-card skill-card" data-testid={`skill-card-${skill.id}`} data-state={skill.warnings.length > 0 ? "attention" : "ok"}>
      <header className="lib-card__head">
        <span className="skill-card__glyph" aria-hidden="true">
          SK
        </span>
        <div className="lib-card__title">
          <h3 className="lib-card__name">{skill.name}</h3>
          <p className="lib-card__target">
            <span className="lib-chip">{skill.origin.kind === "app" ? `De um app: ${skill.origin.appId}` : SKILL_ORIGIN_LABELS[skill.origin.kind]}</span>
            <span className="lib-chip" title="Versão atual">
              v{skill.version}
            </span>
            {skill.readonly && <span className="lib-chip">só leitura</span>}
            <span className="lib-card__url" title={skill.id}>
              {skill.id}
            </span>
          </p>
        </div>
      </header>
      <p className="lib-card__desc" data-testid={`skill-desc-${skill.id}`}>
        {skill.description}
      </p>
      {skill.warnings.map((warning) => (
        <p key={warning} className="lib-card__reason lib-card__reason--attention" role="note">
          {warning}
        </p>
      ))}

      <div className="lib-card__body">
        <section className="lib-card__col" aria-label="Custo">
          <h4 className="lib-card__label">O que custa</h4>
          <p className="skill-card__cost" data-testid={`skill-cost-${skill.id}`}>
            <span>
              <strong>{tokensLabel(skill.indexTokens)}</strong> sempre no contexto de quem recebe (a linha do índice)
            </span>
            <span>
              <strong>{tokensLabel(skill.weightTokens)}</strong> só quando o agente lê o SKILL.md
            </span>
            <span className="ui-muted">
              {skill.files} {skill.files === 1 ? "arquivo" : "arquivos"} · {formatBytes(skill.bytes)} · {readsLabel(skill)}
            </span>
          </p>
        </section>
        <section className="lib-card__col lib-card__col--uses" aria-label="Quem usa">
          <h4 className="lib-card__label">
            Quem usa{skill.uses.length > 0 && <span className="ui-muted"> · {skillUsageLabel(skill)}</span>}
          </h4>
          <WhoUses connector={skill} />
        </section>
      </div>

      <footer className="lib-card__actions">
        <span className="ui-muted skill-card__updated">Atualizada em {new Date(skill.updatedAt).toLocaleDateString("pt-BR")}</span>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--small" onClick={onGrant} data-testid={`skill-grant-${skill.id}`}>
            Liberar…
          </button>
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={onEdit} data-testid={`skill-edit-${skill.id}`}>
            {skill.readonly ? "Ver" : "Editar"}
          </button>
          {skill.readonly && (
            <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={act.pending} onClick={() => void act.run(() => api.duplicateLibrarySkill(skill.id))} data-testid={`skill-duplicate-${skill.id}`}>
              Duplicar
            </button>
          )}
          {skill.hasPrevious && !skill.readonly && (
            <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={act.pending} onClick={() => void act.run(() => api.restoreLibrarySkill(skill.id))} title={`Volta ao texto da versão ${skill.previousVersion}`} data-testid={`skill-restore-${skill.id}`}>
              Voltar à anterior
            </button>
          )}
          <button type="button" className="ui-button ui-button--danger ui-button--small" onClick={onRemove} data-testid={`skill-remove-${skill.id}`}>
            Excluir
          </button>
        </div>
      </footer>
      <ErrorText>{act.error}</ErrorText>
    </li>
  );
}

/**
 * Aba Skills: instruções prontas (pasta com SKILL.md) guardadas na plataforma e entregues a agentes
 * específicos. O agente recebe uma cópia na pasta dele e uma linha de índice nas instruções; lê o
 * SKILL.md quando a tarefa pede. Criar escrevendo, enviar pasta/zip ou importar do computador por cópia.
 */
export function LibrarySkillsTab({ workspaceId }: { workspaceId: string | null }) {
  const skills = useLibraryStore((state) => state.skills);
  const loadError = useLibraryStore((state) => state.skillsError);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const [filter, setFilter] = useState<SkillFilterId>("todas");
  const [origin, setOrigin] = useState<SkillOriginFilter>("todas");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<SkillEditing | null>(null);
  const [importing, setImporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [granting, setGranting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<LibrarySkillView | null>(null);

  useEffect(() => {
    void useLibraryStore.getState().loadSkills();
  }, []);

  const all = useMemo(() => skills ?? [], [skills]);
  const counts = useMemo(() => skillFilterCounts(all, origin, workspaceId), [all, origin, workspaceId]);
  const shown = useMemo(() => filterSkills(all, { filter, origin, query, workspaceId }), [all, filter, origin, query, workspaceId]);
  const grantingItem = granting ? all.find((item) => item.id === granting) : undefined;

  return (
    <div className="lib-tab" data-testid="library-skills">
      <p className="skill-intro">
        Skills são instruções prontas (regras, formatos, checklists, modelos) que o agente lê quando a tarefa pede. A Biblioteca guarda a sua <strong>cópia</strong>: nada vem da configuração pessoal do computador. Cada agente recebe só o que você liberar; limite recomendado de {SKILL_LIMITS.maxPerAgent} skills por agente.
      </p>
      <div className="lib-toolbar">
        <input className="ui-input lib-toolbar__search" type="search" placeholder="Buscar skill, workspace ou agente" value={query} onChange={(event) => setQuery(event.currentTarget.value)} aria-label="Buscar" data-testid="skill-search" />
        <div className="ui-actions lib-toolbar__actions">
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setImporting(true)} data-testid="skill-import">
            Importar do computador
          </button>
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setUploading(true)} data-testid="skill-upload">
            Enviar pasta ou .zip
          </button>
          <button type="button" className="ui-button ui-button--small" onClick={() => setEditing({ mode: "create" })} data-testid="skill-new">
            + Nova skill
          </button>
        </div>
      </div>

      <div className="lib-filters">
        <div className="lib-filters__chips" role="group" aria-label="Filtro">
          {SKILL_FILTERS.map((item) => (
            <button key={item.id} type="button" className="lib-filter" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)} data-testid={`skill-filter-${item.id}`}>
              {item.label} <span className="lib-filter__count">{counts[item.id]}</span>
            </button>
          ))}
        </div>
        <label className="lib-filters__ws">
          <span className="ui-muted">Origem</span>
          <select className="ui-input ui-input--compact" value={origin} onChange={(event) => setOrigin(event.currentTarget.value as SkillOriginFilter)} data-testid="skill-origin-filter">
            {SKILL_ORIGINS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="lib-filters__ws">
          <span className="ui-muted">Workspace</span>
          <select className="ui-input ui-input--compact" value={workspaceId ?? ""} onChange={(event) => openLibrary({ tab: "skills", workspaceId: event.currentTarget.value || null })} data-testid="skill-workspace-filter">
            <option value="">Todos</option>
            {(workspaces ?? []).map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ErrorText>{loadError}</ErrorText>
      {skills === null ? (
        !loadError && (
          <p className="ui-muted" role="status">
            Carregando skills…
          </p>
        )
      ) : all.length === 0 ? (
        <section className="lib-empty" data-testid="skill-empty">
          <h3 className="lib-card__name">A Biblioteca ainda não tem skills</h3>
          <p className="ui-muted">Escreva a primeira (“+ Nova skill”), envie uma pasta pronta ou importe uma das que já existem neste computador. Depois use “Liberar…” para escolher quais agentes recebem.</p>
        </section>
      ) : shown.length === 0 ? (
        <p className="lib-empty ui-muted" data-testid="skill-none">
          Nenhuma skill com esse filtro.
        </p>
      ) : (
        <ul className="lib-list" data-testid="skill-list">
          {shown.map((skill) => (
            <SkillCard key={skill.id} skill={skill} onGrant={() => setGranting(skill.id)} onEdit={() => setEditing({ mode: "edit", skill })} onRemove={() => setRemoving(skill)} />
          ))}
        </ul>
      )}

      {editing && <SkillEditorDialog key={editing.mode === "edit" ? editing.skill.id : "nova"} editing={editing} onClose={() => setEditing(null)} onSaved={(saved) => editing.mode === "create" && setGranting(saved.id)} />}
      {uploading && <SkillUploadDialog onClose={() => setUploading(false)} onSaved={(saved) => setGranting(saved.id)} />}
      {importing && <SkillImportDialog onClose={() => setImporting(false)} />}
      {grantingItem && <GrantDialog skill={grantingItem} onClose={() => setGranting(null)} />}
      {removing && (
        <ConfirmDialog
          title="Excluir skill"
          testId="confirm-delete-skill"
          message={
            <p>
              Excluir <strong>{removing.name}</strong> da Biblioteca? {removing.uses.length > 0 ? `Ela sai de ${removing.uses.length === 1 ? "1 workspace" : `${removing.uses.length} workspaces`} e os agentes perdem a cópia e a linha do índice. ` : ""}A versão anterior também é apagada.
            </p>
          }
          confirmLabel="Excluir skill"
          onConfirm={() => api.deleteLibrarySkill(removing.id)}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
