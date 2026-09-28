"""
Hrebeniuk — одноразове налаштування Blender (запускає ВСТАНОВИТИ.bat).
  blender -b --python hrb_setup.py -- <https://адреса_сайту/ або папка> [--personal <папка>]
1. вмикає Online Access (Blender вимагає його навіть для репозиторію в папці)
2. прибирає старі ручні копії наших аддонів (резервна копія в addons\_hrb_backup)
3. підключає репозиторій «Hrebeniuk Tools» з перевіркою оновлень при старті
Самі аддони ставить наступний крок .bat: blender --command extension install ...
"""
import bpy
import addon_utils
import json
import os
import re
import shutil
import sys
import time

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
REPOS = []                                   # (dir або https-адреса, module, name)
if args:
    REPOS.append((args[0], "hrebeniuk", "Hrebeniuk Tools"))
if "--personal" in args:
    REPOS.append((args[args.index("--personal") + 1], "hrebeniuk_personal", "Hrebeniuk Personal"))

# id пакета -> назва в bl_info (щоб знайти старі копії з будь-яким іменем файлу)
KNOWN = {
    "hrebeniuk_hub": "Hrebeniuk Hub", "seam_shadow": "Seam Shadow Painter",
    "wirecolor_mask_addon": "WireColor Masks", "custom_frame_render": "Custom Frame Render",
    "create_project_blender": "Create Project", "shot_list": "Shot List",
    "texture_cleaner": "Texture Cleaner", "keyframe_shift_addon": "Keyframe Shift",
    "quick_share_telegram": "Quick Share",
}


def is_url(s):
    return s.lower().startswith(("http://", "https://"))


def index_url(src):
    """https://…/  → https://…/index.json ;  папка → file:///…/index.json"""
    if is_url(src):
        return src if src.endswith(".json") else src.rstrip("/") + "/index.json"
    return "file:///" + os.path.abspath(os.path.join(src, "index.json")).replace("\\", "/")


def repo_ids(src):
    try:
        if is_url(src):
            import urllib.request
            with urllib.request.urlopen(index_url(src), timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
        else:
            data = json.load(open(os.path.join(src, "index.json"), encoding="utf-8"))
        return [p["id"] for p in data.get("data", [])]
    except Exception as e:
        print("HRB  не вдалось прочитати index.json:", e)
        return []


def legacy_id(mod):
    name = mod.__name__
    for pid, title in KNOWN.items():
        if re.fullmatch(rf"{pid}(_v\d+)?", name):
            return pid
        if getattr(mod, "bl_info", {}).get("name") == title:
            return pid
    return None


def cleanup_legacy(ids):
    user_addons = os.path.normcase(os.path.abspath(bpy.utils.user_resource('SCRIPTS', path="addons")))
    backup = os.path.join(user_addons, "_hrb_backup", time.strftime("%Y%m%d_%H%M%S"))
    removed = []
    for mod in addon_utils.modules(refresh=True):
        if mod.__name__.startswith("bl_ext."):
            continue
        path = os.path.normcase(os.path.abspath(mod.__file__))
        if not path.startswith(user_addons):
            continue                              # чіпаємо тільки користувацькі аддони
        pid = legacy_id(mod)
        if pid not in ids:
            continue
        try:
            addon_utils.disable(mod.__name__, default_set=True)
        except Exception:
            pass
        target = os.path.dirname(path) if os.path.basename(path) == "__init__.py" else path
        os.makedirs(backup, exist_ok=True)
        shutil.move(target, os.path.join(backup, os.path.basename(target)))
        removed.append(f"{mod.__name__} -> {pid}")
    return removed, backup


prefs = bpy.context.preferences
prefs.system.use_online_access = True
print("HRB  Online Access: on")

all_ids = []
for d, _m, _n in REPOS:
    all_ids += repo_ids(d)
removed, backup = cleanup_legacy(set(all_ids))
for r in removed:
    print("HRB  прибрано стару копію:", r)
if removed:
    print("HRB  резервна копія:", backup)

for d, module, name in REPOS:
    url = index_url(d)
    repo = next((r for r in prefs.extensions.repos if r.module == module), None)
    if repo is None:
        repo = prefs.extensions.repos.new(name=name, module=module, remote_url=url)
    repo.remote_url = url
    repo.use_remote_url = True
    repo.enabled = True
    repo.use_sync_on_startup = True
    print(f"HRB  репозиторій '{name}': {url}")

bpy.ops.wm.save_userpref()
print("HRB  IDS " + ",".join(all_ids))
print("HRB  готово")
