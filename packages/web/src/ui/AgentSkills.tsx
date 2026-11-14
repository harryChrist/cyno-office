import { useEffect } from "react";
import "../pages/library/skills.css";
import { openLibrary } from "../pages/library/libraryView";
import { agentSkillBudget, skillsOfAgent, tokensLabel } from "../pages/library/skillsView";
import { useLibraryStore } from "../store/libraryStore";
import { useNavStore } from "../store/navStore";
import { useWorkspaceStore } from "../store/workspaceStore";

/**
 * Skills que chegam ao agente (as que a Biblioteca liberou ao workspace e foram entregues a ele),
 * com o custo do índice e os avisos de limite (mais de 12 skills ou ~6 mil tokens de índice). Quem
 * libera ou tira é a Biblioteca (aba Skills) ou o Maestro (`set_agent_skills`).
 */
export function AgentSkills({ agentId, testId = "agent-skills" }: { agentId: string; testId?: string }) {
  const skills = useLibraryStore((state) => state.skills);
  const workspaceId = useNavStore((state) => state.workspaceId);
  const workspaceName = useWorkspaceStore((state) => state.workspaces?.find((workspace) => workspace.id === workspaceId)?.name ?? workspaceId);

  useEffect(() => {
    if (useLibraryStore.getState().skills === null) void useLibraryStore.getState().loadSkills();
  }, []);

  const mine = skillsOfAgent(skills, workspaceId, agentId);
  const budget = agentSkillBudget(mine);
  return (
    <div className="agent-has-wrap" data-testid={testId}>
      {mine.length === 0 ? (
        <p className="ui-muted ui-empty" data-testid={`${testId}-empty`}>
          {skills === null ? "Carregando skills…" : "Nenhuma skill chega a este agente."}
        </p>
      ) : (
        <>
          <ul className="agent-has" aria-label="Skills deste agente">
            {mine.map((skill) => (
              <li key={skill.id} className="agent-has__row" data-testid={`${testId}-${skill.id}`}>
                <span className="skill-card__glyph skill-card__glyph--small" aria-hidden="true">
                  SK
                </span>
                <span className="agent-has__text">
                  <span className="agent-has__name">{skill.name}</span>
                  <span className="agent-has__from">
                    Da Biblioteca · liberada ao workspace {workspaceName} · índice {tokensLabel(skill.indexTokens)}
                    {skill.usage.reads > 0 ? ` · lida ${skill.usage.reads} ${skill.usage.reads === 1 ? "vez" : "vezes"}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  className="ui-link agent-has__open"
                  onClick={() => (skill.origin.kind === "app" ? openLibrary({ tab: "apps", item: skill.origin.appId }) : openLibrary({ tab: "skills", workspaceId, item: skill.id }))}
                  aria-label={`Abrir ${skill.name} na Biblioteca`}
                  data-testid={`${testId}-open-${skill.id}`}
                >
                  Abrir
                </button>
              </li>
            ))}
          </ul>
          <p className="ui-muted agent-skills__budget" data-testid={`${testId}-budget`}>
            {budget.count} {budget.count === 1 ? "skill" : "skills"} · índice {tokensLabel(budget.indexTokens)} sempre no contexto
          </p>
          {budget.warnings.map((warning) => (
            <p key={warning} className="skill-note" role="note" data-testid={`${testId}-warning`}>
              {warning}
            </p>
          ))}
        </>
      )}
      <button type="button" className="ui-link" onClick={() => openLibrary({ tab: "skills", workspaceId })} data-testid={`${testId}-library`}>
        Abrir skills na Biblioteca
      </button>
    </div>
  );
}
