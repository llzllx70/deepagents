"""Tests for Docker sandbox pool behavior."""

from pathlib import Path

import pytest

from deepagents_cli.integrations.docker_pool import DockerPoolConfig, DockerSandboxPool


@pytest.mark.asyncio
async def test_acquire_for_session_unpauses_bind_workspace(
    tmp_path: Path, monkeypatch
) -> None:
    config = DockerPoolConfig(
        image="deepagents-sandbox:22.04",
        pool_size=1,
        min_idle=0,
        bind_workspace=True,
    )
    pool = DockerSandboxPool(config)
    calls: dict[str, str] = {}

    def fake_create_container(
        *, name: str | None = None, workspace_dir: Path | None = None
    ) -> str:
        assert name == "session-1"
        assert workspace_dir == tmp_path
        return "container-1"

    def fake_unpause(container_id: str) -> None:
        calls["container_id"] = container_id

    monkeypatch.setattr(pool, "_create_container", fake_create_container)
    monkeypatch.setattr(pool, "_unpause_container", fake_unpause)

    backend = await pool.acquire_for_session("session-1", tmp_path)

    assert calls["container_id"] == "container-1"
    assert backend.id == "session-1"


@pytest.mark.asyncio
async def test_acquire_for_session_unpauses_idle_container(monkeypatch) -> None:
    config = DockerPoolConfig(
        image="deepagents-sandbox:22.04",
        pool_size=1,
        min_idle=0,
        bind_workspace=False,
    )
    pool = DockerSandboxPool(config)
    pool._idle.add("container-2")
    calls: dict[str, str] = {}

    def fake_rename(container_id: str, new_name: str) -> None:
        assert container_id == "container-2"
        assert new_name == "session-2"

    def fake_unpause(container_id: str) -> None:
        calls["container_id"] = container_id

    monkeypatch.setattr(pool, "_rename_container", fake_rename)
    monkeypatch.setattr(pool, "_unpause_container", fake_unpause)

    backend = await pool.acquire_for_session("session-2")

    assert calls["container_id"] == "container-2"
    assert backend.id == "session-2"
