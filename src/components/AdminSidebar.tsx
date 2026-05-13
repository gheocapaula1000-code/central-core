import { LayoutDashboard, Smartphone, Bot, ClipboardList, KeyRound, BarChart3, ShieldCheck, Wallet, MapPin } from "lucide-react";
import coreIcon from "@/assets/core-icon.png";
import { NavLink } from "@/components/NavLink";
import { useLocation } from "react-router-dom";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";

const menuItems = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "App Collegate", url: "/apps", icon: Smartphone },
  { title: "Territori", url: "/territori", icon: MapPin },
  { title: "Provider Operativi", url: "/providers", icon: Bot },
  { title: "Chiavi & Sicurezza", url: "/security", icon: KeyRound },
  { title: "Metrics", url: "/metrics", icon: BarChart3 },
  { title: "Self-Test", url: "/selftest", icon: ShieldCheck },
  { title: "Centro Crediti API", url: "/api-credits", icon: Wallet },
  { title: "Task Registry (legacy)", url: "/tasks", icon: ClipboardList },
];

export function AdminSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const _location = useLocation();

  return (
    <Sidebar collapsible="icon" className="border-r border-border">
      <SidebarContent>
        <div className="flex items-center gap-2 px-4 py-5">
          <img src={coreIcon} alt="Central Core" className="h-7 w-7 rounded shrink-0" />
          {!collapsed && (
            <span className="font-bold text-lg tracking-tight text-foreground">
              Core V3
            </span>
          )}
        </div>

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild>
                    <NavLink
                      to={item.url}
                      end
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                      activeClassName="bg-sidebar-accent text-violet-400 font-medium"
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      {!collapsed && <span>{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
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
