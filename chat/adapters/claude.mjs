import {
  messageEvent, toolUseEvent, toolResultEvent,
  reasoningEvent, statusEvent, usageEvent, sessionErrorEvent,
  questionEvent, planApprovalEvent,
} from '../normalizer.mjs';

// Interactive tools that need user input — their tool_result (exit 1) should be suppressed
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Claude Code adapter.
 *
 * When run with `claude -p --output-format stream-json --verbose`, stdout
 * emits JSONL with BOTH complete messages AND streaming events.
 *
 * To avoid duplicate rendering we use ONLY the complete messages
 * (type: "assistant", "user", "result") for text and tool_use blocks.
 * From stream_event we only extract thinking deltas (which aren't
 * duplicated in complete messages).
 */
export function createClaudeAdapter() {
  // Track tool_use_ids for interactive tools so we can suppress their error results
  const pendingInteractiveIds = new Set();

  return {
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return [];

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return [];
      }

      const events = [];

      switch (obj.type) {
        case 'system':
          events.push(statusEvent(obj.subtype === 'init'
            ? `Session started (${obj.session_id || 'unknown'})`
            : `System: ${obj.subtype || 'unknown'}`));
          break;

        case 'assistant': {
          // Complete assistant message — the authoritative source for text & tool_use
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                events.push(messageEvent('assistant', block.text));
              } else if (block.type === 'thinking') {
                events.push(reasoningEvent(block.thinking));
              } else if (block.type === 'tool_use') {
                if (block.name === 'AskUserQuestion' && block.input?.questions) {
                  pendingInteractiveIds.add(block.id);
                  events.push(questionEvent(block.input.questions, block.id));
                } else if (block.name === 'ExitPlanMode') {
                  pendingInteractiveIds.add(block.id);
                  events.push(planApprovalEvent(block.input?.plan, block.input?.allowedPrompts, block.id));
                } else {
                  events.push(toolUseEvent(
                    block.name,
                    typeof block.input === 'string'
                      ? block.input
                      : JSON.stringify(block.input, null, 2),
                  ));
                }
              } else if (block.type === 'tool_result') {
                const output = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map(c => c.text || '').join('\n')
                    : JSON.stringify(block.content);
                events.push(toolResultEvent(block.tool_use_id || '', output));
              }
            }
          }
          break;
        }

        case 'user': {
          // Tool results returned to the model
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                // Suppress error results for interactive tools (they fail with exit 1 in headless mode)
                if (pendingInteractiveIds.has(block.tool_use_id)) {
                  pendingInteractiveIds.delete(block.tool_use_id);
                  continue;
                }
                const output = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map(c => c.text || '').join('\n')
                    : JSON.stringify(block.content);
                events.push(toolResultEvent(
                  block.tool_use_id || '',
                  output,
                  block.is_error ? 1 : 0,
                ));
              }
            }
          }
          break;
        }

        case 'result':
          if (obj.is_error) {
            // Session error (e.g. stale --resume ID, API failure). Emit dedicated event
            // so the frontend can show recovery options.
            events.push(sessionErrorEvent(obj.result || 'Session error during execution'));
            break;
          }
          // Skip obj.result text — it duplicates the last assistant message.
          // Only emit usage + completed status.
          if (obj.cost_usd !== undefined || obj.usage) {
            const u = obj.usage || {};
            events.push(usageEvent(
              u.input_tokens || 0,
              u.output_tokens || 0,
              u.cache_creation_input_tokens || 0,
              u.cache_read_input_tokens || 0,
            ));
          }
          events.push(statusEvent('completed'));
          break;

        case 'stream_event': {
          // Only extract thinking deltas from streaming events.
          // Text and tool_use are handled via complete "assistant" messages above.
          const evt = obj.event;
          if (!evt) break;
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
            events.push(reasoningEvent(evt.delta.thinking || ''));
          }
          break;
        }

        default:
          break;
      }

      return events;
    },

    flush() {
      return [];
    },
  };
}

/**
 * Build the command-line arguments for spawning Claude Code.
 */
export function buildClaudeArgs(prompt, options = {}) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

  if (options.maxTurns) {
    args.push('--max-turns', String(options.maxTurns));
  }
  if (options.resume) {
    args.push('--resume', options.resume);
  }
  if (options.continue) {
    args.push('--continue');
  }
  if (options.allowedTools) {
    args.push('--allowedTools', ...options.allowedTools);
  }
  if (options.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  // Inject hook settings so AskUserQuestion/ExitPlanMode are intercepted by the web UI
  if (options.hookSettingsJson) {
    args.push('--settings', options.hookSettingsJson);
  }

  // Thinking: Claude Code enables extended thinking automatically on supported models.
  // When thinking is requested, we use a model that supports it.
  if (options.thinking) {
    args.push('--model', 'sonnet');
  }

  return args;
}

/**
 * Build args for stdin-based multi-turn (stream-json input).
 */
export function buildClaudeStreamArgs(options = {}) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
  ];

  if (options.resume) {
    args.push('--resume', options.resume);
  }
  if (options.sessionId) {
    args.push('--session-id', options.sessionId);
  }
  if (options.allowedTools) {
    args.push('--allowedTools', ...options.allowedTools);
  }
  if (options.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  return args;
}
