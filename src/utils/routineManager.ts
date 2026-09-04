import cron from 'node-cron';
import { getAllActiveRoutines, getRoutineById, Routine } from '../memory/routines.js';
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
        const job = cron.schedule(routine.cronExpression, async () => {
            try {
                // 🛡️ Validação defensiva pré-disparo: a rotina ainda existe e continua ativa no banco?
                const current = await getRoutineById(routine.id);
                if (!current || !current.isActive) {
                    logger.warn(`[ROUTINE MANAGER] Rotina ID ${routine.id} não encontrada ou inativa no banco de dados. Desagendando da memória.`);
                    descheduleRoutine(routine.id);
                    return;
                }

                logger.info(`[ROUTINE MANAGER] Disparando rotina ID ${current.id} para o chat ${current.chatJid}`);
                injectSystemMessage(current.chatJid, current.prompt, 'main', {
                    triggerType: 'cron_routine',
                    routineId: current.id,
                    routinePrompt: current.prompt,
                    topicId: current.topicId,
                });
            } catch (error) {
                logger.error(`[ROUTINE MANAGER] Erro ao verificar ou disparar rotina ID ${routine.id}:`, error);
            }
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

export function hasActiveJob(id: number): boolean {
    return activeJobs.has(id);
}

export function getActiveJobsCount(): number {
    return activeJobs.size;
}
