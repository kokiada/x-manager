import { Component, type ReactNode } from 'react';

/**
 * 描画中の例外でアプリ全体が真っ黒に落ちるのを防ぐ境界。
 * （2026-11-22 の 3-1 後、予約・履歴タブで画面全体が黒くなり操作不能に
 * なった。再読み込みで復旧したが、原因の例外文すら画面に出なかった。）
 * 例外が起きたら画面にメッセージと再読み込みボタンを出し、原因を
 * 追えるようにする。
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // 開発者ツールで原因を追えるよう残す。画面にもメッセージを出す。
    console.error('画面の描画でエラーが発生しました', error);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div style={{ padding: 24, maxWidth: 640, margin: '40px auto' }}>
          <h1 style={{ fontSize: 18 }}>画面の表示でエラーが発生しました</h1>
          <p style={{ fontSize: 13 }}>{error.message || '不明なエラーです。'}</p>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            再読み込みする
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
