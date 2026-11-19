import type { Section } from '../components/AppShell';

export function Placeholder({ section }: { section: Section }) {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-no">{section.no}</span>
            {section.label}
          </h1>
          <p className="page-lede">{section.description}</p>
        </div>
      </div>
      <div className="placeholder-box">
        <div className="ph-tag">Coming in {section.milestone}</div>
        <p style={{ marginBottom: 0 }}>
          このセクションは {section.milestone} で実装予定です。基盤（データモデル・Executor
          インターフェース・デザインシステム）は M1 で用意済みのため、ここにそのまま機能が載ります。
        </p>
      </div>
    </div>
  );
}
