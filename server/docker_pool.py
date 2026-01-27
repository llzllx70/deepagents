"""Docker sandbox pool management."""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path

from .docker import DockerSandboxBackend, ensure_docker_available

logger = logging.getLogger(__name__)


@dataclass
class DockerPoolConfig:
    image: str
    pool_size: int
    min_idle: int
    workdir: str = "/workspace"
    cpus: str | None = None
    memory: str | None = None
    pids_limit: str | None = None
    bind_workspace: bool = False

    @classmethod
    def from_env(cls) -> "DockerPoolConfig":
        def _int_from_env(name: str, default: int) -> int:
            raw = os.environ.get(name)
            if raw is None:
                return default
            try:
                return int(raw)
            except ValueError:
                return default

        def _bool_from_env(name: str, default: bool) -> bool:
            raw = os.environ.get(name)
            if raw is None:
                return default
            return raw.strip().lower() in ("1", "true", "yes", "on")

        image = os.environ.get("DEEPAGENTS_DOCKER_IMAGE", "deepagents-sandbox:22.04")
        pool_size = _int_from_env("DEEPAGENTS_DOCKER_POOL_SIZE", 10)
        min_idle = _int_from_env("DEEPAGENTS_DOCKER_MIN_IDLE", 2)
        workdir = os.environ.get("DEEPAGENTS_DOCKER_WORKDIR", "/workspace")
        cpus = os.environ.get("DEEPAGENTS_DOCKER_CPUS")
        memory = os.environ.get("DEEPAGENTS_DOCKER_MEMORY")
        pids_limit = os.environ.get("DEEPAGENTS_DOCKER_PIDS_LIMIT")
        bind_workspace = _bool_from_env("DEEPAGENTS_DOCKER_BIND_WORKSPACE", False)

        if pool_size < 1:
            pool_size = 1
        if min_idle < 0:
            min_idle = 0
        if min_idle > pool_size:
            min_idle = pool_size

        return cls(
            image=image,
            pool_size=pool_size,
            min_idle=min_idle,
            workdir=workdir,
            cpus=cpus,
            memory=memory,
            pids_limit=pids_limit,
            bind_workspace=bind_workspace,
        )


class DockerSandboxPool:
    """Maintain a warm pool of running Docker sandboxes."""

    def __init__(self, config: DockerPoolConfig) -> None:
        self._config = config
        self._pool_id = uuid.uuid4().hex[:8]
        self._idle: set[str] = set()
        self._in_use: set[str] = set()
        self._lock = asyncio.Lock()

    @property
    def config(self) -> DockerPoolConfig:
        return self._config

    async def start(self) -> None:
        await asyncio.to_thread(ensure_docker_available)
        logger.info(
            "Docker pool startup: image=%s pool_size=%s min_idle=%s bind_workspace=%s",
            self._config.image,
            self._config.pool_size,
            self._config.min_idle,
            self._config.bind_workspace,
        )
        if self._config.bind_workspace:
            logger.info("Docker pool bind_workspace enabled; skipping idle warmup")
            return
        await self._ensure_idle(self._config.pool_size)

    async def acquire_for_session(
        self, session_id: str, workspace_dir: Path | None = None
    ) -> DockerSandboxBackend:
        if self._config.bind_workspace:
            if workspace_dir is None:
                msg = "workspace_dir required when bind_workspace is enabled."
                raise RuntimeError(msg)
            container_id = await asyncio.to_thread(
                self._create_container, name=session_id, workspace_dir=workspace_dir
            )
            await asyncio.to_thread(self._unpause_container, container_id)
            async with self._lock:
                self._in_use.add(session_id)
                in_use_count = len(self._in_use)
            logger.info(
                "Docker pool acquire session (bind workspace): session_id=%s in_use=%s",
                session_id,
                in_use_count,
            )
            return DockerSandboxBackend(session_id, workdir=self._config.workdir)

        container_id: str | None = None
        async with self._lock:
            if self._idle:
                container_id = self._idle.pop()
                should_expand = len(self._idle) < self._config.min_idle
            else:
                should_expand = self._config.pool_size > 0
            idle_count = len(self._idle)

        if container_id is not None:
            await asyncio.to_thread(self._rename_container, container_id, session_id)
        else:
            container_id = await asyncio.to_thread(self._create_container, name=session_id)
        if container_id is None:
            msg = "Failed to acquire Docker sandbox."
            raise RuntimeError(msg)
        await asyncio.to_thread(self._unpause_container, container_id)

        async with self._lock:
            self._in_use.add(session_id)
            in_use_count = len(self._in_use)

        if should_expand:
            await self._ensure_idle(self._config.pool_size)

        logger.info(
            "Docker pool acquire session: session_id=%s idle=%s in_use=%s",
            session_id,
            idle_count,
            in_use_count,
        )
        return DockerSandboxBackend(session_id, workdir=self._config.workdir)

    async def shutdown(self) -> None:
        async with self._lock:
            all_ids = list(self._idle | self._in_use)
            self._idle.clear()
            self._in_use.clear()
        logger.info("Docker pool shutdown: containers=%s", len(all_ids))
        for container_id in all_ids:
            await asyncio.to_thread(self._remove_container, container_id)

    async def acquire(self) -> DockerSandboxBackend:
        if self._config.bind_workspace:
            msg = "Docker pool bind_workspace enabled; use acquire_for_session instead."
            raise RuntimeError(msg)

        async with self._lock:
            has_idle = bool(self._idle)

        if not has_idle:
            await self._ensure_idle(self._config.pool_size)

        async with self._lock:
            if not self._idle:
                msg = "No Docker sandboxes available."
                raise RuntimeError(msg)
            container_id = self._idle.pop()
            self._in_use.add(container_id)
            should_expand = len(self._idle) < self._config.min_idle
            idle_count = len(self._idle)
            in_use_count = len(self._in_use)

        if should_expand:
            await self._ensure_idle(self._config.pool_size)

        logger.info(
            "Docker pool acquire: container_id=%s idle=%s in_use=%s",
            container_id,
            idle_count,
            in_use_count,
        )
        await asyncio.to_thread(self._unpause_container, container_id)
        return DockerSandboxBackend(container_id, workdir=self._config.workdir)

    async def release(self, backend: DockerSandboxBackend) -> None:
        container_id = backend.id
        if self._config.bind_workspace:
            async with self._lock:
                if container_id in self._in_use:
                    self._in_use.remove(container_id)
                idle_count = len(self._idle)
                in_use_count = len(self._in_use)
            logger.info(
                "Docker pool release (bind workspace): container_id=%s idle=%s in_use=%s",
                container_id,
                idle_count,
                in_use_count,
            )
            await asyncio.to_thread(self._remove_container, container_id)
            return

        extra_ids: list[str] = []
        async with self._lock:
            if container_id in self._in_use:
                self._in_use.remove(container_id)
                self._idle.add(container_id)
            if len(self._idle) > self._config.pool_size:
                extra_count = len(self._idle) - self._config.pool_size
                extra_ids = list(self._idle)[:extra_count]
                for extra_id in extra_ids:
                    self._idle.remove(extra_id)
            idle_count = len(self._idle)
            in_use_count = len(self._in_use)
        logger.info(
            "Docker pool release: container_id=%s idle=%s in_use=%s extra=%s",
            container_id,
            idle_count,
            in_use_count,
            len(extra_ids),
        )
        for extra_id in extra_ids:
            await asyncio.to_thread(self._remove_container, extra_id)

    async def remove(self, backend: DockerSandboxBackend) -> None:
        container_id = backend.id
        async with self._lock:
            was_in_use = container_id in self._in_use
            was_idle = container_id in self._idle
            if was_in_use:
                self._in_use.remove(container_id)
            if was_idle:
                self._idle.remove(container_id)
            idle_count = len(self._idle)
            in_use_count = len(self._in_use)
        logger.info(
            "Docker pool remove: container_id=%s idle=%s in_use=%s",
            container_id,
            idle_count,
            in_use_count,
        )
        await asyncio.to_thread(self._remove_container, container_id)
        if self._config.bind_workspace:
            return
        if idle_count < self._config.min_idle:
            await self._ensure_idle(self._config.pool_size)

    async def sync_workspace(self, backend: DockerSandboxBackend, target_dir: Path) -> None:
        await asyncio.to_thread(backend.copy_workspace_to_host, target_dir)

    async def _ensure_idle(self, target: int) -> None:
        if self._config.bind_workspace:
            return
        async with self._lock:
            missing = max(0, target - len(self._idle))
        if missing <= 0:
            return
        logger.info("Docker pool ensure idle: missing=%s target=%s", missing, target)
        created: list[str] = []
        for _ in range(missing):
            container_id = await asyncio.to_thread(self._create_container)
            created.append(container_id)
        async with self._lock:
            self._idle.update(created)

    def _create_container(
        self, *, name: str | None = None, workspace_dir: Path | None = None
    ) -> str:
        if name is None:
            name = f"deepagents-sbx-{self._pool_id}-{uuid.uuid4().hex[:6]}"
        user_skills_root = os.environ.get(
            "DEEPAGENTS_USER_SKILLS_ROOT", str(Path.home() / ".deepagents")
        )
        project_skills_dir = os.environ.get(
            "DEEPAGENTS_PROJECT_SKILLS_DIR",
            str(Path.cwd() / ".deepagents" / "skills"),
        )
        user_skills_path = Path(user_skills_root).expanduser()
        project_skills_path = Path(project_skills_dir).expanduser()
        user_skills_path.mkdir(parents=True, exist_ok=True)
        project_skills_path.mkdir(parents=True, exist_ok=True)
        args = [
            "docker",
            "run",
            "-d",
            "--name",
            name,
            "--label",
            f"deepagents.pool_id={self._pool_id}",
            "--label",
            "deepagents.managed=1",
            "-v",
            f"{user_skills_path}:/user-skills:ro",
            "-v",
            f"{project_skills_path}:/skills:ro",
        ]
        if workspace_dir is not None:
            workspace_path = workspace_dir.resolve()
            args += ["-v", f"{workspace_path}:{self._config.workdir}"]
        if self._config.cpus:
            args += ["--cpus", self._config.cpus]
        if self._config.memory:
            args += ["--memory", self._config.memory]
        if self._config.pids_limit:
            args += ["--pids-limit", self._config.pids_limit]
        args.append(self._config.image)

        result = subprocess.run(args, capture_output=True, text=True)
        logger.debug(
            "Docker run args=%s rc=%s stdout=%s stderr=%s",
            args,
            result.returncode,
            result.stdout.strip(),
            result.stderr.strip(),
        )
        if result.returncode != 0:
            msg = result.stderr.strip() or "Failed to start Docker sandbox."
            raise RuntimeError(msg)
        container_id = result.stdout.strip()
        self._pause_container(container_id)
        logger.info("Started Docker sandbox %s", container_id)
        return container_id

    def _rename_container(self, container_id: str, new_name: str) -> None:
        result = subprocess.run(
            ["docker", "rename", container_id, new_name],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            msg = result.stderr.strip() or "Failed to rename Docker sandbox."
            raise RuntimeError(msg)

    def _remove_container(self, container_id: str) -> None:
        result = subprocess.run(
            ["docker", "rm", "-f", container_id],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            msg = result.stderr.strip() or "Failed to remove Docker sandbox."
            logger.warning("Docker sandbox cleanup failed for %s: %s", container_id, msg)
        else:
            logger.info("Removed Docker sandbox %s", container_id)

    def _pause_container(self, container_id: str) -> None:
        result = subprocess.run(
            ["docker", "pause", container_id],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            stderr = result.stderr.strip()
            if "already paused" in stderr.lower():
                return
            msg = stderr or "Failed to pause Docker sandbox."
            raise RuntimeError(msg)

    def _unpause_container(self, container_id: str) -> None:
        result = subprocess.run(
            ["docker", "unpause", container_id],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            stderr = result.stderr.strip()
            if "not paused" in stderr.lower():
                return
            msg = stderr or "Failed to unpause Docker sandbox."
            raise RuntimeError(msg)
