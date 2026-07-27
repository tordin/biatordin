import { agent, routeFromSupervisor, routeFromSpecialist } from "../../src/graph/workflow.js";

describe("LangGraph Workflow System & Routing Edges", () => {
  test("deve compilar o grafo principal sem erros", () => {
    expect(agent).toBeDefined();
    expect(typeof agent.invoke).toBe("function");
  });

  test("deve rotear corretamente a partir das decisões do supervisor", () => {
    expect(routeFromSupervisor({ nextAgent: "searchAgent" } as any)).toBe("searchAgent");
    expect(routeFromSupervisor({ nextAgent: "taskAgent" } as any)).toBe("taskAgent");
    expect(routeFromSupervisor({ nextAgent: "routineAgent" } as any)).toBe("routineAgent");
    expect(routeFromSupervisor({ nextAgent: "memoryAgent" } as any)).toBe("memoryAgent");
    expect(routeFromSupervisor({ nextAgent: "securityAgent" } as any)).toBe("securityAgent");
    expect(routeFromSupervisor({ nextAgent: "whatsappAgent" } as any)).toBe("whatsappAgent");
    expect(routeFromSupervisor({ nextAgent: "reasoningAgent" } as any)).toBe("reasoningAgent");
    expect(routeFromSupervisor({ nextAgent: "weatherAgent" } as any)).toBe("weatherAgent");
    expect(routeFromSupervisor({ nextAgent: "FINISH" } as any)).toBe("__end__");
  });

  test("deve rotear a partir de agentes especialistas de volta ao supervisor ou para __end__", () => {
    expect(routeFromSpecialist({ nextAgent: "FINISH" } as any)).toBe("__end__");
    expect(routeFromSpecialist({ nextAgent: "supervisor" } as any)).toBe("supervisor");
  });
});
