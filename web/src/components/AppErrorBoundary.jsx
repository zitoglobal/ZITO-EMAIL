import React, { Component } from 'react';

/** 顶层兜底：避免未捕获渲染错误整站白屏 */
export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err) {
    return { err };
  }

  componentDidCatch(err, info) {
    console.error('[app]', err, info?.componentStack);
  }

  render() {
    if (this.state.err) {
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'grid',
            placeItems: 'center',
            padding: 24,
            fontFamily: 'system-ui, sans-serif',
            background: '#f4f6fb',
            color: '#1f2330',
          }}
        >
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>界面出了点问题</h1>
            <p style={{ fontSize: 13, color: '#5b6172', margin: '0 0 16px', lineHeight: 1.5 }}>
              {this.state.err.message || '未知错误'}。刷新通常可恢复；若反复出现请联系管理员。
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                height: 36,
                padding: '0 16px',
                borderRadius: 8,
                border: 0,
                background: '#0a66ff',
                color: '#fff',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
