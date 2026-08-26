import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface PlanStep {
  agent: string;
  task: string;
  status: PlanStepStatus;
}

export interface ContextData {
  executionLog?: string[];
  executedTools?: string[];
  activePlan?: (PlanStep | string)[];
  newExecution?: string;
  newExecutedTools?: string[];
  lastError?: string;
  lastInteractionTimestamp?: number;
  accountName?: string;
  topicId?: string;
  isGroup?: boolean;
  isTrustedChat?: boolean;
  chatJid?: string;
  chatName?: string;
  senderJid?: string;
  senderName?: string;
  masterNumber?: string;
  specialistTask?: string;
  evaluationAttempts?: number;
  evaluationFeedback?: string;
  proposedResponse?: string;
  silenceReason?: string;
  outputMessages?: { targetJid: string; message: string; accountName: string }[];
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
      
      // Se houver outputMessages, faz o append (array vazio = reset/limpeza)
      if (y && y.outputMessages) {
        if (y.outputMessages.length === 0) {
          newState.outputMessages = []; // Array vazio = reset intencional
        } else {
          newState.outputMessages = [...(x.outputMessages || []), ...y.outputMessages];
        }
      }
      
      return newState;
    },
    default: () => ({ executionLog: [], outputMessages: [] }),
  }),
});
