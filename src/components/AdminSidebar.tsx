import {
  LayoutDashboard,
  Smartphone,
  Bot,
  ClipboardList,
  KeyRound,
  BarChart3,
  ShieldCheck,
  Wallet,
  MapPin,
  Target,
  Briefcase,
  BookOpen,
  Layers,
  FlaskConical,
  Database,
  Activity,
  Radar,
  Gem,
  Flag,
  Archive,
} from "lucide-react";
import coreIcon from "@/assets/core-icon.png";
import { NavLink } from "@/components/NavLink";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";

type Item = { title: string; url: string; icon: typeof LayoutDashboard };

const coreOps: Item[] = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "App Collegate", url: "/apps", icon: Smartphone },
  { title: "Provider Operativi", url: "/providers", icon: Bot },
  { title: "Diagnostica Provider", url: "/provider-diagnostics", icon: Activity },
  { title: "Chiavi & Sicurezza", url: "/security", icon: KeyRound },
  { title: "Metrics", url: "/metrics", icon: BarChart3 },
  { title: "Self-Test", url: "/selftest", icon: ShieldCheck },
  { title: "Centro Crediti API", url: "/api-credits", icon: Wallet },
  { title: "Jobs Dev", url: "/dev/jobs", icon: ClipboardList },
  { title: "Task Registry (legacy)", url: "/tasks", icon: ClipboardList },
];

// Active products. Product-specific internal pages would be grouped here.
// Currently none of the in-app pages are AcquisitionRadar/Wyloni/LuxuRadar-specific
// (those products live as Core endpoints / external PWAs), so each group exposes
// only the Apps entry as anchor + diagnostics.
const acquisitionRadar: Item[] = [
  { title: "AcquisitionRadar", url: "/apps", icon: Radar },
];
const wyloni: Item[] = [
  { title: "Wyloni", url: "/apps", icon: Flag },
];
const luxuRadar: Item[] = [
  { title: "LuxuRadar", url: "/apps", icon: Gem },
];

// Civiko One / KeyDraft / Sottra / Veneto Prestige / Regiads / Deep Source Core
// pages — kept reachable, grouped under Archive.
const archive: Item[] = [
  { title: "Territori", url: "/territori", icon: MapPin },
  { title: "Microzone Fase 1", url: "/microzone-fase-1", icon: Layers },
  { title: "Checklist Microzona (esempio)", url: "/checklist-microzona-esempio", icon: FlaskConical },
  { title: "Opportunità Pilota", url: "/opportunita-pilota", icon: Target },
  { title: "Dossier Agenzia", url: "/dossier-agenzia", icon: Briefcase },
  { title: "Sintesi Proprietario", url: "/sintesi-proprietario", icon: BookOpen },
  { title: "Motore Dati (Pilota PD)", url: "/data-engine", icon: Database },
  { title: "Source Registry Padova", url: "/source-registry", icon: Database },
];

function Group({ label, items, collapsed, muted }: { label: string; items: Item[]; collapsed: boolean; muted?: boolean }) {
  return (
    <SidebarGroup>
      {!collapsed && (
        <SidebarGroupLabel className={muted ? "text-muted-foreground/60" : undefined}>
          {label}
        </SidebarGroupLabel>
      )}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title + item.url}>
              <SidebarMenuButton asChild>
                <NavLink
                  to={item.url}
                  end
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors hover:bg-sidebar-accent ${
                    muted ? "text-sidebar-foreground/60" : "text-sidebar-foreground"
                  }`}
                  activeClassName="bg-sidebar-accent text-violet-400 font-medium"
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {!collapsed && <span className="text-sm">{item.title}</span>}
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AdminSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";

  return (
    <Sidebar collapsible="icon" className="border-r border-border">
      <SidebarContent>
        <div className="flex items-center gap-2 px-4 py-5">
          <img src={coreIcon} alt="Central Core" className="h-7 w-7 rounded shrink-0" />
          {!collapsed && (
            <span className="font-bold text-lg tracking-tight text-foreground">Core V3</span>
          )}
        </div>

        <Group label="Core Operations" items={coreOps} collapsed={collapsed} />
        <Group label="AcquisitionRadar" items={acquisitionRadar} collapsed={collapsed} />
        <Group label="Wyloni" items={wyloni} collapsed={collapsed} />
        <Group label="LuxuRadar" items={luxuRadar} collapsed={collapsed} />

        {!collapsed && (
          <div className="px-4 pt-3 pb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground/70">
            <Archive className="h-3 w-3" />
            Archivio / Legacy
          </div>
        )}
        <Group label="Civiko One & altri" items={archive} collapsed={collapsed} muted />
      </SidebarContent>

      <SidebarFooter className="px-4 pb-4">
        {!collapsed && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-mono">v3.3.5</span>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
