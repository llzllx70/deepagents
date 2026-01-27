"""Read-only backend wrapper for safety in shared host paths."""

from __future__ import annotations

from deepagents.backends.protocol import (
    BackendProtocol,
    EditResult,
    FileDownloadResponse,
    FileInfo,
    FileUploadResponse,
    GrepMatch,
    WriteResult,
)


class ReadOnlyBackend(BackendProtocol):
    """Wrap a backend and block mutating operations."""

    def __init__(self, backend: BackendProtocol) -> None:
        self._backend = backend

    def ls_info(self, path: str) -> list[FileInfo]:
        return self._backend.ls_info(path)

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> str:
        return self._backend.read(file_path, offset=offset, limit=limit)

    def glob_info(self, pattern: str, path: str = "/") -> list[FileInfo]:
        return self._backend.glob_info(pattern, path=path)

    def grep_raw(
        self, pattern: str, path: str | None = None, glob: str | None = None
    ) -> list[GrepMatch] | str:
        return self._backend.grep_raw(pattern, path=path, glob=glob)

    def write(self, file_path: str, content: str) -> WriteResult:
        return WriteResult(error="Permission denied: read-only backend")

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        return EditResult(error="Permission denied: read-only backend")

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return [
            FileUploadResponse(path=path, error="permission_denied")
            for path, _ in files
        ]

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return self._backend.download_files(paths)
