import { useEffect, useRef } from "react"
import { useDebugger } from "@/contexts/DebuggerContext"
import { cn } from "@/lib/utils"
import { Terminal, Clock, Fingerprint, ShieldAlert, Zap } from "lucide-react"

export function PanelChat({ chatId, onOpenTrace, traceOpen }: { chatId: string, onOpenTrace: (runId: string) => void, traceOpen: boolean }) {
  const { messages: allMessages } = useDebugger();
  const messages = allMessages[chatId] || [];
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chatId, messages]);

  // Enforcing a minimum width of 400px but flexible otherwise.
  return (
    <div className="flex-1 flex flex-col h-full bg-[#EFEAE2] min-w-[400px] relative">
      {/* Chat Background Pattern placeholder */}
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#000 1px, transparent 1px)', backgroundSize: '20px 20px' }}></div>
      
      <div className="p-4 border-b bg-white border-border shadow-sm z-10 flex items-center justify-between">
        <div className="font-semibold text-sm flex items-center gap-2">
          Chat ao Vivo
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 z-10">
        {(allMessages[chatId] || []).map(msg => {
          const isBia = msg.sender === 'bia';

          if (msg.isSilent || msg.isError) {
            return (
              <div key={msg.id} className="flex flex-col ml-auto items-end max-w-[75%] z-10 my-2">
                <button
                  onClick={() => msg.runId && onOpenTrace(msg.runId)}
                  className={cn(
                    "text-xs px-3 py-1.5 rounded-full border flex items-center gap-2 shadow-sm transition-all hover:scale-105 active:scale-95 cursor-pointer",
                    msg.isError ? "bg-red-50 text-red-600 border-red-200 hover:bg-red-100" : "bg-white text-muted-foreground border-border hover:bg-muted"
                  )}
                  title="Clique para ver os detalhes da execução (Trace)"
                >
                  {msg.isError ? <ShieldAlert className="w-3 h-3" /> : <Zap className="w-3 h-3" />}
                  {msg.text}
                </button>
              </div>
            );
          }

          return (
            <div key={msg.id} className={cn("flex flex-col max-w-[75%]", isBia ? "ml-auto items-end" : "mr-auto items-start")}>
              {msg.isCron && (
                <div className="text-[10px] uppercase font-bold text-muted-foreground bg-white/80 px-2 py-0.5 rounded-t-md mb-[-4px] ml-2 z-0 border border-b-0 border-border">
                  Rotina Agendada
                </div>
              )}
              {msg.isMission && (
                <div className="text-[10px] uppercase font-bold text-purple-700 bg-purple-50 px-2 py-0.5 rounded-t-md mb-[-4px] ml-2 z-0 border border-b-0 border-purple-200">
                  Missão Autônoma (Target)
                </div>
              )}
              
              <div 
                onClick={msg.runId ? () => onOpenTrace(msg.runId!) : undefined}
                className={cn(
                  "relative group px-4 py-2 rounded-2xl shadow-sm text-sm z-10 text-left transition-all duration-200",
                  isBia ? "bg-white border-l-4 border-primary rounded-tr-none" : "bg-[#dcf8c6] rounded-tl-none",
                  msg.runId && "cursor-pointer hover:shadow-md hover:-translate-y-[1px] active:scale-[0.99] active:translate-y-0"
                )}
                title={msg.runId ? "Clique para ver os detalhes da execução (Trace)" : undefined}
              >
                <p className="whitespace-pre-wrap">{msg.text}</p>
                <span className="text-[10px] text-muted-foreground float-right mt-2 ml-4">{msg.time}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
