#!/usr/bin/env python3

import argparse
import json
import math
import time
from collections import deque

try:
    import numpy as np
except Exception:
    np = None

try:
    import sounddevice as sd
except Exception:
    sd = None

try:
    import soundfile as sf
except Exception:
    sf = None

from voice_audio_common import default_input_source, make_temp_wav, trim


def parse_args():
    parser = argparse.ArgumentParser(description="Capture one utterance and stop after trailing silence")
    parser.add_argument("--timeout-ms", type=int, default=15000)
    parser.add_argument("--speech-start-timeout-ms", type=int, default=5000)
    parser.add_argument("--silence-ms", type=int, default=900)
    parser.add_argument("--frame-ms", type=int, default=100)
    parser.add_argument("--pre-roll-ms", type=int, default=250)
    parser.add_argument("--speech-threshold", type=float, default=0.0015)
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--input-backend", default="sounddevice")
    parser.add_argument("--input-source", default="")
    parser.add_argument("--output-path", default="")
    return parser.parse_args()


def resolve_device(source):
    normalized = trim(source)
    if not normalized:
        normalized = trim(default_input_source("sounddevice"))
    if not normalized:
        return None
    try:
        return int(normalized)
    except ValueError:
        return normalized


def main():
    args = parse_args()
    if trim(args.input_backend) and trim(args.input_backend).lower() != "sounddevice":
        raise SystemExit("voice-capture-until-silence.py currently supports only the sounddevice backend")
    if sd is None or sf is None or np is None:
        raise SystemExit("sounddevice, soundfile, and numpy are required")

    output_path = trim(args.output_path) or make_temp_wav("voice-capture-")
    device = resolve_device(args.input_source)
    frame_ms = max(20, int(args.frame_ms))
    frame_count = max(1, int(round(args.sample_rate * frame_ms / 1000)))
    pre_roll_blocks = max(1, int(math.ceil(max(0, args.pre_roll_ms) / frame_ms)))
    silence_blocks_needed = max(1, int(math.ceil(max(1, args.silence_ms) / frame_ms)))
    speech_deadline = time.monotonic() + max(1, args.speech_start_timeout_ms) / 1000.0
    hard_deadline = time.monotonic() + max(1, args.timeout_ms) / 1000.0

    pre_roll = deque(maxlen=pre_roll_blocks)
    frames = []
    started = False
    silent_blocks = 0
    peak_seen = 0.0

    with sd.InputStream(
        samplerate=args.sample_rate,
        channels=1,
        dtype="float32",
        device=device,
        blocksize=frame_count,
    ) as stream:
        while True:
            now = time.monotonic()
            if now >= hard_deadline:
                break
            chunk, _overflowed = stream.read(frame_count)
            chunk = chunk.copy()
            peak = float(np.max(np.abs(chunk))) if chunk.size else 0.0
            peak_seen = max(peak_seen, peak)

            if not started:
                pre_roll.append(chunk)
                if peak >= args.speech_threshold:
                    started = True
                    frames.extend(list(pre_roll))
                    silent_blocks = 0
                elif now >= speech_deadline:
                    break
                continue

            frames.append(chunk)
            if peak >= args.speech_threshold:
                silent_blocks = 0
            else:
                silent_blocks += 1
                if silent_blocks >= silence_blocks_needed:
                    break

    if not started or not frames:
        payload = {
            "audioPath": "",
            "speechDetected": False,
            "peak": peak_seen,
        }
        print(json.dumps(payload, ensure_ascii=False))
        return

    if silent_blocks > 0 and len(frames) > silent_blocks:
        frames = frames[:-silent_blocks]
    audio = np.concatenate(frames, axis=0)
    sf.write(output_path, audio, args.sample_rate)
    duration_ms = int(round(audio.shape[0] * 1000.0 / args.sample_rate))
    payload = {
        "audioPath": output_path,
        "speechDetected": True,
        "durationMs": duration_ms,
        "peak": peak_seen,
    }
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
