import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "katex/dist/katex.min.css";
import "./styles.css";
import { bootstrapDocumentTheme } from "./theme";

bootstrapDocumentTheme(
  typeof window !== "undefined" ? window.lithium?.getInitialThemeState?.() : undefined,
  typeof window !== "undefined" ? window : undefined,
  typeof document !== "undefined" ? document : undefined
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
