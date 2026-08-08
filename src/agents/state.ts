import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";

export interface ContextData {
  executionLog?: string[];
  executedTools?: string[];
  activePlan?: string[];
  newExecution?: string;
  newExecutedTools?: string[];
  lastError?: string;
  lastInteractionTimestamp?: number;
  isTrustedChat?: boolean;
  chatJid?: string;
  chatName?: string;
  senderJid?: string;
  senderName?: string;
  masterNumber?: string;
  specialistTask?: string;
  [key: string]: any;
}

// 1. Extended State Definition
export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  nextAgent: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "supervisor",
  }),
  contextData: Annotation<ContextData>({
    reducer: (x, y) => {
      if (y && y.__reset) {
        const { __reset, ...rest } = y;
        return rest;
      }
      const newState = { ...x, ...y };
      
      // Se algum agente disparar uma nova execução, faz o append no log
      if (y && y.newExecution) {
        newState.executionLog = [...(x.executionLog || []), y.newExecution];
        delete newState.newExecution;
      }
      
      // Se ferramentas foram executadas na rodada, faz o append no log de ferramentas
      if (y && y.newExecutedTools) {
        newState.executedTools = [...(x.executedTools || []), ...y.newExecutedTools];
        delete newState.newExecutedTools;
      }
      
      return newState;
    },
    default: () => ({ executionLog: [] }),
  }),
});
