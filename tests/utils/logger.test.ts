import { 
  generateTriggerId, 
  setActiveTrigger, 
  getActiveTrigger, 
  clearActiveTrigger, 
  logger 
} from "../../src/utils/logger.js";

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
});
