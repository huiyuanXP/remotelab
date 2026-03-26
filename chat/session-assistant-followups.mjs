import { loadHistory } from './history.mjs';
import { parseTaskCardFromAssistantContent } from './session-task-card.mjs';

export async function findLatestAssistantMessageForRun(sessionId, runId) {
  const events = await loadHistory(sessionId, { includeBodies: true });
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'message' || event.role !== 'assistant') continue;
    if (runId && event.runId !== runId) continue;
    return event;
  }
  return null;
}

export async function maybeApplyAssistantTaskCard(sessionId, runId, session = null, services = {}) {
  const currentSession = session || await services.getSession(sessionId);
  if (!currentSession || !services.isTaskCardEnabledForSession(currentSession)) {
    return null;
  }

  const assistantEvent = await findLatestAssistantMessageForRun(sessionId, runId);
  const taskCard = parseTaskCardFromAssistantContent(assistantEvent?.content || '');
  if (!taskCard) return null;

  return services.updateSessionTaskCard(sessionId, taskCard);
}

export function scheduleSessionTaskCardSuggestion(session, run, services = {}) {
  if (!session?.id || !run || session.archived || services.isInternalSession(session)) {
    return false;
  }
  if (!services.isTaskCardEnabledForSession(session)) {
    return false;
  }

  const suggestionDone = services.triggerSessionTaskCardSuggestion({
    id: session.id,
    folder: session.folder,
    name: session.name || '',
    sourceName: session.sourceName || '',
    taskCard: session.taskCard,
    tool: run.tool || session.tool,
    model: run.model || undefined,
    effort: run.effort || undefined,
    thinking: false,
  });

  suggestionDone.then(async (result) => {
    if (!result?.taskCard) return;
    const latestAssistant = await findLatestAssistantMessageForRun(session.id);
    if (latestAssistant?.runId !== run.id) return;
    await services.updateSessionTaskCard(session.id, result.taskCard);
  }).catch((error) => {
    console.error(`[task-card] Failed to update task card for ${session.id?.slice(0, 8)}: ${error.message}`);
  });

  return true;
}
