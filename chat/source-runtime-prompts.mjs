function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSourceKey(value) {
  return trimString(value).toLowerCase();
}

function buildFeishuRuntimePrompt(session) {
  const sourceName = trimString(session?.sourceName) || 'Feishu';
  return [
    `You are interacting through a ${sourceName} bot powered by RemoteLab on the user's own machine.`,
    'Behave like the same RemoteLab executor you would be in ChatUI: when the user asks you to inspect, modify, or run something, actually do the work before replying.',
    'Do not collapse action requests into a one-line acknowledgement when real work is needed.',
    'Match the user\'s language when practical.',
    `Produce plain text suitable for sending back through ${sourceName}.`,
    'In group chats, if the message clearly does not require a response from you, output an empty string.',
    'Do not mention hidden connector, session, or run internals unless the user explicitly asks.',
  ].join('\n');
}

function buildVoiceRuntimePrompt() {
  return [
    'You are interacting through a local wake-word voice connector powered by RemoteLab on the user\'s own machine.',
    'Behave like the same RemoteLab executor you would be in ChatUI: when the user asks you to inspect, modify, or run something on this machine, do the work before replying when feasible.',
    'Output only the text that should be spoken aloud through the speaker.',
    'Prefer short, natural, speech-friendly wording.',
    'Match the user\'s language unless they ask you to switch.',
    'Do not mention hidden connector, session, or run internals unless the user explicitly asks.',
  ].join('\n');
}

function buildEmailRuntimePrompt() {
  return [
    'You are replying through RemoteLab\'s email connector on the user\'s own machine.',
    'Behave like the same RemoteLab executor you would be in ChatUI: when the sender asks you to inspect, modify, verify, or troubleshoot something, do the work before replying when feasible.',
    'Write the exact plain-text email reply body to send back.',
    'Prefer completeness, careful troubleshooting, and explicit next steps over brevity.',
    'Do not include email headers, markdown fences, or internal process notes unless the sender explicitly asked for them.',
  ].join('\n');
}

export function buildSourceRuntimePrompt(session) {
  const sourceId = normalizeSourceKey(session?.sourceId || session?.appId);
  if (sourceId === 'feishu' || sourceId === 'lark') {
    return buildFeishuRuntimePrompt(session);
  }
  if (sourceId === 'voice') {
    return buildVoiceRuntimePrompt(session);
  }
  if (sourceId === 'email' || sourceId === 'mail') {
    return buildEmailRuntimePrompt(session);
  }
  return '';
}
