import { useDebugger } from "@/contexts/DebuggerContext"
import { cn } from "@/lib/utils"
import { Search, MessageSquare, Shield, Clock } from "lucide-react"

export function PanelSidebar({ selectedId, onSelect }: { selectedId: string, onSelect: (id: string) => void }) {
  const { chats } = useDebugger()

  return (
    <div className="w-[320px] shrink-0 border-r border-border bg-muted/30 flex flex-col h-full">
      <div className="p-4 border-b border-border font-semibold text-sm">
        Conversas recentes
      </div>
      <div className="overflow-y-auto flex-1">
        {chats.map(chat => (
          <button
            key={chat.id}
            onClick={() => onSelect(chat.id)}
            className={cn(
              "w-full text-left p-4 border-b border-border/50 hover:bg-muted transition-colors flex gap-3",
              selectedId === chat.id && "bg-white dark:bg-muted shadow-sm"
            )}
          >
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0 text-primary font-semibold">
              {chat.name.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex justify-between items-baseline mb-1">
                <span className="font-medium text-sm truncate">{chat.name}</span>
                <span className="text-xs text-muted-foreground">{chat.time}</span>
              </div>
              <p className="text-xs text-muted-foreground truncate">{chat.lastMessage}</p>
            </div>
            {chat.unread > 0 && (
              <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold mt-1">
                {chat.unread}
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
