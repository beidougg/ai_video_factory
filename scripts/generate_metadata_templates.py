#!/usr/bin/env python3
"""
素材元数据模板生成器 (T4.6)
批量扫描素材目录，为每个视频/图片文件生成元数据 JSON 骨架。

用法:
  python generate_metadata_templates.py [素材目录] [输出目录]
"""

import os, json, sys
from pathlib import Path
import subprocess

def get_video_duration(filepath):
    """用 ffprobe 获取视频时长"""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', filepath],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            return float(data.get('format', {}).get('duration', 0))
    except Exception:
        pass
    return 0

def get_video_resolution(filepath):
    """用 ffprobe 获取视频分辨率"""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_streams', filepath],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            for stream in data.get('streams', []):
                if stream.get('codec_type') == 'video':
                    w, h = stream.get('width', 0), stream.get('height', 0)
                    return f"{w}x{h}"
    except Exception:
        pass
    return "unknown"

VIDEO_EXT = {'.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.m4v'}
IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'}

def scan_directory(root_dir):
    """扫描目录下所有媒体文件"""
    files = []
    for filepath in Path(root_dir).rglob('*'):
        if filepath.suffix.lower() in VIDEO_EXT:
            dur = get_video_duration(str(filepath))
            res = get_video_resolution(str(filepath))
            files.append({
                'type': 'video',
                'path': str(filepath),
                'name': filepath.name,
                'duration': round(dur, 1),
                'resolution': res,
            })
        elif filepath.suffix.lower() in IMAGE_EXT:
            files.append({
                'type': 'image',
                'path': str(filepath),
                'name': filepath.name,
                'duration': 5.0,  # 默认 5 秒展示
                'resolution': 'unknown',
            })
    return files

def generate_metadata(files, output_dir):
    """为每个文件生成元数据 JSON"""
    os.makedirs(output_dir, exist_ok=True)
    generated = []

    for f in files:
        name_without_ext = Path(f['name']).stem
        meta = {
            "file": f['name'],
            "file_path": f['path'],
            "type": f['type'],
            "duration": f['duration'],
            "resolution": f['resolution'],
            "tags": [],
            "scenario": "",
            "quality": "B",
            "source": "",
            "usage_count": 0,
            "avg_retention": 0.0,
            "created_at": "",
            "notes": ""
        }

        output_path = os.path.join(output_dir, f"{name_without_ext}.json")
        # 避免覆盖已有文件
        if os.path.exists(output_path):
            print(f"   ⏭️  跳过 (已存在): {name_without_ext}.json")
            continue

        with open(output_path, 'w', encoding='utf-8') as out:
            json.dump(meta, out, ensure_ascii=False, indent=2)
        generated.append(output_path)
        print(f"   ✅ {name_without_ext}.json")

    return generated

def main():
    args = sys.argv[1:]
    if not args:
        # 默认扫描 assets/videos/
        base = Path(__file__).resolve().parent.parent
        search_dir = str(base / 'assets' / 'videos')
        out_dir = str(base / 'assets' / 'metadata')
    else:
        search_dir = args[0]
        out_dir = args[1] if len(args) > 1 else os.path.join(search_dir, '..', 'metadata')

    print('=' * 50)
    print('📂 素材元数据模板生成器')
    print(f'   扫描目录: {search_dir}')
    print(f'   输出目录: {out_dir}')
    print('=' * 50)

    if not os.path.exists(search_dir):
        print(f'⚠️ 目录不存在: {search_dir}')
        # 仍创建 metadata 目录
        os.makedirs(out_dir, exist_ok=True)
        print(f'   已创建元数据目录: {out_dir}')
        print('   请先放入素材文件到 assets/videos/ 目录')
        return

    files = scan_directory(search_dir)

    if not files:
        print(f'📭 未找到媒体文件，请将视频放入 {search_dir}')
        # 生成样本元数据
        sample_path = os.path.join(out_dir, 'sample_product_showcase.json')
        if not os.path.exists(sample_path):
            sample = {
                "file": "sample.mp4",
                "file_path": "assets/videos/products/sample.mp4",
                "type": "video",
                "duration": 5.0,
                "resolution": "1920x1080",
                "tags": ["产品展示", "特写"],
                "scenario": "产品首镜头",
                "quality": "A",
                "source": "示例",
                "usage_count": 0,
                "avg_retention": 0.0,
                "created_at": "2026-01-01",
                "notes": "示例元数据模板，请按此格式为实际素材创建"
            }
            with open(sample_path, 'w', encoding='utf-8') as f:
                json.dump(sample, f, ensure_ascii=False, indent=2)
            print(f'   📝 已创建示例元数据: {sample_path}')
        return

    print(f'\n📊 找到 {len(files)} 个媒体文件:')
    for f in files:
        print(f'   [{f["type"]}] {f["name"]} | {f["duration"]}s | {f["resolution"]}')

    print(f'\n🔧 生成元数据模板...')
    generated = generate_metadata(files, out_dir)
    print(f'\n✅ 完成! 生成 {len(generated)} 个元数据文件')
    print(f'   输出: {out_dir}')
    print(f'\n⚠️ 请编辑每个 JSON 文件的 tags, scenario, quality 等字段')

if __name__ == '__main__':
    main()
