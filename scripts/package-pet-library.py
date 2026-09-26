#!/usr/bin/env python3
"""Build reproducible release ZIPs, an inspectable catalog and download pages.

Requires Pillow. Source folders remain untouched; private app state is never read.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
RECOMMENDED = ("idle", "sleep", "nudgeGentle", "nudgeStrong", "breakRelax")
EXCLUDE = {".DS_Store", "__MACOSX"}
STAMP = (2020, 1, 1, 0, 0, 0)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def files(root):
    result = []
    for path in sorted(root.rglob("*")):
        if any(part in EXCLUDE or part.startswith("._") for part in path.relative_to(root).parts):
            continue
        if path.is_symlink():
            raise ValueError(f"Symlinks are not allowed in release packs: {path}")
        if path.is_file():
            result.append(path)
    return result


def validate(root, manifest):
    assert manifest.get("schemaVersion") == 1, root
    assert manifest.get("id") and manifest.get("name"), root
    assert manifest.get("license") and manifest.get("distribution"), root
    assert (root / "preview.png").is_file(), root
    actions = list(manifest.get("animations", {}).items())
    sources = manifest.get("sourceActions", [])
    source_ids = [a["id"] for a in sources]
    assert len(source_ids) == len(set(source_ids)), root
    assert set(manifest.get("idleSourceActionIDs", [])) <= set(source_ids), root
    actions += [(a["id"], a) for a in sources]
    assert "idle" in manifest.get("animations", {}), root
    folders = {}
    for name, action in actions:
        folder = (root / action["folder"]).resolve()
        assert folder.is_relative_to(root.resolve()), (root, name)
        frames = sorted(folder.glob("*.png"))
        assert frames and 1 <= action["fps"] <= 12, (root, name)
        assert action.get("frameCount", len(frames)) == len(frames), (root, name)
        audio = action.get("audio")
        if audio and audio.get("file"):
            path = (root / audio["file"]).resolve()
            assert path.is_relative_to(root.resolve()) and path.is_file(), (root, name)
        if folder not in folders:
            dimensions = set()
            transparent = False
            for frame in frames:
                with Image.open(frame) as im:
                    im.verify()
                with Image.open(frame) as im:
                    dimensions.add(im.size)
                    transparent |= im.convert("RGBA").getchannel("A").getextrema()[0] < 255
            assert len(dimensions) == 1, (root, name, dimensions)
            folders[folder] = {"frames": len(frames), "size": list(next(iter(dimensions))), "transparent": transparent}
    return {
        "valid": True,
        "uniqueFrameCount": sum(f["frames"] for f in folders.values()),
        "actionFolderCount": len(folders),
        "missingRecommendedActions": [a for a in RECOMMENDED if a not in manifest["animations"]],
        "opaqueActionFolders": [p.name for p, value in folders.items() if not value["transparent"]],
    }


def write_zip(path, members):
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, data in sorted(members):
            entry = zipfile.ZipInfo(name, date_time=STAMP)
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data)
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None, path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=ROOT / "local-pet-packs/FocusPetPetPacks")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    version = json.loads((ROOT / "package.json").read_text())["version"]
    assert json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["version"] == version
    config = json.loads((ROOT / "docs/pet-packs/catalog-source.json").read_text())
    out = args.out or ROOT / "release" / f"v{version}"
    out.mkdir(parents=True, exist_ok=True)
    base = f"https://github.com/{config['repository']}/releases/download/v{version}/"
    expected = {name for c in config["categories"] for name in c["packs"]}
    present = {p.parent.name for p in args.source.glob("*/pet.json")}
    assert expected == present, f"Catalog mismatch: missing={expected-present}; uncataloged={present-expected}"
    pack_records, category_records, all_members = [], [], []
    seen_ids = set()
    for category in config["categories"]:
        category_members = []
        for folder in category["packs"]:
            root = args.source / folder
            manifest = json.loads((root / "pet.json").read_text())
            pet_id = manifest["id"]
            assert re.fullmatch(r"[a-z0-9_\-]+", pet_id) and pet_id not in seen_ids, pet_id
            seen_ids.add(pet_id)
            idle_override = config.get("idlePools", {}).get(pet_id)
            if idle_override is not None:
                manifest["idleSourceActionIDs"] = idle_override
            manifest["resourceVersion"] = version
            validation = validate(root, manifest)
            contents = []
            for p in files(root):
                content = p.read_bytes()
                if p.name == "pet.json":
                    content = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
                if p.suffix == ".md":
                    content = re.sub(r"`(/(?:Users|home)/[^`]+)`", lambda m: f"`{Path(m[1]).name}`", content.decode()).encode()
                if p.name == "RESOURCE_NOTES.md" and idle_override is not None:
                    content += "\nRelease archive: the random idle pool is limited to calm actions; all original actions, frames and audio remain available.\n".encode()
                contents.append((f"{folder}/{p.relative_to(root).as_posix()}", content))
            for name, content in contents:
                if name.endswith((".md", ".json")):
                    assert b"/Users/" not in content and b"/home/" not in content, name
            filename = f"FocusPet-Pet-{pet_id}-{version}.zip"
            write_zip(out / filename, contents)
            with Image.open(sorted((root / manifest["animations"]["idle"]["folder"]).glob("*.png"))[0]) as im:
                preview = im.convert("RGBA")
                if preview.getbbox():
                    preview = preview.crop(preview.getbbox())
                preview.thumbnail((240, 200), Image.Resampling.LANCZOS)
                preview.save(ROOT / "docs/assets/pet-packs" / f"{pet_id}.webp", lossless=True)
            record = {
                "id": pet_id, "name": manifest["name"], "archiveVersion": version,
                "sourceFolder": folder, "category": category["id"], "categoryName": category["name"],
                "author": manifest["author"], "license": manifest["license"],
                "distribution": manifest["distribution"], "sourceActions": len(manifest.get("sourceActions", [])),
                "mappedActions": len(manifest["animations"]), "files": len(contents),
                "idlePool": manifest.get("idleSourceActionIDs", []),
                "validation": validation, "notes": config["notes"].get(pet_id, ""),
                "filename": filename, "bytes": (out / filename).stat().st_size,
                "sha256": digest(out / filename), "url": base + filename,
            }
            pack_records.append(record)
            category_members.extend(contents)
        filename = f"FocusPet-Pets-{category['id']}-{version}.zip"
        write_zip(out / filename, category_members)
        category_records.append({"id": category["id"], "name": category["name"], "count": len(category["packs"]), "filename": filename, "bytes": (out / filename).stat().st_size, "sha256": digest(out / filename), "url": base + filename})
        all_members.extend(category_members)
        print(f"Validated and packaged {category['name']}: {len(category['packs'])} packs", flush=True)
    catalog = {"schemaVersion": 1, "appVersion": version, "archiveVersion": version, "packCount": len(pack_records), "categories": category_records, "packs": pack_records}
    index = json.dumps(catalog, ensure_ascii=False, indent=2) + "\n"
    (ROOT / "docs/pet-packs/catalog.json").write_text(index)
    (out / f"FocusPet-Pets-Catalog-{version}.json").write_text(index)
    overview = "# Focus Pet 桌宠资源归档\n\n" + f"归档版本：{version}。共 {len(pack_records)} 个桌宠，保留原始作者、许可与动作。\n\n在应用的桌宠页选择导入 ZIP，即可直接导入全集、分类合集或单只桌宠。\n\n资源不是软件开源授权的一部分；原有 localOnly / unknown 标记保持不变，详见各包 pet.json。\n\n"
    overview += "\n".join(f"- {p['name']} (`{p['id']}`)：{p['sourceActions']} 个源动作；作者 {p['author']}。{p['notes']}" for p in pack_records) + "\n"
    filename = f"FocusPet-Pets-All-{version}.zip"
    write_zip(out / filename, all_members + [("README.md", overview.encode()), ("catalog.json", index.encode())])
    (out / f"FocusPet-Pets-README-{version}.md").write_text(overview)
    lines = ["# 桌宠资源下载", "", f"**归档版本 v{version} · {len(pack_records)} 个桌宠 · 适配 Focus Pet {version}。**", "", f"[下载全部桌宠（ZIP）]({base+filename}) · [Release 页面](https://github.com/{config['repository']}/releases/tag/v{version}) · [机器可读目录](catalog.json)", "", "下载后无需解压，在应用的 **桌宠 → 导入 → ZIP 文件** 中选择资源包。全集会一次导入全部桌宠，分类合集和单包同样可直接导入。", "", "## 分类合集", "", "| 分类 | 数量 | 下载 |", "| --- | ---: | --- |"]
    for c in category_records:lines.append(f"| {c['name']} | {c['count']} | [ZIP · {c['bytes']/1024/1024:.1f} MB]({c['url']}) |")
    for c in category_records:
        lines += ["", f"## {c['name']}", "", "| 预览 | 桌宠 | 源动作 | 原作者 | 单包下载 |", "| --- | --- | ---: | --- | --- |"]
        for p in [p for p in pack_records if p['category']==c['id']]:
            lines.append(f"| <img src=\"../assets/pet-packs/{p['id']}.webp\" width=\"88\" alt=\"{p['name']}\"> | **{p['name']}**<br>{p['notes']} | {p['sourceActions']} | {p['author']} | [ZIP · {p['bytes']/1024/1024:.1f} MB]({p['url']}) |")
    lines += ["", "## 版本与素材许可", "", "归档版本跟随应用发布版本；桌宠 ID 保持稳定，更新同一 ID 会替换其资源。基础像素猫和扩充版使用不同 ID，可同时保留。", "", "原作者信息、`license` 和 `distribution` 均按素材原包保留。第三方角色及授权未明确的资源仍标记 `localOnly` / `unknown`，这些文件不自动取得软件仓库的许可；仅用于个人本地体验，二次分发或商用需确认原作者许可。", "", "派蒙、皮克啾为仅待机的轻量包。其他包也按原有动作发布，没有为补齐数量而伪造动画。完整帧数、动作数和缺失项见目录 JSON。", "", "Release 的 SHA256SUMS.txt 可用于核验下载完整性。"]
    (ROOT / "docs/pet-packs/README.md").write_text("\n".join(lines)+"\n")
    for dst in [out / "SHA256SUMS.txt"]:
        dst.write_text("".join(f"{digest(p)}  {p.name}\n" for p in sorted(out.iterdir()) if p.is_file() and p.name!='SHA256SUMS.txt'))
    print(f"Complete: {len(pack_records)} pets; artifacts in {out}", flush=True)

if __name__ == "__main__":main()
