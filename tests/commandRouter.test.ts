import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { isCommand, handleCommand, getChatModelOverride, CommandContext } from '../src/commands/commandRouter.js';
import { setAIClient } from '../src/memory/embeddings.js';

describe('Command Router System', () => {
  let mockSock: { sendMessage: any };

  beforeAll(() => {
    setAIClient({
      models: {
        embedContent: async () => ({
          embeddings: [{ values: new Array(3072).fill(0.1) }]
        })
      }
    });
  });

  beforeEach(() => {
    mockSock = {
      sendMessage: jest.fn<any>().mockResolvedValue({})
    };
  });

  test('isCommand detector - identifica strings iniciadas com / ou !', () => {
    expect(isCommand('/novo')).toBe(true);
    expect(isCommand('/status')).toBe(true);
    expect(isCommand('!ajuda')).toBe(true);
    expect(isCommand('  /limpar  ')).toBe(true);
  });

  test('isCommand detector - retorna false para mensagens comuns', () => {
    expect(isCommand('Oi Bia, tudo bem?')).toBe(false);
    expect(isCommand('qual o clima hoje?')).toBe(false);
    expect(isCommand('')).toBe(false);
  });

  test('handleCommand - executa /novo (/limpar) e reseta o tópico', async () => {
    const ctx: CommandContext = {
      text: '/novo',
      chatJid: 'test@s.whatsapp.net',
      userJid: 'test@s.whatsapp.net',
      accountName: 'main',
      isGroup: false,
      sock: mockSock
    };

    const handled = await handleCommand(ctx);
    expect(handled).toBe(true);
    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      'test@s.whatsapp.net',
      expect.objectContaining({
        text: expect.stringContaining('Contexto Zerado!')
      })
    );
  });

  test('handleCommand - executa /status', async () => {
    const ctx: CommandContext = {
      text: '/status',
      chatJid: 'test@s.whatsapp.net',
      userJid: 'test@s.whatsapp.net',
      accountName: 'main',
      isGroup: false,
      sock: mockSock
    };

    const handled = await handleCommand(ctx);
    expect(handled).toBe(true);
    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      'test@s.whatsapp.net',
      expect.objectContaining({
        text: expect.stringContaining('Status do Sistema - Bia')
      })
    );
  });

  test('handleCommand - executa /cancelar e limpa a fila', async () => {
    const clearQueueMock = jest.fn();
    const ctx: CommandContext = {
      text: '/cancelar',
      chatJid: 'test@s.whatsapp.net',
      userJid: 'test@s.whatsapp.net',
      accountName: 'main',
      isGroup: false,
      sock: mockSock,
      clearQueue: clearQueueMock
    };

    const handled = await handleCommand(ctx);
    expect(handled).toBe(true);
    expect(clearQueueMock).toHaveBeenCalled();
    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      'test@s.whatsapp.net',
      expect.objectContaining({
        text: expect.stringContaining('Operação Cancelada!')
      })
    );
  });

  test('handleCommand - executa /guardar e /buscar', async () => {
    const ctxSave: CommandContext = {
      text: '/guardar Senha da Wi-Fi é 123456',
      chatJid: 'test@s.whatsapp.net',
      userJid: 'test@s.whatsapp.net',
      accountName: 'main',
      isGroup: false,
      sock: mockSock
    };

    const handledSave = await handleCommand(ctxSave);
    expect(handledSave).toBe(true);
    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      'test@s.whatsapp.net',
      expect.objectContaining({
        text: expect.stringContaining('Memória Salva com Sucesso!')
      })
    );

    const ctxSearch: CommandContext = {
      text: '/buscar Wi-Fi',
      chatJid: 'test@s.whatsapp.net',
      userJid: 'test@s.whatsapp.net',
      accountName: 'main',
      isGroup: false,
      sock: mockSock
    };

    const handledSearch = await handleCommand(ctxSearch);
    expect(handledSearch).toBe(true);
    expect(mockSock.sendMessage).toHaveBeenCalled();
  });

  test('handleCommand - altera o modelo com /modelo', async () => {
    const ctxModel: CommandContext = {
      text: '/modelo pro',
      chatJid: 'test@s.whatsapp.net',
      userJid: 'test@s.whatsapp.net',
      accountName: 'main',
      isGroup: false,
      sock: mockSock
    };

    const handled = await handleCommand(ctxModel);
    expect(handled).toBe(true);
    expect(getChatModelOverride('test@s.whatsapp.net')).toBe('Gemini 2.5 Pro');
    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      'test@s.whatsapp.net',
      expect.objectContaining({
        text: expect.stringContaining('Gemini 2.5 Pro')
      })
    );
  });

  test('handleCommand - exibe menu com /ajuda', async () => {
    const ctxHelp: CommandContext = {
      text: '/ajuda',
      chatJid: 'test@s.whatsapp.net',
      userJid: 'test@s.whatsapp.net',
      accountName: 'main',
      isGroup: false,
      sock: mockSock
    };

    const handled = await handleCommand(ctxHelp);
    expect(handled).toBe(true);
    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      'test@s.whatsapp.net',
      expect.objectContaining({
        text: expect.stringContaining('Menu de Comandos da Bia')
      })
    );
  });

  test('handleCommand - executa /explicar', async () => {
    const ctxExplicar: CommandContext = {
      text: '/explicar',
      chatJid: 'test@s.whatsapp.net',
      userJid: 'test@s.whatsapp.net',
      accountName: 'main',
      isGroup: false,
      sock: mockSock
    };

    const handled = await handleCommand(ctxExplicar);
    expect(handled).toBe(true);
    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      'test@s.whatsapp.net',
      expect.objectContaining({
        text: expect.stringContaining('Como processei seu pedido')
      })
    );
  });

  test('handleCommand - informa se o comando for desconhecido', async () => {
    const ctxUnknown: CommandContext = {
      text: '/desconhecido',
      chatJid: 'test@s.whatsapp.net',
      userJid: 'test@s.whatsapp.net',
      accountName: 'main',
      isGroup: false,
      sock: mockSock
    };

    const handled = await handleCommand(ctxUnknown);
    expect(handled).toBe(true);
    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      'test@s.whatsapp.net',
      expect.objectContaining({
        text: expect.stringContaining('não reconhecido')
      })
    );
  });
});
