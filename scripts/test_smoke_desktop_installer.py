import errno
import importlib.util
from pathlib import Path
import urllib.error
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('installer_smoke', Path(__file__).with_name('smoke-desktop-installer.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class WebViewCloseTests(unittest.TestCase):
    def test_timeout_keeps_waiting_until_connection_is_refused(self):
        process = MagicMock(spec=['webview_port', 'pid', 'poll', 'terminate', 'kill', 'wait'])
        process.webview_port = 12345
        opener = MagicMock()
        opener.open.side_effect = [urllib.error.URLError(TimeoutError('slow endpoint')),
                                   urllib.error.URLError(ConnectionRefusedError(errno.ECONNREFUSED, 'closed'))]
        with patch.object(smoke.urllib.request, 'build_opener', return_value=opener), patch.object(smoke.time, 'sleep'):
            smoke.stop(process)
        self.assertEqual(opener.open.call_count, 2)

    def test_only_timeouts_fail_instead_of_crediting_an_old_webview(self):
        process = MagicMock(spec=['webview_port', 'pid', 'poll', 'terminate', 'kill', 'wait'])
        process.webview_port = 12345
        opener = MagicMock()
        opener.open.side_effect = urllib.error.URLError(TimeoutError('still listening'))
        with patch.object(smoke.urllib.request, 'build_opener', return_value=opener), patch.object(smoke.time, 'sleep'), patch.object(smoke.time, 'monotonic', side_effect=[0, 1, 31]):
            with self.assertRaisesRegex(RuntimeError, 'Old WebView remained running'):
                smoke.stop(process)


if __name__ == '__main__':
    unittest.main()
