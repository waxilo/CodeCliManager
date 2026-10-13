import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KiroAccessData, KiroModelsStateData } from '../../types';
import { renderKiroViewHtml } from './view';
import { copyKiroAccess, renderKiroAccess, renderKiroModels } from './panel';

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
    openaiBaseUrl: 'http://127.0.0.1:5050/openai/v1',
    apiKeyMasked: 'ccm-••••••••abcd',
    hasApiKey: true,
    model: 'claude-opus-5',
    ...overrides,
  };
}

function query(selector: string): HTMLElement {
  return document.querySelector<HTMLElement>(`#kiro-view ${selector}`)!;
}

/** 构造模型状态；models 为「展示 + 自定义」合并后的候选列表 */
function modelsState(models: string[]): KiroModelsStateData {
  return {
    running: true,
    displayModels: models,
    customModels: [],
    models: [...models],
    defaultModel: models[0] ?? '',
  };
}

function copyBtn(kind: string): HTMLButtonElement {
  return query(`[data-kiro-copy="${kind}"]`) as HTMLButtonElement;
}

const ALL_COPY_KINDS = [
  'base_url',
  'openai_base_url',
  'api_key',
  'env',
  'json',
  'openai_env',
  'openai_json',
];

function modelPickerBtn(): HTMLButtonElement {
  return query('[data-kiro-model-picker]') as HTMLButtonElement;
}

describe('Kiro 外部接入信息', () => {
  beforeEach(() => {
    document.body.innerHTML = renderKiroViewHtml();
    // 模型状态是模块级缓存，必须显式清掉，否则用例间互相污染
    renderKiroModels(null);
    copyAccessMock.mockReset();
    resetKeyMock.mockReset();
    proxyAccessMock.mockReset();
  });

  it('运行中渲染地址 / 脱敏密钥 / 模型，并放开复制', () => {
    renderKiroModels(modelsState(['auto', 'gpt-5.6-sol']));
    renderKiroAccess(runningAccess());

    expect(query('[data-kiro-access-base]').textContent).toBe('http://127.0.0.1:5050');
    expect(query('[data-kiro-access-key]').textContent).toBe('ccm-••••••••abcd');
    expect(query('[data-kiro-access-model]').textContent).toBe('claude-opus-5');
    for (const kind of ALL_COPY_KINDS) {
      expect(copyBtn(kind).disabled).toBe(false);
    }
    expect(modelPickerBtn().disabled).toBe(false);
  });

  it('渲染 OpenAI 入口地址（origin + /openai/v1）', () => {
    renderKiroAccess(runningAccess());

    expect(query('[data-kiro-access-openai]').textContent).toBe(
      'http://127.0.0.1:5050/openai/v1',
    );
  });

  it('未运行时所有复制入口禁用，不展示历史地址', () => {
    renderKiroModels(modelsState(['auto']));
    renderKiroAccess(
      runningAccess({ running: false, port: null, baseUrl: '', openaiBaseUrl: '' }),
    );

    expect(query('[data-kiro-access-base]').textContent).toBe('未运行');
    expect(query('[data-kiro-access-openai]').textContent).toBe('未运行');
    for (const kind of ALL_COPY_KINDS) {
      expect(copyBtn(kind).disabled).toBe(true);
    }
    // 未运行不可选模型
    expect(modelPickerBtn().disabled).toBe(true);
  });

  it('模型选择按钮只在有候选模型时可点', () => {
    // 有候选 → 可点
    renderKiroModels(modelsState(['auto', 'gpt-5.6-sol']));
    renderKiroAccess(runningAccess());
    expect(modelPickerBtn().disabled).toBe(false);

    // 候选为空 → 禁用（没有可选内容）
    renderKiroModels(modelsState([]));
    renderKiroAccess(runningAccess());
    expect(modelPickerBtn().disabled).toBe(true);

    // 模型状态未加载 → 禁用
    renderKiroModels(null);
    renderKiroAccess(runningAccess());
    expect(modelPickerBtn().disabled).toBe(true);
  });

  it('密钥缺失时禁用依赖密钥的复制项，保留地址复制与模型选择', () => {
    renderKiroModels(modelsState(['auto']));
    renderKiroAccess(runningAccess({ apiKeyMasked: '', hasApiKey: false }));

    expect(copyBtn('base_url').disabled).toBe(false);
    expect(copyBtn('openai_base_url').disabled).toBe(false);
    // 模型选择与密钥无关，必须保持可点
    expect(modelPickerBtn().disabled).toBe(false);
    expect(copyBtn('api_key').disabled).toBe(true);
    expect(copyBtn('env').disabled).toBe(true);
    expect(copyBtn('json').disabled).toBe(true);
    expect(copyBtn('openai_env').disabled).toBe(true);
    expect(copyBtn('openai_json').disabled).toBe(true);
  });

  it('未生成密钥时，地址类复制仍会真正调用后端', async () => {
    renderKiroAccess(runningAccess({ apiKeyMasked: '', hasApiKey: false }));

    await copyKiroAccess('base_url');
    expect(copyAccessMock).toHaveBeenCalledWith('base_url');

    copyAccessMock.mockClear();
    await copyKiroAccess('openai_base_url');
    expect(copyAccessMock).toHaveBeenCalledWith('openai_base_url');
  });

  it('两个协议地址必须在页面上分别展示，取值不同', () => {
    renderKiroAccess(runningAccess());

    const anthropic = query('[data-kiro-access-base]').textContent!;
    const openai = query('[data-kiro-access-openai]').textContent!;
    expect(openai).not.toBe(anthropic);
    expect(openai.endsWith('/openai/v1')).toBe(true);
    expect(anthropic.endsWith('/openai/v1')).toBe(false);
  });

  it('复制失败（后端抛错）时不静默，走提示分支', async () => {
    renderKiroAccess(runningAccess());
    copyAccessMock.mockRejectedValueOnce(new Error('Kiro 代理密钥不可用'));

    // 不应抛出，错误被 copyKiroAccess 内部转成 toast
    await expect(copyKiroAccess('api_key')).resolves.toBeUndefined();
    expect(copyAccessMock).toHaveBeenCalledWith('api_key');
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

  it('OpenAI 复制项把 kind 原样传给后端', async () => {
    renderKiroAccess(runningAccess());
    await copyKiroAccess('openai_env');
    expect(copyAccessMock).toHaveBeenCalledWith('openai_env');
  });

  /**
   * 回归：首次渲染（未经过任何二次挂载）就必须把地址 / 密钥 / 模型与复制按钮全部放开。
   *
   * 用户症状是「打开页面后要先重开一次才能复制」。这里从「未运行」渲染一次再切到
   * 「运行中 + 有密钥」，断言同一批按钮立即变为可点 —— 不依赖任何二次 mount。
   * 若后端在启动窗口把 `hasApiKey` 误报为 false，本用例会在 key 类按钮上失败。
   */
  it('首次渲染即可复制：未运行 → 运行中一次刷新即放开全部按钮', () => {
    // 页面初次打开，代理尚未运行
    renderKiroModels(null);
    renderKiroAccess(
      runningAccess({
        running: false,
        port: null,
        baseUrl: '',
        openaiBaseUrl: '',
        apiKeyMasked: '',
        hasApiKey: false,
      }),
    );
    expect(copyBtn('api_key').disabled).toBe(true);

    // 代理启动完成后的第一次 refreshKiroAccess（无需重开页面）
    renderKiroModels(modelsState(['auto']));
    renderKiroAccess(runningAccess());

    expect(query('[data-kiro-access-base]').textContent).toBe('http://127.0.0.1:5050');
    expect(query('[data-kiro-access-openai]').textContent).toBe(
      'http://127.0.0.1:5050/openai/v1',
    );
    expect(query('[data-kiro-access-key]').textContent).toBe('ccm-••••••••abcd');
    for (const kind of ALL_COPY_KINDS) {
      expect(copyBtn(kind).disabled).toBe(false);
    }
    expect(modelPickerBtn().disabled).toBe(false);
  });
});
