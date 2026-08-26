import { useDebugger } from "@/contexts/DebuggerContext"
import { Bug, Activity, Zap, ShieldAlert, Cpu, ChevronRight } from "lucide-react"

export function Topbar({ chatId, runId, nodeId }: { chatId: string | null, runId: string | null, nodeId: string | null }) {
  const { connected, chats, traces } = useDebugger();
  const chat = chats.find(c => c.id === chatId)
  const allNodes = Object.values(traces).flat()
  const node = allNodes.find(n => n.id === nodeId)

  return (
    <header className="h-14 border-b border-border bg-background flex items-center px-4 shrink-0 justify-between z-50">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 font-semibold text-lg">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
          Bia
        </div>
        
        {chat && (
          <>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{chat.name}</span>
          </>
        )}
        
        {runId && (
          <>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground font-mono">
              {runId.startsWith('DIR_') ? `Notificação #${runId.slice(4)}` : runId.startsWith('outbound-') ? `Notificação #${runId.slice(9, 17)}` : `Run #${runId}`}
            </span>
          </>
        )}

        {nodeId && node && (
          <>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">{node.title}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted px-2 py-1 rounded-md border border-border">
        <Activity className="w-4 h-4 text-green-500" />
        <span>Live</span>
      </div>
    </header>
  )
}
