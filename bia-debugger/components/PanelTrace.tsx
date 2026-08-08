import { motion } from "framer-motion"
import { useDebugger } from "@/contexts/DebuggerContext"
import { cn } from "@/lib/utils"
import { X, Wrench, Search, ChevronRight } from "lucide-react"

export function PanelTrace({ runId, onClose, onSelectNode, inspectorOpen }: { runId: string, onClose: () => void, onSelectNode: (nodeId: string) => void, inspectorOpen: boolean }) {
  const { traces, messages } = useDebugger();
  const traceNodes = traces[runId] || [];

  const matchedMessage = Object.values(messages).flat().find(m => m.runId === runId);
  const firstNode = traceNodes[0];
  const runTime = matchedMessage?.time 
    || (firstNode?.timestamp ? new Date(firstNode.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : firstNode?.time);

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 450, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", bounce: 0, duration: 0.4 }}
      className="shrink-0 bg-white border-l border-border h-full flex flex-col relative z-20 shadow-xl"
    >
      <div className="w-[450px] h-full flex flex-col">
        <div className="p-4 border-b border-border flex items-center justify-between bg-muted/30">
          <div>
            <h2 className="font-semibold text-sm">Rastro de Execução</h2>
            <p className="text-[10px] font-mono text-muted-foreground">
              Run #{runId} {runTime ? `• ${runTime}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-muted rounded-full transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 relative">
          {/* Vertical dashed line */}
          <div className="absolute top-6 bottom-6 left-[39px] w-0.5 border-l-2 border-dashed border-border z-0"></div>
          
          <div className="space-y-6 relative z-10">
            {traceNodes.map((node, idx) => (
              <div 
                key={node.id} 
                className="flex gap-4 cursor-pointer group"
                onClick={() => onSelectNode(node.id)}
              >
                <div className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center shrink-0 border-2 shadow-sm bg-white transition-transform group-hover:scale-110",
                  node.tint === 'green' ? 'border-[var(--tint-green-border)] text-green-600' : 
                  node.tint === 'purple' ? 'border-[var(--tint-purple-border)] text-purple-600' :
                  'border-[var(--tint-orange-border)] text-orange-600'
                )}>
                  {node.isToolStep || node.type === 'tool' ? (
                     <Wrench className="w-4 h-4" />
                  ) : (
                    <div className={cn(
                      "w-3 h-3 rounded-full",
                      node.tint === 'green' ? 'bg-[var(--tint-green-border)]' : 
                      node.tint === 'purple' ? 'bg-[var(--tint-purple-border)]' :
                      'bg-[var(--tint-orange-border)]'
                    )}></div>
                  )}
                </div>
                
                <div className="flex-1 min-w-0 pb-2">
                  <div className="bg-white border border-border shadow-sm rounded-lg p-3 group-hover:border-primary/30 transition-colors">
                    <div className="flex justify-between items-start">
                      <h3 className="text-sm font-semibold">{node.title}</h3>
                      <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                    {node.subtitle && (
                      <p className="text-xs text-muted-foreground mt-1">{node.subtitle}</p>
                    )}
                    
                    {node.tools && node.tools.map((tool, i) => (
                      <div key={i} className="mt-3 bg-muted rounded-md p-2 border border-border">
                        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-foreground mb-1">
                          <Wrench className="w-3 h-3 text-orange-500" />
                          {tool.name}
                        </div>
                        <div className="font-mono text-[9px] text-muted-foreground bg-white p-1 rounded border border-border mt-1">
                          {tool.input}
                        </div>
                        <div className="font-mono text-[9px] text-muted-foreground bg-white p-1 rounded border border-border mt-1 truncate">
                          {tool.rawOutput}
                        </div>
                      </div>
                    ))}
                    
                    {node.toolDetails && (
                      <div className="mt-3 bg-muted rounded-md p-2 border border-border">
                        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-foreground mb-1">
                          <Wrench className="w-3 h-3 text-blue-500" />
                          {node.toolDetails.name}
                        </div>
                        <div className="font-mono text-[9px] text-muted-foreground bg-white p-1 rounded border border-border mt-1">
                          {node.toolDetails.input}
                        </div>
                        <div className="font-mono text-[9px] text-muted-foreground bg-white p-1 rounded border border-border mt-1 truncate">
                          {node.toolDetails.rawOutput}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="p-3 border-t border-border bg-muted/50 text-[10px] font-mono text-muted-foreground flex justify-between">
          <span>Tempo: 4.2s</span>
          <span>Tokens: 3.4k</span>
        </div>
      </div>
    </motion.div>
  )
}
