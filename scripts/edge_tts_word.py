#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
edge-tts 词级 TTS 生成 (O3.2)
用 edge-tts 的 WordBoundary 模式生成：
  - 音频 MP3
  - 词级时间戳 JSON（秒单位，供逐字字幕聚合）

用法:
  python scripts/edge_tts_word.py --text "..." --out-mp3 voice.mp3 --out-words words.json
  python scripts/edge_tts_word.py --file text.txt --out-mp3 voice.mp3 --out-words words.json
"""

import argparse
import asyncio
import json
import os
import sys

try:
    import edge_tts
except ImportError:
    print(json.dumps({"error": "edge-tts 未安装，请先安装（pip install edge-tts）"}, ensure_ascii=False))
    sys.exit(1)

DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
DEFAULT_PROXY = "http://127.0.0.1:7897"


async def generate(text, out_mp3, out_words, voice, rate, proxy):
    tts = edge_tts.Communicate(
        text, voice, rate=rate, boundary="WordBoundary", proxy=proxy
    )

    audio = bytearray()
    words = []

    async for chunk in tts.stream():
        t = chunk.get("type")
        if t == "audio":
            audio.extend(chunk.get("data", b""))
        elif t == "WordBoundary":
            # offset/duration 单位 100ns (1e-7 秒)，转为秒
            words.append({
                "text": chunk.get("text"),
                "start": round(chunk.get("offset", 0) / 1e7, 3),
                "duration": round(chunk.get("duration", 0) / 1e7, 3),
            })

    if not audio:
        print(json.dumps({"error": "未生成音频数据"}, ensure_ascii=False))
        sys.exit(1)

    # 确保输出目录存在
    os.makedirs(os.path.dirname(os.path.abspath(out_mp3)), exist_ok=True)
    os.makedirs(os.path.dirname(os.path.abspath(out_words)), exist_ok=True)

    # 计算每个词的结束时间
    for w in words:
        w["end"] = round(w["start"] + w["duration"], 3)

    with open(out_mp3, "wb") as f:
        f.write(bytes(audio))

    with open(out_words, "w", encoding="utf-8") as f:
        json.dump({"voice": voice, "words": words, "count": len(words)},
                  f, ensure_ascii=False, indent=2)

    print(json.dumps({
        "ok": True,
        "mp3": out_mp3,
        "words": out_words,
        "word_count": len(words),
    }, ensure_ascii=False))


def main():
    p = argparse.ArgumentParser(description="edge-tts 词级 TTS 生成")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--text", help="要合成的文本")
    src.add_argument("--file", help="从文件读取文本")
    p.add_argument("--out-mp3", required=True, help="输出 MP3 路径")
    p.add_argument("--out-words", required=True, help="输出词级时间戳 JSON 路径")
    p.add_argument("--voice", default=DEFAULT_VOICE)
    p.add_argument("--rate", default="+10%")
    p.add_argument("--proxy", default=DEFAULT_PROXY)
    args = p.parse_args()

    text = args.text
    if args.file:
        with open(args.file, "r", encoding="utf-8") as f:
            text = f.read()

    asyncio.run(generate(text, args.out_mp3, args.out_words,
                         args.voice, args.rate, args.proxy))


if __name__ == "__main__":
    main()
