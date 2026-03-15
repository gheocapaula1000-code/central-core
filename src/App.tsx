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
import MetricsPage from "@/pages/MetricsPage";
import SelftestPage from "@/pages/SelftestPage";
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
                  <Route path="/metrics" element={<MetricsPage />} />
                  <Route path="/selftest" element={<SelftestPage />} />
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
