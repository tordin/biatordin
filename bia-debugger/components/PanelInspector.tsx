import { motion } from "framer-motion"
import { useDebugger } from "@/contexts/DebuggerContext"
import { cn } from "@/lib/utils"
import { ArrowLeft, Box, Terminal, Database, Cpu, ChevronDown, ChevronRight, Send } from "lucide-react"
import { JsonView, defaultStyles } from "react-json-view-lite"
import "react-json-view-lite/dist/index.css"
import { useState } from "react"

// ── Collapsible block for the System prompt ──────────────────────────────────
function SystemBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded-md overflow-hidden min-w-0">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 bg-muted hover:bg-muted/80 transition-colors text-left min-w-0"
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <span className="text-[10px] font-bold uppercase text-muted-foreground shrink-0">System</span>
        {!open && (
          <span className="text-[10px] font-mono text-muted-foreground/70 truncate ml-1 min-w-0">
            {content.slice(0, 80).replace(/\n/g, ' ')}…
          </span>
        )}
      </button>
      {open && (
        <pre className="text-[10px] font-mono bg-muted/40 text-foreground p-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-h-[400px] overflow-y-auto">
          {content}
        </pre>
      )}
    </div>
  );
}

// ── LLM Input section: renders messages grouped by role ──────────────────────
function LlmInputSection({ messages }: { messages: any[] }) {
  if (!messages || messages.length === 0) return null;

  // Normalise: LangChain can send arrays of message objects (role/content)
  // or nested arrays from ChatModel. Flatten one level if needed.
  const flat: any[] = Array.isArray(messages[0]) ? messages.flat() : messages;

  return (
    <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm min-w-0">
      <div className="bg-muted px-3 py-2 border-b border-border text-xs font-semibold flex items-center gap-2">
        <Box className="w-3.5 h-3.5 shrink-0" />
        Input do Modelo
      </div>
      <div className="p-3 space-y-2 min-w-0">
        {flat.map((msg: any, idx: number) => {
          // Normalise role
          const role: string =
            msg.role ||
            (msg.type === 'human' || msg.id?.includes('HumanMessage') ? 'user' :
             msg.type === 'system' || msg.id?.includes('SystemMessage') ? 'system' :
             msg.type === 'ai'    || msg.id?.includes('AIMessage')    ? 'assistant' : 'unknown');

          const content: string =
            typeof msg.content === 'string'
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? JSON.stringify(c))).join('\n')
                : JSON.stringify(msg.content ?? '');

          const normalised = role.toLowerCase();

          if (normalised === 'system') {
            return <SystemBlock key={idx} content={content} />;
          }

          if (normalised === 'user' || normalised === 'human') {
            return (
              <div key={idx} className="border border-blue-200 rounded-md overflow-hidden min-w-0">
                <div className="px-2 py-1 bg-blue-50 text-[10px] font-bold uppercase text-blue-700">Human</div>
                <pre className="text-[10px] font-mono bg-blue-50/50 text-blue-900 p-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-h-[300px] overflow-y-auto">
                  {content}
                </pre>
              </div>
            );
          }

          if (normalised === 'assistant' || normalised === 'ai') {
            return (
              <div key={idx} className="border border-purple-200 rounded-md overflow-hidden min-w-0">
                <div className="px-2 py-1 bg-purple-50 text-[10px] font-bold uppercase text-purple-700">AI</div>
                <pre className="text-[10px] font-mono bg-purple-50/50 text-purple-900 p-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-h-[300px] overflow-y-auto">
                  {content}
                </pre>
              </div>
            );
          }

          // Fallback for unknown roles
          return (
            <div key={idx} className="border border-border rounded-md overflow-hidden min-w-0">
              <div className="px-2 py-1 bg-muted text-[10px] font-bold uppercase text-muted-foreground">{role}</div>
              <pre className="text-[10px] font-mono bg-muted/30 p-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-h-[200px] overflow-y-auto">
                {content}
              </pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function PanelInspector({ nodeId, onClose }: { nodeId: string, onClose: () => void }) {
  const { inspectors, traces, messages } = useDebugger();
  const inspectorData = inspectors[nodeId] || {
    context: "Carregando...",
    memory: "Carregando...",
    agentState: {},
    modelOutput: {},
    logs: "Carregando..."
  };

  let nodeTitle = "Inspetor de Nó";
  let isLlmStep = false;
  let isToolStep = false;
  let isOutputStep = false;
  let nodeTools: any[] = [];
  let fallbackOutboundText = "";
  let fallbackRecipient = "";

  for (const [runId, traceList] of Object.entries(traces)) {
    const node = traceList.find(n => n.id === nodeId);
    if (node) {
      nodeTitle = node.title;
      isLlmStep = !!node.isLlmStep;
      isToolStep = !!node.isToolStep;
      isOutputStep = node.type === 'output' || node.title === 'Envio de Mensagem' || node.title.toLowerCase().includes('saída');
      nodeTools = node.tools ? [...node.tools] : [];
      if (node.toolDetails) nodeTools.push(node.toolDetails);

      if (isOutputStep) {
        const matchedMsg = Object.values(messages).flat().find(m => m.runId === runId && m.sender === 'bia' && !m.isSilent);
        if (matchedMsg) {
          fallbackOutboundText = matchedMsg.text;
          fallbackRecipient = matchedMsg.chatId;
        } else if (node.subtitle) {
          fallbackOutboundText = node.subtitle;
        }
      }
    }
  }

  const outboundText = inspectorData.outboundText || inspectorData.agentState?.text || fallbackOutboundText;
  const recipient = inspectorData.recipient || inspectorData.chatId || fallbackRecipient;

  const hasAgentState = inspectorData.agentState && Object.keys(inspectorData.agentState).length > 0;
  const hasModelOutput = inspectorData.modelOutput && Object.keys(inspectorData.modelOutput).length > 0;
  const hasLlmMessages = inspectorData.llmMessages && Array.isArray(inspectorData.llmMessages) && inspectorData.llmMessages.length > 0;
  const hasLogs = inspectorData.logs && inspectorData.logs !== "N/A" && inspectorData.logs !== "Carregando...";

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 600, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", bounce: 0, duration: 0.4 }}
      className="shrink-0 bg-white border-l border-border h-full flex flex-col relative z-30 shadow-2xl overflow-hidden"
    >
      <div className="w-[600px] h-full flex flex-col min-w-0">
        <div className="p-4 border-b border-border flex items-center gap-3 bg-muted/30 shrink-0">
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-muted rounded-md border border-border bg-white shadow-sm transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-sm truncate">Detalhes: {nodeTitle}</h2>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-4 min-w-0">

          {/* ── LLM step: clean Input + Output ── */}
          {isLlmStep && (
            <>
              {hasLlmMessages && (
                <LlmInputSection messages={inspectorData.llmMessages} />
              )}

              {hasModelOutput && (
                <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm min-w-0">
                  <div className="bg-muted px-3 py-2 border-b border-border text-xs font-semibold flex items-center gap-2">
                    <Cpu className="w-3.5 h-3.5 shrink-0" />
                    Resposta do Modelo
                  </div>
                  <div className="p-3 overflow-x-auto text-[11px] max-w-full">
                    <JsonView data={inspectorData.modelOutput} shouldExpandNode={() => true} style={defaultStyles} />
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Non-LLM steps ── */}
          {!isLlmStep && (
            <>
              {/* ── Output / Message Send step ── */}
              {isOutputStep && (
                <div className="bg-white border border-emerald-200 rounded-lg overflow-hidden shadow-sm min-w-0">
                  <div className="bg-emerald-50 px-3 py-2 border-b border-emerald-200 text-xs font-semibold text-emerald-900 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Send className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                      <span>Mensagem Enviada ao Usuário</span>
                    </div>
                    {recipient && (
                      <span className="text-[10px] font-mono text-emerald-700 bg-emerald-100/80 px-2 py-0.5 rounded border border-emerald-200 truncate max-w-[220px]">
                        Para: {recipient}
                      </span>
                    )}
                  </div>
                  <div className="p-3 space-y-3 min-w-0">
                    <div className="border border-emerald-200/80 rounded-md bg-emerald-50/20 p-3 min-w-0">
                      <div className="text-[10px] font-bold text-emerald-800 uppercase mb-1.5 flex items-center justify-between">
                        <span>Texto Enviado (Conteúdo Final)</span>
                        {inspectorData.accountName && (
                          <span className="text-[9px] font-normal lowercase text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                            via {inspectorData.accountName}
                          </span>
                        )}
                      </div>
                      <pre className="text-xs font-sans text-slate-800 bg-white p-3 rounded-md border border-emerald-200/60 whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed shadow-inner max-h-[400px] overflow-y-auto">
                        {outboundText || "Mensagem enviada com sucesso."}
                      </pre>
                    </div>
                  </div>
                </div>
              )}

              {hasAgentState && (
                <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm min-w-0">
                  <div className="bg-muted px-3 py-2 border-b border-border text-xs font-semibold flex items-center gap-2">
                    <Database className="w-3.5 h-3.5 shrink-0" />
                    Estado
                  </div>
                  <div className="p-3 overflow-x-auto text-[11px] max-w-full">
                    <JsonView data={inspectorData.agentState} shouldExpandNode={() => true} style={defaultStyles} />
                  </div>
                </div>
              )}

              {nodeTools && nodeTools.length > 0 && (
                <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm min-w-0">
                  <div className="bg-orange-50 text-orange-900 px-3 py-2 border-b border-orange-200 text-xs font-semibold flex items-center gap-2">
                    <Box className="w-3.5 h-3.5 text-orange-600 shrink-0" />
                    Invocação de Ferramentas &amp; RAW Output ({nodeTools.length})
                  </div>
                  <div className="p-3 space-y-3 min-w-0">
                    {nodeTools.map((tool, idx) => (
                      <div key={idx} className="border border-border rounded-md p-3 bg-muted/30 space-y-2 min-w-0 overflow-hidden">
                        <div className="font-semibold text-xs text-orange-700 flex items-center gap-1.5 truncate">
                          🔧 {tool.name}
                        </div>
                        <div>
                          <div className="text-[10px] font-bold text-muted-foreground uppercase mb-1">Payload de Entrada (Arguments)</div>
                          <pre className="text-[10px] font-mono bg-white p-2 rounded border border-border whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-h-[200px] overflow-y-auto">
                            {tool.input}
                          </pre>
                        </div>
                        <div>
                          <div className="text-[10px] font-bold text-muted-foreground uppercase mb-1">Resposta Bruta (&lt;RAW_TOOL_OUTPUT&gt;)</div>
                          <pre className="text-[10px] font-mono bg-slate-900 text-emerald-400 p-2 rounded border border-border whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-h-[300px] overflow-y-auto">
                            {tool.rawOutput}
                          </pre>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {hasModelOutput && (
                <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm min-w-0">
                  <div className="bg-muted px-3 py-2 border-b border-border text-xs font-semibold flex items-center gap-2">
                    <Cpu className="w-3.5 h-3.5 shrink-0" />
                    Decisão Estruturada do Agente
                  </div>
                  <div className="p-3 overflow-x-auto text-[11px] max-w-full">
                    <JsonView data={inspectorData.modelOutput} shouldExpandNode={() => true} style={defaultStyles} />
                  </div>
                </div>
              )}

              {hasLogs && (
                <div className="bg-[#1e1e1e] border border-border rounded-lg overflow-hidden shadow-sm text-gray-300 min-w-0">
                  <div className="bg-[#2d2d2d] px-3 py-2 border-b border-[#3d3d3d] text-xs font-semibold flex items-center gap-2">
                    <Terminal className="w-3.5 h-3.5 shrink-0" />
                    Console Logs
                  </div>
                  <pre className="p-3 text-[10px] font-mono whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-h-[300px] overflow-y-auto">
                    {inspectorData.logs}
                  </pre>
                </div>
              )}
            </>
          )}

        </div>
      </div>
    </motion.div>
  )
}
