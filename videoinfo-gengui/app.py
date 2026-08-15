"""
NativeOS Admin — main entry.

Boot flow:
  1. .env loaded (from local .env → rn-app/.env.local → process env).
  2. If Supabase is not configured, the only tab is Settings.
  3. Once configured: Content + SeriesUpload (new) + legacy pipeline + Settings.

Cross-tab coordination uses `services.tab_bus.bus`. The bus carries
typed signals so tabs can talk without MainWindow having to know
about every interaction (e.g. ContentTab → SeriesUploadTab on
"上传到此合集" without MainWindow forwarding anything).
"""

from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication, QMainWindow, QTabWidget

from services.env_config import get_supabase_config
from services.tab_bus import bus
from tabs.content_tab import ContentTab
from tabs.series_upload_tab import SeriesUploadTab
from tabs.settings_tab import SettingsTab


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle('NativeOS Admin')
        self.resize(1200, 800)

        self._tabs = QTabWidget()
        self.setCentralWidget(self._tabs)

        # Always-visible: settings (user can re-check connection)
        self._settings_tab = SettingsTab()
        self._settings_idx = self._tabs.addTab(self._settings_tab, '⚙️ 系统设置')

        if get_supabase_config().is_configured:
            self._add_main_tabs()
        else:
            self._tabs.setCurrentIndex(0)

        # Cross-tab focus: any tab can request "bring me to front" by
        # emitting bus.request_focus_tab with the QWidget it wants
        # focused. The window finds the tab index by widget identity.
        bus.request_focus_tab.connect(self._focus_tab_by_widget)

    def _add_main_tabs(self) -> None:
        from tabs.download_tab import DownloadTab
        from tabs.generate_tab import GenerateTab
        from tabs.upload_tab import UploadTab

        # Order matters: content first (daily driver), series upload
        # next (the new step 3), then legacy pipeline.
        self._content_idx = self._tabs.addTab(ContentTab(), '📚 内容管理')
        self._series_upload_idx = self._tabs.addTab(SeriesUploadTab(), '⬆️ 按合集上传')
        self._tabs.addTab(DownloadTab(), '下载')
        self._tabs.addTab(GenerateTab(), '扫描 & 生成')
        self._tabs.addTab(UploadTab(), '自由上传')

    def _focus_tab_by_widget(self, widget) -> None:
        for i in range(self._tabs.count()):
            if self._tabs.widget(i) is widget:
                self._tabs.setCurrentIndex(i)
                return


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName('NativeOS Admin')
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == '__main__':
    raise SystemExit(main())
