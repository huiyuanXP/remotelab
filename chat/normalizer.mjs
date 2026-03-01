let counter = 0;

export function createEvent(type, fields = {}) {
  counter += 1;
  return {
    type,
    id: `evt_${String(counter).padStart(6, '0')}`,
    timestamp: Date.now(),
    ...fields,
  };
}

export function resetCounter() {
  counter = 0;
}

export function messageEvent(role, content, images) {
  const fields = { role, content };
  if (images && images.length > 0) fields.images = images;
  return createEvent('message', fields);
}

export function toolUseEvent(toolName, toolInput) {
  return createEvent('tool_use', { role: 'assistant', toolName, toolInput });
}

export function toolResultEvent(toolName, output, exitCode) {
  return createEvent('tool_result', { role: 'system', toolName, output, exitCode });
}

export function fileChangeEvent(filePath, changeType) {
  return createEvent('file_change', { role: 'system', filePath, changeType });
}

export function reasoningEvent(content) {
  return createEvent('reasoning', { role: 'assistant', content });
}

export function statusEvent(content) {
  return createEvent('status', { role: 'system', content });
}

export function usageEvent(inputTokens, outputTokens) {
  return createEvent('usage', { role: 'system', inputTokens, outputTokens });
}
