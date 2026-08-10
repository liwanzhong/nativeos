import sys

from PySide6.QtWidgets import QApplication, QMainWindow, QTabWidget

from tabs.download_tab import DownloadTab
from tabs.generate_tab import GenerateTab
from tabs.upload_tab import UploadTab


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle('Video Info GenGUI')
        self.resize(1100, 750)

        tabs = QTabWidget()
        tabs.addTab(DownloadTab(), '下载视频')
        tabs.addTab(GenerateTab(), '扫描 & 生成')
        tabs.addTab(UploadTab(), '上传')
        self.setCentralWidget(tabs)


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName('Video Info GenGUI')
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == '__main__':
    raise SystemExit(main())
