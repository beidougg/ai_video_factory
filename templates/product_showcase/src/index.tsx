// Remotion 视频模板 - 通用口播+画面风格 (T2.1)
// 接收 JSON props: { scenes, width, height, fps, audioSrc }
// 用法: npx remotion render src/index.tsx \
//   --props='{"scenes": [...], "audioSrc": "voice.mp3"}' \
//   out/final.mp4

import React, { useMemo } from 'react';
import { useCurrentFrame, useVideoConfig, Audio, Sequence, Img, interpolate } from 'remotion';

// ============ Props 类型定义 ============
interface SceneItem {
  index: number;
  text: string;
  duration: number;
  suggestion?: string;
  candidates?: Array<{
    file: string;
    file_path: string;
    start: number;
    end: number;
    score?: number;
  }>;
}

interface VideoProps {
  scenes: SceneItem[];
  total_duration?: number;
  audioSrc?: string;
  subtitleStyle?: {
    fontSize?: number;
    color?: string;
    backgroundColor?: string;
  };
}

// ============ 分镜组件 ============
const Scene: React.FC<{
  scene: SceneItem;
  sceneIndex: number;
}> = ({ scene, sceneIndex }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // 整个分镜的帧范围
  const isActive = frame >= sceneIndex * scene.duration * fps &&
    frame < (sceneIndex + 1) * scene.duration * fps;

  if (!isActive) return null;

  // 分镜内的相对帧
  const localFrame = frame - sceneIndex * scene.duration * fps;
  const localDuration = scene.duration * fps;

  // 入场/出场动画 (淡入淡出)
  const opacity = interpolate(
    localFrame,
    [0, 5, localDuration - 5, localDuration],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const translateY = interpolate(
    localFrame,
    [0, 5],
    [20, 0],
    { extrapolateRight: 'clamp' }
  );

  // 背景素材 (第一个候选)
  const bgMedia = scene.candidates?.[0];

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        opacity,
      }}
    >
      {/* 背景层 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
        }}
      />

      {/* 字幕层 - 底部居中 */}
      <div
        style={{
          position: 'absolute',
          bottom: '12%',
          left: '5%',
          right: '5%',
          transform: `translateY(${translateY}px)`,
        }}
      >
        <p
          style={{
            fontSize: '2.8rem',
            fontWeight: 'bold',
            color: '#ffffff',
            textAlign: 'center',
            textShadow: '0 2px 8px rgba(0,0,0,0.6)',
            lineHeight: 1.4,
            margin: 0,
            padding: '0 20px',
          }}
        >
          {scene.text}
        </p>
      </div>

      {/* 分镜序号 */}
      <div
        style={{
          position: 'absolute',
          top: 30,
          right: 30,
          background: 'rgba(255,255,255,0.15)',
          borderRadius: 20,
          padding: '4px 16px',
          color: 'rgba(255,255,255,0.7)',
          fontSize: '0.9rem',
        }}
      >
        {scene.index}/{scene.suggestion ? ` ${scene.suggestion.slice(0, 20)}` : ''}
      </div>
    </div>
  );
};

// ============ 主组件 ============
export const ProductShowcase: React.FC<VideoProps> = ({
  scenes = [],
  audioSrc,
  subtitleStyle = {},
}) => {
  const { fps, width, height } = useVideoConfig();

  return (
    <div
      style={{
        position: 'relative',
        width,
        height,
        backgroundColor: '#0a0a1a',
        overflow: 'hidden',
        fontFamily: '"Noto Sans CJK SC", "WenQuanYi Micro Hei", sans-serif',
      }}
    >
      {/* 音频轨道 */}
      {audioSrc && <Audio src={audioSrc} />}

      {/* 渲染所有分镜 */}
      {scenes.map((scene) => (
        <Scene
          key={scene.index}
          scene={scene}
          sceneIndex={scene.index - 1}
        />
      ))}
    </div>
  );
};

// 默认导出 (Remotion 要求)
export default ProductShowcase;

// 注册为 Remotion 可渲染组件
import { registerRoot } from 'remotion';
registerRoot(ProductShowcase);
