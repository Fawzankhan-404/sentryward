from dataclasses import dataclass


@dataclass
class Notification:
    user_id: int
    message: str


def build_notification(user_id, message):
    return Notification(user_id=user_id, message=message)
