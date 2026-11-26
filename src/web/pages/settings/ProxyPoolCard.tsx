import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ProxyPoolEntry } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import { tr } from '../../i18n.js';

type TestState = { kind: 'success' | 'error'; text: string } | null;
type PoolIconName = 'pencil' | 'pencilSquare' | 'check' | 'x' | 'eye' | 'eyeSlash' | 'bolt' | 'trash';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
  fontSize: 13,
};

const PROXY_URL_PROTOCOLS = ['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'];

/** 与服务端 SUPPORTED_PROXY_PROTOCOLS 同口径的前端预校验 */
function isValidProxyUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return PROXY_URL_PROTOCOLS.includes(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

/** 24 格手绘描边图标：与页面既有 empty-state 图标同风格，无图标库依赖 */
function PoolIcon({ name, size = 15 }: { name: PoolIconName; size?: number }) {
  const shapes: Record<PoolIconName, JSX.Element> = {
    pencil: (
      <>
        <path d="M4 20l4-1L20 7l-3-3L5 16l-1 4z" />
        <path d="M15.5 5.5l3 3" />
      </>
    ),
    pencilSquare: (
      <>
        <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
        <path d="M8 16.5l1.2-3.6 6-6 2.4 2.4-6 6L8 16.5z" />
        <path d="M14.2 7.9l2.4 2.4" />
      </>
    ),
    check: <path d="M5 13l4 4 10-11" />,
    x: <path d="M6 6l12 12M18 6L6 18" />,
    eye: (
      <>
        <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    eyeSlash: (
      <>
        <path d="M2.5 12S6 5.5 12 5.5c1.6 0 3 .4 4.2 1M21.5 12S18 18.5 12 18.5c-1.6 0-3-.4-4.2-1" />
        <path d="M9.9 9.9a3 3 0 004.2 4.2" />
        <path d="M4 4l16 16" />
      </>
    ),
    bolt: <path d="M13 2L4.5 13.5H11L9.5 22 19 10h-6.5L13 2z" />,
    trash: (
      <>
        <path d="M4 7h16" />
        <path d="M9 7V4.5h6V7" />
        <path d="M6.5 7l1 12.5h9L17.5 7" />
        <path d="M10 10.5v6M14 10.5v6" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[name]}
    </svg>
  );
}

function PoolIconButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: PoolIconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="btn btn-ghost"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '6px',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        color: danger && !disabled ? 'var(--color-danger)' : undefined,
        flexShrink: 0,
      }}
    >
      <PoolIcon name={icon} />
    </button>
  );
}

/**
 * 系统代理池卡片：多条命名代理、单选默认（允许无默认）、逐条测试（仅即时回显）、
 * 删除与改地址前展示引用影响数。替代旧“单条系统代理”卡片。
 * 布局：名称行（含测试结果右对齐）+ 地址行（编辑/操作图标右对齐，改地址就地编辑并预填原文）。
 */
export default function ProxyPoolCard() {
  const toast = useToast();
  const [items, setItems] = useState<ProxyPoolEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [savingNew, setSavingNew] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [testState, setTestState] = useState<Record<number, TestState>>({});
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [editingNameId, setEditingNameId] = useState<number | null>(null);
  const [editingNameValue, setEditingNameValue] = useState('');
  const [editUrlId, setEditUrlId] = useState<number | null>(null);
  const [editUrlValue, setEditUrlValue] = useState('');
  const [editUrlLoading, setEditUrlLoading] = useState(false);
  const [usageHint, setUsageHint] = useState<Record<number, { siteCount: number; accountCount: number }>>({});
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getProxyPool();
      if (!mountedRef.current) return;
      setItems(Array.isArray(res?.items) ? res.items : []);
    } catch (error: any) {
      if (mountedRef.current) toast.error(error?.message || '加载代理池失败');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const isBusy = (id: number | null) => id !== null && busyId === id;

  const createEntry = async () => {
    const name = newName.trim();
    const url = newUrl.trim();
    if (!name) { toast.info(tr('请填写代理名称')); return; }
    if (!url || !isValidProxyUrl(url)) {
      toast.error(tr('请填写合法的代理地址（支持 http(s)://、socks4://、socks5://）'));
      return;
    }
    setSavingNew(true);
    try {
      await api.createProxyPoolEntry({ name, url });
      setNewName('');
      setNewUrl('');
      toast.success(tr('代理已保存'));
      await load();
    } catch (error: any) {
      toast.error(error?.message || tr('保存代理失败'));
    } finally {
      setSavingNew(false);
    }
  };

  const loadUsage = async (id: number) => {
    try {
      const usage = await api.getProxyPoolUsage(id);
      if (!mountedRef.current) return null;
      setUsageHint((prev) => ({ ...prev, [id]: usage }));
      return usage;
    } catch {
      return null;
    }
  };

  const startEditName = (item: ProxyPoolEntry) => {
    setEditUrlId(null);
    setEditingNameId(item.id);
    setEditingNameValue(item.name);
  };

  const saveName = async (id: number) => {
    const name = editingNameValue.trim();
    if (!name) { toast.info(tr('请填写代理名称')); return; }
    setBusyId(id);
    try {
      await api.updateProxyPoolEntry(id, { name });
      setEditingNameId(null);
      toast.success(tr('名称已更新'));
      await load();
    } catch (error: any) {
      toast.error(error?.message || tr('更新名称失败'));
    } finally {
      setBusyId(null);
    }
  };

  /** 进入地址编辑：预填 reveal 原文，用户就地修改后保存；影响面并行取回 */
  const startEditUrl = async (item: ProxyPoolEntry) => {
    setEditingNameId(null);
    setEditUrlId(item.id);
    setEditUrlValue('');
    setEditUrlLoading(true);
    try {
      const [res] = await Promise.all([
        api.revealProxyPoolEntry(item.id),
        loadUsage(item.id),
      ]);
      if (!mountedRef.current) return;
      setEditUrlValue(res.url);
      setRevealed((prev) => ({ ...prev, [item.id]: res.url }));
    } catch (error: any) {
      toast.error(error?.message || tr('获取完整地址失败'));
      setEditUrlId(null);
    } finally {
      if (mountedRef.current) setEditUrlLoading(false);
    }
  };

  const cancelEditUrl = (id: number) => {
    setEditUrlId(null);
    setEditUrlValue('');
    setRevealed((prev) => { const next = { ...prev }; delete next[id]; return next; });
  };

  const saveUrl = async (id: number) => {
    const url = editUrlValue.trim();
    if (!url || !isValidProxyUrl(url)) {
      toast.error(tr('请填写合法的代理地址（支持 http(s)://、socks4://、socks5://）'));
      return;
    }
    setBusyId(id);
    try {
      await api.updateProxyPoolEntryUrl(id, { url });
      setEditUrlId(null);
      setRevealed((prev) => { const next = { ...prev }; delete next[id]; return next; });
      toast.success(tr('代理地址已更新，引用它的站点/连接已同步生效'));
      await load();
    } catch (error: any) {
      toast.error(error?.message || tr('更新代理地址失败'));
    } finally {
      setBusyId(null);
    }
  };

  const makeDefault = async (id: number) => {
    setBusyId(id);
    try {
      await api.setDefaultProxyPoolEntry(id);
      toast.success(tr('已设为默认系统代理'));
      await load();
    } catch (error: any) {
      toast.error(error?.message || tr('设置默认代理失败'));
    } finally {
      setBusyId(null);
    }
  };

  const runTest = async (id: number) => {
    setBusyId(id);
    setTestState((prev) => ({ ...prev, [id]: null }));
    try {
      const res = await api.testProxyPoolEntry(id);
      setTestState((prev) => ({ ...prev, [id]: { kind: 'success', text: `连通成功，延迟 ${res.latencyMs} ms` } }));
    } catch (error: any) {
      setTestState((prev) => ({ ...prev, [id]: { kind: 'error', text: error?.message || '代理测试失败' } }));
    } finally {
      setBusyId(null);
    }
  };

  const toggleReveal = async (id: number) => {
    if (revealed[id]) {
      setRevealed((prev) => { const next = { ...prev }; delete next[id]; return next; });
      return;
    }
    setBusyId(id);
    try {
      const res = await api.revealProxyPoolEntry(id);
      setRevealed((prev) => ({ ...prev, [id]: res.url }));
    } catch (error: any) {
      toast.error(error?.message || tr('获取完整地址失败'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item: ProxyPoolEntry) => {
    const usage = await loadUsage(item.id);
    if (!mountedRef.current) return;
    const impact = usage
      ? `当前有 ${usage.siteCount} 个站点、${usage.accountCount} 个连接使用此代理，删除后将按优先级回落。`
      : '';
    const confirmed = window.confirm(
      `${tr('确认删除代理')}「${item.name}」？${item.isDefault ? tr('（这是默认系统代理，删除后勾选系统代理的站点将直连）') : ''}\n${impact}`,
    );
    if (!confirmed) { return; }
    setBusyId(item.id);
    try {
      await api.deleteProxyPoolEntry(item.id);
      toast.success(tr('代理已删除'));
      await load();
    } catch (error: any) {
      toast.error(error?.message || tr('删除代理失败'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card animate-slide-up stagger-3" style={{ padding: 20 }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>系统代理池</div>
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12, lineHeight: 1.6 }}>
        保存多个网络代理并选一个作为默认系统代理；站点/连接可按层级引用池内代理。
        优先级：账号代理 &gt; 站点代理 &gt; 系统代理；同一层内：自定义地址 &gt; 代理池 &gt; 系统代理。
        未勾选系统代理的站点默认直连。
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>加载中…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          {items.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              暂无代理，可在下方添加第一条；添加后它会自动成为默认系统代理。
            </div>
          )}
          {items.map((item) => {
            const state = testState[item.id];
            const usage = usageHint[item.id];
            const displayUrl = revealed[item.id] ?? item.url;
            const isEditingName = editingNameId === item.id;
            const isEditingUrl = editUrlId === item.id;
            return (
              <div
                key={item.id}
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '10px 12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  background: item.isDefault ? 'color-mix(in srgb, var(--color-primary) 6%, transparent)' : 'transparent',
                }}
              >
                {/* 第一行：默认选择 + 名称（可就地改名）；右侧统一放测试连通性结果 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <input
                    type="radio"
                    name="proxy-pool-default"
                    aria-label={`设为默认：${item.name}`}
                    checked={item.isDefault}
                    disabled={isBusy(item.id)}
                    onChange={() => void makeDefault(item.id)}
                    style={{ margin: 0 }}
                  />
                  {isEditingName ? (
                    <>
                      <input
                        value={editingNameValue}
                        onChange={(event) => setEditingNameValue(event.target.value)}
                        style={{ ...inputStyle, maxWidth: 220 }}
                        aria-label="编辑代理名称"
                      />
                      <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', fontSize: 12 }} disabled={isBusy(item.id)} onClick={() => void saveName(item.id)}>保存</button>
                      <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', fontSize: 12 }} onClick={() => setEditingNameId(null)}>取消</button>
                    </>
                  ) : (
                    <>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{item.name}</span>
                      {item.isDefault && <span className="badge badge-info" style={{ fontSize: 11 }}>默认</span>}
                      <PoolIconButton icon="pencil" label={tr('改名')} onClick={() => startEditName(item)} disabled={isBusy(item.id)} />
                    </>
                  )}
                  <span
                    style={{
                      marginLeft: 'auto',
                      textAlign: 'right',
                      fontSize: 12,
                      color: state?.kind === 'error' ? 'var(--color-danger)' : 'var(--color-success)',
                    }}
                  >
                    {state?.text || ''}
                  </span>
                </div>

                {/* 第二行：地址（改地址时就地编辑并预填原文）；操作图标统一右对齐 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {isEditingUrl ? (
                    <input
                      value={editUrlValue}
                      onChange={(event) => setEditUrlValue(event.target.value)}
                      placeholder={editUrlLoading ? tr('正在读取完整地址…') : tr('完整代理地址（支持 http(s)://、socks4://、socks5://）')}
                      style={{ ...inputStyle, fontFamily: 'var(--font-mono)', flex: 1, minWidth: 0 }}
                      aria-label="编辑代理地址"
                      disabled={editUrlLoading}
                    />
                  ) : (
                    <code style={{ fontSize: 12, fontFamily: 'var(--font-mono)', wordBreak: 'break-all', flex: 1, minWidth: 0 }}>
                      {displayUrl}
                    </code>
                  )}
                  {isEditingUrl ? (
                    <>
                      {usage && (usage.siteCount > 0 || usage.accountCount > 0) && (
                        <span style={{ fontSize: 11, color: 'var(--color-text-muted)', maxWidth: 220 }}>
                          {`${usage.siteCount} 站点 · ${usage.accountCount} 连接引用`}
                        </span>
                      )}
                      <button
                        className="btn btn-primary"
                        style={{ padding: '6px 10px', fontSize: 12 }}
                        disabled={isBusy(item.id) || editUrlLoading || !editUrlValue.trim()}
                        onClick={() => void saveUrl(item.id)}
                      >
                        {tr('保存')}
                      </button>
                      <PoolIconButton icon="x" label={tr('取消')} onClick={() => cancelEditUrl(item.id)} />
                    </>
                  ) : (
                    <>
                      {item.hasCredentials && (
                        <PoolIconButton
                          icon={revealed[item.id] ? 'eyeSlash' : 'eye'}
                          label={revealed[item.id] ? tr('隐藏') : tr('显示完整地址')}
                          onClick={() => void toggleReveal(item.id)}
                          disabled={isBusy(item.id)}
                        />
                      )}
                      <PoolIconButton
                        icon="bolt"
                        label={tr('测试连通性')}
                        onClick={() => void runTest(item.id)}
                        disabled={isBusy(item.id)}
                      />
                      <PoolIconButton
                        icon="pencilSquare"
                        label={tr('改地址')}
                        onClick={() => void startEditUrl(item)}
                        disabled={isBusy(item.id)}
                      />
                      <PoolIconButton
                        icon="trash"
                        label={tr('删除')}
                        onClick={() => void remove(item)}
                        disabled={isBusy(item.id)}
                        danger
                      />
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{tr('新增代理')}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder={tr('备注名称（如 家宽出口）')}
            style={{ ...inputStyle, maxWidth: 220 }}
            aria-label="新代理名称"
          />
          <input
            value={newUrl}
            onChange={(event) => { setNewUrl(event.target.value); }}
            placeholder={tr('代理地址（如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080）')}
            style={{ ...inputStyle, flex: 1, minWidth: 220, fontFamily: 'var(--font-mono)' }}
            aria-label="新代理地址"
          />
          <button className="btn btn-primary" disabled={savingNew} onClick={() => void createEntry()}>
            {savingNew ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : tr('保存')}
          </button>
        </div>
      </div>
    </div>
  );
}
