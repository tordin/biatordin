import { getMemory, updateMemory, getAllSandboxesMemory } from "../../src/memory/coreMemory.js";

describe("Core Memory Layer", () => {
  const trustedJid = "5519997064504@s.whatsapp.net";
  const untrustedJid = "551988880000@s.whatsapp.net";

  test("deve ler a memória global para chat confiável", () => {
    const memory = getMemory(trustedJid, true);
    expect(memory).toBeDefined();
    expect(typeof memory).toBe("string");
  });

  test("deve isolar a memória em sandbox para chat não-confiável", () => {
    const sandboxMemoryBefore = getMemory(untrustedJid, false);
    expect(sandboxMemoryBefore).toContain("Memória e Arquivos Isolados");

    const newSandboxContent = `# Memória e Arquivos Isolados (${untrustedJid})\n- Nota privada de grupo\n`;
    updateMemory(untrustedJid, false, newSandboxContent);

    const sandboxMemoryAfter = getMemory(untrustedJid, false);
    expect(sandboxMemoryAfter).toContain("Nota privada de grupo");
  });

  test("deve ler a lista de todos os sandboxes", () => {
    const sandboxes = getAllSandboxesMemory();
    expect(sandboxes).toContain("--- TODOS OS SANDBOXES ---");
  });
});
