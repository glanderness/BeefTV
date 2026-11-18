"""Verify built packages and prepare the unsigned payload for the signing job."""
import hashlib
import json
from pathlib import Path
import sys

CNB_BASE = "https://cnb.cool/beeftv-downloads/desktop/-/releases/download/depth-runtime-v2/"
COS_BASE = "https://beeftv-components-1481187348.cos.ap-guangzhou.myqcloud.com/depth-runtime-v2/"
R2_BASE = "https://updates.beefapi.com/beeftv/components/depth-runtime-v2/"
GITHUB_BASE = "https://github.com/glanderness/BeefTV/releases/download/depth-runtime-v2/"
MODEL_NAME = "video_depth_anything_vits.pth"
MODEL_GITHUB_URL = f"https://github.com/glanderness/BeefTV/releases/download/v1.5.5/{MODEL_NAME}"


def component_urls(name, include_cnb=False):
    urls = [COS_BASE + name, R2_BASE + name, GITHUB_BASE + name]
    return [CNB_BASE + name, *urls] if include_cnb else urls


def verify_file(root, entry, include_cnb=False):
    name = entry["name"]
    if Path(name).name != name or "/" in name or "\\" in name:
        raise ValueError("unsafe artifact name")
    path = root / name
    if path.stat().st_size != entry["size"] or entry["size"] <= 0:
        raise ValueError("artifact size mismatch")
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != entry["sha256"]:
        raise ValueError("artifact hash mismatch")
    return {"urls": component_urls(name, include_cnb=include_cnb), "size": entry["size"], "sha256": digest}


def prepare(root, include_cnb=False):
    runtimes = {}
    for variant in ("cpu", "cuda"):
        name = f"beeftv-depth-runtime-v1-windows-amd64-{variant}.zip"
        meta = json.loads((root / (name + ".json")).read_text(encoding="utf-8-sig"))
        if meta["name"] != name or not 0 < meta["files"] <= 50000 or not 0 < meta["expandedSize"] <= 12 << 30:
            raise ValueError("invalid runtime metadata")
        if meta.get("parts"):
            parts = []
            whole = hashlib.sha256()
            for index, part in enumerate(meta["parts"], 1):
                if part["name"] != f"{name}.part-{index:03d}" or part["size"] >= 2 << 30:
                    raise ValueError("invalid release part")
                parts.append(verify_file(root, part, include_cnb=include_cnb))
                with (root / part["name"]).open("rb") as source:
                    while chunk := source.read(1024 * 1024):
                        whole.update(chunk)
            if sum(p["size"] for p in parts) != meta["size"] or whole.hexdigest() != meta["sha256"]:
                raise ValueError("assembled runtime mismatch")
            artifact = {"urls": [], "size": meta["size"], "sha256": meta["sha256"], "parts": parts}
        else:
            artifact = verify_file(root, meta, include_cnb=include_cnb)
        artifact.update(files=meta["files"], expandedSize=meta["expandedSize"])
        runtimes[f"windows-amd64/{variant}"] = artifact
    model_urls = [COS_BASE + MODEL_NAME, R2_BASE + MODEL_NAME, MODEL_GITHUB_URL]
    if include_cnb:
        model_urls.insert(0, CNB_BASE + MODEL_NAME)
    return {"version": 2, "runtimes": runtimes, "model": {
        "urls": model_urls,
        "size": 116440756,
        "sha256": "13379300b739e659f076a59d52e9801bd8d38c541a7e71f73bbca4dcfb013609",
    }}


if __name__ == "__main__":
    include_cnb = "--include-cnb" in sys.argv[3:]
    Path(sys.argv[2]).write_text(json.dumps(prepare(Path(sys.argv[1]), include_cnb=include_cnb), separators=(",", ":")), encoding="utf-8")
