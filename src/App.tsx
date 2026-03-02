import { useState } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AdminSidebar } from "@/components/AdminSidebar";
import Dashboard from "@/pages/Dashboard";
import AppsPage from "@/pages/AppsPage";
import ProvidersPage from "@/pages/ProvidersPage";
import TasksPage from "@/pages/TasksPage";
import SecurityPage from "@/pages/SecurityPage";
import NotFound from "@/pages/NotFound";

const queryClient = new QueryClient();

const DASHBOARD_PASSWORD = "core2025!";

function AuthGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem("core_authed") === "1");
  const [pw, setPw] = useState("");
  const [error, setError] = useState(false);

  if (authed) return <>{children}</>;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pw === DASHBOARD_PASSWORD) {
      sessionStorage.setItem("core_authed", "1");
      setAuthed(true);
    } else {
      setError(true);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-lg border p-6">
        <h1 className="text-xl font-semibold">Central Core Dashboard</h1>
        <input
          type="password"
          value={pw}
          onChange={(e) => { setPw(e.target.value); setError(false); }}
          placeholder="Password"
          className="w-full px-3 py-2 border border-zinc-400 dark:border-zinc-600 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-500"
          autoFocus
        />
        {error && <p className="text-sm text-red-500">Password errata</p>}
        <button type="submit" className="w-full rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">
          Accedi
        </button>
      </form>
    </div>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthGate>
          <SidebarProvider>
            <div className="min-h-screen flex w-full">
              <AdminSidebar />
              <div className="flex-1 flex flex-col min-w-0">
                <header className="h-12 flex items-center border-b px-4 shrink-0">
                  <SidebarTrigger />
                </header>
                <main className="flex-1 p-6 overflow-auto">
                  <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/apps" element={<AppsPage />} />
                    <Route path="/providers" element={<ProvidersPage />} />
                    <Route path="/tasks" element={<TasksPage />} />
                    <Route path="/security" element={<SecurityPage />} />
                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </main>
              </div>
            </div>
          </SidebarProvider>
        </AuthGate>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
