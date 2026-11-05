import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import Settings from './Settings.js';
// 单位枚举与中文标签直接取共用纯函数模块，测试与页面同源，避免两处各写一份而漂移
import { CHECKIN_DELAY_UNITS, CHECKIN_DELAY_UNIT_LABELS } from '../../server/shared/checkinDelayPolicy.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAuthInfo: vi.fn(),
    getRuntimeSettings: vi.fn(),
    getDownstreamApiKeys: vi.fn(),
    getRoutesLite: vi.fn(),
    getRuntimeDatabaseConfig: vi.fn(),
    getBrandList: vi.fn(),
    updateRuntimeSettings: vi.fn(),
    triggerCheckinAll: vi.fn(),
    getModelTokenCandidates: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: () => null,
  InlineBrandIcon: () => null,
  getBrand: () => null,
  normalizeBrandIconKey: (icon: string) => icon,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// 以下查找辅助都限定在「签到随机延迟」小节容器内，避免误中页面其他卡片的同类控件
function findDelayCard(root: WebTestRenderer): ReactTestInstance {
  return root.root.find((node) => (
    node.type === 'div'
    && node.props['data-settings-card'] === 'checkin-delay'
  ));
}

function findDelayToggle(card: ReactTestInstance): ReactTestInstance {
  return card.find((node) => node.type === 'input' && node.props.type === 'checkbox');
}

function findDelayNumberInputs(card: ReactTestInstance): ReactTestInstance[] {
  // 返回顺序即渲染顺序：[最小延迟, 最大延迟]
  return card.findAll((node) => node.type === 'input' && node.props.type === 'number');
}

function findDelayUnitSelect(card: ReactTestInstance): ReactTestInstance {
  return card.findByType(ModernSelect);
}

async function renderSettings(): Promise<WebTestRenderer> {
  let root!: WebTestRenderer;
  await act(async () => {
    root = create(
      <MemoryRouter>
        <ToastProvider>
          <Settings />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await flushMicrotasks();
  return root;
}

/**
 * 设置页 runtime 回显的基线夹具：与 beforeEach 里的默认值逐字一致，
 * 用例只需覆盖自己关心的字段，避免每条用例重抄二十来个无关键。
 */
function baseRuntime(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    checkinCron: '0 8 * * *',
    checkinScheduleMode: 'cron',
    checkinIntervalHours: 6,
    checkinDelayEnabled: true,
    checkinDelayMin: 1,
    checkinDelayMax: 6,
    checkinDelayUnit: 'hour',
    balanceRefreshCron: '0 * * * *',
    logCleanupCron: '15 4 * * *',
    logCleanupUsageLogsEnabled: true,
    logCleanupProgramLogsEnabled: true,
    logCleanupRetentionDays: 14,
    routingFallbackUnitCost: 1,
    routingWeights: {},
    adminIpAllowlist: [],
    systemProxyUrl: '',
    ...overrides,
  };
}
describe('Settings checkin random delay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAuthInfo.mockResolvedValue({ masked: 'sk-****' });
    apiMock.getRuntimeSettings.mockResolvedValue({
      checkinCron: '0 8 * * *',
      checkinScheduleMode: 'cron',
      checkinIntervalHours: 6,
      // 后端回显的是「原值 + 单位」，不是毫秒
      checkinDelayEnabled: true,
      checkinDelayMin: 1,
      checkinDelayMax: 6,
      checkinDelayUnit: 'hour',
      balanceRefreshCron: '0 * * * *',
      logCleanupCron: '15 4 * * *',
      logCleanupUsageLogsEnabled: true,
      logCleanupProgramLogsEnabled: true,
      logCleanupRetentionDays: 14,
      routingFallbackUnitCost: 1,
      routingWeights: {},
      adminIpAllowlist: [],
      systemProxyUrl: '',
    });
    apiMock.getDownstreamApiKeys.mockResolvedValue({ items: [] });
    apiMock.getRoutesLite.mockResolvedValue([]);
    apiMock.getBrandList.mockResolvedValue({ brands: [] });
    apiMock.getRuntimeDatabaseConfig.mockResolvedValue({
      active: { dialect: 'sqlite', connection: '(default sqlite path)', ssl: false },
      saved: null,
      restartRequired: false,
    });
    apiMock.updateRuntimeSettings.mockResolvedValue({ success: true });
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('displays the four delay values echoed by the runtime settings endpoint', async () => {
    const root = await renderSettings();
    try {
      const card = findDelayCard(root);

      expect(findDelayToggle(card).props.checked).toBe(true);

      const numberInputs = findDelayNumberInputs(card);
      expect(numberInputs).toHaveLength(2);
      expect(numberInputs.map((input) => input.props.value)).toEqual([1, 6]);

      const unitSelect = findDelayUnitSelect(card);
      expect(unitSelect.props.value).toBe('hour');
      // 选项来自共用模块：分钟 / 小时两档，且没有秒级
      expect(unitSelect.props.options).toEqual(
        CHECKIN_DELAY_UNITS.map((unit) => ({ value: unit, label: CHECKIN_DELAY_UNIT_LABELS[unit] })),
      );

      // 说明文案必须传达「偏移只做更晚不做提前」与「仅 Cron 生效」两条关键语义
      expect(collectText(card)).toContain('不做提前');
      expect(collectText(card)).toContain('间隔签到');
    } finally {
      root.unmount();
    }
  });

  it('keeps the three delay inputs disabled while the server reports the switch off', async () => {
    // 首屏就收到 enabled=false 时，三个控件从渲染起即应为禁用状态
    apiMock.getRuntimeSettings.mockResolvedValue({
      checkinCron: '0 8 * * *',
      checkinScheduleMode: 'cron',
      checkinIntervalHours: 6,
      checkinDelayEnabled: false,
      checkinDelayMin: 0,
      checkinDelayMax: 360,
      checkinDelayUnit: 'minute',
      balanceRefreshCron: '0 * * * *',
      logCleanupCron: '15 4 * * *',
      logCleanupUsageLogsEnabled: true,
      logCleanupProgramLogsEnabled: true,
      logCleanupRetentionDays: 14,
      routingFallbackUnitCost: 1,
      routingWeights: {},
      adminIpAllowlist: [],
      systemProxyUrl: '',
    });

    const root = await renderSettings();
    try {
      const card = findDelayCard(root);
      expect(findDelayToggle(card).props.checked).toBe(false);
      expect(findDelayNumberInputs(card).map((input) => input.props.disabled)).toEqual([true, true]);
      expect(findDelayUnitSelect(card).props.disabled).toBe(true);
    } finally {
      root.unmount();
    }
  });

  it('disables the delay inputs when toggling the switch off and re-enables them when toggling on', async () => {
    const root = await renderSettings();
    try {
      const card = findDelayCard(root);

      await act(async () => {
        findDelayToggle(card).props.onChange({ target: { checked: false } });
      });

      expect(findDelayToggle(card).props.checked).toBe(false);
      expect(findDelayNumberInputs(card).map((input) => input.props.disabled)).toEqual([true, true]);
      expect(findDelayUnitSelect(card).props.disabled).toBe(true);

      await act(async () => {
        findDelayToggle(card).props.onChange({ target: { checked: true } });
      });

      expect(findDelayNumberInputs(card).map((input) => input.props.disabled)).toEqual([false, false]);
      expect(findDelayUnitSelect(card).props.disabled).toBe(false);
    } finally {
      root.unmount();
    }
  });

  it('saves the delay fields as raw values plus unit instead of milliseconds', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      checkinCron: '0 8 * * *',
      checkinScheduleMode: 'cron',
      checkinIntervalHours: 6,
      checkinDelayEnabled: true,
      checkinDelayMin: 0,
      checkinDelayMax: 6,
      checkinDelayUnit: 'hour',
      balanceRefreshCron: '0 * * * *',
      logCleanupCron: '15 4 * * *',
      logCleanupUsageLogsEnabled: true,
      logCleanupProgramLogsEnabled: true,
      logCleanupRetentionDays: 14,
      routingFallbackUnitCost: 1,
      routingWeights: {},
      adminIpAllowlist: [],
      systemProxyUrl: '',
    });

    const root = await renderSettings();
    try {
      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '保存定时任务'
      ));

      await act(async () => {
        await saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledTimes(1);
      const payload = apiMock.updateRuntimeSettings.mock.calls[0][0];
      expect(payload).toEqual(expect.objectContaining({
        checkinDelayEnabled: true,
        checkinDelayMin: 0,
        checkinDelayMax: 6,
        checkinDelayUnit: 'hour',
      }));
      // 6 小时必须以原值 + 单位提交，绝不能被换算成 21600000 这类毫秒
      expect(payload.checkinDelayMax).toBe(6);
      expect(JSON.stringify(payload)).not.toContain('21600000');
    } finally {
      root.unmount();
    }
  });

  it('rejects negative and inverted min/max inputs before saving', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      checkinCron: '0 8 * * *',
      checkinScheduleMode: 'cron',
      checkinIntervalHours: 6,
      checkinDelayEnabled: true,
      checkinDelayMin: 10,
      checkinDelayMax: 20,
      checkinDelayUnit: 'minute',
      balanceRefreshCron: '0 * * * *',
      logCleanupCron: '15 4 * * *',
      logCleanupUsageLogsEnabled: true,
      logCleanupProgramLogsEnabled: true,
      logCleanupRetentionDays: 14,
      routingFallbackUnitCost: 1,
      routingWeights: {},
      adminIpAllowlist: [],
      systemProxyUrl: '',
    });

    const root = await renderSettings();
    try {
      const card = findDelayCard(root);
      const minInput = () => findDelayNumberInputs(card)[0];
      const maxInput = () => findDelayNumberInputs(card)[1];

      // 负数被拒绝，保持原值
      await act(async () => {
        minInput().props.onChange({ target: { value: '-5' } });
      });
      expect(minInput().props.value).toBe(10);

      // 最小延迟大于当前最大延迟（30 > 20）被拒绝，保持原值
      await act(async () => {
        minInput().props.onChange({ target: { value: '30' } });
      });
      expect(minInput().props.value).toBe(10);

      // 最大延迟小于当前最小延迟（5 < 10）被拒绝，保持原值
      await act(async () => {
        maxInput().props.onChange({ target: { value: '5' } });
      });
      expect(maxInput().props.value).toBe(20);

      // 合法值正常采纳：max 提到 25 后再把 min 提到 25
      await act(async () => {
        maxInput().props.onChange({ target: { value: '25' } });
      });
      expect(maxInput().props.value).toBe(25);
      await act(async () => {
        minInput().props.onChange({ target: { value: '25' } });
      });
      expect(minInput().props.value).toBe(25);
    } finally {
      root.unmount();
    }
  });

  it('窗口相对账号数过窄时给出提示，且不拦截保存（定稿第 8.2 条）', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue(baseRuntime({
      checkinDelayEnabled: true,
      checkinDelayMin: 0,
      checkinDelayMax: 10,
      checkinDelayUnit: 'minute',
      checkinDelayHint: { windowMs: 600_000, accountCount: 100, avgBandMs: 6_000, tooNarrow: true, compressed: false },
    }));

    const root = await renderSettings();
    try {
      expect(JSON.stringify(root.toJSON())).toContain('分散效果有限');

      // 「仅提示不拦截」：提示亮着时保存按钮仍可点、且仍会发出请求。
      // 沿用本文件既有的定位法（精确文案 + onClick 存在），与上面「saves the delay fields」那条保持一致；
      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '保存定时任务'
      ));

      await act(async () => {
        await saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledTimes(1);
    } finally {
      root.unmount();
    }
  });

  it('窗口未被日终压缩且不过窄时不出现任何提示（定稿第 4 条）', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue(baseRuntime({
      checkinDelayHint: { windowMs: 6 * 3600_000, accountCount: 20, avgBandMs: 18_000_000, tooNarrow: false, compressed: false },
    }));

    const root = await renderSettings();
    try {
      const text = JSON.stringify(root.toJSON());
      expect(text).not.toContain('已被压缩到当日日终');
      expect(text).not.toContain('分散效果有限');
    } finally {
      root.unmount();
    }
  });

  it('服务端读不到判据时不显示任何提示，也不报错（回显为 null 的路径）', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue(baseRuntime({ checkinDelayHint: null }));

    const root = await renderSettings();
    try {
      const text = JSON.stringify(root.toJSON());
      expect(text).not.toContain('分散效果有限');
      expect(text).not.toContain('已被压缩到当日日终');
    } finally {
      root.unmount();
    }
  });

});
