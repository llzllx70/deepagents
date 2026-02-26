from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(ROOT / "libs" / "deepagents-cli"))
sys.path.insert(0, str(ROOT / "libs" / "deepagents"))

from deepagents_cli.config import settings

LOG_DIR = ROOT / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
WORKSPACE_DIR = ROOT / "workspace"
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
HISTORY_PATH = DATA_DIR / "chat_history.json"
SESSION_STATE_PATH = DATA_DIR / "session_state.json"
USERS_DIR = DATA_DIR / "users"
USERS_DIR.mkdir(parents=True, exist_ok=True)
AUTH_SESSIONS_PATH = DATA_DIR / "auth_sessions.json"
SESSION_OWNERS_PATH = DATA_DIR / "session_owners.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(filename)s:%(lineno)d - %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "server.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("deepagents_server")

os.environ.setdefault("DEEPAGENTS_PROJECT_SKILLS_DIR", str(ROOT / ".deepagents" / "skills"))
os.environ.setdefault("DEEPAGENTS_USER_SKILLS_ROOT", str(settings.user_deepagents_dir))
