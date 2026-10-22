import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('split_depth_runtime', Path(__file__).with_name('split-depth-runtime.py'))
split = importlib.util.module_from_spec(spec)
spec.loader.exec_module(split)


class SplitRuntimeTests(unittest.TestCase):
    def make_archive(self, path, bad_record=False, record_override=None):
        with zipfile.ZipFile(path, 'w') as archive:
            for name, value in {
                '.python/python.exe': b'python',
                '.python/python311.dll': b'python DLL',
                '.python/Lib/os.py': b'stdlib',
                split.SITE + 'pip/__main__.py': b'pip',
                split.SITE + 'numpy/__init__.py': b'numpy',
                split.SITE + 'cv2/__init__.py': b'cv2',
                split.SITE + 'torch/__init__.py': b'torch',
                split.SITE + 'torch/__pycache__/unrecorded.pyc': b'pyc',
                split.SITE + 'functorch/lib.dll': b'functorch',
                split.SITE + 'torchgen/gen.py': b'torchgen',
                split.SITE + 'torchvision/__init__.py': b'vision',
                split.SITE + 'torch-2.8.0+cu128.dist-info/RECORD': record_override if record_override is not None else b'../../../../escape.py,,\n' if bad_record else b'torch/__init__.py,,\nfunctorch/lib.dll,,\ntorchgen/gen.py,,\nbin/torchrun.exe,,\nbin/torchfrtrace.exe,,\n',
                split.SITE + 'torchvision-0.23.0+cu128.dist-info/RECORD': b'torchvision/__init__.py,,\n',
                'worker/depth_capture/__init__.py': b'worker',
            }.items():
                archive.writestr(name.replace('/', '\\'), value)

    def test_only_torch_owned_roots_are_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root/'full.zip', root/'base.zip'
            self.make_archive(source)
            original = source.read_bytes()
            metadata = split.split_archive(source, target)
            self.assertEqual(source.read_bytes(), original)
            with zipfile.ZipFile(target) as archive:
                self.assertEqual(archive.namelist(), ['.python/python.exe', '.python/python311.dll', '.python/Lib/os.py', split.SITE+'pip/__main__.py', split.SITE+'numpy/__init__.py', split.SITE+'cv2/__init__.py', 'worker/depth_capture/__init__.py'])
                self.assertEqual(archive.read(split.SITE+'numpy/__init__.py'), b'numpy')
            self.assertEqual(metadata['externalVersions'], {'torch':'2.8.0+cu128', 'torchvision':'0.23.0+cu128'})
            with self.assertRaises(ValueError):
                split.split_archive(source, target)

    def test_bad_record_cannot_create_a_base(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.make_archive(root/'full.zip', bad_record=True)
            with self.assertRaises(ValueError):
                split.split_archive(root/'full.zip', root/'base.zip')
            self.assertFalse((root/'base.zip').exists())

    def test_record_cannot_remove_interpreter_or_unrelated_packages(self):
        for path in ['../../python.exe', '../../python311.dll', '../../Lib/os.py', 'pip/__main__.py', 'cv2/__init__.py', 'numpy/__init__.py', 'bin/unrelated.exe']:
            with self.subTest(path=path), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                self.make_archive(root/'full.zip', record_override=(path+',,\n').encode())
                with self.assertRaises(ValueError):
                    split.split_archive(root/'full.zip', root/'base.zip')
                self.assertFalse((root/'base.zip').exists())


if __name__ == '__main__':
    unittest.main()
