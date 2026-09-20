"""Package only the production extension, excluding references and test dependencies."""
import json
import argparse
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def package_extension(root, target=None):
    """Use the same explicit root runtime files as the manual installer."""
    names = json.loads((root / "tools" / "runtime-files.json").read_text(encoding="utf-8"))
    if not names or len(names) != len(set(names)):
        raise ValueError("Runtime file list must be nonempty and contain no duplicates")
    for name in names:
        if not isinstance(name, str) or Path(name).name != name or "\\" in name:
            raise ValueError(f"Invalid runtime filename: {name!r}")
        if not (root / name).is_file():
            raise FileNotFoundError(f"Missing runtime file: {name}")
    version = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
    target = target or root / "dist" / f"sillytavern-breeze-{version}.zip"
    target.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(target, "w", ZIP_DEFLATED) as archive:
        for name in names:
            archive.write(root / name, f"sillytavern-breeze/{name}")
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Optional destination zip path")
    args = parser.parse_args()
    print(package_extension(Path(__file__).resolve().parents[1], args.output))
