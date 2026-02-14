"""Docker sandbox backend implementation."""

from __future__ import annotations

import shlex
import subprocess
import tempfile
from pathlib import Path

from deepagents.backends.protocol import (
    EditResult,
    ExecuteResponse,
    FileDownloadResponse,
    FileOperationError,
    FileUploadResponse,
    WriteResult,
)
from deepagents.backends.sandbox import BaseSandbox
from deepagents.backends.utils import perform_string_replacement

_DEFAULT_TIMEOUT_SECONDS = 120


def _combine_output(stdout: str | None, stderr: str | None) -> str:
    return f"{stdout or ''}{stderr or ''}".rstrip()


def _infer_cp_error(stderr: str, *, is_upload: bool) -> FileOperationError:
    lowered = stderr.lower()
    if "permission denied" in lowered:
        return "permission_denied"
    if "no such file or directory" in lowered or "not found" in lowered:
        return "invalid_path" if is_upload else "file_not_found"
    if "is a directory" in lowered or "not a directory" in lowered:
        return "is_directory"
    return "invalid_path"


class DockerSandboxBackend(BaseSandbox):
    """Sandbox backend that executes commands inside a Docker container."""

    def __init__(
        self,
        container_id: str,
        *,
        workdir: str = "/workspace",
        timeout_seconds: int = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._container_id = container_id
        self._workdir = workdir
        self._timeout_seconds = timeout_seconds

    @property
    def id(self) -> str:
        return self._container_id

    @property
    def workdir(self) -> str:
        return self._workdir

    def execute(self, command: str) -> ExecuteResponse:
        args = [
            "docker",
            "exec",
            "-w",
            self._workdir,
            self._container_id,
            "bash",
            "-lc",
            command,
        ]
        try:
            result = subprocess.run(
                args,
                capture_output=True,
                text=True,
                timeout=self._timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            output = _combine_output(exc.stdout, exc.stderr)
            if output:
                output = f"{output}\nCommand timed out."
            else:
                output = "Command timed out."
            return ExecuteResponse(output=output, exit_code=124, truncated=True)

        output = _combine_output(result.stdout, result.stderr)
        return ExecuteResponse(output=output, exit_code=result.returncode)

    def write(self, file_path: str, content: str) -> WriteResult:
        """Write file content using docker cp to avoid oversized exec args."""
        # Match FilesystemBackend semantics: refuse to overwrite existing files.
        check = self.execute(f"test -e {shlex.quote(file_path)}")
        if check.exit_code == 0:
            return WriteResult(
                error=(
                    f"Cannot write to {file_path} because it already exists. "
                    "Read and then make an edit, or write to a new path."
                )
            )
        if check.exit_code not in (1,):
            msg = check.output.strip() or "Unknown error checking file existence."
            return WriteResult(error=f"Error writing file '{file_path}': {msg}")

        response = self.upload_files([(file_path, content.encode("utf-8"))])[0]
        if response.error:
            return WriteResult(error=f"Error writing file '{file_path}': {response.error}")
        return WriteResult(path=file_path, files_update=None)

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        """Edit a file by download/replace/upload to avoid shell arg size limits."""
        response = self.download_files([file_path])[0]
        if response.error or response.content is None:
            return EditResult(error=f"Error: File '{file_path}' not found")

        try:
            content = response.content.decode("utf-8")
        except UnicodeDecodeError as exc:
            return EditResult(error=f"Error editing file '{file_path}': {exc}")

        replacement = perform_string_replacement(
            content,
            old_string,
            new_string,
            replace_all,
        )
        if isinstance(replacement, str):
            return EditResult(error=replacement)

        new_content, occurrences = replacement
        upload = self.upload_files([(file_path, new_content.encode("utf-8"))])[0]
        if upload.error:
            return EditResult(error=f"Error editing file '{file_path}': {upload.error}")

        return EditResult(
            path=file_path,
            files_update=None,
            occurrences=int(occurrences),
        )

    def pause(self) -> None:
        self._set_pause_state(paused=True)

    def unpause(self) -> None:
        self._set_pause_state(paused=False)

    def _set_pause_state(self, *, paused: bool) -> None:
        action = "pause" if paused else "unpause"
        args = ["docker", action, self._container_id]
        try:
            result = subprocess.run(
                args,
                capture_output=True,
                text=True,
                timeout=self._timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            output = _combine_output(exc.stdout, exc.stderr)
            msg = output or f"Timed out trying to {action} Docker sandbox."
            raise RuntimeError(msg) from exc
        if result.returncode == 0:
            return
        stderr = result.stderr.strip()
        lowered = stderr.lower()
        if paused and "already paused" in lowered:
            return
        if not paused and "not paused" in lowered:
            return
        msg = stderr or f"Failed to {action} Docker sandbox."
        raise RuntimeError(msg)

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        responses: list[FileUploadResponse] = []
        for path, content in files:
            error: FileOperationError | None = None
            tmp_path: Path | None = None
            try:
                parent = Path(path).parent
                if str(parent) not in ("", "."):
                    mkdir_cmd = f"mkdir -p {shlex.quote(str(parent))}"
                    self.execute(mkdir_cmd)

                with tempfile.NamedTemporaryFile(delete=False) as tmp_file:
                    tmp_file.write(content)
                    tmp_path = Path(tmp_file.name)

                args = ["docker", "cp", str(tmp_path), f"{self._container_id}:{path}"]
                result = subprocess.run(
                    args,
                    capture_output=True,
                    text=True,
                    timeout=self._timeout_seconds,
                )
                if result.returncode != 0:
                    error = _infer_cp_error(result.stderr, is_upload=True)
            except subprocess.TimeoutExpired:
                error = "invalid_path"
            except OSError:
                error = "invalid_path"
            finally:
                if tmp_path and tmp_path.exists():
                    tmp_path.unlink()
            responses.append(FileUploadResponse(path=path, error=error))
        return responses

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        responses: list[FileDownloadResponse] = []
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_root = Path(tmp_dir)
            for index, path in enumerate(paths):
                error: FileOperationError | None = None
                content: bytes | None = None
                dest_path = tmp_root / f"payload-{index}"
                if dest_path.exists():
                    if dest_path.is_dir():
                        for child in dest_path.iterdir():
                            if child.is_file():
                                child.unlink()
                        dest_path.rmdir()
                    else:
                        dest_path.unlink()
                try:
                    args = [
                        "docker",
                        "cp",
                        f"{self._container_id}:{path}",
                        str(dest_path),
                    ]
                    result = subprocess.run(
                        args,
                        capture_output=True,
                        text=True,
                        timeout=self._timeout_seconds,
                    )
                    if result.returncode != 0:
                        error = _infer_cp_error(result.stderr, is_upload=False)
                    else:
                        if dest_path.is_dir():
                            error = "is_directory"
                        else:
                            content = dest_path.read_bytes()
                except subprocess.TimeoutExpired:
                    error = "invalid_path"
                except OSError:
                    error = "invalid_path"
                responses.append(
                    FileDownloadResponse(path=path, content=content, error=error)
                )
                if dest_path.exists():
                    if dest_path.is_dir():
                        for child in dest_path.iterdir():
                            if child.is_file():
                                child.unlink()
                        dest_path.rmdir()
                    else:
                        dest_path.unlink()
        return responses

    def copy_workspace_to_host(self, target_dir: Path) -> None:
        target_dir.mkdir(parents=True, exist_ok=True)
        args = [
            "docker",
            "cp",
            f"{self._container_id}:{self._workdir}/.",
            str(target_dir),
        ]
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=self._timeout_seconds,
        )
        if result.returncode != 0:
            stderr = result.stderr.strip()
            msg = stderr or "Failed to copy workspace from container."
            raise RuntimeError(msg)


def ensure_docker_available() -> None:
    result = subprocess.run(
        ["docker", "version"],
        capture_output=True,
        text=True,
        timeout=_DEFAULT_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        msg = result.stderr.strip() or "Docker is not available."
        raise RuntimeError(msg)
