import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

try {
  const root = document.getElementById("root");
  if (!root) throw new Error("Root element not found");
  createRoot(root).render(<App />);
} catch (e) {
  console.error("[main] Failed to mount app:", e);
  const root = document.getElementById("root");
  if (root) root.innerHTML = `<pre style="color:red;padding:2rem">${e}</pre>`;
}
