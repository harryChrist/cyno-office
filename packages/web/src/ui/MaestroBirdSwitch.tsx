import { useSyncExternalStore } from "react";
import { birdBesideMaestro, setBirdBesideMaestro, subscribeBirdHome } from "../cena/bichos/birdHome";
import { Switch } from "./widgets";

/**
 * Onde mora a calopsita: no poleirinho da mesa do Maestro (padrão) ou no balcão da recepção. Aparece em
 * Configurações (Escritório > Bichos do escritório). Preferência só deste
 * navegador, sem server (os easter eggs são só visuais).
 */
export function MaestroBirdSwitch() {
  const on = useSyncExternalStore(subscribeBirdHome, () => birdBesideMaestro());
  return (
    <Switch
      label="Calopsita ao lado do Maestro"
      description={on ? "O poleirinho fica na mesa do Maestro, ao lado dele (sem a Sala do Maestro, fica na recepção)." : "O poleirinho fica no balcão da recepção."}
      checked={on}
      testId="maestro-bird"
      onChange={(next) => setBirdBesideMaestro(next)}
    />
  );
}
