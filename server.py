#!/usr/bin/env python3
"""Compatibility wrapper for the split frontend/backend architecture.

The live backend now lives under backend/server.py. Keeping this file as a thin
wrapper preserves current scripts and tests while the app uses the dedicated
backend directory for production deployments. The canonical site files live in
frontend/ — served from here too so local runs and tests use the same copy the
deployments do.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# serve the canonical frontend/ unless the caller chose a site dir
os.environ.setdefault(
    "TCRS_SITE_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend"))

from backend.server import main


if __name__ == "__main__":
    main()
