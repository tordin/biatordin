import { SystemMessage, HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import { sanitizeMessagesForModel } from "../../src/utils/sanitize.js";

describe('Sanitize', () => {
  it('should convert tool messages to system messages and remove intermediate AI tool calls/tags', () => {
    const input = [
      new SystemMessage("sys"),
      new HumanMessage("hello"),
      new AIMessage({ content: "thinking...", tool_calls: [{ name: "search", id: "1", args: {} }] }),
      new ToolMessage({ content: "results", tool_call_id: "1" }),
      new AIMessage({ content: "final answer <｜｜DSML｜｜tool_calls> tag" })
    ];
    
    const output = sanitizeMessagesForModel(input);
    expect(output.length).toBe(3);
    expect(output[0]).toBeInstanceOf(SystemMessage);
    expect(output[0].content).toBe("sys");
    expect(output[1]).toBeInstanceOf(HumanMessage);
    expect(output[1].content).toBe("hello");
    expect(output[2]).toBeInstanceOf(SystemMessage);
    expect(output[2].content).toContain("[RESULTADO DA FERRAMENTA]: results");
  });
});
