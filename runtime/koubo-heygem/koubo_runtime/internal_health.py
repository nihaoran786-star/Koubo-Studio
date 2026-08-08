from __future__ import annotations

import sys
import time
import urllib.error
import urllib.request

HEALTH_URL = "http://127.0.0.1:8384/health"
ATTEMPTS = 60
INTERVAL_SECONDS = 1.0


def wait_until_healthy() -> bool:
    for attempt in range(ATTEMPTS):
        try:
            request = urllib.request.Request(HEALTH_URL, method="GET")
            with urllib.request.urlopen(request, timeout=1.0) as response:
                if 200 <= response.status < 300:
                    return True
        except (urllib.error.URLError, TimeoutError):
            pass
        if attempt + 1 < ATTEMPTS:
            time.sleep(INTERVAL_SECONDS)
    return False


if __name__ == "__main__":
    sys.exit(0 if wait_until_healthy() else 1)
