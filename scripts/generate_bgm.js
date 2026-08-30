#!/usr/bin/env node
/**
 * BGM 生成脚本 (O2.1)
 * 用 FFmpeg 合成 5 首原创无版权背景音乐到 assets/bgm/
 * 来源：AI 合成原创，可商用（无第三方版权）
 *
 * 用法: node scripts/generate_bgm.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(PROJECT_DIR, 'assets', 'bgm');
const TMP_DIR = path.join(OUT_DIR, '.tmp');

// ============ FFmpeg 定位 ============
function findFFmpeg() {
  const candidates = [
    'ffmpeg',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages',
      'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-8.1-full_build', 'bin', 'ffmpeg.exe'),
  ];
  for (const c of candidates) {
    try {
      execSync(`"${c}" -version`, { stdio: 'ignore' });
      return c;
    } catch {}
  }
  throw new Error('未找到 ffmpeg，请安装或配置 PATH');
}

// ============ 音符频率 (A4=440Hz) ============
const NOTE = {
  C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.00, A3: 220.00, B3: 246.94,
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.00,
};

// ============ 和弦定义 (三和弦) ============
const CHORD = {
  C:  ['C4', 'E4', 'G4'],
  G:  ['G3', 'B3', 'D4'],
  Am: ['A3', 'C4', 'E4'],
  F:  ['F3', 'A3', 'C4'],
  Dm: ['D4', 'F4', 'A4'],
  Em: ['E3', 'G3', 'B3'],
  E:  ['E4', 'G#4', 'B4'],
};

// G#4 单独定义（不在 NOTE 中）
NOTE['G#4'] = 415.30;
NOTE['C6'] = 1046.50;

// ============ 5 首 BGM 定义 ============
// tempo: 每和弦秒数; melody: 旋律音（可选，高八度点缀）
const BGMS = [
  {
    id: 'bright_upbeat', name: '明亮欢快', tempo: 2, bpm: 120,
    chords: ['C', 'G', 'Am', 'F'],
    melody: ['C5', 'B4', 'A4', 'G4'],
  },
  {
    id: 'warm_ambient', name: '温暖舒缓', tempo: 4, bpm: 72,
    chords: ['Am', 'F', 'C', 'G'],
    melody: ['A4', 'F4', 'C5', 'G4'],
  },
  {
    id: 'tech_future', name: '科技未来', tempo: 2, bpm: 100,
    chords: ['Am', 'F', 'C', 'E'],
    melody: ['A5', 'F5', 'C5', 'E5'],
  },
  {
    id: 'cheerful_playful', name: '活泼俏皮', tempo: 2, bpm: 132,
    chords: ['C', 'F', 'G', 'C'],
    melody: ['E5', 'F5', 'G5', 'C6'],
  },
  {
    id: 'epic_inspire', name: '大气励志', tempo: 4, bpm: 88,
    chords: ['Am', 'F', 'C', 'G'],
    melody: ['A4', 'F4', 'C5', 'D5'],
  },
];

// ============ 工具 ============
function buildChordExpr(chordName, melodyNote, dur) {
  const notes = CHORD[chordName].map(n => NOTE[n]);
  const parts = notes.map(f => `0.16*sin(2*PI*${f}*t)`);
  // 旋律音（音量略高，作为点缀）
  if (melodyNote && NOTE[melodyNote]) {
    parts.push(`0.12*sin(2*PI*${NOTE[melodyNote]}*t)`);
  }
  // 包络：sin(PI*t/d)^0.5 让起止为 0，中间最大，避免爆音
  const env = `sin(PI*t/${dur})^0.6`;
  return `(${parts.join('+')})*${env}`;
}

function genChordSegment(ff, chordName, melodyNote, dur, outWav) {
  const expr = buildChordExpr(chordName, melodyNote, dur);
  execSync(
    `"${ff}" -hide_banner -loglevel error -f lavfi -i "aevalsrc=${expr}:s=44100:d=${dur}" ` +
    `-c:a pcm_s16le "${outWav}" -y`,
    { stdio: 'inherit' }
  );
}

function concatWavs(ff, wavs, outWav) {
  const list = wavs.map(w => `file '${w.replace(/\\/g, '/')}'`).join('\n');
  const listFile = path.join(TMP_DIR, 'list.txt');
  fs.writeFileSync(listFile, list, 'utf-8');
  execSync(
    `"${ff}" -hide_banner -loglevel error -f concat -safe 0 -i "${listFile}" -c copy "${outWav}" -y`,
    { stdio: 'inherit' }
  );
}

function wavToMp3(ff, inWav, outMp3) {
  execSync(
    `"${ff}" -hide_banner -loglevel error -i "${inWav}" -c:a libmp3lame -q:a 2 "${outMp3}" -y`,
    { stdio: 'inherit' }
  );
}

// ============ 主流程 ============
function main() {
  const ff = findFFmpeg();
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

  const manifest = { generatedAt: new Date().toISOString(), source: 'AI 合成原创音乐（无第三方版权，可商用）', bgms: [] };

  for (const bgm of BGMS) {
    console.log(`\n🎵 生成 BGM: ${bgm.name} (${bgm.id})`);
    const segments = [];
    // 每个和弦循环 2 遍，保证时长足够（约 16-32 秒）
    for (let rep = 0; rep < 2; rep++) {
      for (let i = 0; i < bgm.chords.length; i++) {
        const segWav = path.join(TMP_DIR, `${bgm.id}_${rep}_${i}.wav`);
        genChordSegment(ff, bgm.chords[i], bgm.melody[i], bgm.tempo, segWav);
        segments.push(segWav);
      }
    }

    // 拼接
    const concatWav = path.join(TMP_DIR, `${bgm.id}_concat.wav`);
    concatWavs(ff, segments, concatWav);

    // 转 mp3
    const outMp3 = path.join(OUT_DIR, `${bgm.id}.mp3`);
    wavToMp3(ff, concatWav, outMp3);

    const sizeKB = (fs.statSync(outMp3).size / 1024).toFixed(1);
    const durSec = bgm.chords.length * bgm.tempo * 2;
    console.log(`   ✅ ${bgm.id}.mp3 (${sizeKB} KB, ${durSec}s)`);

    manifest.bgms.push({
      id: bgm.id,
      name: bgm.name,
      bpm: bgm.bpm,
      duration: durSec,
      file: `${bgm.id}.mp3`,
      license: 'AI 合成原创，可商用（无第三方版权）',
      mood: bgm.name,
    });
  }

  // 清理临时文件
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  // 写 manifest
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  console.log('\n✅ 全部 BGM 生成完成，manifest.json 已写入');
}

try {
  main();
} catch (e) {
  console.error('❌ BGM 生成失败:', e.message);
  process.exit(1);
}
