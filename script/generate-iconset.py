#!/usr/bin/env python3
import os
import subprocess
from PIL import Image, ImageDraw

def draw_master_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    scale = size / 1024.0
    
    margin = 0
    radius = 225 * scale
    rect_box = [margin, margin, size - margin, size - margin]
    
    # 绘制纯色深色背景（去掉高亮外边框线）
    draw.rounded_rectangle(rect_box, radius=radius, fill=(15, 23, 42, 255))
    
    # M 主体
    p1 = (260 * scale, 720 * scale)
    p2 = (260 * scale, 280 * scale)
    p3 = (512 * scale, 530 * scale)
    p4 = (764 * scale, 280 * scale)
    p5 = (764 * scale, 720 * scale)
    
    stroke_w = max(1, int(round(28 * scale)))
    draw.line([p1, p2, p3, p4, p5], fill=(56, 189, 248, 255), width=stroke_w, joint="round")
    
    # 代码终端标识 > _
    prompt_stroke = max(1, int(round(22 * scale)))
    draw.line([(390*scale, 600*scale), (470*scale, 650*scale), (390*scale, 700*scale)], fill=(168, 85, 247, 255), width=prompt_stroke, joint="round")
    draw.line([(530*scale, 700*scale), (630*scale, 700*scale)], fill=(168, 85, 247, 255), width=prompt_stroke)
    
    # 顶部 AI 星芒
    star_cx, star_cy = 512 * scale, 200 * scale
    sr = 30 * scale
    draw.polygon([
        (star_cx, star_cy - sr*1.5),
        (star_cx + sr*0.4, star_cy - sr*0.4),
        (star_cx + sr*1.5, star_cy),
        (star_cx + sr*0.4, star_cy + sr*0.4),
        (star_cx, star_cy + sr*1.5),
        (star_cx - sr*0.4, star_cy + sr*0.4),
        (star_cx - sr*1.5, star_cy),
        (star_cx - sr*0.4, star_cy - sr*0.4)
    ], fill=(56, 189, 248, 255))
    
    return img

print("🎨 动态绘制最新 Coding Agent 主图标...")
target_repo = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
full_master_icon = draw_master_icon(1024)

# macOS 官方 HIG 完美标准：在 1024x1024 画布中缩放到 824px，四周留 100px 边距
# 这会与 Arc / 系统设置 / 右侧应用的圆角边缘 100% 精确对齐
icon_size = 824
pad = 100
squircle_icon = full_master_icon.resize((icon_size, icon_size), Image.Resampling.LANCZOS)
macos_master_icon = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
macos_master_icon.paste(squircle_icon, (pad, pad), squircle_icon)

# 目标处理目录
target_dirs = [
    os.path.join(target_repo, "packages/desktop/icons/dev"),
    os.path.join(target_repo, "packages/desktop/icons/beta"),
    os.path.join(target_repo, "packages/desktop/icons/prod"),
    os.path.join(target_repo, "packages/desktop/resources/icons"),
]

updated_count = 0

def generate_tray_template(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    scale = size / 22.0
    stroke_w = max(1, int(round(1.6 * scale)))
    
    # 极简高精 M + > 终端提示符 (去掉了拥挤的外框，保持在 22x22 极佳像素精度)
    p1 = (3.5 * scale, 17.5 * scale)
    p2 = (3.5 * scale, 4.5 * scale)
    p3 = (11.0 * scale, 12.0 * scale)
    p4 = (18.5 * scale, 4.5 * scale)
    p5 = (18.5 * scale, 17.5 * scale)
    draw.line([p1, p2, p3, p4, p5], fill=(0, 0, 0, 255), width=stroke_w, joint="round")
    
    # 精致的底部提示符 > _
    draw.line([(8.5*scale, 14.5*scale), (11.0*scale, 16.5*scale), (8.5*scale, 18.5*scale)], fill=(0, 0, 0, 255), width=stroke_w, joint="round")
    draw.line([(13.0*scale, 18.5*scale), (16.0*scale, 18.5*scale)], fill=(0, 0, 0, 255), width=stroke_w)
    
    return img

tray_icon_1x = generate_tray_template(22)
tray_icon_2x = generate_tray_template(44)

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
