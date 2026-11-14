import type { JointPartView, JointView } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { canRetry, isJointOpen, jointProgress, jointStatusLabel, partLabel, partTone, receivedLine, waitingLine } from "./jointView";

const part = (extra: Partial<JointPartView> & Pick<JointPartView, "ref" | "workspaceName">): JointPartView => ({ workspace: extra.workspaceName.toLowerCase(), title: `Parte ${extra.ref}`, dependsOn: [], state: "esperando", waitingFor: [], ...extra });
const joint = (parts: JointPartView[], extra: Partial<JointView> = {}): JointView => ({ id: "J-0001", title: "Post com arte", status: "ativo", paused: false, createdAt: "2026-11-11T12:00:00.000Z", parts, ...extra });

describe("cartão do projeto conjunto", () => {
  const design = part({ ref: "P1", workspaceName: "Design", state: "concluida" });
  const posts = part({ ref: "P2", workspaceName: "Posts", dependsOn: ["P1"], state: "esperando", waitingFor: ["P1"] });

  it("progresso, tom e rótulo de cada parte", () => {
    expect(jointProgress(joint([design, posts]))).toBe("1/2 partes");
    expect(partTone("concluida")).toBe("ok");
    expect(partTone("bloqueada")).toBe("bad");
    expect(partTone("esperando_voce")).toBe("wait");
    expect(partLabel({ state: "esperando_voce" })).toBe("esperando você");
  });

  it("diz quem a parte espera, só enquanto ela espera", () => {
    const view = joint([part({ ref: "P1", workspaceName: "Design", state: "andando" }), posts]);
    expect(waitingLine(view, posts)).toBe("esperando a parte P1 (Design)");
    expect(waitingLine(view, view.parts[0]!)).toBe("");
    const two = part({ ref: "P3", workspaceName: "Redes", dependsOn: ["P1", "P2"], waitingFor: ["P1", "P2"] });
    expect(waitingLine(joint([design, posts, two]), two)).toBe("esperando as partes P1 (Design) e P2 (Posts)");
  });

  it("o estado do conjunto em uma frase", () => {
    expect(jointStatusLabel(joint([design, posts]))).toBe("andando");
    expect(jointStatusLabel(joint([design, posts], { paused: true }))).toBe("pausado");
    expect(jointStatusLabel(joint([design, posts], { status: "concluido" }))).toBe("concluído");
    const stuck = joint([part({ ref: "P1", workspaceName: "Design", state: "falhou" }), part({ ref: "P2", workspaceName: "Posts", state: "bloqueada", dependsOn: ["P1"], waitingFor: ["P1"] })], { status: "travado" });
    expect(jointStatusLabel(stuck)).toBe("travado: a parte P1 falhou");
    expect(isJointOpen(stuck)).toBe(true);
    expect(isJointOpen(joint([], { status: "cancelado" }))).toBe(false);
  });

  it("só refaz a parte que falhou quando as dependências dela já terminaram", () => {
    const failed = part({ ref: "P1", workspaceName: "Design", state: "falhou" });
    const stuck = joint([failed, part({ ref: "P2", workspaceName: "Posts", state: "bloqueada", dependsOn: ["P1"], waitingFor: ["P1"] })], { status: "travado" });
    expect(canRetry(stuck, failed)).toBe(true);
    expect(canRetry(stuck, stuck.parts[1]!)).toBe(false);
    expect(canRetry(joint([failed]), failed)).toBe(false);
  });

  it("mostra o que a parte recebeu da anterior", () => {
    const received = part({
      ref: "P2",
      workspaceName: "Posts",
      state: "andando",
      received: { at: "2026-11-11T12:00:00.000Z", items: [{ from: "P1", workspace: "design", summary: "Arte feita,\nfundo creme.", media: [{ mediaId: "M-0001", title: "Arte do café" }] }] },
    });
    expect(receivedLine(joint([design, received]), received)).toBe("Veio da P1 (Design): 1 mídia: Arte do café · Arte feita, fundo creme.");
    expect(receivedLine(joint([design]), design)).toBe("");
  });
});
