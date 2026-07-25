import { cleanMarkdownForWhatsApp } from '../../src/transport/formatters.js';

describe('WhatsApp Formatting Utility (cleanMarkdownForWhatsApp)', () => {
  it('deve retornar string vazia se texto for nulo ou vazio', () => {
    expect(cleanMarkdownForWhatsApp('')).toBe('');
  });

  it('deve limpar títulos, listas com asteriscos, links e divisores horizontal', () => {
    const input = '### Título\n* Item 1\n* Item 2\n[Link](http://exemplo.com)\n***\nFinal';
    const expected = '*Título*\n• Item 1\n• Item 2\nLink (http://exemplo.com)\n\nFinal';
    expect(cleanMarkdownForWhatsApp(input)).toBe(expected);
  });

  it('deve converter tabelas markdown em pares de chave-valor amigáveis', () => {
    const tableInput = 
      '| Detalhe | Informação |\n' +
      '| --- | --- |\n' +
      '| Data | 25/07 |\n' +
      '| Horário | 15:00 |\n' +
      '| Coluna1 | Coluna2 | Coluna3 |';

    const output = cleanMarkdownForWhatsApp(tableInput);
    expect(output).toContain('*Data*: 25/07');
    expect(output).toContain('*Horário*: 15:00');
    expect(output).toContain('Coluna1 - Coluna2 - Coluna3');
  });
});
