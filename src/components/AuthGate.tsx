import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Session } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; isAdmin: boolean };

const NotFoundScreen = () => (
  <div className="flex min-h-screen w-full items-center justify-center bg-muted">
    <div className="text-center">
      <h1 className="mb-4 text-4xl font-bold">404</h1>
      <p className="mb-4 text-xl text-muted-foreground">Page not found</p>
    </div>
  </div>
);

const LoadingScreen = () => (
  <div className="flex min-h-screen w-full items-center justify-center bg-background">
    <div className="text-sm text-muted-foreground">Loading…</div>
  </div>
);

const LoginScreen = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) toast.error(error.message);
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Central Core</CardTitle>
          <CardDescription>Sign in to access the admin hub.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <PasswordInput
                id="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export const AuthGate = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let mounted = true;

    const checkAdmin = async (session: Session | null) => {
      if (!session) {
        if (mounted) setState({ status: "unauthenticated" });
        return;
      }
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", session.user.id)
        .eq("role", "admin")
        .maybeSingle();
      if (!mounted) return;
      if (error) {
        setState({ status: "authenticated", isAdmin: false });
        return;
      }
      setState({ status: "authenticated", isAdmin: !!data });
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ status: "loading" });
      // Defer to avoid deadlock with supabase client
      setTimeout(() => checkAdmin(session), 0);
    });

    supabase.auth.getSession().then(({ data }) => checkAdmin(data.session));

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (state.status === "loading") return <LoadingScreen />;
  if (state.status === "unauthenticated") return <LoginScreen />;
  if (!state.isAdmin) return <NotFoundScreen />;
  return <>{children}</>;
};
