import { installAndroidPixelSafety } from "./lib/androidSafety";
// Doit précéder toute création de canvas.
installAndroidPixelSafety();
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
