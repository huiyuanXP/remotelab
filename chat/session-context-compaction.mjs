export function clipCompactionSection(value, maxChars = 12000) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${text.slice(0, headChars).trimEnd()}\n[... truncated by RemoteLab ...]\n${text.slice(-tailChars).trimStart()}`;
}

export function buildDelegationHandoff({
  source,
  task,
}) {
  const normalizedTask = clipCompactionSection(task, 4000);
  const sourceId = typeof source?.id === 'string' ? source.id.trim() : '';
  const lines = [normalizedTask || '(no delegated task provided)'];
  if (sourceId) {
    lines.push('', `Parent session id: ${sourceId}`);
  }
  return lines.join('\n');
}
