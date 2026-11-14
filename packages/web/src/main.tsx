import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGate } from "./auth/AuthGate";
import { applyPaletteCssVars } from "./theme/paletteCss";
import { instalarDemo } from "./demo/instalar";
import { pedeDemo } from "./demo/modoDemo";
import { SeloDemo } from "./demo/SeloDemo";
import "./styles.css";
import "./theme/tokens.css";

// `?demo=1`: o escritório de mentira (sem servidor de agentes e sem IA); nada é gravado em lugar nenhum.
const demo = pedeDemo(window.location.search);
if (demo) instalarDemo(window.location.search);

applyPaletteCssVars();

const root = document.getElementById("root");
if (!root) throw new Error("Elemento #root não encontrado");

createRoot(root).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
    {demo && <SeloDemo />}
  </StrictMode>,
);
