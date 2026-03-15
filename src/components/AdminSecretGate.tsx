import { useState, useCallback } from "react";
import { Lock, LogIn, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { setCoreSecret, isCoreUnlocked, clearCoreSecret } from "@/lib/coreAdminFetch";

interface AdminSecretGateProps {
  children: React.ReactNode;
}

export function AdminSecretGate({ children }: AdminSecretGateProps) {
  const [unlocked, setUnlocked] = useState(() => isCoreUnlocked());
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleUnlock = useCallback(() => {
    if (!secret.trim()) {
      setError("Inserisci il secret amministrativo");
      return;
    }
    if (secret.trim().length < 8) {
      setError("Secret troppo corto");
      return;
    }
    setCoreSecret(secret.trim());
    setSecret("");
    setError(null);
    setUnlocked(true);
  }, [secret]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleUnlock();
    },
    [handleUnlock],
  );

  if (unlocked) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md border-border">
        <CardHeader className="text-center space-y-2">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Lock className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl font-semibold text-foreground">
            Console Amministrativa
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Accesso riservato — inserisci il secret per continuare
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <input
              type="password"
              placeholder="AI_CORE_SECRET"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            {error && (
              <div className="flex items-center gap-1.5 text-sm text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                {error}
              </div>
            )}
          </div>
          <Button onClick={handleUnlock} className="w-full" size="sm">
            <LogIn className="h-4 w-4 mr-2" />
            Sblocca Console
          </Button>
          <p className="text-[11px] text-center text-muted-foreground">
            Il secret viene salvato solo in sessionStorage e non persiste tra sessioni.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
