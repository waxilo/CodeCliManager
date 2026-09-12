import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KiroAccessData } from '../../types';
import { renderKiroViewHtml } from './view';
import { copyKiroAccess, renderKiroAccess } from './panel';

const copyAccessMock = vi.fn();
const resetKeyMock = vi.fn();
const proxyAccessMock = vi.fn();

vi.mock('../../api', () => ({
  kiroCopyAccess: (...args: unknown[]) => copyAccessMock(...args),
  kiroResetProxyKey: (...args: unknown[]) => resetKeyMock(...args),
  kiroProxyAccess: (...args: unknown[]) => proxyAccessMock(...args),
}));

function runningAccess(overrides: Partial<KiroAccessData> = {}): KiroAccessData {
  return {
    running: true,
    port: 5050,
    baseUrl: 'http://127.0.0.1:5050',
    apiKeyMasked: 'ccm-••••••••abcd',
    hasApiKey: true,
    model: 'claude-opus-5',
    ...overrides,
  };
}

function query(selector: string): HTMLElement {
  return document.querySelector<HTMLElement>(`#kiro-card ${selector}`)!;
}

function copyBtn(kind: string): HTMLButtonElement {
  return query(`[data-kiro-copy="${kind}"]`) as HTMLButtonElement;
}

describe('Kiro 外部接入信息', () => {
  beforeEach(() => {
    document.body.innerHTML = renderKiroViewHtml();
    copyAccessMock.mockReset();
    resetKeyMock.mockReset();
    proxyAccessMock.mockReset();
  });

  it('运行中渲染地址 / 脱敏密钥 / 模型，并放开复制', () => {
    renderKiroAccess(runningAccess());

    expect(query('[data-kiro-access-base]').textContent).toBe('http://127.0.0.1:5050');
    expect(query('[data-kiro-access-key]').textContent).toBe('ccm-••••••••abcd');
    expect(query('[data-kiro-access-model]').textContent).toBe('claude-opus-5');
    for (const kind of ['base_url', 'api_key', 'model', 'env', 'json']) {
      expect(copyBtn(kind).disabled).toBe(false);
    }
  });

  it('未运行时所有复制入口禁用，不展示历史地址', () => {
    renderKiroAccess(runningAccess({ running: false, port: null, baseUrl: '' }));

    expect(query('[data-kiro-access-base]').textContent).toBe('未运行');
    for (const kind of ['base_url', 'api_key', 'model', 'env', 'json']) {
      expect(copyBtn(kind).disabled).toBe(true);
    }
  });

  it('密钥缺失时禁用依赖密钥的复制项，保留地址复制', () => {
    renderKiroAccess(runningAccess({ apiKeyMasked: '', hasApiKey: false }));

    expect(copyBtn('base_url').disabled).toBe(false);
    expect(copyBtn('api_key').disabled).toBe(true);
    expect(copyBtn('env').disabled).toBe(true);
    expect(copyBtn('json').disabled).toBe(true);
  });

  it('复制走后端命令，未运行时直接提示且不调用后端', async () => {
    renderKiroAccess(runningAccess());
    await copyKiroAccess('api_key');
    expect(copyAccessMock).toHaveBeenCalledWith('api_key');

    renderKiroAccess(runningAccess({ running: false }));
    copyAccessMock.mockClear();
    await copyKiroAccess('base_url');
    expect(copyAccessMock).not.toHaveBeenCalled();
  });
});
