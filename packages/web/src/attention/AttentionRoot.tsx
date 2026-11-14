import { PUSH_TEST_KEY } from "@cyno/shared";
import { useEffect } from "react";
import { AttentionToasts } from "../hud/AttentionToasts";
import { AwayCard } from "../hud/AwayCard";
import { onAttentionRaised, useAttentionStore } from "../store/attentionStore";
import { useNavStore } from "../store/navStore";
import { connectCynoSocket } from "../ws/cynoSocket";
import { decideNotify, decideSound, decideToast, EMPTY_SOUND_MEMORY, isOnTarget, noteSound, type SoundMemory } from "./decide";
import { useDevicePrefs } from "./devicePrefs";
import { ensureNotificationWorker, listenNotificationClicks, notificationPermission, showAttentionNotification } from "./notify";
import { startPresence } from "./awayStore";
import { openAlert } from "./openAlert";
import { alertKeyFromSearch } from "./push";
import { attentionAudio } from "./sound";
import { useToastStore } from "./toastStore";
import { useAttentionKeys } from "./useAttentionKeys";
import { useAttentionTitle } from "./useAttentionTitle";

/**
 * A cadeia de atenção do navegador, montada uma vez no app (qualquer página): abre o socket da
 * plataforma só para os `attention:*`, mantém o título da aba e a tecla `P`, e decide o que fazer
 * com cada alerta que nasce ao vivo (aviso na tela, som, notificação do navegador). O socket do
 * Cyno só fica aberto na página do Cyno; este aqui fica aberto o tempo todo, porque o dono precisa
 * ser chamado de onde estiver.
 */
export function AttentionRoot() {
  useAttentionTitle();
  useAttentionKeys();

  // O socket da plataforma e a ressincronização: cada conexão (e reconexão) busca a lista de novo, quieta.
  useEffect(() => {
    let first = true;
    void useAttentionStore.getState().load();
    return connectCynoSocket({
      onEvent: (event) => {
        if (event.type === "cyno:snapshot") {
          // O primeiro snapshot vem junto da carga que já foi pedida; os seguintes são reconexões.
          if (first) first = false;
          else void useAttentionStore.getState().load();
          return;
        }
        if (event.type === "attention:raised" || event.type === "attention:updated" || event.type === "attention:cleared") useAttentionStore.getState().applyEvent(event);
      },
    });
  }, []);

  // O que ainda está aberto: o aviso de um alerta que a causa limpou some.
  useEffect(
    () =>
      useAttentionStore.subscribe((state, previous) => {
        if (state.open === previous.open) return;
        useToastStore.getState().prune(new Map(state.open.map((alert) => [alert.key, alert] as const)));
      }),
    [],
  );

  // Um alerta nasceu ao vivo: aviso, som e notificação, cada um com a sua regra (decide.ts).
  useEffect(() => {
    let memory: SoundMemory = EMPTY_SOUND_MEMORY;
    return onAttentionRaised((alert) => {
      const now = Date.now();
      const device = useDevicePrefs.getState().prefs;
      const account = useAttentionStore.getState().prefs;
      const hidden = document.visibilityState === "hidden";
      const nav = useNavStore.getState();
      if (decideToast(device, account, alert, { visible: !hidden, onTarget: isOnTarget(alert, { page: nav.page, sub: nav.sub, workspaceId: nav.workspaceId }), now })) useToastStore.getState().push(alert, now);
      const sound = decideSound(device, account, alert, memory, now);
      if (sound && attentionAudio.play(sound, device.volume)) memory = noteSound(memory, alert, now);
      if (decideNotify(device, account, alert, { hidden, permission: notificationPermission(), now })) void showAttentionNotification(alert, openAlert);
    });
  }, []);

  // O navegador só deixa tocar depois de um gesto: com o som ligado, o primeiro clique ou tecla libera.
  useEffect(() => {
    const unlock = () => {
      if (useDevicePrefs.getState().prefs.sound) void attentionAudio.unlock();
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // Notificação do celular: o service worker só entra com a opção ligada; o clique nela leva ao item.
  const notificationsOn = useDevicePrefs((state) => state.prefs.browserNotifications);
  useEffect(() => {
    if (notificationsOn) void ensureNotificationWorker();
  }, [notificationsOn]);
  useEffect(
    () =>
      listenNotificationClicks((key) => {
        const alert = useAttentionStore.getState().open.find((candidate) => candidate.key === key);
        if (alert) openAlert(alert);
        // Aviso de lote (ou de um alerta que já saiu): leva ao que espera você. O de teste só traz a aba.
        else if (key && key !== PUSH_TEST_KEY) useNavStore.getState().go("para-voce");
      }),
    [],
  );

  // Abriu pelo clique numa notificação com o site fechado: `/?alert=<chave>` leva ao alerta (e tira o parâmetro do endereço).
  const loaded = useAttentionStore((state) => state.loaded);
  useEffect(() => {
    if (!loaded) return;
    const key = alertKeyFromSearch(window.location.search);
    if (!key) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("alert");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    const alert = useAttentionStore.getState().open.find((candidate) => candidate.key === key);
    if (alert) openAlert(alert);
    else if (key !== PUSH_TEST_KEY) useNavStore.getState().go("para-voce");
  }, [loaded]);

  // A presença do dono (só com a aba visível e entrada recente) e o "enquanto você estava fora" ao voltar.
  useEffect(() => startPresence(), []);

  return (
    // Os avisos e o cartão "Enquanto você estava fora" dividem a mesma coluna do canto: empilham, sem um cobrir o outro.
    <div className="attn-stack">
      <AttentionToasts />
      <AwayCard />
    </div>
  );
}
