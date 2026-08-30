// Remotion 视频模板 - 动画科普风格 (T4.3)
// 适用于知识科普/教育类内容，色彩丰富、动画灵动
// 接收 JSON props: { scenes, width, height, fps, audioSrc, title }
//
// 用法:
//   npx remotion render templates/animation_knowledge/src/index.tsx \
//     --props='{"scenes": [...], "audioSrc": "voice.mp3"}' \
//     out/knowledge.mp4

import React, { useMemo } from 'react';
import {
  useCurrentFrame,
  useVideoConfig,
  Audio,
  Sequence,
  Img,
  interpolate,
  spring,
  AbsoluteFill,
  staticFile,
} from 'remotion';

// ============ 类型 ============
interface SceneItem {
  index: number;
  text: string;
  duration: number;
  start: number;
  end: number;
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
  title?: string;
  subtitleStyle?: {
    fontSize?: number;
    color?: string;
    backgroundColor?: string;
  };
}

// ============ 科普主题色板 ============
const PALETTE = [
  { bg: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', accent: '#ffd700', text: '#ffffff' },
  { bg: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)', accent: '#ffeb3b', text: '#ffffff' },
  { bg: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)', accent: '#ff6b6b', text: '#ffffff' },
  { bg: 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)', accent: '#ff4757', text: '#1a1a2e' },
  { bg: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)', accent: '#2d3436', text: '#ffffff' },
  { bg: 'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)', accent: '#4834d4', text: '#ffffff' },
  { bg: 'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)', accent: '#e17055', text: '#2d3436' },
  { bg: 'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)', accent: '#d63031', text: '#2d3436' },
];

// ============ 粒子效果 ============
const FloatingParticles: React.FC<{ count?: number }> = ({ count = 8 }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {Array.from({ length: count }).map((_, i) => {
        const seed = i * 137.5 + 42;
        const x = (seed * 7.3) % 100;
        const y = ((frame * 0.3 + i * 60)) % height;
        const opacity = interpolate(
          (frame + i * 30) % 120,
          [0, 20, 100, 120],
          [0, 0.6, 0.6, 0],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
        );
        const size = 4 + (i % 3) * 3;

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${x}%`,
              top: y,
              width: size,
              height: size,
              borderRadius: '50%',
              backgroundColor: `rgba(255,255,255,${opacity})`,
              filter: `blur(${i % 2 === 0 ? 1 : 0}px)`,
            }}
          />
        );
      })}
    </div>
  );
};

// ============ 标题入场动画 ============
const AnimatedTitle: React.FC<{ title: string }> = ({ title }) => {
  const frame = useCurrentFrame();
  const springProgress = spring({
    frame,
    fps: 30,
    config: { damping: 15, stiffness: 80, mass: 0.8 },
  });

  const opacity = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: 'clamp' });
  const translateY = interpolate(springProgress, [0, 1], [-30, 0]);
  const scale = interpolate(springProgress, [0, 1], [0.85, 1]);

  return (
    <div
      style={{
        position: 'absolute',
        top: '5%',
        left: '50%',
        transform: `translate(-50%, ${translateY}px) scale(${scale})`,
        opacity,
        zIndex: 10,
      }}
    >
      <div
        style={{
          background: 'rgba(0,0,0,0.5)',
          backdropFilter: 'blur(10px)',
          borderRadius: 30,
          padding: '8px 28px',
          border: '1px solid rgba(255,255,255,0.2)',
        }}
      >
        <span
          style={{
            fontSize: '1.4rem',
            fontWeight: 700,
            color: '#ffffff',
            letterSpacing: '0.05em',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
      </div>
    </div>
  );
};

// ============ 分镜组件 ============
const KnowledgeScene: React.FC<{
  scene: SceneItem;
  sceneIndex: number;
  totalScenes: number;
}> = ({ scene, sceneIndex, totalScenes }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const sceneStartFrame = sceneIndex * scene.duration * fps;
  const sceneEndFrame = (sceneIndex + 1) * scene.duration * fps;

  if (frame < sceneStartFrame || frame >= sceneEndFrame) return null;

  const localFrame = frame - sceneStartFrame;
  const localDuration = scene.duration * fps;

  // 颜色主题
  const theme = PALETTE[sceneIndex % PALETTE.length];

  // 入场动画: 弹性缩放 + 淡入
  const entranceSpring = spring({
    frame: localFrame,
    fps,
    config: { damping: 12, stiffness: 100, mass: 0.6 },
  });

  // 出场动画: 缩小退出
  const exitFrame = localDuration - 8;
  const exitProgress = interpolate(
    localFrame,
    [exitFrame, localDuration],
    [1, 0.3],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const scale = entranceSpring * exitProgress;
  const opacity = interpolate(
    localFrame,
    [0, 5, exitFrame, localDuration],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  // 文字逐字动画
  const chars = [...scene.text];
  const charsPerFrame = Math.max(1, Math.ceil(chars.length / (localDuration * 0.6)));
  const visibleChars = Math.min(chars.length, Math.floor(localFrame * charsPerFrame / fps * 3));

  // 图标动画
  const iconRotate = interpolate(localFrame, [0, 15], [0, 360], { extrapolateRight: 'clamp' });

  // 进度条
  const progress = Math.min(1, localFrame / localDuration);

  return (
    <AbsoluteFill style={{ opacity, overflow: 'hidden' }}>
      {/* 背景渐变 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: theme.bg,
        }}
      />

      {/* 浮动粒子 */}
      <FloatingParticles count={10} />

      {/* 装饰几何图形 */}
      <div
        style={{
          position: 'absolute',
          top: '-10%',
          right: '-5%',
          width: '40%',
          height: '50%',
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.08)',
          transform: `rotate(${iconRotate * 0.5}deg)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: '-15%',
          left: '-10%',
          width: '30%',
          height: '40%',
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.06)',
          transform: `rotate(-${iconRotate * 0.3}deg)`,
        }}
      />

      {/* 主内容区域 */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 8%',
          transform: `scale(${scale})`,
        }}
      >
        {/* 序号徽章 */}
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            backgroundColor: theme.accent,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 20,
            boxShadow: `0 4px 20px ${theme.accent}66`,
          }}
        >
          <span style={{ fontSize: '1.6rem', fontWeight: 'bold', color: '#1a1a2e' }}>
            {scene.index}
          </span>
        </div>

        {/* Suggestion 标签 */}
        {scene.suggestion && (
          <div
            style={{
              fontSize: '0.9rem',
              color: 'rgba(255,255,255,0.7)',
              marginBottom: 16,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
            }}
          >
            {scene.suggestion.slice(0, 30)}
          </div>
        )}

        {/* 主文字 */}
        <p
          style={{
            fontSize: '2.4rem',
            fontWeight: 'bold',
            color: theme.text,
            textAlign: 'center',
            lineHeight: 1.5,
            textShadow: theme.text === '#ffffff'
              ? '0 2px 10px rgba(0,0,0,0.3)'
              : 'none',
            margin: 0,
            maxWidth: '85%',
          }}
        >
          {visibleChars < chars.length ? chars.slice(0, visibleChars).join('') + '|' : scene.text}
        </p>

        {/* 素材来源标签 */}
        {scene.candidates && scene.candidates.length > 0 && (
          <div
            style={{
              marginTop: 24,
              fontSize: '0.8rem',
              color: 'rgba(255,255,255,0.5)',
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              justifyContent: 'center',
            }}
          >
            {scene.candidates.slice(0, 3).map((c, i) => (
              <span
                key={i}
                style={{
                  padding: '2px 10px',
                  borderRadius: 10,
                  background: 'rgba(255,255,255,0.15)',
                  fontSize: '0.7rem',
                }}
              >
                {c.file || '素材'}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 进度条 */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 3,
          background: 'rgba(255,255,255,0.15)',
        }}
      >
        <div
          style={{
            width: `${progress * 100}%`,
            height: '100%',
            background: theme.accent,
            transition: 'width 0.05s linear',
          }}
        />
      </div>

      {/* 分镜计数 */}
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          right: 16,
          fontSize: '0.75rem',
          color: 'rgba(255,255,255,0.5)',
        }}
      >
        {sceneIndex + 1} / {totalScenes}
      </div>
    </AbsoluteFill>
  );
};

// ============ 开场动画 ============
const Intro: React.FC<{ title: string; themeIndex: number }> = ({ title, themeIndex }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const theme = PALETTE[themeIndex % PALETTE.length];

  const opacity = interpolate(frame, [20, 30, 55, 60], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const scale = interpolate(frame, [0, 20], [0.7, 1], {
    extrapolateRight: 'clamp',
  });
  const ringScale = interpolate(frame, [0, 40], [0, 1.5], {
    extrapolateRight: 'clamp',
  });

  if (frame > 60) return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: theme.bg,
        opacity,
        zIndex: 100,
      }}
    >
      {/* 扩散环 */}
      <div
        style={{
          position: 'absolute',
          width: 100,
          height: 100,
          borderRadius: '50%',
          border: `3px solid ${theme.accent}`,
          transform: `scale(${ringScale})`,
          opacity: Math.max(0, 1 - ringScale / 2),
        }}
      />

      <div
        style={{
          textAlign: 'center',
          transform: `scale(${scale})`,
        }}
      >
        <h1
          style={{
            fontSize: '3rem',
            fontWeight: 'bold',
            color: theme.text,
            textShadow: theme.text === '#ffffff' ? '0 4px 20px rgba(0,0,0,0.4)' : 'none',
            margin: 0,
            lineHeight: 1.3,
          }}
        >
          {title}
        </h1>
      </div>
    </div>
  );
};

// ============ 结尾 ============
const Outro: React.FC<{ title: string; totalDuration: number }> = ({ title, totalDuration }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const outroStart = totalDuration * fps - 60;
  if (frame < outroStart) return null;

  const localFrame = frame - outroStart;
  const opacity = interpolate(localFrame, [0, 15, 45, 60], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        opacity,
        zIndex: 100,
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: '1.8rem', color: '#ffffff', fontWeight: 'bold', margin: 0 }}>
          感谢观看
        </p>
        <p style={{ fontSize: '1rem', color: 'rgba(255,255,255,0.6)', marginTop: 12 }}>
          {title}
        </p>
      </div>
    </div>
  );
};

// ============ 主组件 ============
export const AnimationKnowledge: React.FC<VideoProps> = ({
  scenes = [],
  audioSrc,
  title = '',
  subtitleStyle = {},
}) => {
  const { fps, width, height } = useVideoConfig();
  const totalDuration = Math.max(1, scenes.reduce((sum, s) => sum + (s.duration || 5), 0));

  return (
    <div
      style={{
        position: 'relative',
        width,
        height,
        backgroundColor: '#1a1a2e',
        overflow: 'hidden',
        fontFamily: '"Noto Sans CJK SC", "WenQuanYi Micro Hei", sans-serif',
      }}
    >
      {/* 音频轨道 */}
      {audioSrc && <Audio src={staticFile(audioSrc)} />}

      {/* 开场 */}
      {title && <Intro title={title} themeIndex={0} />}

      {/* 标题挂件 */}
      {title && <AnimatedTitle title={title} />}

      {/* 渲染所有分镜 */}
      {scenes.map((scene, i) => (
        <KnowledgeScene
          key={scene.index || i}
          scene={{ ...scene, index: scene.index || i + 1 }}
          sceneIndex={i}
          totalScenes={scenes.length}
        />
      ))}

      {/* 结尾 */}
      <Outro title={title} totalDuration={totalDuration} />
    </div>
  );
};

// 默认导出
export default AnimationKnowledge;

// ============ Remotion 注册 ============
import { registerRoot, Composition } from 'remotion';

const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="AnimationKnowledge"
      component={AnimationKnowledge}
      durationInFrames={3000}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{ scenes: [], audioSrc: '', title: '' }}
    />
  );
};

registerRoot(RemotionRoot);
