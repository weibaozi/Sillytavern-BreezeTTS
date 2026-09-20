"""Package only the production extension, excluding references and test dependencies."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
source = root / "extension"
version = json.loads((source / "manifest.json").read_text(encoding="utf-8"))["version"]
target = root / "dist" / f"sillytavern-breeze-{version}.zip"
target.parent.mkdir(exist_ok=True)
with ZipFile(target, "w", ZIP_DEFLATED) as archive:
    for path in sorted(source.iterdir()):
        if path.is_file():
            archive.write(path, f"sillytavern-breeze/{path.name}")
print(target)
