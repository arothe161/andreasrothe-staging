import React from "react";
import ReactDOM from "react-dom/client";
import Systembrett from "./Systembrett";
import "./index.css";

// Sucht das Root-Element, das die Jekyll-Seite systembrett.html bereitstellt.
// Falls das Element fehlt (z.B. bei falscher Einbindung), gibt es eine klare
// Konsolen-Fehlermeldung statt eines stillen Fehlschlags.
const container = document.getElementById("systembrett-root");

if (!container) {
  console.error(
    'Systembrett: Element mit id="systembrett-root" wurde auf der Seite nicht gefunden.'
  );
} else {
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <Systembrett />
    </React.StrictMode>
  );
}
