/**
 * 全局图标约定：细笔触、光学对齐，避免默认 2px 偏粗。
 * 用法：<Icon as={Reply} /> 或 <Reply {...ICON} />
 */
import React from 'react';

export const ICON = {
  size: 16,
  strokeWidth: 1.75,
};

export const ICON_SM = {
  size: 14,
  strokeWidth: 1.75,
};

export const ICON_LG = {
  size: 20,
  strokeWidth: 1.6,
};

export const ICON_XL = {
  size: 40,
  strokeWidth: 1.25,
};

/** 统一包装 lucide 图标 */
export function Icon({ as: Cmp, size = ICON.size, strokeWidth = ICON.strokeWidth, className, ...rest }) {
  if (!Cmp) return null;
  return <Cmp size={size} strokeWidth={strokeWidth} className={className} aria-hidden={rest['aria-label'] ? undefined : true} {...rest} />;
}
