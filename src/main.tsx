import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

/**
 * Safe boot — handles root-not-found, chunk mismatch, and
 * unexpected mount failures with a static recovery fallback.
 */
function boot() {
  const root = document.getElementById("root");
  if (!root) {
    console.error("[boot] #root element not found — cannot mount.");
    return;
  }

  try {
    createRoot(root).render(<App />);
  } catch (e: unknown) {
    console.error("[boot] Failed to mount app:", e);
    showRecovery(root, e);
  }
}

function showRecovery(el: HTMLElement, error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  // Detect chunk / cache mismatch
  const isChunkError = /loading chunk|failed to fetch dynamically imported|import/i.test(msg);
  el.innerHTML = [
    '<div style="padding:2rem;font-family:system-ui;max-width:40rem">',
    '<h1 style="color:#b91c1c;font-size:1.25rem;margin:0 0 .75rem">Boot failure</h1>',
    `<p style="color:#71717a;font-size:.875rem;margin:0 0 1rem">${isChunkError ? "Asset mismatch — a new version may have been deployed." : "The admin shell failed to start."}</p>`,
    '<button onclick="location.reload()" style="padding:.5rem 1rem;background:#7c3aed;color:#fff;border:none;border-radius:.375rem;cursor:pointer;font-size:.875rem">Reload</button>',
    "</div>",
  ].join("");
}

boot();
