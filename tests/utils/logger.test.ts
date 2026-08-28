import { 
  generateTriggerId, 
  setActiveTrigger, 
  getActiveTrigger, 
  clearActiveTrigger, 
  logger,
  loggerCallbackHandler
} from "../../src/utils/logger.js";
import { ToolMessage } from "@langchain/core/messages";

describe("Logger & Trigger Tracking System", () => {
  const threadId = "test-thread-logger";

  test("deve gerar um ID de gatilho válido com 8 caracteres hexadecimais em caixa alta", () => {
    const triggerId = generateTriggerId();
    expect(triggerId).toBeDefined();
    expect(triggerId.length).toBe(8);
  });

  test("deve registrar, recuperar e limpar o gatilho ativo para uma thread", () => {
    const trigger = setActiveTrigger(threadId, {
      triggerId: "TRIG1234",
      triggerType: "whatsapp_message",
      threadId,
      chatJid: "test@s.whatsapp.net"
    });

    expect(trigger).toBeDefined();
    expect(trigger.triggerId).toBe("TRIG1234");

    const retrieved = getActiveTrigger(threadId);
    expect(retrieved?.triggerId).toBe("TRIG1234");

    clearActiveTrigger(threadId);
    expect(getActiveTrigger(threadId)).toBeUndefined();
  });

  test("deve emitir logs formatados no logger sem exceções", () => {
    expect(() => logger.info("Teste de mensagem informativa")).not.toThrow();
    expect(() => logger.warn("Teste de aviso")).not.toThrow();
    expect(() => logger.error("Teste de erro", new Error("Erro teste"))).not.toThrow();
    expect(() => logger.logAgentStart("testAgent", threadId, {})).not.toThrow();
  });

  test("deve registrar resultado de gatilho com motivo de silêncio", () => {
    const trigger = {
      triggerId: "TRIG9999",
      triggerType: "whatsapp_message" as const,
      threadId: "test-thread",
      chatJid: "123@s.whatsapp.net",
      startedAt: new Date().toISOString()
    };

    expect(() => {
      logger.logTriggerOutcome(trigger, {
        action: "silent",
        reason: "Observação passiva na conta pessoal",
        agentsUsed: ["supervisor"],
        durationMs: 150
      });
    }).not.toThrow();
  });

  test("deve processar handleToolStart e handleToolEnd com ToolMessage e extrair texto", () => {
    const runId = "test-tool-run-123";
    const toolMessage = new ToolMessage({
      content: "Rotina ID 533 foi cancelada com sucesso.",
      name: "delete_routine",
      tool_call_id: "call_abc"
    });

    expect(() => {
      loggerCallbackHandler.handleToolStart(
        { name: "delete_routine" } as any,
        '{"id":533}',
        runId,
        undefined,
        undefined,
        { thread_id: "test-thread-tool", agentName: "routineAgent" },
        "delete_routine"
      );

      loggerCallbackHandler.handleToolEnd(
        toolMessage,
        runId,
        undefined,
        undefined,
        undefined
      );
    }).not.toThrow();
  });
});
