"""文件说明：桌面启动专用图标生成；从集中 TOML 读取 SVG 和尺寸，依赖 Pillow 与 resvg，不包含安装包流程。"""

from io import BytesIO
from pathlib import Path
import tomllib

ROOT = Path(__file__).resolve().parents[2]


def create_icon(target: Path) -> None:
    """按集中配置将正式 SVG 渲染为透明多尺寸 ICO，更新目标文件并保留相同内容的时间戳。

    小尺寸使用扩大分缝的母版；resvg 负责矢量光栅化，Pillow 负责 ICO 封装。
    配置或 SVG 无效时抛出异常，拒绝继续使用旧图标；产物仅在完整生成后原子替换。
    """
    from PIL import Image
    from resvg_py import svg_to_bytes

    config = tomllib.loads((ROOT / "config/sat_layout_opt.toml").read_text(encoding="utf-8"))["branding"]
    sizes = sorted(set(config["windows_icon_sizes"]), reverse=True)
    if not sizes or any(type(size) is not int or not 1 <= size <= 256 for size in sizes):
        raise ValueError("branding.windows_icon_sizes 必须是 1–256 的非空整数列表")
    frames = []
    for size in sizes:
        source = config["small_icon_svg" if size <= config["small_icon_max_size"] else "icon_svg"]
        png = svg_to_bytes(svg_path=str(ROOT / source), width=size, height=size, skip_system_fonts=True)
        with Image.open(BytesIO(png)) as rendered:
            frames.append(rendered.convert("RGBA"))
    output = BytesIO()
    frames[0].save(output, format="ICO", sizes=[(size, size) for size in sizes], append_images=frames[1:])
    payload = output.getvalue()
    if target.is_file() and target.read_bytes() == payload:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".partial")
    temporary.write_bytes(payload)
    temporary.replace(target)
