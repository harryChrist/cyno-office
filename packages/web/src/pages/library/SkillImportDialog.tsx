import { skillBigNote, type ImportLibrarySkillsResponse, type SkillImportResponse } from "@cyno/shared";
import { useEffect, useState } from "react";
import { api, describeError } from "../../api/client";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText, Modal } from "../../ui/widgets";
import { formatBytes } from "./skillsView";

/**
 * Importar do computador: lista as skills de `~/.claude/skills` e dos plugins instalados (só nome e
 * descrição, lidos agora). O que você marcar é COPIADO para a Biblioteca; a original não é tocada e a
 * cópia nunca aponta de volta para ela. Nada é liberado a ninguém por importar.
 */
export function SkillImportDialog({ onClose }: { onClose: () => void }) {
  const [result, setResult] = useState<SkillImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [done, setDone] = useState<ImportLibrarySkillsResponse | null>(null);
  const run = useAsyncAction();

  useEffect(() => {
    let alive = true;
    api.listSkillImportCandidates().then(
      (response) => alive && setResult(response),
      (failure: unknown) => alive && setError(describeError(failure)),
    );
    return () => {
      alive = false;
    };
  }, []);

  const toggle = (key: string, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const needle = query.trim().toLowerCase();
  const shown = (result?.candidates ?? []).filter((candidate) => !needle || `${candidate.name} ${candidate.description} ${candidate.source}`.toLowerCase().includes(needle));

  const submit = async () => {
    const response = await run.run(() => api.importLibrarySkills([...picked]));
    if (response) {
      setDone(response);
      setPicked(new Set());
      // As copiadas passam a aparecer como "Já na Biblioteca" na mesma lista.
      const names = new Set(response.imported.map((skill) => skill.name.toLowerCase()));
      setResult((current) => (current ? { ...current, candidates: current.candidates.map((candidate) => (names.has(candidate.name.toLowerCase()) ? { ...candidate, alreadyInLibrary: true } : candidate)) } : current));
    }
  };

  return (
    <Modal title="Importar skills do computador" onClose={onClose} wide testId="skill-import-dialog">
      <div className="skill-import">
        <p className="skill-import__hint">
          Mostramos só o <strong>nome e a descrição</strong> das skills que existem em <code>~/.claude/skills</code> e nos plugins instalados. O que você marcar é <strong>copiado</strong> para a Biblioteca (a original não é tocada nem lida de novo depois). Importar não libera a skill a nenhum agente.
        </p>
        <ErrorText>{error}</ErrorText>
        {!result && !error && (
          <p className="ui-muted" role="status">
            Procurando skills…
          </p>
        )}
        {result && result.reason && <p className="ui-muted">{result.reason}</p>}
        {result && result.candidates.length > 0 && (
          <>
            <input className="ui-input" type="search" placeholder="Buscar candidata" value={query} onChange={(event) => setQuery(event.currentTarget.value)} aria-label="Buscar candidata" data-testid="skill-import-search" />
            <ul className="skill-import__list" data-testid="skill-import-list">
              {shown.map((candidate) => (
                <li key={candidate.key} className="skill-import__row" data-problem={candidate.problem ? "true" : undefined}>
                  <label className="skill-import__label">
                    <input type="checkbox" checked={picked.has(candidate.key)} disabled={Boolean(candidate.problem)} onChange={(event) => toggle(candidate.key, event.currentTarget.checked)} data-testid={`skill-import-check-${candidate.key}`} />
                    <span className="skill-import__text">
                      <span className="skill-import__name">
                        {candidate.name} <span className="lib-chip">{candidate.source}</span>
                        {candidate.alreadyInLibrary && <span className="ui-badge ui-badge--neutral">Já na Biblioteca</span>}
                      </span>
                      <span className="skill-import__desc">{candidate.description || "(sem descrição)"}</span>
                      <span className="skill-import__meta">
                        {candidate.files} {candidate.files === 1 ? "arquivo" : "arquivos"} · {formatBytes(candidate.bytes)}
                        {!candidate.problem && skillBigNote(candidate.bytes, candidate.files) && <span className="skill-import__big" data-testid="skill-import-big"> · {skillBigNote(candidate.bytes, candidate.files)}</span>}
                        {candidate.problem && <span className="skill-import__problem"> · não dá para importar: {candidate.problem}</span>}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
              {shown.length === 0 && <li className="ui-muted">Nenhuma candidata com essa busca.</li>}
            </ul>
          </>
        )}
        {done && (
          <div className="skill-import__done" role="status" data-testid="skill-import-done">
            {done.imported.length > 0 && <p>Copiadas para a Biblioteca: {done.imported.map((skill) => skill.name).join(", ")}. Use “Liberar…” na lista para escolher quem as recebe.</p>}
            {done.imported.flatMap((skill) => skill.warnings.filter((warning) => /SKILL\.md é grande/.test(warning)).map((warning) => <p key={`${skill.id}-big`} className="ui-muted">{skill.name}: {warning}</p>))}
            {done.failed.map((failure) => (
              <p key={failure.key} className="ui-error">
                Não foi possível importar: {failure.reason}
              </p>
            ))}
          </div>
        )}
        <ErrorText testId="skill-import-error">{run.error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Fechar
          </button>
          <button type="button" className="ui-button" disabled={picked.size === 0 || run.pending} onClick={() => void submit()} data-testid="skill-import-submit">
            {run.pending ? "Copiando…" : picked.size === 0 ? "Marque as que quer copiar" : `Copiar ${picked.size} ${picked.size === 1 ? "skill" : "skills"}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
