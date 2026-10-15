from .db import connection

# Column names cannot be bound as parameters, so the sort key is mapped onto a
# fixed set of SQL fragments and anything else falls back to the default.
SORT_COLUMNS = {
    "newest": "created_at DESC",
    "oldest": "created_at ASC",
    "title": "title ASC",
}


def list_reports(owner_id, sort="newest"):
    order_by = SORT_COLUMNS.get(sort, SORT_COLUMNS["newest"])
    with connection() as conn:
        cursor = conn.execute(
            f"SELECT id, title, created_at FROM reports WHERE owner_id = %s ORDER BY {order_by}",
            (owner_id,),
        )
        return cursor.fetchall()
