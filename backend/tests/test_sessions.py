"""Session resume/fork plumbing tests that do not require the pi runtime."""

import asyncio
import json
from io import StringIO

import pytest

from config import get_sessions_dir
from api.sessions import _read_session_from_disk
from models import PiConfig
from services.pi_manager import PiManager, PiProcess


class FakePi:
    def __init__(self, cwd: str):
        self.cwd = cwd
        self.session_id = "active-session"
        self.is_alive = True
        self.config = PiConfig()
        self.calls: list[tuple[str, dict]] = []
        self.shutdown_called = False

    async def send_command(self, command: str, **params):
        self.calls.append((command, params))
        return {"success": True}

    async def shutdown(self):
        self.shutdown_called = True


def _write_session(cwd, session_id: str):
    session_dir = get_sessions_dir(str(cwd)) / "encoded"
    session_dir.mkdir(parents=True)
    path = session_dir / f"{session_id}.jsonl"
    path.write_text(json.dumps({"type": "session", "id": session_id}) + "\n")
    return path


def test_find_session_file_uses_exact_session_id(tmp_path):
    mgr = PiManager()
    path = _write_session(tmp_path, "session-123")
    assert mgr._find_session_file("session-123", str(tmp_path)) == path.resolve()
    assert mgr._find_session_file("session-12", str(tmp_path)) is None


def test_read_session_history_uses_workspace_cwd(tmp_path):
    session_dir = get_sessions_dir(str(tmp_path)) / "encoded"
    session_dir.mkdir(parents=True)
    path = session_dir / "session-456.jsonl"
    path.write_text(
        json.dumps({"type": "session", "id": "session-456"})
        + "\n"
        + json.dumps({
            "type": "message",
            "id": "message-1",
            "message": {"role": "user", "content": [{"type": "text", "text": "hello"}]},
        })
        + "\n"
    )
    messages = _read_session_from_disk("session-456", str(tmp_path))
    assert messages[0]["content"][0]["text"] == "hello"


@pytest.mark.anyio
async def test_resume_session_switches_existing_process(tmp_path):
    mgr = PiManager()
    path = _write_session(tmp_path, "session-123")
    cwd = str(tmp_path.resolve())
    fake = FakePi(cwd)
    mgr._processes[cwd] = fake
    mgr._session_map[fake.session_id] = cwd

    resumed = await mgr.resume_session("session-123", cwd, PiConfig())

    assert resumed is fake
    assert fake.calls == [("switch_session", {"sessionPath": str(path.resolve())})]


@pytest.mark.anyio
async def test_resume_session_spawns_directly_on_persisted_file(tmp_path, monkeypatch):
    mgr = PiManager()
    path = _write_session(tmp_path, "session-123")
    spawned = FakePi(str(tmp_path.resolve()))
    spawned.session_id = "session-123"
    calls = []

    async def fake_spawn(cwd, session_dir, config, *, session_path=None):
        calls.append((cwd, session_dir, session_path))
        return spawned

    monkeypatch.setattr(PiProcess, "spawn", fake_spawn)

    resumed = await mgr.resume_session("session-123", str(tmp_path), PiConfig())

    assert resumed is spawned
    assert calls[0][2] == str(path.resolve())
    assert spawned.calls == []
    assert mgr.get_by_session("session-123") is spawned


@pytest.mark.anyio
async def test_restart_session_preserves_id_and_replaces_process(tmp_path, monkeypatch):
    mgr = PiManager()
    path = _write_session(tmp_path, "session-123")
    cwd = str(tmp_path.resolve())
    old = FakePi(cwd)
    mgr._processes[cwd] = old
    mgr._session_map[old.session_id] = cwd
    replacement = FakePi(cwd)
    replacement.session_id = "session-123"

    async def fake_spawn(spawn_cwd, session_dir, config, *, session_path=None):
        assert session_path == str(path.resolve())
        assert config.model == "custom-test/luna"
        return replacement

    monkeypatch.setattr(PiProcess, "spawn", fake_spawn)

    restarted = await mgr.restart_session(
        "session-123",
        cwd,
        PiConfig(model="custom-test/luna"),
    )

    assert old.shutdown_called is True
    assert restarted is replacement
    assert mgr.get_by_session("session-123") is replacement
    assert mgr.get_by_session("active-session") is None


class FakeProcess:
    returncode = None
    stderr = StringIO("")

    @staticmethod
    def poll():
        return None


@pytest.mark.anyio
async def test_event_readers_receive_broadcast_instead_of_stealing_events(tmp_path):
    process = PiProcess(FakeProcess(), str(tmp_path), "session-1", PiConfig())
    first = process.read_events()
    second = process.read_events()
    first_task = asyncio.create_task(anext(first))
    second_task = asyncio.create_task(anext(second))
    await asyncio.sleep(0)

    event = {"type": "agent_start", "sessionId": "session-1"}
    await process._dispatch(event)

    assert await asyncio.wait_for(first_task, timeout=1) == event
    assert await asyncio.wait_for(second_task, timeout=1) == event
    await first.aclose()
    await second.aclose()


@pytest.mark.anyio
async def test_custom_model_switch_restarts_stale_runtime(client, temp_workspace, monkeypatch):
    import api.sessions as sessions_api

    current = FakePi(str(temp_workspace))
    current.session_id = "session-123"

    async def reject_missing_model(command: str, **params):
        assert command == "set_model"
        return {"success": False, "error": "model not found"}

    current.send_command = reject_missing_model
    replacement = FakePi(str(temp_workspace))
    replacement.session_id = "session-123"

    async def restart_session(session_id, cwd, config):
        assert session_id == "session-123"
        assert config.model == "custom-luna/luna-max"
        return replacement

    monkeypatch.setattr(sessions_api.pi_manager, "get_by_session", lambda _session_id: current)
    monkeypatch.setattr(sessions_api.pi_manager, "restart_session", restart_session)

    response = await client.post(
        "/api/sessions/session-123/model",
        params={"cwd": str(temp_workspace)},
        json={"model": "custom-luna/luna-max"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "id": "session-123",
        "model": "custom-luna/luna-max",
        "restarted": True,
    }
