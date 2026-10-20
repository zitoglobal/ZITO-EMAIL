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
            <button
              type="button"
              onClick={() => { window.location.href = '/?box=inbox'; }}
              style={{
                height: 36,
                marginLeft: 8,
                padding: '0 16px',
                borderRadius: 8,
                border: '1px solid #d5d9e2',
                background: '#fff',
                color: '#1f2330',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              回到收件箱
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** 某一栏崩溃时留下列表和侧栏，不把整个邮箱换成全页错误 */
export class PaneErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err) {
    return { err };
  }

  componentDidCatch(err, info) {
    console.error('[pane]', this.props.pane || 'pane', err, info?.componentStack);
  }

  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null });
  }

  render() {
    if (!this.state.err) return this.props.children;
    const pane = this.props.pane === 'list' ? 'list-pane' : 'reader-pane';
    return (
      <section className={`${pane} empty-reader pane-fallback`}>
        <p>{this.props.title || '这一栏暂时打不开'}</p>
        <p className="muted">{this.state.err.message || '未知错误'}。列表和侧栏仍可使用。</p>
        <div className="qr-actions">
          <button type="button" className="btn-ghost sm" onClick={() => this.setState({ err: null })}>
            重试
          </button>
          {this.props.onClose ? (
            <button type="button" className="btn-primary sm" onClick={this.props.onClose}>
              {this.props.closeLabel || '回到列表'}
            </button>
          ) : null}
        </div>
      </section>
    );
  }
}
