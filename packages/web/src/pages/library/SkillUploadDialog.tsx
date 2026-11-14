import { skillBigNote, SKILL_LIMITS, type LibrarySkillView } from "@cyno/shared";
import { useState } from "react";
import { api } from "../../api/client";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText, Modal } from "../../ui/widgets";
import { formatBytes } from "./skillsView";

type Picked = { kind: "folder"; files: { path: string; file: File }[] } | { kind: "zip"; file: File };

/** Lê um arquivo como base64 (sem o "data:…;base64,"). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error(`Não foi possível ler ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Enviar uma skill pronta: uma pasta (com o SKILL.md dentro) ou um .zip. A conferência é no servidor
 * (frontmatter, nomes de arquivo, tamanho, executáveis); aqui só o aviso de tamanho para não subir à toa.
 */
export function SkillUploadDialog({ onClose, onSaved }: { onClose: () => void; onSaved?: (skill: LibrarySkillView) => void }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const run = useAsyncAction();

  const total = picked ? (picked.kind === "zip" ? picked.file.size : picked.files.reduce((sum, item) => sum + item.file.size, 0)) : 0;
  // Só o teto técnico contra acidente barra aqui; o tamanho comum nunca.
  const tooBig = picked?.kind === "folder" ? total > SKILL_LIMITS.maxBytes : picked ? picked.file.size > SKILL_LIMITS.maxBytes : false;
  const bigNote = picked?.kind === "folder" ? skillBigNote(total, picked.files.length) : null;

  const submit = async () => {
    if (!picked) return;
    const saved = await run.run(async () => {
      if (picked.kind === "zip") return api.uploadLibrarySkill({ zipBase64: await readBase64(picked.file) });
      const files = await Promise.all(picked.files.map(async (item) => ({ path: item.path, dataBase64: await readBase64(item.file) })));
      return api.uploadLibrarySkill({ files });
    });
    if (saved) {
      onSaved?.(saved);
      onClose();
    }
  };

  return (
    <Modal title="Enviar skill (pasta ou .zip)" onClose={onClose} testId="skill-upload-dialog">
      <div className="skill-import">
        <p className="skill-import__hint">
          A pasta precisa ter um <code>SKILL.md</code> na raiz com <code>name</code> e <code>description</code> no começo. Arquivos de apoio (modelos, exemplos) vão junto. Sem executáveis nem binários nativos.
        </p>
        <div className="skill-upload__pickers">
          <label className="ui-button ui-button--secondary skill-upload__pick">
            Escolher pasta…
            <input
              type="file"
              className="sr-only"
              // `webkitdirectory` não está nos tipos do React; o navegador entende.
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              multiple
              data-testid="skill-upload-folder"
              onChange={(event) => {
                const list = [...(event.currentTarget.files ?? [])];
                setPicked(list.length > 0 ? { kind: "folder", files: list.map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file })) } : null);
              }}
            />
          </label>
          <label className="ui-button ui-button--secondary skill-upload__pick">
            Escolher .zip…
            <input
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              data-testid="skill-upload-zip"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                setPicked(file ? { kind: "zip", file } : null);
              }}
            />
          </label>
        </div>
        {picked && (
          <p className="skill-upload__chosen" data-testid="skill-upload-chosen">
            {picked.kind === "zip" ? `${picked.file.name} · ${formatBytes(total)}` : `Pasta com ${picked.files.length} ${picked.files.length === 1 ? "arquivo" : "arquivos"} · ${formatBytes(total)}`}
          </p>
        )}
        {bigNote && !tooBig && (
          <p className="ui-muted" data-testid="skill-upload-big">
            Skill {bigNote}. Só o SKILL.md e a descrição entram no contexto do agente; o resto fica na pasta dele para ler quando precisar.
          </p>
        )}
        {tooBig && <p className="ui-error">Passa do teto técnico de segurança ({formatBytes(SKILL_LIMITS.maxBytes)}): provavelmente é a pasta errada.</p>}
        <ErrorText testId="skill-upload-error">{run.error}</ErrorText>
        <div className="ui-actions">
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="ui-button" disabled={!picked || tooBig || run.pending} onClick={() => void submit()} data-testid="skill-upload-submit">
            {run.pending ? "Enviando…" : "Enviar skill"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
