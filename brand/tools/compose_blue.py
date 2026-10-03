"""把导出的 PNG 合到品牌蓝底上，用来检查透明边缘是否干净。

两份输入都是**图案版**（白版与蓝版）：白版合到蓝底上要看的是"边缘有没有白边/黑边"，
蓝版合上去是"同一版图案在两种背景下的观感"。仓库里没有字标文件，所以这里不引用它。

输出默认写到 `export/on-blue-preview.png`（仓库内，跟着 export 一起走）；
想写到别处就设环境变量 `IRMIA_BRAND_PREVIEW_OUT`。
"""
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
EXP = os.path.abspath(os.path.join(HERE, "..", "export"))

BLUE = (0, 102, 232, 255)
names = ["irmia-mark-512.png", "irmia-mark-blue-512.png"]
tiles = []
for n in names:
    path = os.path.join(EXP, n)
    if not os.path.exists(path):
        raise SystemExit(f"缺少 {n}（先在 brand/tools 下跑 build_png.py 生成导出物）")
    im = Image.open(path).convert("RGBA")
    bg = Image.new("RGBA", im.size, BLUE)
    bg.alpha_composite(im)
    tiles.append((n, bg.convert("RGB")))
h = 560
scaled = [(n, im.resize((int(im.width * h / im.height), h), Image.LANCZOS)) for n, im in tiles]
W = sum(im.width for _, im in scaled) + 30
sheet = Image.new("RGB", (W, h + 10), (30, 30, 30))
x = 10
for n, im in scaled:
    sheet.paste(im, (x, 5))
    x += im.width + 20
out = os.environ.get("IRMIA_BRAND_PREVIEW_OUT") or os.path.join(EXP, "on-blue-preview.png")
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
sheet.save(out)
print("wrote", out, sheet.size)
