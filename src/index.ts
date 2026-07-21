import dotenv from 'dotenv';
import { connectToWhatsApp } from './transport/whatsapp.js';
import { logger } from './utils/logger.js';
import { checkpointer } from './memory/checkpointer.js';
import { initRoutineManager } from './utils/routineManager.js';
import fs from 'fs';
import path from 'path';

dotenv.config();

let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`\n[SHUTDOWN] Recebido sinal ${signal}. Iniciando graceful shutdown...`);

  try {
    // 1. O checkpointer local do sqlite sincroniza no encerramento (o processo em si fecharia normal,
    // mas se precisarmos de algum teardown manual de DB ou WhatsApp, colocamos aqui).
    // Por hora, apenas avisamos e encerramos
    logger.info("[SHUTDOWN] Cleanup finalizado com sucesso.");
    process.exit(0);
  } catch (error) {
    logger.error("[SHUTDOWN] Erro durante o shutdown limpo:", error);
    process.exit(1);
  }
}

import { initTopicsTable } from './memory/topics.js';
import { initSecurityTable } from './memory/security.js';

// Captura sinais de terminação
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

async function bootstrap() {
  try {
    await initTopicsTable();
    await initSecurityTable();
    
    connectToWhatsApp('main').catch((err) => {
      logger.error('Falha ao iniciar o WhatsApp Bot (main):', err);
    });

    const personalCredsPath = path.join(process.cwd(), 'auth_info_baileys_personal', 'creds.json');
    if (fs.existsSync(personalCredsPath)) {
      logger.info('Credenciais da conta personal encontradas. Iniciando conexão...');
      connectToWhatsApp('personal').catch((err) => {
        logger.error('Falha ao iniciar o WhatsApp Bot (personal):', err);
      });
    } else {
      logger.info('Conta personal não configurada. Inicie via chat se desejar.');
    }

    initRoutineManager().catch((err) => {
      logger.error('Falha ao iniciar o gerenciador de rotinas:', err);
    });
  } catch (err) {
    logger.error('Erro crítico no bootstrap da aplicação:', err);
    process.exit(1);
  }
}

bootstrap();
