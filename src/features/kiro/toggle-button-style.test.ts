import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 「停止」按钮的样式回归保护。
 *
 * 缺陷形态：`renderKiroCard` 给停止态按钮同时挂 `settings-btn-primary` 与
 * `settings-btn-danger`。两条规则特异性同为 (0,1,0)，而 `.settings-btn-primary`
 * 在 settings.css 里排在 `.settings-btn-danger` **之后**，于是主色把危险色全部夺回 ——
 * 真实浏览器实测「停止」与「启动」背景/文字完全相同（bg rgb(94,106,210)、纯白文字），
 * 只在 hover 瞬间闪一下红。
 *
 * jsdom 不做 CSS 级联计算，无法断言 computed style，因此这里退化为
 * **源码级断言**：组合选择器 `.settings-btn-primary.settings-btn-danger` 必须存在
 * 且排在 `.settings-btn-primary` 之后，其特异性 (0,2,0) 高于单类规则 (0,1,0)，
 * 从而稳定胜出。谁删掉这个组合规则，本用例就会失败。
 *
 * 注意：不要改用 `?raw` 导入 —— vitest 会把 CSS 转成空字符串（实测 len=0）。
 */
const settingsCss = readFileSync(
  resolve(process.cwd(), 'src/styles/components/settings.css'),
  'utf8',
);

function specificityOf(selector: string): number {
  const classes = (selector.match(/\.[a-zA-Z0-9_-]+/g) ?? []).length;
  const ids = (selector.match(/#[a-zA-Z0-9_-]+/g) ?? []).length;
  const elements = (selector.match(/(^|[\s>+~])[a-zA-Z][a-zA-Z0-9-]*/g) ?? []).length;
  return ids * 100 + classes * 10 + elements;
}

describe('Kiro「停止」按钮危险色样式', () => {
  it('拿到了真实的样式源码（防止路径/读取方式失效导致假绿）', () => {
    expect(settingsCss.length).toBeGreaterThan(1000);
    expect(settingsCss).toContain('.settings-btn-secondary');
  });

  it('单独的危险类定义了红底红字', () => {
    const block = settingsCss.match(/\.settings-btn-danger\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(block).toContain('background: var(--color-danger-bg)');
    expect(block).toContain('color: var(--color-danger)');
  });

  it('存在 primary + danger 的组合覆盖规则（修复前缺失）', () => {
    expect(settingsCss).toMatch(/\.settings-btn-primary\.settings-btn-danger\s*\{/);
  });

  it('组合规则的特异性高于单类规则，保证稳定胜出', () => {
    const combo = specificityOf('.settings-btn-primary.settings-btn-danger');
    const single = specificityOf('.settings-btn-primary');
    expect(combo).toBeGreaterThan(single);
    expect(combo).toBe(20); // (0,2,0)
    expect(single).toBe(10); // (0,1,0)
  });

  it('组合规则同时覆盖常态与 hover（否则悬停会闪回主色）', () => {
    expect(settingsCss).toMatch(
      /\.settings-btn-primary\.settings-btn-danger:hover:not\(:disabled\)\s*\{/,
    );
  });

  it('组合规则必须排在单类主色规则之后，避免再被夺回', () => {
    const primaryIdx = settingsCss.indexOf('.settings-btn-primary {');
    const comboIdx = settingsCss.indexOf('.settings-btn-primary.settings-btn-danger {');
    expect(primaryIdx).toBeGreaterThan(-1);
    expect(comboIdx).toBeGreaterThan(-1);
    // 即便靠特异性已能胜出，仍要求顺序一致 —— 双保险，且可读性更好
    expect(comboIdx).toBeGreaterThan(primaryIdx);
  });
});
