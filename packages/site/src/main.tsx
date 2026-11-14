import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/silkscreen/400.css";
import "@fontsource/silkscreen/700.css";
import { App } from "./App";
import "./styles.css";

const raiz = document.getElementById("root");
if (raiz) {
  createRoot(raiz).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
