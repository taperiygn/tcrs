from __future__ import annotations

import os
from pathlib import Path


def password_file_candidates() -> list[Path]:
    repo_root = Path(__file__).resolve().parent.parent
    candidates = []
    configured = os.environ.get("TCRS_PASSWORD_FILE", "").strip()
    if configured:
        candidates.append(Path(configured).expanduser())
    candidates.extend([
        repo_root / ".M",
        repo_root / "backend" / ".M",
        Path.home() / ".config" / "tcrs" / ".M",
    ])
    return candidates


def load_password() -> str:
    env_password = os.environ.get("TCRS_PASSWORD", "").strip()
    if env_password:
        return env_password

    for candidate in password_file_candidates():
        try:
            if not candidate.exists():
                continue
            for raw_line in candidate.read_text("utf-8", errors="replace").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                return line
        except OSError:
            continue
    return ""
