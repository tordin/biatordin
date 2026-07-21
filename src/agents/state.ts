import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";

export interface ContextData {
  executionLog?: string[];
  activePlan?: string[];
  newExecution?: string;
  lastError?: string;
  lastInteractionTimestamp?: number;
  isTrustedChat?: boolean;
  chatJid?: string;
  chatName?: string;
  senderJid?: string;
  senderName?: string;
  masterNumber?: string;
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
      
      return newState;
    },
    default: () => ({ executionLog: [] }),
  }),
});
