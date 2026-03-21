
import json, bisect

INDEX_PATH = "/opt/void-memory/data/tasm-temporal-index.json"

def load_index():
    with open(INDEX_PATH) as f:
        return json.load(f)

def range_query(start_date, end_date, index=None):
    """Binary search for blocks between two dates. O(log n)."""
    if index is None:
        index = load_index()
    timestamps = [e["ts"] for e in index]
    left = bisect.bisect_left(timestamps, start_date)
    right = bisect.bisect_right(timestamps, end_date)
    return index[left:right]

def before(date, n=5, index=None):
    """Get n blocks before a given date."""
    if index is None:
        index = load_index()
    timestamps = [e["ts"] for e in index]
    pos = bisect.bisect_left(timestamps, date)
    return index[max(0, pos-n):pos]

def after(date, n=5, index=None):
    """Get n blocks after a given date."""
    if index is None:
        index = load_index()
    timestamps = [e["ts"] for e in index]
    pos = bisect.bisect_right(timestamps, date)
    return index[pos:pos+n]

def most_recent(n=5, index=None):
    """Get n most recent blocks."""
    if index is None:
        index = load_index()
    return index[-n:]
