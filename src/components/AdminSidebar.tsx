import { Cpu, LayoutDashboard, Smartphone, Bot, ClipboardList, KeyRound, BarChart3 } from "lucide-react";
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
  { title: "Providers AI", url: "/providers", icon: Bot },
  { title: "Task Registry", url: "/tasks", icon: ClipboardList },
  { title: "Chiavi & Sicurezza", url: "/security", icon: KeyRound },
  { title: "Logs", url: "#", icon: BarChart3, disabled: true },
];

export function AdminSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();

  return (
    <Sidebar collapsible="icon" className="border-r border-border">
      <SidebarContent>
        <div className="flex items-center gap-2 px-4 py-5">
          <Cpu className="h-6 w-6 text-violet-400 shrink-0" />
          {!collapsed && (
            <span className="font-bold text-lg tracking-tight text-foreground">
              Core v3
            </span>
          )}
        </div>

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild disabled={item.disabled}>
                    {item.disabled ? (
                      <div className="flex items-center gap-2 px-2 py-1.5 opacity-40 cursor-not-allowed">
                        <item.icon className="h-4 w-4 shrink-0" />
                        {!collapsed && (
                          <span className="flex items-center gap-2">
                            {item.title}
                            <span className="text-[10px] rounded bg-secondary px-1.5 py-0.5 text-muted-foreground">soon</span>
                          </span>
                        )}
                      </div>
                    ) : (
                      <NavLink
                        to={item.url}
                        end
                        className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                        activeClassName="bg-sidebar-accent text-violet-400 font-medium"
                      >
                        <item.icon className="h-4 w-4 shrink-0" />
                        {!collapsed && <span>{item.title}</span>}
                      </NavLink>
                    )}
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
            <span className="font-mono">v3.1.0</span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              ONLINE
            </span>
          </div>
        )}
        {collapsed && (
          <div className="flex justify-center">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
