import { definirOpcoesDeSom, useOpcoesDeSom } from "../../cena/opcoesDeSom";
import { EGG_PREFS, setEggPref, useEggPrefs } from "../../cena/bichos/prefs";
import { MaestroBirdSwitch } from "../../ui/MaestroBirdSwitch";
import { Switch } from "../../ui/widgets";
import { OptionHead, StateBadge } from "./SettingsOption";

/**
 * Seção "Escritório": preferências só deste navegador (localStorage, sem server). O som do mapa novo (desligado
 * por padrão) e os bichos do mapa novo (gato, cachorro e calopsita): liga/desliga cada um (lista em `cena/bichos/prefs.ts`)
 * e onde mora a calopsita. Desligado, o bicho some na hora.
 */
export function OfficeSettings() {
  const prefs = useEggPrefs();
  const som = useOpcoesDeSom();
  return (
    <div className="settings__groups">
      <section className="settings__card" data-testid="settings-som">
        <OptionHead
          title="Sons do escritório"
          seal="navegador"
          state={<StateBadge tone={som.ligado ? "on" : "off"}>{som.ligado ? "Ligado" : "Desligado"}</StateBadge>}
          line="Teclado de quem trabalha à vista, elevador, ping-pong e fliperama, só quando o Escritório está aberto. Vem desligado; o navegador só libera o áudio depois de um clique seu."
        />
        <div className="settings__switches">
          <Switch label="Tocar os sons do escritório" checked={som.ligado} testId="settings-som-ligado" onChange={(ligado) => definirOpcoesDeSom({ ligado })} />
          <label className="ui-field">
            <span className="ui-field__label">Volume: {Math.round(som.volume * 100)}%</span>
            <input type="range" min={0} max={100} step={5} value={Math.round(som.volume * 100)} disabled={!som.ligado} aria-label="Volume dos sons do escritório" data-testid="settings-som-volume" onChange={(event) => definirOpcoesDeSom({ volume: Number(event.currentTarget.value) / 100 })} />
          </label>
        </div>
      </section>
      <section className="settings__card" data-testid="settings-pets">
        <OptionHead
          title="Bichos do escritório"
          seal="navegador"
          state={<StateBadge tone="value">{EGG_PREFS.filter((pref) => prefs[pref.id]).length} de {EGG_PREFS.length} ligados</StateBadge>}
          line="Só enfeite: os bichos não mexem em tarefas nem nos agentes. Cada navegador guarda a sua escolha; desligado, o bicho some na hora."
        />
        <div className="settings__switches">
          {EGG_PREFS.map((pref) => (
            <Switch key={pref.id} label={pref.label} description={pref.hint} checked={prefs[pref.id]} testId={`settings-pref-${pref.id}`} onChange={(on) => setEggPref(pref.id, on)} />
          ))}
          <MaestroBirdSwitch />
        </div>
      </section>
      <p className="settings__fine" data-testid="settings-licenca-cena">
        O mapa usa código e arte de um projeto de código aberto (licença MIT).{" "}
        <a href="/licencas/cena-LICENSE.txt" target="_blank" rel="noopener noreferrer" className="ui-link">
          Ver a licença
        </a>
      </p>
    </div>
  );
}
