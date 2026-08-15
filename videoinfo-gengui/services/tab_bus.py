"""
Cross-tab message bus. The ContentTab and SeriesUploadTab live in
different QTabWidget positions; the natural Qt way to coordinate
them is via signals. We use a QObject singleton (`bus`) instead of
threading signals through MainWindow — that way any tab can listen
without MainWindow having to know about all of them.

Usage:
    from services.tab_bus import bus
    bus.upload_series_requested.connect(my_slot)
    bus.upload_series_requested.emit('peppa-pig')
"""

from __future__ import annotations

from typing import Any

from PySide6.QtCore import QObject, Signal


class TabBus(QObject):
    # Emitted by ContentTab when the user clicks "上传到此合集".
    # SeriesUploadTab listens and pre-selects that series.
    upload_series_requested = Signal(str)

    # Emitted by any tab that wants MainWindow to switch to a specific
    # tab. Payload is the QWidget itself so MainWindow can find its
    # index by identity (no hardcoded magic numbers).
    request_focus_tab = Signal(QObject)


# Module-level singleton. Safe to import from anywhere; PySide6 is
# happy to share QObject instances across the app.
bus = TabBus()
