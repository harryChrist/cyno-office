import type { GitCloneJob, GitCredentialView } from "@cyno/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloneRepoDialogContent, type CloneRepoDialogContentProps } from "./CloneRepoDialog";
import { GitCredentialForm, GitCredentialsView, type GitCredentialsViewProps } from "./GitCredentialsPanel";
import {
  cloneStatusText,
  suggestHostFromUrl,
  suggestRepoName,
  validateCloneNameClient,
  validateCloneUrlClient,
  validateCredentialForm,
} from "./gitView";

const TOKEN_CRED: GitCredentialView = {
  id: "github-1234abcd",
  label: "GitHub pessoal",
  host: "github.com",
  kind: "token",
  username: "ana",
  createdAt: "2026-11-25T10:00:00.000Z",
  hasSecret: true,
};

const SSH_CRED: GitCredentialView = {
  id: "gitlab-5678ef01",
  label: "GitLab SSH",
  host: "gitlab.com",
  kind: "ssh",
  createdAt: "2026-11-25T11:00:00.000Z",
  hasSecret: true,
};

function renderClone(extra: Partial<CloneRepoDialogContentProps> = {}): string {
  return renderToStaticMarkup(
    createElement(CloneRepoDialogContent, {
      url: "",
      name: "",
      branch: "",
      credentialId: "",
      credentials: [TOKEN_CRED, SSH_CRED],
      loadingCreds: false,
      credsError: null,
      addingCred: false,
      submitting: false,
      formError: null,
      job: null,
      onUrlChange: () => undefined,
      onNameChange: () => undefined,
      onBranchChange: () => undefined,
      onCredentialChange: () => undefined,
      onToggleAddCred: () => undefined,
      onCreateCred: async () => undefined,
      onSubmit: () => undefined,
      onReset: () => undefined,
      onClose: () => undefined,
      ...extra,
    }),
  );
}

function renderCreds(extra: Partial<GitCredentialsViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(GitCredentialsView, {
      credentials: [TOKEN_CRED, SSH_CRED],
      loading: false,
      loadError: null,
      adding: false,
      confirmDeleteId: null,
      deletingId: null,
      deleteError: null,
      onToggleAdd: () => undefined,
      onCancelAdd: () => undefined,
      onCreate: async () => undefined,
      onAskDelete: () => undefined,
      onConfirmDelete: () => undefined,
      onRetryLoad: () => undefined,
      ...extra,
    }),
  );
}

describe("gitView: validação de URL, nome, host e credenciais", () => {
  it("valida URLs https:// e SSH e recusa file://, ext::, espaços, hífen e credenciais embutidas", () => {
    expect(validateCloneUrlClient("https://github.com/org/app.git")).toBeNull();
    expect(validateCloneUrlClient("ssh://git@gitlab.com/org/app.git")).toBeNull();
    expect(validateCloneUrlClient("git@github.com:org/app.git")).toBeNull();

    expect(validateCloneUrlClient("")).toMatch(/Informe a URL/i);
    expect(validateCloneUrlClient("file:///tmp/repo")).toMatch(/file:\/\/ e ext::/i);
    expect(validateCloneUrlClient("ext::sh -c id")).toMatch(/file:\/\/ e ext::/i);
    expect(validateCloneUrlClient("-u/tmp/repo")).toMatch(/hífen/i);
    expect(validateCloneUrlClient("https://github.com/org/com espaco")).toMatch(/espaços/i);
    expect(validateCloneUrlClient("https://user:pass@github.com/org/app.git")).toMatch(/credencial salva/i);
  });

  it("deriva nome e host da URL e valida nome de pasta contra '..'", () => {
    expect(suggestRepoName("https://github.com/org/meu-site.git")).toBe("meu-site");
    expect(suggestRepoName("git@gitlab.com:time/api.git")).toBe("api");
    expect(suggestHostFromUrl("https://github.com/org/meu-site.git")).toBe("github.com");
    expect(suggestHostFromUrl("git@gitlab.com:time/api.git")).toBe("gitlab.com");

    expect(validateCloneNameClient("meu-site")).toBeNull();
    expect(validateCloneNameClient("../fora")).toMatch(/inválido/i);
    expect(validateCloneNameClient("a/b")).toMatch(/inválido/i);
  });

  it("valida formulário de credencial token e SSH", () => {
    expect(
      validateCredentialForm({ label: "GH", host: "github.com", kind: "token", username: "", secret: "tok_valido" }),
    ).toBeNull();
    expect(
      validateCredentialForm({ label: "GH", host: "https://github.com", kind: "token", username: "", secret: "tok" }),
    ).toMatch(/apenas o host/i);
    expect(
      validateCredentialForm({ label: "SSH", host: "github.com", kind: "ssh", username: "", secret: "invalida" }),
    ).toMatch(/-----BEGIN/i);
    expect(
      validateCredentialForm({
        label: "SSH",
        host: "github.com",
        kind: "ssh",
        username: "",
        secret: "-----BEGIN OPENSSH PRIVATE KEY-----\ncorpo\n-----END OPENSSH PRIVATE KEY-----",
      }),
    ).toBeNull();
  });
});

describe("CloneRepoDialogContent e GitCredentialsView: renderização e estados", () => {
  it("renderiza janela de clone com campos, opções de credencial e erro de validação", () => {
    const html = renderClone({
      url: "https://github.com/org/demo.git",
      formError: "URL inválida. Protocolos file:// e ext:: não são permitidos.",
    });
    expect(html).toContain('data-testid="clone-repo-url"');
    expect(html).toContain("Sem credencial (repositório público)");
    expect(html).toContain("GitHub pessoal (github.com · Token)");
    expect(html).toContain("GitLab SSH (gitlab.com · SSH)");
    expect(html).toContain('placeholder="demo"');
    expect(html).toContain("Protocolos file:// e ext:: não são permitidos.");
  });

  it("renderiza progresso durante o clone e 'Pasta cadastrada' ao concluir", () => {
    const runningJob: GitCloneJob = {
      id: "clone-1-abc",
      status: "running",
      url: "https://github.com/org/demo.git",
      name: "demo",
      startedAt: "2026-11-25T12:00:00.000Z",
      progress: 65,
      log: ["Clonando em demo…", "Receiving objects:  65% (13/20)"],
    };
    expect(cloneStatusText(runningJob)).toBe("Clonando… 65%");
    const runningHtml = renderClone({ url: runningJob.url, job: runningJob });
    expect(runningHtml).toContain("Clonando… 65%");
    expect(runningHtml).toContain('role="progressbar"');
    expect(runningHtml).toContain("Receiving objects:  65% (13/20)");

    const doneJob: GitCloneJob = {
      ...runningJob,
      status: "done",
      progress: 100,
      finishedAt: "2026-11-25T12:00:05.000Z",
      result: { path: "/dados/repos/demo", folderAdded: true },
    };
    const doneHtml = renderClone({ url: doneJob.url, job: doneJob });
    expect(doneHtml).toContain("Pasta cadastrada");
    expect(doneHtml).toContain("/dados/repos/demo");

    const errorJob: GitCloneJob = {
      ...runningJob,
      status: "error",
      error: "Credencial recusada. Confira o token ou a chave SSH escolhida.",
    };
    const errorHtml = renderClone({ url: errorJob.url, job: errorJob });
    expect(errorHtml).toContain("Credencial recusada");
    expect(errorHtml).toContain("Tentar de novo");
  });

  it("renderiza painel 'Credenciais do git' com lista, estados de carregamento/vazio e formulários token/SSH sem exibir segredo", () => {
    const listHtml = renderCreds();
    expect(listHtml).toContain("Credenciais do git");
    expect(listHtml).toContain("GitHub pessoal");
    expect(listHtml).toContain("github.com");
    expect(listHtml).toContain("usuário: ana");
    expect(listHtml).toContain("segredo salvo");
    expect(listHtml).toContain("GitLab SSH");

    expect(renderCreds({ loading: true })).toContain("Carregando credenciais…");
    expect(renderCreds({ credentials: [] })).toContain("Nenhuma credencial salva");

    const tokenFormHtml = renderToStaticMarkup(
      createElement(GitCredentialForm, {
        initialKind: "token",
        onCreate: async () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(tokenFormHtml).toContain('type="password"');
    expect(tokenFormHtml).toContain('data-testid="git-cred-username"');

    const sshFormHtml = renderToStaticMarkup(
      createElement(GitCredentialForm, {
        initialKind: "ssh",
        onCreate: async () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(sshFormHtml).toContain('data-testid="git-cred-ssh-key"');
    expect(sshFormHtml).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
  });
});
