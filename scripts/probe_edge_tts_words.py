#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
edge-tts 词级时间戳探测 (O3.1)
探测 edge-tts 是否输出 WordBoundary 事件（词级时间戳）
输出 JSON 报告，用于决策是否可做逐字字幕（O3.2）

用法: python scripts/probe_edge_tts_words.py
"""

import asyncio
import json
import sys

try:
    import edge_tts
except ImportError:
    print(json.dumps({"error": "edge-tts 未安装，请先安装"}))
    sys.exit(1)


async def probe():
    text = "人工智能正在改变我们的课堂，让我们一起来了解。"
    voice = "zh-CN-XiaoxiaoNeural"
    proxy = "http://127.0.0.1:7897"

    word_boundaries = []
    sentence_boundaries = []
    audio_chunks = 0

    tts = edge_tts.Communicate(text, voice, boundary="WordBoundary", proxy=proxy)

    async for chunk in tts.stream():
        t = chunk.get("type")
        if t == "audio":
            audio_chunks += 1
        elif t == "WordBoundary":
            word_boundaries.append({
                "text": chunk.get("text"),
                "offset": chunk.get("offset"),      # 100ns 单位
                "duration": chunk.get("duration"),  # 100ns 单位
            })
        elif t == "SentenceBoundary":
            sentence_boundaries.append({
                "text": chunk.get("text"),
                "offset": chunk.get("offset"),
                "duration": chunk.get("duration"),
            })

    report = {
        "supported": len(word_boundaries) > 0,
        "voice": voice,
        "text": text,
        "audio_chunks": audio_chunks,
        "word_count": len(word_boundaries),
        "sentence_count": len(sentence_boundaries),
        "words": word_boundaries[:20],  # 前 20 个词级时间戳样本
        "sentence_boundaries": sentence_boundaries,
        "offset_unit": "100ns (1e-7 秒)",
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(probe())
