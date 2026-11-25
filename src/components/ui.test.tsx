import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tooltip } from './ui';

describe('Tooltip', () => {
  it('説明文と子要素を描画する', () => {
    const html = renderToStaticMarkup(
      <Tooltip label="補足の説明です">
        <span>？</span>
      </Tooltip>,
    );
    expect(html).toContain('補足の説明です');
    expect(html).toContain('？');
    expect(html).toContain('role="tooltip"');
  });

  it('aria-describedby で説明文と結び付ける', () => {
    const html = renderToStaticMarkup(
      <Tooltip label="説明">
        <span>？</span>
      </Tooltip>,
    );
    const match = html.match(/aria-describedby="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(html).toContain(`id="${match![1]}"`);
  });
});
