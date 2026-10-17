/**
 * 全局图标约定：细笔触、光学对齐，避免默认 2px 偏粗。
 * 用法：<Icon as={Reply} /> 或 <Reply {...ip(15)} />
 */
import React from 'react';

export const STROKE = 1.75;

export const ICON = { size: 16, strokeWidth: STROKE };
export const ICON_SM = { size: 14, strokeWidth: STROKE };
export const ICON_MD = { size: 15, strokeWidth: STROKE };
export const ICON_LG = { size: 17, strokeWidth: STROKE };
export const ICON_XL = { size: 40, strokeWidth: 1.25 };

/** 自定义尺寸的图标 props */
export function ip(size = 16, strokeWidth = STROKE) {
  return { size, strokeWidth };
}

/** 统一包装 lucide 图标 */
export function Icon({ as: Cmp, size = ICON.size, strokeWidth = STROKE, className, ...rest }) {
  if (!Cmp) return null;
  const hidden = rest['aria-label'] || rest['aria-labelledby'] || rest['aria-hidden'] === false ? undefined : true;
  return <Cmp size={size} strokeWidth={strokeWidth} className={className} aria-hidden={hidden} {...rest} />;
}
