"""Memory-release tests for the TTS worker.

These exercise `release_memory` against stand-in torch modules, so they need neither torch nor the
Qwen weights. Run them directly from the repository root:

    python3 -m pytest ebook-reader/python
"""

from __future__ import annotations

import gc
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "tts_worker", Path(__file__).with_name("tts_worker.py")
)
assert _SPEC is not None and _SPEC.loader is not None
worker = importlib.util.module_from_spec(_SPEC)
sys.modules["tts_worker"] = worker
_SPEC.loader.exec_module(worker)


class FakeAllocator:
    """One device's allocator, recording the emptying the worker asks for."""

    def __init__(self, available: bool) -> None:
        self.available = available
        self.emptied = 0

    def is_available(self) -> bool:
        return self.available

    def empty_cache(self) -> None:
        self.emptied += 1


def fake_torch(cuda: FakeAllocator, mps: FakeAllocator | None) -> Any:
    """A torch stand-in exposing only what `release_memory` reads.

    @param cuda - the CUDA allocator.
    @param mps - the MPS allocator, or `None` for a build without that backend.
    """
    backends = SimpleNamespace() if mps is None else SimpleNamespace(mps=mps)
    return SimpleNamespace(cuda=cuda, mps=mps, backends=backends)


@pytest.fixture(autouse=True)
def _without_torch(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each test states the torch it runs against; none inherits a real one."""
    monkeypatch.delitem(sys.modules, "torch", raising=False)


def test_release_without_torch_collects_python_objects() -> None:
    collected: list[str] = []

    class Canary:
        def __init__(self) -> None:
            self.self_reference = self

        def __del__(self) -> None:
            collected.append("canary")

    Canary()
    gc.disable()
    try:
        worker.release_memory()
    finally:
        gc.enable()
    assert collected == ["canary"]


def test_release_empties_the_available_device(monkeypatch: pytest.MonkeyPatch) -> None:
    cuda = FakeAllocator(available=True)
    mps = FakeAllocator(available=False)
    monkeypatch.setitem(sys.modules, "torch", fake_torch(cuda, mps))
    worker.release_memory()
    assert (cuda.emptied, mps.emptied) == (1, 0)

    cuda = FakeAllocator(available=False)
    mps = FakeAllocator(available=True)
    monkeypatch.setitem(sys.modules, "torch", fake_torch(cuda, mps))
    worker.release_memory()
    assert (cuda.emptied, mps.emptied) == (0, 1)


def test_release_on_cpu_touches_no_allocator(monkeypatch: pytest.MonkeyPatch) -> None:
    cuda = FakeAllocator(available=False)
    mps = FakeAllocator(available=False)
    monkeypatch.setitem(sys.modules, "torch", fake_torch(cuda, mps))
    worker.release_memory()
    assert (cuda.emptied, mps.emptied) == (0, 0)


def test_release_on_a_build_without_mps(monkeypatch: pytest.MonkeyPatch) -> None:
    cuda = FakeAllocator(available=False)
    monkeypatch.setitem(sys.modules, "torch", fake_torch(cuda, None))
    worker.release_memory()
    assert cuda.emptied == 0
