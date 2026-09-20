"""Verify the downloadable ZIP contains exactly the manual install runtime."""
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("breeze_package", ROOT / "tools" / "package.py")
PACKAGER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGER)


class PackageTests(unittest.TestCase):
    def test_archive_matches_runtime_bytes_and_manifest_entries(self):
        names = json.loads((ROOT / "tools" / "runtime-files.json").read_text(encoding="utf-8"))
        with TemporaryDirectory(prefix="breeze-package-") as temporary:
            target = PACKAGER.package_extension(ROOT, Path(temporary) / "extension.zip")
            with ZipFile(target) as archive:
                self.assertEqual(archive.namelist(), [f"sillytavern-breeze/{name}" for name in names])
                for name in names:
                    self.assertEqual(archive.read(f"sillytavern-breeze/{name}"), (ROOT / name).read_bytes())
                manifest = json.loads(archive.read("sillytavern-breeze/manifest.json"))
                for key in ("js", "css"):
                    self.assertIn(f"sillytavern-breeze/{manifest[key]}", archive.namelist())

    def test_missing_runtime_does_not_create_partial_archive(self):
        with TemporaryDirectory(prefix="breeze-package-") as temporary:
            root = Path(temporary)
            (root / "tools").mkdir()
            (root / "tools" / "runtime-files.json").write_text('["missing.js"]', encoding="utf-8")
            target = root / "extension.zip"
            with self.assertRaisesRegex(FileNotFoundError, "Missing runtime file"):
                PACKAGER.package_extension(root, target)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
