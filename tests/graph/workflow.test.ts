import { agent, routeFromSupervisor, routeFromSpecialist, routeFromEvaluator } from "../../src/graph/workflow.js";

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
    expect(routeFromSupervisor({ nextAgent: "followUpAgent" } as any)).toBe("followUpAgent");

    // Cenário ativo onde especialistas foram executados: Roteia para evaluator
    expect(routeFromSupervisor({ nextAgent: "FINISH", contextData: { accountName: "main", proposedResponse: "Aqui está sua resposta", executionLog: ["weatherAgent"], executedTools: ["get_weather"] } } as any)).toBe("evaluator");

    // Cenário trivial sem chamadas a especialistas/ferramentas (ex: "oi bom dia"): Pula avaliador direto para outputGateway
    expect(routeFromSupervisor({ nextAgent: "FINISH", contextData: { accountName: "main", proposedResponse: "Bom dia!", executionLog: [], executedTools: [] } } as any)).toBe("outputGateway");

    // Cenário passivo (conta pessoal): Pula avaliador direto para outputGateway
    expect(routeFromSupervisor({ nextAgent: "FINISH", contextData: { accountName: "personal" } } as any)).toBe("outputGateway");

    // Resposta silenciosa ([SILENT]): Pula avaliador direto para outputGateway
    expect(routeFromSupervisor({ nextAgent: "FINISH", contextData: { accountName: "main", proposedResponse: "[SILENT]" } } as any)).toBe("outputGateway");
  });

  test("deve rotear a partir de agentes especialistas de volta ao supervisor ou para outputGateway", () => {
    expect(routeFromSpecialist({ nextAgent: "FINISH" } as any)).toBe("outputGateway");
    expect(routeFromSpecialist({ nextAgent: "supervisor" } as any)).toBe("supervisor");
  });

  test("deve rotear a partir do avaliador (evaluator) para outputGateway ou de volta ao supervisor", () => {
    expect(routeFromEvaluator({ nextAgent: "outputGateway" } as any)).toBe("outputGateway");
    expect(routeFromEvaluator({ nextAgent: "supervisor" } as any)).toBe("supervisor");
    expect(routeFromEvaluator({ nextAgent: "FINISH" } as any)).toBe("outputGateway");
  });
});

