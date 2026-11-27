import {
  GIT_CLONE_PATH,
  GIT_CREDENTIALS_PATH,
  gitCloneJobPath,
  gitCredentialItemPath,
  type CreateGitCredentialBody,
  type GitCloneBody,
  type GitCloneJobResponse,
  type GitCredentialResponse,
  type GitCredentialsResponse,
} from "@cyno/shared";
import { requestJson } from "./client";

/** Rotas do cofre de credenciais e clone de repositórios git. */
export const gitApi = {
  listCredentials: () => requestJson<GitCredentialsResponse>(GIT_CREDENTIALS_PATH),
  createCredential: (body: CreateGitCredentialBody) =>
    requestJson<GitCredentialResponse>(GIT_CREDENTIALS_PATH, { method: "POST", body }),
  deleteCredential: (id: string) =>
    requestJson<void>(gitCredentialItemPath(id), { method: "DELETE" }),
  startClone: (body: GitCloneBody) =>
    requestJson<GitCloneJobResponse>(GIT_CLONE_PATH, { method: "POST", body }),
  getClone: (id: string) => requestJson<GitCloneJobResponse>(gitCloneJobPath(id)),
};
