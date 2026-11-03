#!/usr/bin/env python3
"""Compatibility wrapper for the split frontend/backend architecture.

The live backend now lives under backend/server.py. Keeping this file as a thin
wrapper preserves current scripts and tests while the app uses the dedicated
backend directory for production deployments.
"""

from backend.server import main


if __name__ == "__main__":
    main()
