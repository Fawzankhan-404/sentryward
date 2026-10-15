from datetime import datetime, timezone


def is_active(subscription):
    if subscription.cancelled_at is not None:
        return False
    return subscription.current_period_end > datetime.now(timezone.utc)
