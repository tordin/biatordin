import { SystemMessage, HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import { sanitizeMessagesForModel, cleanJsonString, buildRecencyAnchoredHistory } from "../../src/utils/sanitize.js";

describe('Sanitize Utility Functions', () => {
  it('should convert tool messages to system messages and remove intermediate AI tool calls/tags', () => {
    const input = [
      new SystemMessage("sys"),
      new HumanMessage("hello"),
      new AIMessage({ content: "thinking...", tool_calls: [{ name: "search", id: "1", args: {} }] }),
      new ToolMessage({ content: "results", tool_call_id: "1" }),
      new AIMessage({ content: "final answer <tool_calls> tag" }),
      new AIMessage({ content: "[SILENT]" }),
      new AIMessage({ content: "resposta AI" }),
      new AIMessage({ content: "resposta AI" }) // mensagem duplicada consecutiva
    ];
    
    const output = sanitizeMessagesForModel(input);
    expect(output.length).toBe(4);
    expect(output[0]).toBeInstanceOf(SystemMessage);
    expect(output[0].content).toBe("sys");
    expect(output[1]).toBeInstanceOf(HumanMessage);
    expect(output[1].content).toBe("hello");
    expect(output[2]).toBeInstanceOf(SystemMessage);
    expect(output[2].content).toContain("[RESULTADO DA FERRAMENTA]: results");
    expect(output[3]).toBeInstanceOf(AIMessage);
    expect(output[3].content).toBe("resposta AI");
  });

  it('deve limpar strings JSON com aspas curvas e fendas de blocos markdown', () => {
    const jsonWithFences = "```json\n{\n  \"key\": \"value\"\n}\n```";
    expect(cleanJsonString(jsonWithFences)).toBe('{ "key": "value" }');

    const jsonWithSmartQuotes = '“key”: ‘value’';
    expect(cleanJsonString(jsonWithSmartQuotes)).toContain('"key": \'value\'');
  });

  it('deve construir histórico ancorado por recência (buildRecencyAnchoredHistory)', () => {
    const msgs = [
      new HumanMessage("Primeira pergunta"),
      new AIMessage("Primeira resposta"),
      new HumanMessage("Pergunta atual")
    ];

    const singleMsg = [new HumanMessage("Apenas uma")];
    expect(buildRecencyAnchoredHistory(singleMsg).length).toBe(1);

    const anchored = buildRecencyAnchoredHistory(msgs, 12);
    expect(anchored.length).toBe(4); // 2 contexto + 1 marker + 1 atual
    expect(anchored[2].content).toContain("MENSAGEM(ÕES) ATUAL(IS) DO USUÁRIO");
  });
  it('should group adjacent human messages from the same sender within 10 minutes', () => {
    const input = [
      new HumanMessage({ content: "[17/08/2026, 10:40:31] msg1", name: "UserA" }),
      new HumanMessage({ content: "[17/08/2026, 10:45:00] msg2", name: "UserA" }),
      new HumanMessage({ content: "[17/08/2026, 10:55:01] msg3", name: "UserA" }), // > 10 min gap from msg2
      new HumanMessage({ content: "[17/08/2026, 10:56:00] msg4", name: "UserB" })  // different user
    ];
    
    const output = sanitizeMessagesForModel(input);
    expect(output.length).toBe(3);
    
    expect(output[0].content).toContain("msg1");
    expect(output[0].content).toContain("msg2");
    expect(output[1].content).toContain("msg3");
    expect(output[2].content).toContain("msg4");
  });
});
