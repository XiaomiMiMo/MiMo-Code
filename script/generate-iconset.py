#!/usr/bin/env python3
import os
import subprocess
from PIL import Image, ImageDraw

source_jpg = "/Users/denis/.gemini/antigravity/brain/7d346382-7cf1-494e-b365-f9555df36f21/app_icon_seamless_1785030788273.jpg"
target_repo = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

print(f"🎨 加载基准概念图标: {source_jpg}")
img = Image.open(source_jpg).convert("RGBA")
w, h = img.size

# 1. 截取原图核心主体
crop_margin = 0
cropped = img.crop((crop_margin, crop_margin, w - crop_margin, h - crop_margin))

# 2. 按照 Apple macOS 标准 HIG 设计规范构建图标：
# 规范：在 1024x1024 的透明画布中，Squircle 图标主体尺寸为 824x824，四周各保留 100px 的透明 Padding 边距。
# 这样在 macOS Dock 栏中尺寸就会与 Arc / Safari / Finder 完全一致！
icon_size = 824
cropped = cropped.resize((icon_size, icon_size), Image.Resampling.LANCZOS)

# 创建 824x824 视效圆角蒙版 (苹果标准圆角 185px)
mask_824 = Image.new("L", (icon_size, icon_size), 0)
draw_824 = ImageDraw.Draw(mask_824)
draw_824.rounded_rectangle([0, 0, icon_size, icon_size], radius=185, fill=255)

squircle_icon = Image.new("RGBA", (icon_size, icon_size), (0, 0, 0, 0))
squircle_icon.paste(cropped, (0, 0), mask_824)

# 居中贴入 1024x1024 透明画布 (Padding: 100px)
macos_master_icon = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
macos_master_icon.paste(squircle_icon, (100, 100), squircle_icon)

# 无 Padding 满铺版本 (用于 Windows / Android 等系统)
full_master_icon = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
full_master_icon.paste(cropped.resize((1024, 1024), Image.Resampling.LANCZOS), (0, 0), mask_824.resize((1024, 1024), Image.Resampling.LANCZOS))

print("✨ 按照 Apple macOS HIG 标准规范生成带 100px 透明 Padding 的 1024x1024 主图标。")

# 目标处理目录
target_dirs = [
    os.path.join(target_repo, "packages/desktop/icons/dev"),
    os.path.join(target_repo, "packages/desktop/icons/beta"),
    os.path.join(target_repo, "packages/desktop/icons/prod"),
    os.path.join(target_repo, "packages/desktop/resources/icons"),
]

updated_count = 0

def generate_tray_template(size, pad, stroke, radius):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, outline=(0, 0, 0, 255), width=stroke)
    x1 = pad + int((size - 2 * pad) * 0.25)
    x2 = pad + int((size - 2 * pad) * 0.55)
    y1 = pad + int((size - 2 * pad) * 0.25)
    ym = pad + int((size - 2 * pad) * 0.50)
    y2 = pad + int((size - 2 * pad) * 0.75)
    draw.line([(x1, y1), (x2, ym)], fill=(0, 0, 0, 255), width=stroke)
    draw.line([(x2, ym), (x1, y2)], fill=(0, 0, 0, 255), width=stroke)
    cx1 = pad + int((size - 2 * pad) * 0.65)
    cx2 = pad + int((size - 2 * pad) * 0.85)
    draw.line([(cx1, y2), (cx2, y2)], fill=(0, 0, 0, 255), width=stroke)
    return img

tray_icon_1x = generate_tray_template(22, pad=3, stroke=2, radius=3)
tray_icon_2x = generate_tray_template(44, pad=6, stroke=3, radius=6)

for target_dir in target_dirs:
    if not os.path.exists(target_dir):
        continue

    print(f"\n📂 正在适配更新目录: {os.path.relpath(target_dir, target_repo)}")

    # 生成标准 1x/2x 托盘图标包
    tray_icon_1x.save(os.path.join(target_dir, "trayTemplate.png"), "PNG")
    tray_icon_2x.save(os.path.join(target_dir, "trayTemplate@2x.png"), "PNG")
    tray_icon_1x.save(os.path.join(target_dir, "tray.png"), "PNG")
    tray_icon_2x.save(os.path.join(target_dir, "tray@2x.png"), "PNG")

    for root, dirs, files in os.walk(target_dir):
        for file in files:
            filepath = os.path.join(root, file)
            rel_path = os.path.relpath(filepath, target_repo)

            if "trayTemplate" in file or "tray" in file:
                continue

            if file.endswith(".png"):
                try:
                    with Image.open(filepath) as target_img:
                        tw, th = target_img.size
                    
                    # macOS 图标/dock 栏使用带 Padding 的图标
                    if "dock" in file or file in ["icon.png", "128x128.png", "128x128@2x.png", "32x32.png", "64x64.png"]:
                        resized = macos_master_icon.resize((tw, th), Image.Resampling.LANCZOS)
                    else:
                        resized = full_master_icon.resize((tw, th), Image.Resampling.LANCZOS)

                    resized.save(filepath, "PNG")
                    print(f"  ✓ 替换 PNG ({tw}x{th}): {rel_path}")
                    updated_count += 1
                except Exception as e:
                    print(f"  ⚠️  处理 PNG 失败 ({rel_path}): {e}")

            elif file.endswith(".ico"):
                try:
                    ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
                    full_master_icon.save(filepath, format="ICO", sizes=ico_sizes)
                    print(f"  ✓ 生成 Windows ICO: {rel_path}")
                    updated_count += 1
                except Exception as e:
                    print(f"  ⚠️  生成 ICO 失败 ({rel_path}): {e}")

# 生成符合 macOS HIG 尺寸规范的 .icns 资源包
print("\n🛠️  重新生成符合 Apple HIG 尺寸规范的 macOS .icns 资源包...")
iconset_dir = os.path.join(target_repo, "packages/desktop/icon.iconset")
os.makedirs(iconset_dir, exist_ok=True)

icon_mapping = [
    (16, "icon_16x16.png"),
    (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"),
    (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"),
    (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"),
    (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"),
    (1024, "icon_512x512@2x.png"),
]

for size, fname in icon_mapping:
    resized = macos_master_icon.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(os.path.join(iconset_dir, fname))

temp_icns = os.path.join(target_repo, "packages/desktop/temp_icon.icns")
cmd = f"iconutil -c icns '{iconset_dir}' -o '{temp_icns}'"
subprocess.run(cmd, shell=True, check=True)

for target_dir in target_dirs:
    if os.path.exists(target_dir):
        dest_icns = os.path.join(target_dir, "icon.icns")
        subprocess.run(f"cp '{temp_icns}' '{dest_icns}'", shell=True, check=True)
        print(f"  ✓ 部署 HIG 规范版 ICNS: {os.path.relpath(dest_icns, target_repo)}")

subprocess.run(f"rm -rf '{iconset_dir}' '{temp_icns}'", shell=True, check=True)

print(f"\n🎉 应用图标批量生成完成！全部尺寸与规范已整合完成。")
