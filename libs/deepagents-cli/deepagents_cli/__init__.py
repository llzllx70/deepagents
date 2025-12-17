"""DeepAgents CLI - Interactive AI coding assistant."""

def cli_main() -> None:
    """Entry point for the CLI.

    Kept as a thin wrapper to avoid importing the full CLI dependency tree on
    `import deepagents_cli` (helps unit tests and lightweight imports).
    """
    from deepagents_cli.main import cli_main as _cli_main

    _cli_main()

__all__ = ["cli_main"]
