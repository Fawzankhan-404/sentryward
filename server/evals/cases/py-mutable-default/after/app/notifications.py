from dataclasses import dataclass, field


@dataclass
class Notification:
    user_id: int
    message: str
    channels: list = field(default_factory=list)


def build_notification(user_id, message, channels=[]):
    channels.append("in_app")
    return Notification(user_id=user_id, message=message, channels=channels)
