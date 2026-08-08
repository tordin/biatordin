import { getToolSeals, getAgentSeals, applyToolSeals } from '../../src/utils/toolSeals.js';

describe('Tool & Agent Seals Utility', () => {
  it('deve retornar string vazia para lista de ferramentas vazia ou não mapeada', () => {
    expect(getToolSeals([])).toBe('');
    expect(getToolSeals(['unknownTool', 'customReasoning'])).toBe('');
  });

  it('deve retornar selos ordenados e separados por espaço para ferramentas executadas', () => {
    const executed = ['addTask', 'googleSearch', 'readMemory', 'weather'];
    const seals = getToolSeals(executed);
    // Esperado: 🔍 (search), 🧠 (memory), 📋 (tasks), 🌦️ (weather)
    expect(seals).toBe('🔍 🧠 📋 🌦️');
  });

  it('deve retornar selos de agentes para especialistas executados (ex: calendarAgent, gmailAgent)', () => {
    const agents = ['calendarAgent', 'gmailAgent', 'searchAgent'];
    const seals = getAgentSeals(agents);
    expect(seals).toBe('📅 📧 🔍');
  });

  it('deve anexar selo de agente (🤖) no final da mensagem em applyToolSeals', () => {
    const msg = 'Aqui estão os eventos da sua agenda.';
    const result = applyToolSeals(msg, [], ['calendarAgent', 'gmailAgent']);
    expect(result).toBe('Aqui estão os eventos da sua agenda.\n\n🤖: 📅 📧');
  });

  it('deve anexar selo de ferramenta (🛠️) no final da mensagem quando ferramentas diretas forem usadas', () => {
    const msg = 'Aqui está a previsão do tempo para Campinas: 22°C com sol.';
    const result = applyToolSeals(msg, ['weather']);
    expect(result).toBe('Aqui está a previsão do tempo para Campinas: 22°C com sol.\n\n🛠️: 🌦️');
  });

  it('deve separar linhas de agentes (🤖) e ferramentas (🛠️) quando ambos forem utilizados', () => {
    const msg = 'Consultei a agenda e fiz a anotação.';
    const result = applyToolSeals(msg, ['storeSemanticMemory'], ['calendarAgent']);
    expect(result).toBe('Consultei a agenda e fiz a anotação.\n\n🤖: 📅\n🛠️: 🧠');
  });

  it('não deve alterar a mensagem se nenhuma ferramenta ou agente foi usado', () => {
    const msg = 'Olá! Como posso te ajudar hoje?';
    const result = applyToolSeals(msg, [], []);
    expect(result).toBe('Olá! Como posso te ajudar hoje?');
  });
});
