import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {getPetSpriteConfigByKey, type PetSpriteAction} from '../data/petSprites';
import {cn} from '../utils/cn';

interface SpriteActorProps {
  spriteKey: string;
  action?: PetSpriteAction;
  className?: string;
  scale?: number;
  flipX?: boolean;
  seed?: number;
  ariaLabel?: string;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
type SpriteConfig = NonNullable<ReturnType<typeof getPetSpriteConfigByKey>>;

const ACTION_TIMING_PROFILE: Record<
  PetSpriteAction,
  {targetLoopMs: number; minFps: number; maxFps: number}
> = {
  idle: {targetLoopMs: 1900, minFps: 0.95, maxFps: 4.8},
  move: {targetLoopMs: 980, minFps: 2.8, maxFps: 8.5},
  feed: {targetLoopMs: 1180, minFps: 1.9, maxFps: 6.8},
  happy: {targetLoopMs: 940, minFps: 2.6, maxFps: 8.2},
};
const BLEND_OUT_MS = 48;

const LOADED_SPRITE_PATHS = new Set<string>();
const LOADING_SPRITE_PATH_TASKS = new Map<string, Promise<void>>();

const ensureSpritePathLoaded = (path: string) => {
  if (!path) return Promise.resolve();
  if (LOADED_SPRITE_PATHS.has(path)) return Promise.resolve();
  const existingTask = LOADING_SPRITE_PATH_TASKS.get(path);
  if (existingTask) return existingTask;

  const task = new Promise<void>((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    const markAsLoaded = () => {
      LOADED_SPRITE_PATHS.add(path);
      LOADING_SPRITE_PATH_TASKS.delete(path);
      resolve();
    };
    image.onload = () => {
      if (typeof image.decode === 'function') {
        image.decode().catch(() => undefined).finally(markAsLoaded);
        return;
      }
      markAsLoaded();
    };
    image.onerror = () => {
      LOADING_SPRITE_PATH_TASKS.delete(path);
      resolve();
    };
    image.src = path;
  });
  LOADING_SPRITE_PATH_TASKS.set(path, task);
  return task;
};

export function SpriteActor({
  spriteKey,
  action = 'idle',
  className,
  scale = 1,
  flipX,
  seed = 0,
  ariaLabel,
}: SpriteActorProps) {
  const targetConfig = getPetSpriteConfigByKey(spriteKey, action);
  const [resolvedConfig, setResolvedConfig] = useState(() => targetConfig ?? null);
  const config =
    targetConfig && LOADED_SPRITE_PATHS.has(targetConfig.path)
      ? targetConfig
      : resolvedConfig;

  const [frameIndex, setFrameIndex] = useState(0);
  const frameMetaRef = useRef<{path: string; frameCount: number}>({
    path: config?.path ?? '',
    frameCount: config?.frameCount ?? 1,
  });
  const previousSeedRef = useRef(seed);
  const lastVisualRef = useRef<{config: SpriteConfig; frameIndex: number} | null>(null);
  const blendTimerRef = useRef<number | null>(null);
  const blendRafRef = useRef<number | null>(null);
  const [blendOverlay, setBlendOverlay] = useState<{config: SpriteConfig; frameIndex: number} | null>(null);
  const [blendOverlayOpacity, setBlendOverlayOpacity] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!targetConfig) {
      setResolvedConfig(null);
      return () => {
        cancelled = true;
      };
    }

    if (LOADED_SPRITE_PATHS.has(targetConfig.path)) {
      setResolvedConfig((previous) => (previous === targetConfig ? previous : targetConfig));
      return () => {
        cancelled = true;
      };
    }

    ensureSpritePathLoaded(targetConfig.path).then(() => {
      if (cancelled) return;
      setResolvedConfig((previous) => (previous === targetConfig ? previous : targetConfig));
    });

    return () => {
      cancelled = true;
    };
  }, [targetConfig]);

  const effectiveFps = useMemo(() => {
    if (!config) return 0;
    const profile = ACTION_TIMING_PROFILE[action];
    const targetFps = config.frameCount / (profile.targetLoopMs / 1000);
    return clamp(targetFps, profile.minFps, profile.maxFps);
  }, [action, config]);

  const frames = useMemo(() => {
    if (!config) return [];
    return Array.from({length: config.frameCount}, (_, index) => index);
  }, [config]);

  useLayoutEffect(() => {
    if (!config) {
      setFrameIndex(0);
      return;
    }

    const isSeedChanged = previousSeedRef.current !== seed;
    previousSeedRef.current = seed;

    const previousMeta = frameMetaRef.current;
    const isPathChanged = previousMeta.path !== config.path;

    setFrameIndex((previous) => {
      if (isSeedChanged) return 0;

      if (!isPathChanged) {
        return clamp(previous, 0, Math.max(config.frameCount - 1, 0));
      }

      const previousMax = Math.max(previousMeta.frameCount - 1, 1);
      const progress = clamp(previous / previousMax, 0, 1);
      const nextMax = Math.max(config.frameCount - 1, 0);
      return Math.round(progress * nextMax);
    });

    frameMetaRef.current = {
      path: config.path,
      frameCount: config.frameCount,
    };
  }, [config?.path, config?.frameCount, seed, spriteKey]);

  useLayoutEffect(() => {
    if (!config) {
      setBlendOverlay(null);
      setBlendOverlayOpacity(0);
      return;
    }

    const previousVisual = lastVisualRef.current;
    if (!previousVisual || previousVisual.config.path === config.path) {
      setBlendOverlay(null);
      setBlendOverlayOpacity(0);
      return;
    }

    if (blendTimerRef.current) {
      window.clearTimeout(blendTimerRef.current);
      blendTimerRef.current = null;
    }
    if (blendRafRef.current) {
      window.cancelAnimationFrame(blendRafRef.current);
      blendRafRef.current = null;
    }

    setBlendOverlay(previousVisual);
    setBlendOverlayOpacity(1);
    blendRafRef.current = window.requestAnimationFrame(() => {
      setBlendOverlayOpacity(0);
    });
    blendTimerRef.current = window.setTimeout(() => {
      setBlendOverlay(null);
      setBlendOverlayOpacity(0);
      blendTimerRef.current = null;
    }, BLEND_OUT_MS);
  }, [config?.path]);

  useEffect(() => {
    if (!config || frames.length <= 1 || effectiveFps <= 0) return;

    const timer = window.setInterval(() => {
      setFrameIndex((previous) => {
        if (previous >= frames.length - 1) {
          return config.loop ? 0 : previous;
        }
        return previous + 1;
      });
    }, 1000 / effectiveFps);

    return () => window.clearInterval(timer);
  }, [config, effectiveFps, frames.length, seed]);

  const safeFrameIndex = Math.min(frameIndex, Math.max(frames.length - 1, 0));
  const currentFrame = frames[safeFrameIndex] ?? 0;

  useEffect(() => {
    if (!config) return;
    lastVisualRef.current = {
      config,
      frameIndex: currentFrame,
    };
  }, [config, currentFrame]);

  useEffect(() => {
    return () => {
      if (blendTimerRef.current) window.clearTimeout(blendTimerRef.current);
      if (blendRafRef.current) window.cancelAnimationFrame(blendRafRef.current);
    };
  }, []);

  if (!config) return null;

  const getFrameStyle = (target: SpriteConfig, frame: number, opacity = 1) => {
    const frameWidth = Math.max(1, Math.round(target.frameWidth * scale));
    const frameHeight = Math.max(1, Math.round(target.frameHeight * scale));
    const columnIndex = frame % target.columns;
    const rowIndex = Math.floor(frame / target.columns);

    return {
      width: `${frameWidth}px`,
      height: `${frameHeight}px`,
      backgroundImage: `url(${target.path})`,
      backgroundPosition: `-${columnIndex * frameWidth}px -${rowIndex * frameHeight}px`,
      backgroundSize: `${target.columns * frameWidth}px ${target.rows * frameHeight}px`,
      transform: flipX ? 'scaleX(-1)' : undefined,
      transformOrigin: 'center',
      opacity,
      transition: blendOverlay ? `opacity ${BLEND_OUT_MS}ms linear` : undefined,
      willChange: 'transform, opacity',
    };
  };

  const currentStyle = getFrameStyle(config, currentFrame, 1);
  const overlayStyle = blendOverlay ? getFrameStyle(blendOverlay.config, blendOverlay.frameIndex, blendOverlayOpacity) : null;

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={cn('relative overflow-hidden [image-rendering:pixelated]', className)}
      style={{
        width: currentStyle.width,
        height: currentStyle.height,
      }}>
      <div className="absolute inset-0 overflow-hidden bg-no-repeat [image-rendering:pixelated]" style={currentStyle} />
      {overlayStyle && (
        <div className="absolute inset-0 overflow-hidden bg-no-repeat [image-rendering:pixelated] pointer-events-none" style={overlayStyle} />
      )}
    </div>
  );
}
