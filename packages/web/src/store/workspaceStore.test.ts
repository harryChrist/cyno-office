import type { Workspace } from "@cyno/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { useNavStore } from "./navStore";
import { currentWorkspaceName, pickWorkspace, useWorkspaceStore } from "./workspaceStore";

const AT = "2026-01-01T00:00:00.000Z";
const LIST: Workspace[] = [
  { id: "principal", name: "Principal", createdAt: AT },
  { id: "linkedin", name: "LinkedIn", createdAt: AT },
];

describe("pickWorkspace", () => {
  it("mantém o atual se ele existe; senão usa o primeiro", () => {
    expect(pickWorkspace("linkedin", LIST)).toBe("linkedin");
    expect(pickWorkspace("excluido", LIST)).toBe("principal");
    expect(pickWorkspace(null, LIST)).toBe("principal");
    expect(pickWorkspace(null, [])).toBeNull();
  });

  it("acha o nome do atual", () => {
    expect(currentWorkspaceName(LIST, "linkedin")).toBe("LinkedIn");
    expect(currentWorkspaceName(null, "linkedin")).toBeNull();
  });
});

describe("useWorkspaceStore.setList", () => {
  beforeEach(() => useNavStore.setState({ workspaceId: null, page: "office" }));

  it("guarda a lista e escolhe um workspace válido quando o atual não existe", () => {
    useWorkspaceStore.getState().setList(LIST);
    expect(useWorkspaceStore.getState().workspaces).toEqual(LIST);
    expect(useNavStore.getState().workspaceId).toBe("principal");

    useNavStore.setState({ workspaceId: "linkedin" });
    useWorkspaceStore.getState().setList(LIST.slice(0, 1)); // linkedin foi excluído
    expect(useNavStore.getState().workspaceId).toBe("principal");
  });
});
