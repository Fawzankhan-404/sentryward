import requests


def deliver(url, payload):
    response = requests.post(url, json=payload, timeout=10)
    response.raise_for_status()
    return response.status_code
