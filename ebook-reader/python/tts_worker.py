#!/usr/bin/env python3
"""Persistent NDJSON worker for local Qwen3-TTS CustomVoice synthesis."""

from __future__ import annotations

import argparse
import gc
import json
import os
import sys
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RuntimeChoice:
    device: str
    dtype: Any


def runtime_choices(torch: Any, configured: str) -> list[RuntimeChoice]:
    """Return the configured runtime or the ordered automatic fallback list."""
    if configured == "cuda":
        return [RuntimeChoice("cuda:0", torch.bfloat16)]
    if configured == "mps":
        return [RuntimeChoice("mps", torch.bfloat16)]
    if configured == "cpu":
        return [RuntimeChoice("cpu", torch.float32)]
    choices: list[RuntimeChoice] = []
    if torch.cuda.is_available():
        choices.append(RuntimeChoice("cuda:0", torch.bfloat16))
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        choices.append(RuntimeChoice("mps", torch.bfloat16))
    choices.append(RuntimeChoice("cpu", torch.float32))
    return choices


def release_memory() -> None:
    """Drop what the last model call left behind and hand the allocator's cached blocks back.

    The device caching allocators keep every block they have handed out, so a process that is never
    told otherwise stays resident at the largest batch it has ever run; a reading that meets one long
    paragraph keeps that peak for the rest of the session. Collecting first releases the tensors held
    by reference cycles, which is where an exception's traceback keeps the frames that produced them.

    Only a model load imports torch, so a request that fails before one collects Python objects alone.
    """
    gc.collect()
    torch = sys.modules.get("torch")
    if torch is None:
        return
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        torch.mps.empty_cache()


def load_model(model_path: str, configured_device: str) -> Any:
    """Load once; auto mode may fall back from an unsupported accelerator to CPU."""
    try:
        import torch
        from qwen_tts import Qwen3TTSModel
    except Exception as error:
        raise RuntimeError(
            'qwen-tts is unavailable; install it in this Python environment with "pip install -U qwen-tts"'
        ) from error

    failures: list[str] = []
    for choice in runtime_choices(torch, configured_device):
        try:
            model = Qwen3TTSModel.from_pretrained(model_path, device_map=choice.device, dtype=choice.dtype)
            print(f"ebook-reader TTS loaded {model_path} on {choice.device}", file=sys.stderr, flush=True)
            return model
        except Exception as error:
            failures.append(f"{choice.device}: {error}")
            if configured_device != "auto":
                break
            release_memory()
    raise RuntimeError("unable to load Qwen3-TTS; " + " | ".join(failures))


def speaker_table(model_path: str) -> dict[str, int]:
    """Read the checkpoint's `talker_config.spk_id` table, so an unknown speaker fails instead of
    reaching a model that may substitute another voice for it, and so an anchored voice can be
    given the same speaker embedding the unanchored path gives it. Keys are lower-cased."""
    with open(os.path.join(model_path, "config.json"), encoding="utf-8") as handle:
        config = json.load(handle)
    talker = config.get("talker_config") if isinstance(config, dict) else None
    speakers = talker.get("spk_id") if isinstance(talker, dict) else None
    return {str(key).lower(): value for key, value in speakers.items()} if isinstance(speakers, dict) else {}


def request_object(line: str) -> dict[str, Any]:
    """Decode one batch request and reject malformed fields before model invocation."""
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("request must be an object")
    if not isinstance(value.get("id"), int):
        raise ValueError("request id must be an integer")
    for field in ("language",):
        if not isinstance(value.get(field), str) or not value[field]:
            raise ValueError(f"{field} must be a non-empty string")
    if not isinstance(value.get("instruct"), str):
        raise ValueError("instruct must be a string")
    segments = value.get("segments")
    if not isinstance(segments, list) or not segments:
        raise ValueError("segments must be a non-empty array")
    for segment in segments:
        if not isinstance(segment, dict):
            raise ValueError("each segment must be an object")
        for field in ("text", "speaker", "output"):
            if not isinstance(segment.get(field), str) or not segment[field]:
                raise ValueError(f"segment {field} must be a non-empty string")
    return value


def decoding_kwargs(decoding: str) -> dict[str, Any]:
    """Generation settings for one decoding mode.

    The checkpoint's `generation_config.json` samples (`do_sample`, `temperature` 0.9, `top_k` 50)
    in both the talker and the sub-talker. `talker-sampled` turns sampling off in the sub-talker
    alone, which fixes each frame's codebook detail; `fully-sampled` keeps the checkpoint's own
    behaviour. The talker always samples, because greedy decoding there fails to emit the stop
    token on a large share of ordinary sentences and runs to `max_new_tokens`, which this
    checkpoint sets to 8192 — about eleven minutes of decoding for one segment.
    """
    if decoding == "talker-sampled":
        return {"subtalker_dosample": False}
    return {}


class VoiceAnchors:
    """The reference speech each anchored voice conditions on, encoded once per process.

    An anchor is a reference recording and its transcript. The talker is given the reference
    codes and text as a prefix, so every segment continues the same voice instead of being
    conditioned by the `spk_id` embedding alone, which leaves consecutive sentences free to drift
    in timbre.

    Encoding a reference costs one speech-tokenizer pass, so it is done on first use and kept.
    """

    def __init__(self, entries: dict[str, tuple[str, str]]) -> None:
        self.entries = entries
        self.built: dict[str, Any] = {}

    def has(self, voice: str) -> bool:
        """
        @param voice - voice id, matched without case.
        @returns whether that voice is anchored.
        """
        return voice.lower() in self.entries

    def prompt(self, model: Any, speakers: dict[str, int], voice: str) -> Any:
        """Build, or return, one voice's prompt item.

        The checkpoint ships no speaker encoder, so the x-vector `create_voice_clone_prompt`
        would extract cannot be computed here. The speaker-embedding slot carries the talker's
        own `spk_id` embedding for the voice instead — the same vector the unanchored path puts
        there — while the reference codes carry the acoustics.

        @param model - the loaded `Qwen3TTSModel`.
        @param speakers - the checkpoint's `talker_config.spk_id` table.
        @param voice - voice id, matched without case.
        @returns the prompt item to condition generation on.
        """
        import soundfile
        import torch
        from qwen_tts.inference.qwen3_tts_model import VoiceClonePromptItem

        key = voice.lower()
        existing = self.built.get(key)
        if existing is not None:
            return existing
        audio, text = self.entries[key]
        wav, rate = soundfile.read(audio, dtype="float32")
        if wav.ndim > 1:
            wav = wav.mean(axis=1)
        inner = model.model
        item = VoiceClonePromptItem(
            ref_code=inner.speech_tokenizer.encode([wav], sr=rate).audio_codes[0],
            ref_spk_embedding=inner.talker.get_input_embeddings()(
                torch.tensor(speakers[key], device=inner.talker.device)
            ),
            x_vector_only_mode=False,
            icl_mode=True,
            ref_text=text,
        )
        self.built[key] = item
        return item


def generate_anchored(
    model: Any, anchors: VoiceAnchors, speakers: dict[str, int], request: dict[str, Any],
    voice: str, gen_kwargs: dict[str, Any],
) -> tuple[list[Any], int]:
    """Generate one batch with every segment conditioned on the voice's anchor.

    `generate_voice_clone` performs these steps, but it refuses a checkpoint whose
    `tts_model_type` is not `base` and it sends no instruction, which the reading category needs.
    The talker's own `generate` accepts an instruction and a voice-clone prompt together, so the
    steps around it are performed here: the target text, the reference text, and the instruction
    are tokenized into the prompt slots, and the generated codes are decoded with the reference
    codes in front and then cut back off, because the decoder needs that prefix as context.

    This uses `Qwen3TTSModel`'s non-public helpers; a qwen-tts upgrade may move them.

    @param model - the loaded `Qwen3TTSModel`.
    @param anchors - the configured anchors.
    @param speakers - the checkpoint's `talker_config.spk_id` table.
    @param request - the batch request.
    @param voice - the one voice every segment of this batch is read with.
    @param gen_kwargs - decoding settings for this process.
    @returns the clips in request order, and their sample rate.
    """
    import torch

    prompt = anchors.prompt(model, speakers, voice)
    segments = request["segments"]
    count = len(segments)
    instruct = request["instruct"] or None

    input_ids = model._tokenize_texts([model._build_assistant_text(s["text"]) for s in segments])
    ref_ids = model._tokenize_texts([model._build_ref_text(prompt.ref_text)]) * count
    instruct_ids = (
        None if instruct is None else model._tokenize_texts([model._build_instruct_text(instruct)]) * count
    )
    prompt_dict = {
        "ref_code": [prompt.ref_code] * count,
        "ref_spk_embedding": [prompt.ref_spk_embedding] * count,
        "x_vector_only_mode": [False] * count,
        "icl_mode": [True] * count,
    }

    codes_list, _ = model.model.generate(
        input_ids=input_ids,
        instruct_ids=instruct_ids,
        ref_ids=ref_ids,
        voice_clone_prompt=prompt_dict,
        languages=[request["language"]] * count,
        **model._merge_generate_kwargs(**gen_kwargs),
    )
    with_prefix = [
        torch.cat([prompt.ref_code.to(codes.device), codes], dim=0) for codes in codes_list
    ]
    del codes_list
    wavs, sample_rate = model.model.speech_tokenizer.decode(
        [{"audio_codes": codes} for codes in with_prefix]
    )
    clips = []
    for codes, whole in zip(with_prefix, wavs):
        # The reference occupies the same share of the waveform as of the codes it was decoded with.
        cut = int(int(prompt.ref_code.shape[0]) / max(int(codes.shape[0]), 1) * whole.shape[0])
        clips.append(whole[cut:])
    return clips, sample_rate


def synthesize(
    model: Any, anchors: VoiceAnchors, speakers: dict[str, int], request: dict[str, Any],
    gen_kwargs: dict[str, Any],
) -> list[float]:
    """Generate one batch in a single model call and publish each segment through an atomic rename.

    The model generates the batch together, which is how several segments are produced in parallel:
    it holds one set of weights on one device, and concurrent calls into it are not supported.

    The batch is anchored when every segment asks for the same anchored voice, which is how the
    Host groups them; a mixed or unanchored batch is read from the `spk_id` embedding alone,
    because one call conditions on one prompt.
    """
    import soundfile
    import torch

    segments = request["segments"]
    instruct = request["instruct"] or None
    count = len(segments)
    voices = {segment["speaker"].lower() for segment in segments}
    voice = next(iter(voices)) if len(voices) == 1 else None
    # Nothing here trains, and a graph would keep every decoding step's activations alive until the
    # clips are released.
    with torch.no_grad():
        if voice is not None and anchors.has(voice):
            wavs, sample_rate = generate_anchored(model, anchors, speakers, request, voice, gen_kwargs)
        else:
            wavs, sample_rate = model.generate_custom_voice(
                text=[segment["text"] for segment in segments],
                language=[request["language"]] * count,
                speaker=[segment["speaker"] for segment in segments],
                instruct=None if instruct is None else [instruct] * count,
                **gen_kwargs,
            )
    if len(wavs) != count:
        raise RuntimeError(f"qwen-tts returned {len(wavs)} clips for {count} segments")
    seconds: list[float] = []
    for segment, audio in zip(segments, wavs):
        output = segment["output"]
        partial = output + ".part"
        soundfile.write(partial, audio, sample_rate, format="FLAC")
        os.replace(partial, output)
        seconds.append(float(len(audio)) / float(sample_rate))
    return seconds


def protocol_channel() -> Any:
    """Reserve stdout for protocol lines and send everything else written to it to stderr.

    qwen-tts and its native dependencies print banners and warnings on stdout; one such line would
    break the NDJSON stream. The original descriptor is duplicated for responses, then descriptor 1
    and `sys.stdout` are pointed at stderr so later writes from Python or native code land there.
    """
    sys.stdout.flush()
    channel = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return channel


def main() -> int:
    """Answer batch requests until stdin closes, one model call per request.

    The model is loaded on the first request that reaches it. Requests are answered in arrival
    order; the batch is where several segments are generated together.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", choices=("auto", "cuda", "mps", "cpu"), default="auto")
    parser.add_argument(
        "--decoding", choices=("talker-sampled", "fully-sampled"), default="talker-sampled"
    )
    parser.add_argument(
        "--voice-prompt", action="append", nargs=3, metavar=("VOICE", "AUDIO", "TEXT"), default=[],
    )
    args = parser.parse_args()
    channel = protocol_channel()
    speakers = speaker_table(args.model)
    entries: dict[str, tuple[str, str]] = {}
    for voice, audio, text in args.voice_prompt:
        key = voice.lower()
        if key not in speakers:
            raise SystemExit(f"--voice-prompt names {voice}, which is not in the model's talker_config.spk_id table")
        if not os.access(audio, os.R_OK):
            raise SystemExit(f"--voice-prompt audio for {voice} cannot be read: {audio}")
        entries[key] = (audio, text)
    anchors = VoiceAnchors(entries)
    gen_kwargs = decoding_kwargs(args.decoding)
    model: Any | None = None

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id: int | None = None
        try:
            request = request_object(line)
            request_id = request["id"]
            unknown = [s["speaker"] for s in request["segments"] if s["speaker"].lower() not in speakers]
            if unknown:
                raise ValueError(
                    f"speaker {unknown[0]} is not in the model's talker_config.spk_id table"
                )
            if model is None:
                model = load_model(args.model, args.device)
            response = {
                "id": request_id,
                "ok": True,
                "seconds": synthesize(model, anchors, speakers, request, gen_kwargs),
            }
        except Exception as error:
            response = {"id": request_id, "ok": False, "error": str(error)}
        channel.write(json.dumps(response, ensure_ascii=False) + "\n")
        channel.flush()
        # After the response, so the release never delays it; the next request is read after this
        # returns, so no model call overlaps it.
        release_memory()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
