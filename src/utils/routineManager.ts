import cron from 'node-cron';
import { getAllActiveRoutines, Routine } from '../memory/routines.js';
import { injectSystemMessage } from '../transport/whatsapp.js';
import { logger } from './logger.js';

const activeJobs = new Map<number, ReturnType<typeof cron.schedule>>();

export async function initRoutineManager() {
    logger.info("[ROUTINE MANAGER] Inicializando e carregando rotinas ativas...");
    try {
        const routines = await getAllActiveRoutines();
        logger.info(`[ROUTINE MANAGER] Encontradas ${routines.length} rotinas ativas.`);
        
        for (const routine of routines) {
            scheduleRoutine(routine);
        }
    } catch (error) {
        logger.error("[ROUTINE MANAGER] Erro ao carregar rotinas:", error);
    }
}

export function scheduleRoutine(routine: Routine) {
    // Se já existe um job para esta rotina, cancela o anterior
    if (activeJobs.has(routine.id)) {
        activeJobs.get(routine.id)?.stop();
    }

    try {
        const job = cron.schedule(routine.cronExpression, () => {
            logger.info(`[ROUTINE MANAGER] Disparando rotina ID ${routine.id} para o chat ${routine.chatJid}`);
            injectSystemMessage(routine.chatJid, routine.prompt, 'main', {
                triggerType: 'cron_routine',
                routineId: routine.id,
                routinePrompt: routine.prompt,
                topicId: routine.topicId,
            });
        });

        activeJobs.set(routine.id, job);
        logger.info(`[ROUTINE MANAGER] Rotina ID ${routine.id} agendada com sucesso. (Cron: ${routine.cronExpression})`);
    } catch (error) {
        logger.error(`[ROUTINE MANAGER] Expressão cron inválida ou erro ao agendar rotina ID ${routine.id}:`, error);
    }
}

export function descheduleRoutine(id: number) {
    if (activeJobs.has(id)) {
        activeJobs.get(id)?.stop();
        activeJobs.delete(id);
        logger.info(`[ROUTINE MANAGER] Rotina ID ${id} desagendada.`);
    }
}
