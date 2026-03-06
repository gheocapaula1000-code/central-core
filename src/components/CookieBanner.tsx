import { useState, useEffect } from "react";

const STORAGE_KEY = "coreheartbeat_cookie_consent";

export default function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setVisible(true);
    } catch {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  const accept = () => {
    try { localStorage.setItem(STORAGE_KEY, "true"); } catch {}
    setVisible(false);
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[9999] border-t border-border bg-card/95 backdrop-blur-sm px-4 py-4 shadow-lg">
      <div className="mx-auto flex max-w-xl flex-col sm:flex-row items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground text-center sm:text-left">
          Questo sito utilizza cookie tecnici per garantire il corretto funzionamento.
          Proseguendo accetti l'utilizzo dei cookie.{" "}
          <a href="/cookie-policy" className="underline hover:text-foreground">Maggiori informazioni</a>
        </p>
        <button
          onClick={accept}
          className="shrink-0 rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors min-h-[44px]"
        >
          OK
        </button>
      </div>
    </div>
  );
}
