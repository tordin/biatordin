import { cleanMarkdownForWhatsApp } from '../../src/transport/formatters.js';

describe('Formatters', () => {
  it('should clean markdown for whatsapp', () => {
    const input = '### Título\n* Item 1\n* Item 2\n[Link](http://exemplo.com)\n***\nFinal';
    const expected = '*Título*\n• Item 1\n• Item 2\nLink (http://exemplo.com)\n\nFinal';
    expect(cleanMarkdownForWhatsApp(input)).toBe(expected);
  });
});
