import { estimateTokens, parseSkillMarkdown, selftestSkillMarkdown, skillBodyWarning, skillMarkdownTemplate, SKILL_LIMITS, type LibrarySkillDetail, type LibrarySkillView } from "@cyno/shared";
import { useEffect, useMemo, useState } from "react";
import { api, describeError } from "../../api/client";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText, Modal } from "../../ui/widgets";
import { Markdown } from "../../ui/markdown/Markdown";
import { formatBytes, randomSelftestPhrase, tokensLabel } from "./skillsView";

export type SkillEditing = { mode: "create" } | { mode: "edit"; skill: LibrarySkillView };

const BLANK = skillMarkdownTemplate(
  "Minha skill",
  "Use quando o usuário pedir ... (diga aqui QUANDO o agente deve usar esta skill, em uma ou duas frases)",
  "\n# Minha skill\n\nExplique aqui, passo a passo, o que o agente deve fazer: regras, formatos, tamanhos, um checklist final.\nArquivos de apoio (modelos, exemplos) podem ser enviados depois e citados daqui.\n",
);

/**
 * Editor de uma skill: o texto do SKILL.md (frontmatter `name` e `description` + o corpo), com a
 * prévia de como o agente enxerga e o custo em tokens. Salvar uma skill que já existe guarda a
 * versão anterior (dá para voltar). Skill de app é só leitura: duplique para editar.
 */
export function SkillEditorDialog({ editing, onClose, onSaved }: { editing: SkillEditing; onClose: () => void; onSaved?: (skill: LibrarySkillView) => void }) {
  const skill = editing.mode === "edit" ? editing.skill : undefined;
  const [detail, setDetail] = useState<LibrarySkillDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [content, setContent] = useState(editing.mode === "create" ? BLANK : "");
  const [tab, setTab] = useState<"texto" | "previa">("texto");
  const save = useAsyncAction();

  useEffect(() => {
    if (!skill) return;
    let alive = true;
    api.getLibrarySkill(skill.id).then(
      (loaded) => {
        if (!alive) return;
        setDetail(loaded);
        setContent(loaded.content);
      },
      (error: unknown) => alive && setLoadError(describeError(error)),
    );
    return () => {
      alive = false;
    };
  }, [skill?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = useMemo(() => parseSkillMarkdown(content), [content]);
  const readonly = skill?.readonly === true;
  const tokens = estimateTokens(content);
  const bodyWarning = skillBodyWarning(tokens);
  const problems = [...parsed.errors];
  const changed = detail ? content !== detail.content : content.trim().length > 0;
  const loading = skill !== undefined && detail === null && !loadError;

  const submit = async () => {
    const saved = await save.run(() => (skill ? api.updateLibrarySkill(skill.id, { content }) : api.createLibrarySkill({ content })));
    if (saved) {
      onSaved?.(saved);
      onClose();
    }
  };

  return (
    <Modal title={skill ? (readonly ? `Ver ${skill.name}` : `Editar ${skill.name}`) : "Nova skill"} onClose={onClose} wide testId="skill-editor">
      <div className="skill-editor">
        {readonly && (
          <p className="lib-grant__note" role="note" data-testid="skill-readonly-note">
            Esta skill veio de um app e é só leitura (some junto com o app). Use “Duplicar” na lista para ter uma cópia editável.
          </p>
        )}
        {!skill && (
          <div className="skill-editor__templates" role="group" aria-label="Modelos">
            <span className="ui-muted">Começar de:</span>
            <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setContent(BLANK)} data-testid="skill-template-blank">
              Em branco
            </button>
            <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setContent(selftestSkillMarkdown(randomSelftestPhrase()))} data-testid="skill-template-selftest" title="Uma frase secreta que só aparece nesta skill: serve para provar que o agente a leu">
              Autoteste (frase secreta)
            </button>
          </div>
        )}
        <ErrorText>{loadError}</ErrorText>
        {loading && (
          <p className="ui-muted" role="status">
            Carregando…
          </p>
        )}
        <div className="skill-editor__tabs" role="tablist" aria-label="Editor">
          {(
            [
              ["texto", "Texto (SKILL.md)"],
              ["previa", "Prévia"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className="lib__tab" onClick={() => setTab(id)} data-testid={`skill-tab-${id}`}>
              {label}
            </button>
          ))}
        </div>
        {tab === "texto" ? (
          <textarea
            className="ui-input skill-editor__text"
            value={content}
            readOnly={readonly || loading}
            spellCheck={false}
            onChange={(event) => setContent(event.currentTarget.value)}
            aria-label="Texto do SKILL.md"
            aria-invalid={problems.length > 0}
            data-testid="skill-content"
          />
        ) : (
          <div className="skill-preview" data-testid="skill-preview">
            <header className="skill-preview__head">
              <h3 className="skill-preview__name">{parsed.frontmatter?.name || "(sem nome)"}</h3>
              <p className="skill-preview__when">
                <strong>Quando o agente usa:</strong> {parsed.frontmatter?.description || "(sem descrição)"}
              </p>
            </header>
            <Markdown source={parsed.body} resolveWiki={() => null} headingOffset={3} />
          </div>
        )}
        <p className="skill-editor__meta" data-testid="skill-meta">
          <span>{tokensLabel(tokens)} quando o agente lê</span>
          {parsed.frontmatter && parsed.frontmatter.name && <span>Linha no índice: ~{estimateTokens(`- ${parsed.frontmatter.name} (id): ${parsed.frontmatter.description.slice(0, SKILL_LIMITS.indexDescriptionChars)} -> skills/id/SKILL.md`)} tokens, sempre no contexto</span>}
          {detail && detail.fileList.length > 1 && (
            <span>
              Arquivos de apoio: {detail.fileList
                .filter((file) => file.path !== "SKILL.md")
                .map((file) => `${file.path} (${formatBytes(file.bytes)})`)
                .join(", ")}
            </span>
          )}
        </p>
        {bodyWarning && (
          <p className="ui-muted" role="status" data-testid="skill-body-warning">
            {bodyWarning} Se der, mova o texto longo para arquivos de apoio que o SKILL.md manda ler.
          </p>
        )}
        {problems.length > 0 && (
          <ul className="skill-editor__problems" role="alert" data-testid="skill-problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {skill?.hasPrevious && <p className="ui-muted skill-editor__hint">Ao salvar, a versão {skill.version} fica guardada como anterior (a lista tem “Voltar à anterior”).</p>}
        <ErrorText testId="skill-error">{save.error}</ErrorText>
        <div className="ui-actions skill-editor__actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            {readonly ? "Fechar" : "Cancelar"}
          </button>
          {!readonly && (
            <button type="button" className="ui-button" disabled={!changed || problems.length > 0 || save.pending || loading} onClick={() => void submit()} data-testid="skill-save">
              {save.pending ? "Salvando…" : skill ? "Salvar nova versão" : "Criar skill"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
