import { useEffect, useRef } from "react"
import { useDebugger } from "@/contexts/DebuggerContext"
import { cn } from "@/lib/utils"
import { Terminal, Clock, ShieldAlert, Zap, Target, VolumeX } from "lucide-react"

export function PanelChat({ chatId, onOpenTrace, traceOpen }: { chatId: string, onOpenTrace: (runId: string) => void, traceOpen: boolean }) {
  const { messages: allMessages } = useDebugger();
  const messages = allMessages[chatId] || [];
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chatId, messages]);

  // Enforcing a responsive minimum width but flexible otherwise.
  return (
    <div className="flex-1 flex flex-col h-full bg-[#EFEAE2] min-w-[300px] relative">
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
          const isSystem = msg.sender === 'system' || msg.isCron || msg.isMission;

          if (msg.isError) {
            return (
              <div key={msg.id} className="flex flex-col ml-auto items-end max-w-[75%] z-10 my-2">
                <button
                  onClick={() => msg.runId && onOpenTrace(msg.runId)}
                  className="text-xs px-3 py-1.5 rounded-full border flex items-center gap-2 shadow-sm transition-all hover:scale-105 active:scale-95 cursor-pointer bg-red-50 text-red-600 border-red-200 hover:bg-red-100"
                  title="Clique para ver os detalhes da execução (Trace)"
                >
                  <ShieldAlert className="w-3 h-3" />
                  {msg.text}
                </button>
              </div>
            );
          }

          if (msg.isSilent) {
            return (
              <div key={msg.id} className="flex flex-col ml-auto items-end max-w-[80%] z-10 my-2">
                <div
                  onClick={msg.runId ? () => onOpenTrace(msg.runId!) : undefined}
                  className={cn(
                    "relative group px-4 py-3 rounded-2xl shadow-sm text-sm z-10 text-left transition-all duration-200 border",
                    "bg-[#f8fafc] border-slate-200/90 text-slate-800",
                    msg.runId && "cursor-pointer hover:shadow-md hover:-translate-y-[1px] active:scale-[0.99]"
                  )}
                  title={msg.runId ? "Clique para ver os detalhes da execução (Trace)" : undefined}
                >
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-md border flex items-center gap-1.5 bg-slate-100 text-slate-600 border-slate-200">
                      <VolumeX className="w-3 h-3 text-slate-500" />
                      Silêncio
                    </span>
                    <span className="text-[10px] text-muted-foreground">{msg.time}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-xs text-slate-600 leading-relaxed italic">
                    {msg.silenceReason ? msg.silenceReason : "Bia avaliou a mensagem e decidiu não responder."}
                  </p>
                  <div className="flex items-center justify-between mt-2 pt-1 border-t border-black/5 text-[10px] text-muted-foreground">
                    <span>Decisão da Supervisora</span>
                    {msg.runId && <span className="text-primary group-hover:underline">Ver Trace →</span>}
                  </div>
                </div>
              </div>
            );
          }

          if (isSystem) {
            const isRoutine = msg.isCron || msg.triggerType === 'cron_routine';
            const isMission = msg.isMission || msg.triggerType === 'mission';
            
            const title = isRoutine 
              ? `Rotina Agendada${msg.routineId ? ` #${msg.routineId}` : ''}`
              : isMission 
              ? 'Missão Autônoma'
              : 'Gatilho de Sistema';

            const icon = isRoutine 
              ? <Clock className="w-3 h-3 text-amber-600" />
              : isMission 
              ? <Target className="w-3 h-3 text-purple-600" />
              : <Terminal className="w-3 h-3 text-blue-600" />;

            const badgeBg = isRoutine 
              ? 'bg-amber-50 text-amber-800 border-amber-200'
              : isMission 
              ? 'bg-purple-50 text-purple-800 border-purple-200'
              : 'bg-blue-50 text-blue-800 border-blue-200';

            const cardStyle = isRoutine 
              ? 'border-amber-200/80 bg-[#fefbf6] text-amber-950'
              : isMission 
              ? 'border-purple-200/80 bg-[#fbf8fe] text-purple-950'
              : 'border-slate-200/80 bg-slate-50 text-slate-900';

            return (
              <div key={msg.id} className="flex flex-col max-w-[80%] mr-auto items-start my-1">
                <div 
                  onClick={msg.runId ? () => onOpenTrace(msg.runId!) : undefined}
                  className={cn(
                    "relative group px-4 py-3 rounded-2xl shadow-sm text-sm z-10 text-left transition-all duration-200 border",
                    cardStyle,
                    msg.runId && "cursor-pointer hover:shadow-md hover:-translate-y-[1px] active:scale-[0.99]"
                  )}
                  title={msg.runId ? "Clique para ver os detalhes da execução (Trace)" : undefined}
                >
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className={cn("text-[10px] uppercase font-bold px-2 py-0.5 rounded-md border flex items-center gap-1.5", badgeBg)}>
                      {icon}
                      {title}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-normal leading-relaxed">{msg.text}</p>
                  <div className="flex items-center justify-between mt-2 pt-1 border-t border-black/5 text-[10px] text-muted-foreground">
                    <span>Disparo do sistema</span>
                    <span>{msg.time}</span>
                  </div>
                </div>
              </div>
            );
          }

          return (
            <div key={msg.id} className={cn("flex flex-col max-w-[75%]", isBia ? "ml-auto items-end" : "mr-auto items-start")}>
              <div 
                onClick={msg.runId ? () => onOpenTrace(msg.runId!) : undefined}
                className={cn(
                  "relative group px-4 py-2 rounded-2xl shadow-sm text-sm z-10 text-left transition-all duration-200",
                  isBia ? "bg-white border-l-4 border-primary rounded-tr-none" : "bg-[#dcf8c6] rounded-tl-none",
                  msg.runId && "cursor-pointer hover:shadow-md hover:-translate-y-[1px] active:scale-[0.99] active:translate-y-0"
                )}
                title={msg.runId ? "Clique para ver os detalhes da execução (Trace)" : undefined}
              >
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{msg.text}</p>
                <span className="text-[10px] text-muted-foreground float-right mt-2 ml-4">{msg.time}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
