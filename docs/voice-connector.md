# Voice Hardware Connector (Prompt-First)

This document is the rollout contract for wiring a wake-word voice connector to RemoteLab.

The design goal is simple:

- microphone + wake-word detection live outside the core server
- the connector turns one spoken request into one normal RemoteLab message
- RemoteLab runs the selected local agent as usual
- the connector converts the final assistant reply back into speaker audio

That keeps voice as just another thin connector on top of the existing session/run/event architecture.

## Copyable Prompt

Use this when handing the setup to an AI coding agent on the RemoteLab machine:

```text
I want you to wire a wake-word voice connector for RemoteLab on this machine.

Target behavior:
- a local microphone listens for a wake phrase
- after wake, capture one utterance
- transcribe it
- send it into RemoteLab as one user message
- wait for the assistant reply
- speak the reply back through the local speaker

Machine / hardware:
- OS: macOS or Linux
- microphone device: <device name>
- speaker device: <device name>
- room / connector name: <living-room / desk / kitchen / etc>
- wake phrase: <phrase>

Pipeline choices:
- wake-word layer: <openWakeWord / Porcupine / custom / already have one>
- capture layer: <ffmpeg / sox / custom>
- STT layer: <whisper.cpp / faster-whisper / cloud API / custom>
- TTS layer: <macOS say / espeak / Piper / cloud API / custom>

RemoteLab session choices:
- tool: <codex / claude / other>
- model: <optional>
- effort: <optional>
- thinking: <true/false>

Constraints:
- keep RemoteLab as the shared runtime and conversation engine
- keep platform-specific audio handling inside the connector
- prefer a stable per-device voice session using externalTriggerId
- keep replies short and speech-friendly

Please:
1. install or verify the needed local dependencies
2. create ~/.config/remotelab/voice-connector/config.json
3. wire the wake/capture/stt/tts commands into scripts/voice-connector.mjs
4. validate with a dry run using --text or --stdin
5. start the persistent connector process
6. report the final command, config path, and validation result
```

## Target State

When the setup is complete, the machine should have:

- one local `voice-connector` process
- one wake pipeline that emits activations
- one capture/transcribe pipeline for each wake event
- one durable RemoteLab session per connector/device
- one TTS path back to the speaker

The expected session scope is:

- `appId`: `voice`
- `appName`: `Voice`
- `group`: `Voice`
- `externalTriggerId`: stable per connector, such as `voice:living-room-speaker`

For demos that want one fresh session per wake event instead of one stable device thread, set:

- `sessionMode`: `per-wake`

## Human Checkpoints

Only interrupt the human for items the AI cannot complete alone.

- `[HUMAN]` Grant microphone permission to the terminal / Node process if the OS prompts.
- `[HUMAN]` Confirm the physical microphone and speaker are the intended devices.
- `[HUMAN]` If the wake-word or STT/TTS vendor requires account credentials, provide them once.

Everything else should stay inside the AI session.

## Connector Contract

The shipped implementation lives in `scripts/voice-connector.mjs`.

It supports three operating modes:

- `--text` for one direct transcript smoke test
- `--stdin` for line-by-line development testing
- `wake.command` for the real persistent wake-word loop

### Wake command

`wake.command` should be a long-running process that writes one line per activation to stdout.

Each line may be either:

- plain text — treated as a ready transcript
- JSON — treated as a wake event payload

Supported JSON fields:

- `eventId`
- `wakeWord`
- `transcript`
- `audioPath`
- `detectedAt`
- `connectorId`
- `roomName`
- `metadata`

If the wake layer already provides `transcript`, the connector can skip capture/STT.
If it provides only a wake event, the connector can call `capture.command` and `stt.command` next.

### Capture command

`capture.command` is optional.

It receives `REMOTELAB_VOICE_*` environment variables and may output either:

- a plain audio file path
- JSON with `{ "audioPath": "..." }`
- JSON with `{ "audioPath": "...", "transcript": "..." }`

### STT command

`stt.command` receives `REMOTELAB_VOICE_AUDIO_PATH` and should output either:

- plain transcript text
- JSON with `text` or `transcript`

### TTS command

The connector supports:

- macOS `say` directly via `tts.mode: "say"`
- a custom `tts.command`

For a custom command, the reply is passed both as stdin and as `REMOTELAB_VOICE_REPLY_TEXT`.

## Example Config

```json
{
  "connectorId": "living-room-speaker",
  "roomName": "Living Room",
  "chatBaseUrl": "http://127.0.0.1:7690",
  "sessionFolder": "~",
  "sessionTool": "codex",
  "model": "",
  "effort": "",
  "thinking": false,
  "wake": {
    "mode": "command",
    "command": "python3 ~/bin/voice-wake-loop.py",
    "keyword": "Hey Rowan"
  },
  "capture": {
    "command": "python3 ~/bin/voice-capture.py",
    "timeoutMs": 90000
  },
  "stt": {
    "command": "python3 ~/bin/voice-transcribe.py",
    "timeoutMs": 120000
  },
  "tts": {
    "mode": "say",
    "voice": "Tingting",
    "rate": 185
  }
}
```

## Built-in macOS demo helpers

This repo now ships a simple macOS-first demo path that keeps all microphone / wake-word handling outside the main server:

- `scripts/voice-wake-phrase.swift` — always-on wake listener using macOS Speech; emits one JSON line when it hears the wake phrase
- `scripts/voice-capture-until-silence.swift` — captures one follow-up utterance and stops after about 1 second of silence
- `scripts/music-open.mjs` — opens a preset Apple Music classical target or a search page, then sends a play/pause key as a pragmatic playback trigger
- `scripts/voice-connector-instance.sh` — start/stop/status helper for the persistent connector process

Example machine-local config for this demo shape:

```json
{
  "connectorId": "desk-speaker",
  "roomName": "Desk",
  "chatBaseUrl": "http://127.0.0.1:7690",
  "sessionFolder": "~",
  "sessionTool": "codex",
  "sessionMode": "per-wake",
  "thinking": false,
  "systemPrompt": "You are Rowan speaking through a local wake-word voice connector on the owner's Mac. You may use shell commands, osascript, and local scripts on this machine when useful. For music playback requests, prefer running `node /Users/jiujianian/code/remotelab/scripts/music-open.mjs --preset apple-music-classical` for generic classical music, or `node /Users/jiujianian/code/remotelab/scripts/music-open.mjs --query \"<query>\"` for a search. When a local action is possible, do it before replying. Reply with exactly the short text that should be spoken aloud.",
  "wake": {
    "mode": "command",
    "command": "swift /Users/jiujianian/code/remotelab/scripts/voice-wake-phrase.swift --phrase \"Hello World\" --locale en-US --cooldown-ms 3000 --restart-delay-ms 1200 --on-device true --allow-server-fallback true",
    "keyword": "Hello World"
  },
  "capture": {
    "command": "swift /Users/jiujianian/code/remotelab/scripts/voice-capture-until-silence.swift --timeout-ms 20000 --speech-start-timeout-ms 8000 --silence-ms 1000 --locale zh-CN --on-device true --allow-server-fallback true",
    "timeoutMs": 30000
  },
  "tts": {
    "mode": "say",
    "voice": "Tingting",
    "rate": 185,
    "timeoutMs": 120000
  }
}
```

Start the persistent demo instance with:

```bash
./scripts/voice-connector-instance.sh start
```

## Validation

Start with the cheapest checks first:

```bash
npm run voice:connect -- --config ~/.config/remotelab/voice-connector/config.json --text "Hello there" --no-speak
```

Then a local interactive pass:

```bash
npm run voice:connect -- --config ~/.config/remotelab/voice-connector/config.json --stdin
```

Then the real wake loop:

```bash
npm run voice:connect -- --config ~/.config/remotelab/voice-connector/config.json
```

Expected outcome:

- a `Voice` session is created or reused in RemoteLab
- the spoken text appears as a normal user message in that session
- the assistant reply is short and speech-friendly
- the reply is spoken through the configured TTS path

## Architecture Fit

This connector does not require a new core runtime model.

It follows the same contract as Feishu, GitHub, and other external connectors:

1. authenticate to RemoteLab
2. create or reuse a session
3. submit one normalized message
4. wait for the run to complete
5. fetch the assistant reply from session events
6. render that reply back into the upstream surface

The only new surface area is the local audio pipeline around the connector.
