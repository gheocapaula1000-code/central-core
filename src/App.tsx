import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AdminSidebar } from "@/components/AdminSidebar";
import Dashboard from "@/pages/Dashboard";
import AppsPage from "@/pages/AppsPage";
import ProvidersPage from "@/pages/ProvidersPage";
import TasksPage from "@/pages/TasksPage";
import SecurityPage from "@/pages/SecurityPage";
import MetricsPage from "@/pages/MetricsPage";
import SelftestPage from "@/pages/SelftestPage";
import ApiCreditsPage from "@/pages/ApiCreditsPage";
import DevJobsPage from "@/pages/DevJobsPage";
import TerritoriPage from "@/pages/TerritoriPage";
import OpportunitaPilotaPage from "@/pages/OpportunitaPilotaPage";
import DossierAgenziaPage from "@/pages/DossierAgenziaPage";
import SintesiProprietarioPage from "@/pages/SintesiProprietarioPage";
import NotFound from "@/pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
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
                  <Route path="/tasks" element={<TasksPage />} />
                  <Route path="/security" element={<SecurityPage />} />
                  <Route path="/metrics" element={<MetricsPage />} />
                  <Route path="/selftest" element={<SelftestPage />} />
                  <Route path="/api-credits" element={<ApiCreditsPage />} />
                  <Route path="/dev/jobs" element={<DevJobsPage />} />
                  <Route path="/territori" element={<TerritoriPage />} />
                  <Route path="/opportunita-pilota" element={<OpportunitaPilotaPage />} />
                  <Route path="/dossier-agenzia" element={<DossierAgenziaPage />} />
                  <Route path="/sintesi-proprietario" element={<SintesiProprietarioPage />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </main>
            </div>
          </div>
        </SidebarProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
