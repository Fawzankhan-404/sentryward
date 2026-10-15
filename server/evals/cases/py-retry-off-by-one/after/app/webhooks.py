import time

import requests

MAX_ATTEMPTS = 3


def deliver(url, payload):
    """POST the payload, trying up to MAX_ATTEMPTS times before giving up."""
    last_error = None
    for attempt in range(1, MAX_ATTEMPTS):
        try:
            response = requests.post(url, json=payload, timeout=10)
            response.raise_for_status()
            return response.status_code
        except requests.RequestException as error:
            last_error = error
            time.sleep(2**attempt)
    raise last_error
