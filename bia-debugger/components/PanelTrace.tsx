import { motion } from "framer-motion"
import { useDebugger } from "@/contexts/DebuggerContext"
import { cn } from "@/lib/utils"
import { X, Wrench, ChevronRight, AlertTriangle, Cpu, Sparkles, Send, CheckCircle2, ShieldCheck } from "lucide-react"

function NodeSubtitle({ subtitle, isTrigger }: { subtitle: string, isTrigger?: boolean }) {
  if (!isTrigger) {
    return <p className="text-xs text-muted-foreground mt-1 break-words [overflow-wrap:anywhere]">{subtitle}</p>;
  }

  return (
    <div 
      onClick={(e) => e.stopPropagation()}
      className="mt-1.5 text-xs text-muted-foreground max-h-16 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] select-text pr-1 font-mono text-[11px] bg-muted/40 p-1.5 rounded border border-border"
    >
      {subtitle}
    </div>
  );
}

export function PanelTrace({ runId, onClose, onSelectNode, inspectorOpen }: { runId: string, onClose: () => void, onSelectNode: (nodeId: string) => void, inspectorOpen: boolean }) {
  const { traces, messages } = useDebugger();
  const traceNodes = traces[runId] || [];

  const matchedMessage = Object.values(messages).flat().find(m => m.runId === runId);
  const firstNode = traceNodes[0];
  const runTime = matchedMessage?.time 
    || (firstNode?.timestamp ? new Date(firstNode.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : firstNode?.time);

  const toolsCount = traceNodes.filter(n => n.isToolStep || n.type === 'tool').length;
  const llmCount = traceNodes.filter(n => n.isLlmStep || n.type === 'supervisor' || n.type === 'agent' || n.type === 'evaluator').length;
  const errorCount = traceNodes.filter(n => n.isErrorStep || n.type === 'error' || n.tint === 'red').length;

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 460, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", bounce: 0, duration: 0.4 }}
      className="shrink-0 bg-white border-l border-border h-full flex flex-col relative z-20 shadow-xl overflow-hidden"
    >
      <div className="w-[460px] h-full flex flex-col min-w-0">
        <div className="p-4 border-b border-border flex items-center justify-between bg-muted/30 shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-sm">Rastro de Execução</h2>
            <p className="text-[10px] font-mono text-muted-foreground truncate">
              {runId.startsWith('DIR_') ? `Notificação #${runId.slice(4)}` : runId.startsWith('outbound-') ? `Notificação #${runId.slice(9, 17)}` : `Run #${runId}`} {runTime ? `• ${runTime}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-muted rounded-full transition-colors shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden p-6 relative min-w-0">
          {traceNodes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center p-4">
              <Sparkles className="w-8 h-8 text-muted-foreground/40 mb-2" />
              <p className="text-sm font-medium text-muted-foreground">Nenhum rastro registrado</p>
              <p className="text-xs text-muted-foreground/70 mt-1">Esta mensagem foi processada diretamente sem etapas intermediárias registradas.</p>
            </div>
          ) : (
            <>
              {/* Vertical dashed line */}
              <div className="absolute top-6 bottom-6 left-[39px] w-0.5 border-l-2 border-dashed border-border z-0"></div>
              
              <div className="space-y-5 relative z-10">
                {traceNodes.map((node, idx) => {
              const isError = node.isErrorStep || node.type === 'error' || node.tint === 'red';
              const isTool = node.isToolStep || node.type === 'tool';
              const isEvaluator = node.type === 'evaluator' || node.agentName === 'evaluator' || node.agentName === 'critic';
              const isLlm = node.isLlmStep || (!isTool && !isError && (node.type === 'supervisor' || node.type === 'agent' || node.type === 'evaluator'));
              const nodeModel = node.modelName || (isLlm ? (node.type === 'supervisor' ? 'gpt-5-nano' : 'deepseek-v4-flash') : undefined);

              return (
                <div 
                  key={node.id} 
                  className="flex gap-4 cursor-pointer group min-w-0"
                  onClick={() => onSelectNode(node.id)}
                >
                  <div className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center shrink-0 border-2 shadow-sm bg-white transition-transform group-hover:scale-110",
                    isError ? 'border-red-500 text-red-600 bg-red-50' :
                    node.tint === 'green' ? 'border-[var(--tint-green-border)] text-green-600' : 
                    node.tint === 'purple' ? 'border-[var(--tint-purple-border)] text-purple-600' :
                    node.tint === 'cyan' || isEvaluator ? 'border-cyan-500 text-cyan-600 bg-cyan-50/40' :
                    'border-[var(--tint-orange-border)] text-orange-600'
                  )}>
                    {isError ? (
                      <AlertTriangle className="w-4 h-4 text-red-600" />
                    ) : isTool ? (
                      <Wrench className="w-4 h-4" />
                    ) : isEvaluator ? (
                      <ShieldCheck className="w-4 h-4 text-cyan-600" />
                    ) : isLlm ? (
                      <Cpu className="w-4 h-4" />
                    ) : node.type === 'output' ? (
                      <Send className="w-3.5 h-3.5" />
                    ) : (
                      <Sparkles className="w-4 h-4" />
                    )}
                  </div>
                  
                  <div className="flex-1 min-w-0 pb-1">
                    <div className={cn(
                      "border shadow-sm rounded-lg p-3 group-hover:border-primary/40 transition-colors overflow-hidden min-w-0",
                      isError ? "bg-red-50/50 border-red-200" : "bg-white border-border"
                    )}>
                      <div className="flex justify-between items-start gap-2">
                        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                          <h3 className={cn("text-sm font-semibold truncate", isError && "text-red-700 font-bold")}>{node.title}</h3>
                          {node.agentName && node.agentName !== node.title && (
                            <span className="text-[10px] px-1.5 py-0.2 bg-muted rounded border border-border text-muted-foreground font-mono truncate">
                              {node.agentName}
                            </span>
                          )}
                          {nodeModel && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded border border-purple-200 font-mono font-medium flex items-center gap-1 shrink-0" title={`Modelo LLM: ${nodeModel}`}>
                              <Cpu className="w-2.5 h-2.5 shrink-0 text-purple-600" />
                              <span>{nodeModel}</span>
                            </span>
                          )}
                        </div>
                        <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                      </div>
                      
                      {node.subtitle && (
                        <NodeSubtitle subtitle={node.subtitle} isTrigger={node.type === 'trigger'} />
                      )}
                      
                      {node.tools && node.tools.map((tool, i) => (
                        <div key={i} className="mt-2.5 bg-muted/70 rounded-md p-2 border border-border overflow-hidden min-w-0">
                          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-foreground mb-1">
                            <Wrench className="w-3 h-3 text-orange-500 shrink-0" />
                            <span className="truncate">{tool.name}</span>
                          </div>
                          <div className="font-mono text-[9px] text-muted-foreground bg-white p-1 rounded border border-border mt-1 truncate" title={tool.input}>
                            {tool.input}
                          </div>
                          <div className="font-mono text-[9px] text-muted-foreground bg-white p-1 rounded border border-border mt-1 truncate" title={tool.rawOutput}>
                            {tool.rawOutput}
                          </div>
                        </div>
                      ))}
                      
                      {node.toolDetails && (() => {
                        const isToolErr = node.isErrorStep || node.tint === 'red' || (typeof node.toolDetails.rawOutput === 'string' && (node.toolDetails.rawOutput.startsWith('Error:') || node.toolDetails.rawOutput.includes('GOOGLE_REAUTH_REQUIRED')));
                        return (
                          <div className={cn("mt-2.5 rounded-md p-2 border overflow-hidden min-w-0", isToolErr ? "bg-red-50/60 border-red-200" : "bg-muted/70 border-border")}>
                            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-foreground mb-1">
                              <Wrench className={cn("w-3 h-3 shrink-0", isToolErr ? "text-red-500" : "text-blue-500")} />
                              <span className={cn("truncate", isToolErr && "text-red-700 font-bold")}>{node.toolDetails.name}</span>
                            </div>
                            <div className="font-mono text-[9px] text-muted-foreground bg-white p-1 rounded border border-border mt-1 truncate" title={node.toolDetails.input}>
                              {node.toolDetails.input}
                            </div>
                            <div className={cn("font-mono text-[9px] p-1 rounded border mt-1 truncate", isToolErr ? "bg-red-100/70 text-red-800 border-red-300 font-semibold" : "text-muted-foreground bg-white border-border")} title={node.toolDetails.rawOutput}>
                              {node.toolDetails.rawOutput}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
            </>
          )}
        </div>

        <div className="p-3 border-t border-border bg-muted/40 text-[11px] font-mono text-muted-foreground flex justify-between items-center shrink-0">
          <div className="flex gap-3 min-w-0 flex-wrap">
            <span>Passos: <b>{traceNodes.length}</b></span>
            <span>Tools: <b>{toolsCount}</b></span>
            <span>LLM: <b>{llmCount}</b></span>
          </div>
          {errorCount > 0 && (
            <span className="text-red-600 font-semibold flex items-center gap-1 shrink-0">
              <AlertTriangle className="w-3 h-3" /> {errorCount} {errorCount === 1 ? 'Alerta' : 'Alertas'}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  )
}
