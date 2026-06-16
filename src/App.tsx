import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AdminSidebar } from "@/components/AdminSidebar";
import { AuthGate } from "@/components/AuthGate";
import Dashboard from "@/pages/Dashboard";
import AppsPage from "@/pages/AppsPage";
import NotFound from "@/pages/NotFound";

// Lazy-loaded heavy pages to keep main bundle < 500kB
const ProvidersPage = lazy(() => import("@/pages/ProvidersPage"));
const ProviderDiagnosticsPage = lazy(() => import("@/pages/ProviderDiagnosticsPage"));
const TasksPage = lazy(() => import("@/pages/TasksPage"));
const SecurityPage = lazy(() => import("@/pages/SecurityPage"));
const MetricsPage = lazy(() => import("@/pages/MetricsPage"));
const SelftestPage = lazy(() => import("@/pages/SelftestPage"));
const ApiCreditsPage = lazy(() => import("@/pages/ApiCreditsPage"));
const DevJobsPage = lazy(() => import("@/pages/DevJobsPage"));
const TerritoriPage = lazy(() => import("@/pages/TerritoriPage"));
const MicrozoneFase1Page = lazy(() => import("@/pages/MicrozoneFase1Page"));
const ChecklistMicrozonaEsempioPage = lazy(() => import("@/pages/ChecklistMicrozonaEsempioPage"));
const OpportunitaPilotaPage = lazy(() => import("@/pages/OpportunitaPilotaPage"));
const DossierAgenziaPage = lazy(() => import("@/pages/DossierAgenziaPage"));
const SintesiProprietarioPage = lazy(() => import("@/pages/SintesiProprietarioPage"));
const DataEnginePage = lazy(() => import("@/pages/DataEnginePage"));
const SourceRegistryPage = lazy(() => import("@/pages/SourceRegistryPage"));
const AdminAggiornaPadovaPage = lazy(() => import("@/pages/AdminAggiornaPadovaPage"));
const CronHealthPage = lazy(() => import("@/pages/CronHealthPage"));

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthGate>
          <SidebarProvider>
            <div className="min-h-screen flex w-full">
              <div className="hidden md:block">
                <AdminSidebar />
              </div>
              <div className="flex-1 flex flex-col min-w-0">
                <header className="h-12 flex items-center border-b px-4 shrink-0 gap-2">
                  <div className="hidden md:block">
                    <SidebarTrigger />
                  </div>
                  <div className="md:hidden">
                    <Sheet>
                      <SheetTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <Menu className="h-5 w-5" />
                        </Button>
                      </SheetTrigger>
                      <SheetContent side="left" className="p-0 w-64">
                        <AdminSidebar />
                      </SheetContent>
                    </Sheet>
                  </div>
                  <span className="font-semibold md:hidden">Central Core V3</span>
                </header>
                <main className="flex-1 p-4 md:p-6 overflow-auto min-w-0">
                  <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/apps" element={<AppsPage />} />
                    <Route path="/providers" element={<ProvidersPage />} />
                    <Route path="/provider-diagnostics" element={<ProviderDiagnosticsPage />} />
                    <Route path="/tasks" element={<TasksPage />} />
                    <Route path="/security" element={<SecurityPage />} />
                    <Route path="/metrics" element={<MetricsPage />} />
                    <Route path="/selftest" element={<SelftestPage />} />
                    <Route path="/api-credits" element={<ApiCreditsPage />} />
                    <Route path="/dev/jobs" element={<DevJobsPage />} />
                    <Route path="/territori" element={<TerritoriPage />} />
                    <Route path="/microzone-fase-1" element={<MicrozoneFase1Page />} />
                    <Route path="/checklist-microzona-esempio" element={<ChecklistMicrozonaEsempioPage />} />
                    <Route path="/test-reale-arcella" element={<Navigate to="/checklist-microzona-esempio" replace />} />
                    <Route path="/opportunita-pilota" element={<OpportunitaPilotaPage />} />
                    <Route path="/dossier-agenzia" element={<DossierAgenziaPage />} />
                    <Route path="/sintesi-proprietario" element={<SintesiProprietarioPage />} />
                    <Route path="/data-engine" element={<DataEnginePage />} />
                    <Route path="/source-registry" element={<SourceRegistryPage />} />
                    <Route path="/admin/aggiorna-padova" element={<AdminAggiornaPadovaPage />} />
                    <Route path="/admin/cron-health" element={<CronHealthPage />} />
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
