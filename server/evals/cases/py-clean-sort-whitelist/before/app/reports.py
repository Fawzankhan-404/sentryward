from .db import connection


def list_reports(owner_id):
    with connection() as conn:
        cursor = conn.execute(
            "SELECT id, title, created_at FROM reports WHERE owner_id = %s ORDER BY created_at DESC",
            (owner_id,),
        )
        return cursor.fetchall()
