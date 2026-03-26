import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

/**
 * Safe boot — handles root-not-found, chunk mismatch, and
 * unexpected mount failures with a CSP-safe recovery fallback.
 * No inline event handlers — uses DOM API + addEventListener.
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
  const isChunkError = /loading chunk|failed to fetch dynamically imported|import/i.test(msg);

  // Build recovery UI via DOM API (CSP-safe, no inline handlers)
  el.textContent = "";

  const wrapper = document.createElement("div");
  wrapper.style.cssText = "padding:2rem;font-family:system-ui;max-width:40rem";

  const h1 = document.createElement("h1");
  h1.style.cssText = "color:#b91c1c;font-size:1.25rem;margin:0 0 .75rem";
  h1.textContent = "Boot failure";

  const p = document.createElement("p");
  p.style.cssText = "color:#71717a;font-size:.875rem;margin:0 0 1rem";
  p.textContent = isChunkError
    ? "Asset mismatch — a new version may have been deployed."
    : "The admin shell failed to start.";

  const btn = document.createElement("button");
  btn.style.cssText = "padding:.5rem 1rem;background:#7c3aed;color:#fff;border:none;border-radius:.375rem;cursor:pointer;font-size:.875rem";
  btn.textContent = "Reload";
  btn.addEventListener("click", () => location.reload());

  wrapper.appendChild(h1);
  wrapper.appendChild(p);
  wrapper.appendChild(btn);
  el.appendChild(wrapper);
}

boot();
