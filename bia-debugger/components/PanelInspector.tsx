import { motion } from "framer-motion"
import { useDebugger } from "@/contexts/DebuggerContext"
import { cn } from "@/lib/utils"
import { ArrowLeft, Box, Terminal, Database, Cpu } from "lucide-react"
import { JsonView, defaultStyles } from "react-json-view-lite"
import "react-json-view-lite/dist/index.css"

export function PanelInspector({ nodeId, onClose }: { nodeId: string, onClose: () => void }) {
  const { inspectors, traces } = useDebugger();
  const inspectorData = inspectors[nodeId] || { 
    context: "Carregando...", 
    memory: "Carregando...", 
    agentState: {}, 
    modelOutput: {}, 
    logs: "Carregando..." 
  };
  
  let nodeTitle = "Inspetor de Nó";
  let nodeType = "agent";
  let isLlmStep = false;
  let isToolStep = false;
  let nodeTools: any[] = [];
  for (const traceList of Object.values(traces)) {
    const node = traceList.find(n => n.id === nodeId);
    if (node) {
        nodeTitle = node.title;
        nodeType = node.type;
        isLlmStep = !!node.isLlmStep;
        isToolStep = !!node.isToolStep;
        nodeTools = node.tools ? [...node.tools] : [];
        if (node.toolDetails) {
            nodeTools.push(node.toolDetails);
        }
    }
  }

  const hasMemory = inspectorData.memory && inspectorData.memory !== "N/A" && inspectorData.memory !== "Carregando..." && inspectorData.memory !== "Aguardando inicialização do LLM...";
  const hasAgentState = inspectorData.agentState && Object.keys(inspectorData.agentState).length > 0;
  
  // Extract user message from agentState or llmMessages if possible
  let userMessage = null;
  const messagesSource = (hasAgentState && inspectorData.agentState.messages && Array.isArray(inspectorData.agentState.messages))
    ? inspectorData.agentState.messages
    : (inspectorData.llmMessages && Array.isArray(inspectorData.llmMessages) ? inspectorData.llmMessages : null);

  if (messagesSource) {
    const userMsg = messagesSource.slice().reverse().find((m: any) => m.role === 'user' || m.type === 'human' || m.id?.includes('HumanMessage'));
    if (userMsg) {
      userMessage = typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content);
    }
  }
  
  const hasModelOutput = inspectorData.modelOutput && Object.keys(inspectorData.modelOutput).length > 0;
  const hasLlmMessages = inspectorData.llmMessages && Array.isArray(inspectorData.llmMessages) && inspectorData.llmMessages.length > 0;
  const hasLogs = inspectorData.logs && inspectorData.logs !== "N/A" && inspectorData.logs !== "Carregando...";

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 600, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", bounce: 0, duration: 0.4 }}
      className="shrink-0 bg-white border-l border-border h-full flex flex-col relative z-30 shadow-2xl"
    >
      <div className="w-[600px] h-full flex flex-col">
        <div className="p-4 border-b border-border flex items-center gap-3 bg-muted/30">
          <button 
            onClick={onClose} 
            className="p-1.5 hover:bg-muted rounded-md border border-border bg-white shadow-sm transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h2 className="font-semibold text-sm">Detalhes: {nodeTitle}</h2>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          
          {(hasMemory || userMessage) && (
            <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
              <div className="bg-muted px-3 py-2 border-b border-border text-xs font-semibold flex items-center gap-2">
                <Box className="w-3.5 h-3.5" />
                Destaques (Gatilho e Memória)
              </div>
              <div className="p-3">
                {userMessage && (
                  <>
                    <div className="text-[10px] uppercase font-bold text-muted-foreground mb-1">Gatilho (Mensagem do Usuário)</div>
                    <pre className="text-[10px] font-mono bg-blue-50 text-blue-900 p-2 rounded border border-blue-200 whitespace-pre-wrap">
                      {userMessage}
                    </pre>
                  </>
                )}
                
                {hasMemory && (
                  <>
                    <div className={cn("text-[10px] uppercase font-bold text-muted-foreground mb-1", userMessage ? "mt-3" : "")}>Memória Core</div>
                    <pre className="text-[10px] font-mono bg-muted/50 p-2 rounded border border-border whitespace-pre-wrap">
                      {inspectorData.memory}
                    </pre>
                  </>
                )}
              </div>
            </div>
          )}

          {hasAgentState && (
            <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
              <div className="bg-muted px-3 py-2 border-b border-border text-xs font-semibold flex items-center gap-2">
                <Database className="w-3.5 h-3.5" />
                Estado
              </div>
              <div className="p-3 overflow-x-auto text-[11px]">
                <JsonView data={inspectorData.agentState} shouldExpandNode={() => true} style={defaultStyles} />
              </div>
            </div>
          )}

          {hasLlmMessages && (
            <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
              <div className="bg-muted px-3 py-2 border-b border-border text-xs font-semibold flex items-center gap-2">
                <Box className="w-3.5 h-3.5" />
                Enviado para o modelo
              </div>
              <div className="p-3 overflow-x-auto text-[11px]">
                <JsonView data={inspectorData.llmMessages} shouldExpandNode={(level: any) => (typeof level === 'number' ? level < 2 : (Array.isArray(level) ? level.length < 2 : true))} style={defaultStyles} />
              </div>
            </div>
          )}

          {nodeTools && nodeTools.length > 0 && (
            <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
              <div className="bg-orange-50 text-orange-900 px-3 py-2 border-b border-orange-200 text-xs font-semibold flex items-center gap-2">
                <Box className="w-3.5 h-3.5 text-orange-600" />
                Invocação de Ferramentas & RAW Output ({nodeTools.length})
              </div>
              <div className="p-3 space-y-3">
                {nodeTools.map((tool, idx) => (
                  <div key={idx} className="border border-border rounded-md p-3 bg-muted/30 space-y-2">
                    <div className="font-semibold text-xs text-orange-700 flex items-center gap-1.5">
                      🔧 {tool.name}
                    </div>
                    <div>
                      <div className="text-[10px] font-bold text-muted-foreground uppercase mb-1">Payload de Entrada (Arguments)</div>
                      <pre className="text-[10px] font-mono bg-white p-2 rounded border border-border overflow-x-auto">
                        {tool.input}
                      </pre>
                    </div>
                    <div>
                      <div className="text-[10px] font-bold text-muted-foreground uppercase mb-1">Resposta Bruta (&lt;RAW_TOOL_OUTPUT&gt;)</div>
                      <pre className="text-[10px] font-mono bg-slate-900 text-emerald-400 p-2 rounded border border-border overflow-x-auto whitespace-pre-wrap">
                        {tool.rawOutput}
                      </pre>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {hasModelOutput && (
            <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
              <div className="bg-muted px-3 py-2 border-b border-border text-xs font-semibold flex items-center gap-2">
                <Cpu className="w-3.5 h-3.5" />
                {isLlmStep ? 'Recebido do modelo (RAW JSON)' : 'Decisão Estruturada do Agente'}
              </div>
              <div className="p-3 overflow-x-auto text-[11px]">
                <JsonView data={inspectorData.modelOutput} shouldExpandNode={() => true} style={defaultStyles} />
              </div>
            </div>
          )}

          {hasLogs && (
            <div className="bg-[#1e1e1e] border border-border rounded-lg overflow-hidden shadow-sm text-gray-300">
              <div className="bg-[#2d2d2d] px-3 py-2 border-b border-[#3d3d3d] text-xs font-semibold flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5" />
                Console Logs
              </div>
              <pre className="p-3 text-[10px] font-mono whitespace-pre-wrap">
                {inspectorData.logs}
              </pre>
            </div>
          )}

        </div>
      </div>
    </motion.div>
  )
}
