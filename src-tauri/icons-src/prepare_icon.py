"""把源图处理为 Tauri 图标生成所需的 1024x1024 RGBA 圆角透明 PNG。

处理步骤：
1. 从四角泛洪填充，识别图标主体之外的纯黑背景区域
2. 按主体外接矩形裁剪，去掉多余黑边
3. 对 alpha 做 1px 内缩，避免缩放时黑色边缘渗出
4. 把透明区域的 RGB 填成主体边缘色，再缩放到 1024x1024
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SRC = Path(__file__).with_name("app-icon.png")
OUT = Path(__file__).with_name("app-icon-1024.png")

# 亮度低于该阈值视为背景黑色
BG_THRESHOLD = 26
OUTSIDE_MARK = 128
SIZE = 1024

img = Image.open(SRC).convert("RGB")
w, h = img.size

# 二值化：背景黑 -> 0，主体 -> 255
bw = img.convert("L").point(lambda v: 0 if v < BG_THRESHOLD else 255)

# 从四角泛洪，把与边角连通的黑色区域标记出来
for corner in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
    if bw.getpixel(corner) == 0:
        ImageDraw.floodfill(bw, corner, OUTSIDE_MARK, thresh=0)

# alpha：外部标记 -> 0，其余 -> 255
alpha = bw.point(lambda v: 0 if v == OUTSIDE_MARK else 255)

bbox = alpha.getbbox()
print(f"source={w}x{h} bbox={bbox}")

# 内缩 1px，去掉圆角处的黑色抗锯齿像素
alpha = alpha.filter(ImageFilter.MinFilter(3))

rgba = img.convert("RGBA")
rgba.putalpha(alpha)
rgba = rgba.crop(bbox)

# 用主体中心区域的背景色填充透明像素，避免缩放时出现暗晕
cw, ch = rgba.size
fill = rgba.getpixel((cw // 2, int(ch * 0.06)))[:3]
backdrop = Image.new("RGBA", rgba.size, fill + (0,))
backdrop.paste(rgba, (0, 0), rgba)
backdrop.putalpha(rgba.getchannel("A"))

out = backdrop.resize((SIZE, SIZE), Image.LANCZOS)
out.save(OUT)
print(f"saved {OUT.name} {out.size} mode={out.mode} fill={fill}")
