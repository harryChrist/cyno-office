import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationPermission, requestNotificationPermission, showAttentionNotification } from "../attention/notify";
import { isDesktopApp, notify, pickFolder } from "./desktopBridge";

describe("ponte desktop (desktopBridge)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("detecta corretamente se está rodando dentro do Tauri", () => {
    expect(isDesktopApp()).toBe(false);

    vi.stubGlobal("window", {});
    expect(isDesktopApp()).toBe(false);

    vi.stubGlobal("window", { __TAURI__: { core: { invoke: vi.fn() } } });
    expect(isDesktopApp()).toBe(true);
  });

  it("pickFolder devolve null fora do Tauri e chama o comando nativo no desktop", async () => {
    expect(await pickFolder()).toBeNull();

    const invoke = vi.fn().mockResolvedValueOnce("C:\\Projetos\\cyno").mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("erro"));
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });

    expect(await pickFolder()).toBe("C:\\Projetos\\cyno");
    expect(invoke).toHaveBeenCalledWith("pick_folder");

    expect(await pickFolder()).toBeNull();
    expect(await pickFolder()).toBeNull();
  });

  it("notify usa o comando Tauri desktop_notify quando dentro do aplicativo desktop", async () => {
    const invoke = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("falha"));
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });

    const ok = await notify({ title: "Cyno · precisa de você", body: "Eco pediu aprovação", onClickRoute: "/?alert=a1" });
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("desktop_notify", {
      title: "Cyno · precisa de você",
      body: "Eco pediu aprovação",
      onClickRoute: "/?alert=a1",
    });

    const failed = await notify({ title: "Teste" });
    expect(failed).toBe(false);
  });

  it("notify usa a API Notification do navegador fora do Tauri e respeita permissão", async () => {
    expect(await notify({ title: "Sem suporte" })).toBe(false);

    const instances: { title: string; options: NotificationOptions; onclick?: () => void; close: ReturnType<typeof vi.fn> }[] = [];
    class FakeNotification {
      static permission: NotificationPermission = "granted";
      onclick?: () => void;
      close = vi.fn();
      constructor(
        public title: string,
        public options: NotificationOptions,
      ) {
        instances.push(this);
      }
    }

    const focus = vi.fn();
    const assign = vi.fn();
    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal("window", { focus, location: { assign } });

    expect(await notify({ title: "Aviso", body: "Detalhes", onClickRoute: "/?alert=k1" })).toBe(true);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.title).toBe("Aviso");
    expect(instances[0]!.options).toEqual({ body: "Detalhes" });

    instances[0]!.onclick?.();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/?alert=k1");
    expect(instances[0]!.close).toHaveBeenCalledTimes(1);

    FakeNotification.permission = "denied";
    expect(await notify({ title: "Bloqueada" })).toBe(false);
  });

  it("showAttentionNotification roteia para o desktopBridge quando dentro do Tauri", async () => {
    const invoke = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });

    expect(notificationPermission()).toBe("granted");
    expect(await requestNotificationPermission()).toBe("granted");

    const shown = await showAttentionNotification(
      {
        id: "a1",
        key: "approval:ws:A-1",
        kind: "approval",
        level: "alert",
        count: 1,
        at: "",
        updatedAt: "",
        text: "Eco pede a sua aprovação",
        needsOwner: true,
        workspaceName: "Demo",
        target: { page: "para-voce" },
      },
      vi.fn(),
    );

    expect(shown).toBe(true);
    expect(invoke).toHaveBeenCalledWith("desktop_notify", {
      title: "Cyno · precisa de você",
      body: "Eco pede a sua aprovação (Demo)",
      onClickRoute: "/?alert=approval%3Aws%3AA-1",
    });
  });
});
