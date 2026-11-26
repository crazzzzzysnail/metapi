import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, type ProxyPoolEntry } from "../api.js";
import {
  buildBatchProxyFields,
  isValidProxyUrlValue,
  proxyPoolLabel,
  proxyPoolOptionLabel,
  resolveEffectiveProxy,
  type BatchProxyMode,
} from "./helpers/proxySelection.js";
import CenteredModal from "../components/CenteredModal.js";
import ResponsiveFilterPanel from "../components/ResponsiveFilterPanel.js";
import ResponsiveFormGrid from "../components/ResponsiveFormGrid.js";
import ResponsiveBatchActionBar from "../components/ResponsiveBatchActionBar.js";
import { useToast } from "../components/Toast.js";
import ModernSelect from "../components/ModernSelect.js";
import { MobileCard, MobileField } from "../components/MobileCard.js";
import { useIsMobile } from "../components/useIsMobile.js";
import DeleteConfirmModal from "../components/DeleteConfirmModal.js";
import SiteBadgeLink from "../components/SiteBadgeLink.js";
// 二-1：账号余额/已用的精度口径收敛到 numberFormat 的单一出口。
import { formatBalanceInline, formatBalanceOrDash, stripSymbol } from "../numberFormat.js";
import { useCurrency } from "../currencyContext.js";
import AccountModelsModal from "./accounts/AccountModelsModal.js";
import {
  buildAddAccountPrereqHint,
  buildVerifyFailureHint,
  normalizeVerifyFailureMessage,
} from "./helpers/accountVerifyFeedback.js";
import {
  isTruthyFlag,
  parsePositiveInt,
  resolveAccountCredentialMode,
} from "./helpers/accountConnection.js";
import {
  clearFocusParams,
  readFocusAccountIntent,
} from "./helpers/navigationFocus.js";
import { TokensPanel } from "./Tokens.js";
import { tr } from "../i18n.js";
import {
  balanceUnavailableHint,
  isBalanceNeverRead,
  isUnlimitedQuota,
} from "./helpers/balanceAvailability.js";
import {
  buildCustomReorderUpdates,
  sortItemsForDisplay,
  type SortMode,
} from "./helpers/listSorting.js";
import { shouldIgnoreRowSelectionClick } from "./helpers/rowSelection.js";
import { fetchProxyPoolQuietly } from "./helpers/proxyPoolFetch.js";
import { buildBatchSelectionInfo } from "./helpers/batchSelectionInfo.js";
import { SITE_DOCS_URL } from "../docsLink.js";
import { getSiteInitializationPreset } from "../../shared/siteInitializationPresets.js";
import { parseBatchApiKeys } from "../../shared/apiKeyBatch.js";

type ConnectionsSegment = "session" | "apikey" | "tokens";

const ACCOUNT_SEGMENTS: Array<{
  value: ConnectionsSegment;
  label: string;
  tooltip: string;
  tooltipSide: "top" | "bottom";
  tooltipAlign: "start" | "center" | "end";
}> = [
  {
    value: "session",
    label: "账号管理",
    tooltip: "用于签到、余额、状态维护",
    tooltipSide: "bottom",
    tooltipAlign: "start",
  },
  {
    value: "apikey",
    label: "API Key管理",
    tooltip: "只有 Base URL + Key 时使用，只负责代理调用",
    tooltipSide: "bottom",
    tooltipAlign: "center",
  },
  {
    value: "tokens",
    label: "账号令牌管理",
    tooltip: "从账号同步或手动维护，供路由实际调用",
    tooltipSide: "bottom",
    tooltipAlign: "end",
  },
];

const SITE_SELECT_SEARCH_PLACEHOLDER = "筛选站点（名称 / 平台 / URL）";

function createLoginForm() {
  return { siteId: 0, username: "", password: "" };
}

function createTokenForm(credentialMode: "session" | "apikey" = "session") {
  return {
    siteId: 0,
    username: "",
    accessToken: "",
    platformUserId: "",
    refreshToken: "",
    tokenExpiresAt: "",
    credentialMode,
    skipModelFetch: false,
  };
}

function createRebindForm(platformUserId = "") {
  return {
    accessToken: "",
    platformUserId,
    refreshToken: "",
    tokenExpiresAt: "",
  };
}

function resolveConnectionsSegment(search: string): ConnectionsSegment {
  const rawSegment = new URLSearchParams(search).get("segment");
  if (rawSegment === "apikey" || rawSegment === "tokens") return rawSegment;
  return "session";
}

/**
 * 编辑面板“当前生效”一行：账号层三格按地址轴推导；
 * 账号层为空时跟随站点层（与服务端 resolveChannelProxyUrl 的“账号整层>站点整层”同序）。
 */
function describeAccountEffectiveProxy(
  form: { proxyUrl?: string | null; proxyId?: number | null; useSystemProxy?: boolean },
  pool: ProxyPoolEntry[],
  site?: { proxyUrl?: string | null; proxyId?: number | null; useSystemProxy?: boolean } | null,
): string {
  const accountMode = resolveEffectiveProxy(form, pool);
  if (accountMode === 'custom') return tr('自定义代理地址（覆盖站点）');
  if (accountMode === 'pool') return `代理池 · ${proxyPoolLabel(pool, form.proxyId)}`;
  if (accountMode === 'system') return tr('系统代理（默认条目，覆盖站点）');
  const siteMode = site ? resolveEffectiveProxy(site, pool) : 'direct';
  if (siteMode === 'custom') return tr('跟随站点：自定义代理地址');
  if (siteMode === 'pool') return `${tr('跟随站点')}：${tr('代理池')} · ${proxyPoolLabel(pool, site?.proxyId)}`;
  if (siteMode === 'system') return `${tr('跟随站点')}：${tr('系统代理')}`;
  return tr('跟随站点：直连');
}

/** 列表徽标：账号层任一格已设置才显示；文案按账号层生效源 */
function accountProxyBadgeLabel(
  extra: { proxyUrl?: unknown; proxyId?: unknown; useSystemProxy?: unknown },
  pool: ProxyPoolEntry[],
): string | null {
  const input = {
    proxyUrl: typeof extra?.proxyUrl === 'string' ? extra.proxyUrl : null,
    proxyId: Number.isInteger(Number(extra?.proxyId)) && Number(extra?.proxyId) > 0 ? Number(extra?.proxyId) : null,
    useSystemProxy: extra?.useSystemProxy === true,
  };
  if (!input.proxyUrl && input.proxyId === null && !input.useSystemProxy) return null;
  const mode = resolveEffectiveProxy(input, pool);
  if (mode === 'custom') return tr('代理');
  if (mode === 'pool') return `${tr('代理池')}·${proxyPoolLabel(pool, input.proxyId)}`;
  if (mode === 'system') return tr('系统代理');
  return null;
}

function getAccountRuntimeStatusRank(account: any): number {
  if (account?.status === "expired") return 4;
  if (account?.status === "disabled" || account?.site?.status === "disabled") {
    return 3;
  }
  const state = String(account?.runtimeHealth?.state || "unknown");
  if (state === "healthy") return 0;
  if (state === "degraded") return 1;
  if (state === "unknown") return 2;
  if (state === "disabled") return 3;
  if (state === "unhealthy") return 4;
  return 2;
}

// 余额可得性的三个判据（isBalanceNeverRead / balanceUnavailableHint / isUnlimitedQuota）
// 已抽到 helpers/balanceAvailability.ts —— 搜索弹窗要复用同一套口径，
// 两处各写一份推断迟早会分叉（一处出 `—`、一处出 `$0.00`）。

export default function Accounts() {
  const location = useLocation();
  const navigate = useNavigate();
  const activeSegment = useMemo(
    () => resolveConnectionsSegment(location.search),
    [location.search],
  );
  const [accounts, setAccounts] = useState<any[]>([]);
  const [sites, setSites] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("custom");
  const [highlightAccountId, setHighlightAccountId] = useState<number | null>(
    null,
  );
  const [expandedAccountIds, setExpandedAccountIds] = useState<number[]>([]);
  const isMobile = useIsMobile();
  // 账号余额/已用都是所属站点自己的美元账，必须按该站汇率换算；
  // 充值价未知时退回纯美元数字（每条记录都带站点徽标，逐格再标「充值价未知」过于臃肿）。
  const { currency, getSiteRate } = useCurrency();
  const [showMobileTools, setShowMobileTools] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<"token" | "login">("token");
  const [loginForm, setLoginForm] = useState(createLoginForm);
  const [tokenForm, setTokenForm] = useState(() => createTokenForm("session"));
  const [createIntentPresetId, setCreateIntentPresetId] = useState<
    string | null
  >(null);
  const [applyCreatePresetModels, setApplyCreatePresetModels] = useState(false);
  const [verifyResult, setVerifyResult] = useState<any>(null);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>(
    {},
  );
  const [embeddedTokenActions, setEmbeddedTokenActions] =
    useState<React.ReactNode>(null);
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([]);
  const [batchActionLoading, setBatchActionLoading] = useState(false);
  const [proxyPool, setProxyPool] = useState<ProxyPoolEntry[]>([]);
  const [batchProxyOpen, setBatchProxyOpen] = useState(false);
  const [batchProxyForm, setBatchProxyForm] = useState<{
    applyProxy: boolean;
    proxyMode: BatchProxyMode;
    proxyUrl: string;
    proxyId: number | null;
  }>({ applyProxy: false, proxyMode: "clear", proxyUrl: "", proxyId: null });
  const [deleteConfirm, setDeleteConfirm] = useState<null | {
    mode: "single" | "batch";
    accountId?: number;
    accountName?: string;
    count?: number;
  }>(null);
  const [editingAccount, setEditingAccount] = useState<any | null>(null);
  const [editForm, setEditForm] = useState({
    username: "",
    status: "active",
    checkinEnabled: true,
    unitCost: "",
    accessToken: "",
    apiToken: "",
    isPinned: false,
    refreshToken: "",
    tokenExpiresAt: "",
    proxyUrl: "",
    proxyId: null as number | null,
    useSystemProxy: false,
    manualBalanceUsd: "",
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const [rebindTarget, setRebindTarget] = useState<any | null>(null);
  const [rebindForm, setRebindForm] = useState(() => createRebindForm());
  const [rebindVerifyResult, setRebindVerifyResult] = useState<any>(null);
  const [rebindVerifying, setRebindVerifying] = useState(false);
  const [rebindSaving, setRebindSaving] = useState(false);
  const [modelModal, setModelModal] = useState<{
    open: boolean;
    account: any | null;
    models: Array<{
      name: string;
      latencyMs: number | null;
      disabled: boolean;
      isManual?: boolean;
    }>;
    pendingDisabled: Set<string>;
    loading: boolean;
    saving: boolean;
    siteName: string;
    manualModelsInput: string;
    addingManualModels: boolean;
  }>({
    open: false,
    account: null,
    models: [],
    pendingDisabled: new Set(),
    loading: false,
    saving: false,
    siteName: "",
    manualModelsInput: "",
    addingManualModels: false,
  });
  const [manualModelDeleteConfirm, setManualModelDeleteConfirm] = useState<null | {
    accountId: number;
    accountName: string;
    modelName: string;
  }>(null);
  const [manualModelDeleting, setManualModelDeleting] = useState(false);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRebindTargetRef = useRef<any | null>(null);
  const modelModalRequestSeqRef = useRef(0);
  const toast = useToast();
  if (rebindTarget) lastRebindTargetRef.current = rebindTarget;
  const activeRebindTarget = rebindTarget || lastRebindTargetRef.current;
  const isRebindSub2Api =
    (activeRebindTarget?.site?.platform || "").toLowerCase() === "sub2api";

  const load = async (forceRefresh = false) => {
    try {
      const snapshot = await api.getAccountsSnapshot(
        forceRefresh ? { refresh: true } : undefined,
      );
      const nextAccounts = Array.isArray(snapshot?.accounts)
        ? snapshot.accounts
        : [];
      const nextSites = Array.isArray(snapshot?.sites) ? snapshot.sites : [];
      setAccounts(nextAccounts);
      setSites(nextSites);
      setSelectedAccountIds((current) =>
        current.filter((id) =>
          nextAccounts.some((account: any) => account.id === id),
        ),
      );
    } catch (error: any) {
      toast.error(error?.message || "加载账号列表失败");
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  // 代理池只在设置页编辑，本页按挂载拉一次即可（编辑弹窗/批量/徽标名称共用）；静默失败不影响列表
  useEffect(() => {
    let cancelled = false;
    void fetchProxyPoolQuietly().then((items) => {
      if (!cancelled) setProxyPool(items);
    });
    return () => { cancelled = true; };
  }, []);

  const selectedTokenSite = useMemo(
    () => sites.find((item) => item.id === tokenForm.siteId) || null,
    [sites, tokenForm.siteId],
  );
  const parsedApiKeys = useMemo(
    () =>
      activeSegment === "apikey"
        ? parseBatchApiKeys(tokenForm.accessToken)
        : [],
    [activeSegment, tokenForm.accessToken],
  );
  const isBatchApiKeyInput =
    activeSegment === "apikey" && parsedApiKeys.length > 1;
  const siteSelectOptions = useMemo(
    () => [
      { value: "0", label: "选择站点" },
      ...sites.map((site: any) => ({
        value: String(site.id),
        label: `${site.name} (${site.platform})`,
        description: site.url || undefined,
      })),
    ],
    [sites],
  );
  const isSub2ApiSelected =
    (selectedTokenSite?.platform || "").toLowerCase() === "sub2api";
  const activeAddCredentialMode =
    activeSegment === "apikey" ? "apikey" : "session";
  const createIntentPreset = useMemo(
    () => getSiteInitializationPreset(createIntentPresetId),
    [createIntentPresetId],
  );

  const resetAddForms = (
    credentialMode: "session" | "apikey" = activeAddCredentialMode,
  ) => {
    setAddMode("token");
    setLoginForm(createLoginForm());
    setTokenForm(createTokenForm(credentialMode));
    setCreateIntentPresetId(null);
    setApplyCreatePresetModels(false);
    setVerifyResult(null);
  };

  const closeAddPanel = () => {
    setShowAdd(false);
    setVerifying(false);
    setSaving(false);
    resetAddForms();
  };

  const resolveAccountDisplayName = (account: any) => {
    const username =
      typeof account?.username === "string" ? account.username.trim() : "";
    if (username) return username;
    return resolveAccountCredentialMode(account) === "apikey"
      ? "API Key 连接"
      : "未命名";
  };

  const sortedAccounts = useMemo(
    () =>
      sortItemsForDisplay(
        accounts,
        sortMode,
        (account) => account.balance || 0,
        getAccountRuntimeStatusRank,
      ),
    [accounts, sortMode],
  );
  const visibleAccounts = useMemo(() => {
    if (activeSegment === "tokens") return [];
    return sortedAccounts.filter(
      (account) => resolveAccountCredentialMode(account) === activeSegment,
    );
  }, [activeSegment, sortedAccounts]);
  const allVisibleAccountsSelected =
    visibleAccounts.length > 0 &&
    visibleAccounts.every((account) => selectedAccountIds.includes(account.id));
  // 已选 ∩ 可见：跨分段残留勾选时由计数后缀显式表达（方案 A 契约：筛选/分段永不自动收缩选择集）
  const selectedVisibleAccountIds = useMemo(
    () => selectedAccountIds.filter((id) => visibleAccounts.some((account) => account.id === id)),
    [selectedAccountIds, visibleAccounts],
  );
  const verifyFailureHint = buildVerifyFailureHint(verifyResult);
  const addAccountPrereqHint = buildAddAccountPrereqHint(verifyResult);

  const setSegment = (nextSegment: ConnectionsSegment) => {
    const params = new URLSearchParams(location.search);
    if (nextSegment === "session") params.delete("segment");
    else params.set("segment", nextSegment);
    const nextSearch = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: nextSearch ? `?${nextSearch}` : "",
      },
      { replace: false },
    );
  };

  useEffect(() => {
    if (activeSegment !== "tokens") return;
    closeAddPanel();
    if (rebindTarget) closeRebindPanel();
    setEditingAccount(null);
  }, [activeSegment]);

  useEffect(() => {
    if (activeSegment === "tokens") return;
    setEmbeddedTokenActions(null);
  }, [activeSegment]);

  useEffect(() => {
    if (activeSegment === "tokens" || !loaded) return;
    const params = new URLSearchParams(location.search);
    const shouldOpenCreate = isTruthyFlag(params.get("create"));
    const requestedSiteId = parsePositiveInt(params.get("siteId"));
    if (!shouldOpenCreate || !requestedSiteId) return;

    const credentialMode = activeSegment === "apikey" ? "apikey" : "session";
    const initializationPreset = getSiteInitializationPreset(
      params.get("initPreset"),
    );
    setShowAdd(true);
    setAddMode("token");
    setVerifyResult(null);
    setCreateIntentPresetId(initializationPreset?.id || null);
    setApplyCreatePresetModels(
      Boolean(initializationPreset?.recommendedModels?.length),
    );
    setLoginForm(createLoginForm());
    setTokenForm({
      ...createTokenForm(credentialMode),
      siteId: requestedSiteId,
      skipModelFetch:
        credentialMode === "apikey" &&
        initializationPreset?.recommendedSkipModelFetch === true,
    });

    params.delete("create");
    params.delete("siteId");
    params.delete("from");
    params.delete("initPreset");
    const nextSearch = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: nextSearch ? `?${nextSearch}` : "",
      },
      { replace: true },
    );
  }, [activeSegment, loaded, location.pathname, location.search, navigate]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  const handleLoginAdd = async () => {
    if (!loginForm.siteId || !loginForm.username || !loginForm.password) return;
    setSaving(true);
    try {
      const result = await api.loginAccount(loginForm);
      if (result.success) {
        closeAddPanel();
        const msg = result.apiTokenFound
          ? `账号 "${loginForm.username}" 已添加，API Key 已自动获取`
          : `账号 "${loginForm.username}" 已添加（未找到 API Key，请手动设置）`;
        toast.success(msg);
        load(true);
      } else {
        toast.error(result.message || "登录失败");
      }
    } catch (e: any) {
      toast.error(e.message || "登录请求失败");
    } finally {
      setSaving(false);
    }
  };

  const handleVerifyToken = async () => {
    if (!tokenForm.siteId || !tokenForm.accessToken) return;
    if (isBatchApiKeyInput) {
      toast.info(
        `检测到 ${parsedApiKeys.length} 个 API Key，批量模式会在添加时逐条校验`,
      );
      return;
    }
    const credentialMode = activeSegment === "apikey" ? "apikey" : "session";
    setVerifying(true);
    setVerifyResult(null);
    try {
      const result = await api.verifyToken({
        siteId: tokenForm.siteId,
        accessToken: tokenForm.accessToken,
        platformUserId: tokenForm.platformUserId
          ? parseInt(tokenForm.platformUserId)
          : undefined,
        credentialMode,
      });
      setVerifyResult(result);
      if (result.success) {
        if (result.tokenType === "apikey") {
          toast.success(
            `API Key 验证成功（可用模型 ${result.modelCount || 0} 个）`,
          );
        } else {
          toast.success(
            `Session 验证成功: ${result.userInfo?.username || "未知用户"}`,
          );
        }
      } else {
        toast.error(
          normalizeVerifyFailureMessage(result.message || "Token 无效"),
        );
      }
    } catch (e: any) {
      toast.error(normalizeVerifyFailureMessage(e?.message));
      setVerifyResult({ success: false, message: e?.message });
    } finally {
      setVerifying(false);
    }
  };

  const handleTokenAdd = async () => {
    if (!tokenForm.siteId || !tokenForm.accessToken) return;
    if (
      !isBatchApiKeyInput &&
      !verifyResult?.success &&
      !tokenForm.skipModelFetch
    ) {
      toast.error("请先验证 Token 成功后再添加账号");
      return;
    }
    const credentialMode = activeSegment === "apikey" ? "apikey" : "session";
    const initializationPreset = createIntentPreset;
    setSaving(true);
    try {
      const result = await api.addAccount({
        siteId: tokenForm.siteId,
        username: tokenForm.username.trim() || undefined,
        accessToken: tokenForm.accessToken,
        accessTokens: isBatchApiKeyInput ? parsedApiKeys : undefined,
        platformUserId: tokenForm.platformUserId
          ? parseInt(tokenForm.platformUserId)
          : undefined,
        refreshToken:
          isSub2ApiSelected && tokenForm.refreshToken.trim()
            ? tokenForm.refreshToken.trim()
            : undefined,
        tokenExpiresAt:
          isSub2ApiSelected && tokenForm.tokenExpiresAt.trim()
            ? Number.parseInt(tokenForm.tokenExpiresAt.trim(), 10)
            : undefined,
        credentialMode,
        skipModelFetch: tokenForm.skipModelFetch,
      });
      if (result?.batch) {
        closeAddPanel();
        const createdCount = Number(result.createdCount) || 0;
        const failedCount = Number(result.failedCount) || 0;
        if (createdCount > 0) {
          toast.success(
            `批量添加完成：成功 ${createdCount}，失败 ${failedCount}`,
          );
        }
        const failedItems = Array.isArray(result.items)
          ? result.items.filter((item: any) => item?.status === "failed")
          : [];
        if (failedItems.length > 0) {
          const firstMessage = failedItems[0]?.message || "创建失败";
          toast.error(`失败 ${failedItems.length} 条：${firstMessage}`);
        }
        load(true);
        return;
      }
      let seededRecommendedModels = false;
      const recommendedModels = initializationPreset?.recommendedModels || [];
      const createdAccountId = Number(result?.id) || 0;
      const shouldSeedRecommendedModels =
        credentialMode === "apikey" &&
        tokenForm.skipModelFetch &&
        applyCreatePresetModels &&
        recommendedModels.length > 0 &&
        createdAccountId > 0;
      if (shouldSeedRecommendedModels) {
        try {
          await api.addAccountAvailableModels(
            createdAccountId,
            recommendedModels,
          );
          seededRecommendedModels = true;
        } catch (seedErr: any) {
          toast.error(seedErr?.message || "连接已添加，但推荐模型补录失败");
        }
      }
      closeAddPanel();
      if (result.queued) {
        toast.info(result.message || "账号已添加，后台正在同步初始化信息。");
      } else if (result.tokenType === "apikey") {
        toast.success("已添加为 API Key 账号（可用于代理转发）");
      } else {
        const parts: string[] = [];
        if (result.usernameDetected) parts.push("用户名已自动识别");
        if (result.apiTokenFound) parts.push("API Key 已自动获取");
        const extra = parts.length ? `（${parts.join("，")}）` : "";
        toast.success(`账号已添加${extra}`);
      }
      if (seededRecommendedModels) {
        toast.success(
          `已补入 ${recommendedModels.length} 个推荐模型并重建路由`,
        );
      }
      load(true);
    } catch (e: any) {
      toast.error(e.message || "添加失败");
    } finally {
      setSaving(false);
    }
  };

  const withLoading = async (
    key: string,
    fn: () => Promise<any>,
    // 第三参数可以是固定文案，也可以是从响应里取文案的函数：
    // 全量签到这类「服务端才知道结果」的操作需要播报服务端文案（例如随机延迟的最迟完成时刻）。
    successMsg?: string | ((res: any) => string),
  ) => {
    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      const res = await fn();
      const message = typeof successMsg === 'function' ? successMsg(res) : successMsg;
      if (message) toast.success(message);
    } catch (e: any) {
      toast.error(e.message || "操作失败");
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
      void load(true);
    }
  };

  const formatModelSuccess = (refresh: any) => {
    const models = Array.isArray(refresh?.modelsPreview)
      ? refresh.modelsPreview
      : [];
    const count = Number.isFinite(refresh?.modelCount)
      ? refresh.modelCount
      : models.length;
    if (models.length === 0) return `已获取到模型（共 ${count} 个）`;
    const preview = models.slice(0, 6).join("、");
    const suffix = `（共 ${count} 个）`;
    return `已获取到模型：${preview}${suffix}`;
  };

  const formatModelFailure = (refresh: any, messageFallback?: string) => {
    const code = refresh?.errorCode;
    if (code === "timeout") return "模型获取失败（请求超时）";
    if (code === "unauthorized") return "模型获取失败，API Key 已无效";
    if (code === "empty_models") return "模型获取失败：未获取到可用模型";
    return messageFallback || refresh?.errorMessage || "模型获取失败";
  };

  const handleCheckModels = async (accountId: number) => {
    const key = `models-${accountId}`;
    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      const result = await api.checkModels(accountId);
      const refresh = result?.refresh;
      if (!refresh || refresh.status !== "success") {
        toast.error(formatModelFailure(refresh, result?.message));
      } else {
        toast.success(formatModelSuccess(refresh));
      }
    } catch (e: any) {
      toast.error(e.message || "模型获取失败");
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
      void load(true);
    }
  };

  const applyLoadedModelModal = (account: any, result: any) => {
    const models = Array.isArray(result?.models) ? result.models : [];
    const disabledSet = new Set<string>(
      models.filter((m: any) => m.disabled).map((m: any) => m.name as string),
    );
    setModelModal((s) => ({
      ...s,
      loading: false,
      models,
      pendingDisabled: disabledSet,
      siteName: result?.siteName || account.site?.name || s.siteName,
    }));
  };

  const loadModelModalModels = async (
    account: any,
    options: {
      refreshUpstream?: boolean;
      resetBeforeLoad?: boolean;
      closeOnError?: boolean;
      successMessage?: string | null;
      errorMessage?: string;
    } = {},
  ) => {
    const requestId = ++modelModalRequestSeqRef.current;
    setModelModal((s) => ({
      ...s,
      open: true,
      account,
      loading: true,
      ...(options.resetBeforeLoad
        ? {
            models: [],
            pendingDisabled: new Set<string>(),
            siteName: "",
            manualModelsInput: "",
          }
        : {}),
    }));
    try {
      if (options.refreshUpstream) {
        await api.checkModels(account.id);
      }
      const result = await api.getAccountModels(account.id);
      if (modelModalRequestSeqRef.current !== requestId) return;
      applyLoadedModelModal(account, result);
      if (options.successMessage) {
        toast.success(options.successMessage);
      }
    } catch (e: any) {
      if (modelModalRequestSeqRef.current !== requestId) return;
      toast.error(e.message || options.errorMessage || "加载模型列表失败");
      setModelModal((s) =>
        options.closeOnError
          ? { ...s, open: false, account: null, loading: false }
          : { ...s, loading: false },
      );
    }
  };

  const openModelModal = async (account: any) => {
    await loadModelModalModels(account, {
      resetBeforeLoad: true,
      closeOnError: true,
      errorMessage: "加载模型列表失败",
    });
  };

  const closeModelModal = () => {
    modelModalRequestSeqRef.current += 1;
    setModelModal((s) => ({
      ...s,
      open: false,
      account: null,
      manualModelsInput: "",
      addingManualModels: false,
    }));
    setManualModelDeleteConfirm(null);
    setManualModelDeleting(false);
  };

  const toggleModelDisabled = (modelName: string) => {
    setModelModal((s) => {
      const next = new Set(s.pendingDisabled);
      if (next.has(modelName)) next.delete(modelName);
      else next.add(modelName);
      return { ...s, pendingDisabled: next };
    });
  };

  const saveModelDisabled = async () => {
    if (!modelModal.account) return;
    const siteId = modelModal.account.siteId;
    setModelModal((s) => ({ ...s, saving: true }));
    try {
      await api.updateSiteDisabledModels(
        siteId,
        Array.from(modelModal.pendingDisabled),
      );
      try {
        await api.rebuildRoutes(false, false);
        toast.success("模型禁用设置已保存，路由已重建");
      } catch {
        toast.error("模型禁用设置已保存，但路由重建失败，请手动刷新路由");
      }
      closeModelModal();
    } catch (e: any) {
      toast.error(e.message || "保存失败");
    } finally {
      setModelModal((s) => ({ ...s, saving: false }));
    }
  };

  const openManualModelDeleteConfirm = (modelName: string) => {
    if (!modelModal.account) return;
    setManualModelDeleteConfirm({
      accountId: modelModal.account.id,
      accountName: resolveAccountDisplayName(modelModal.account),
      modelName,
    });
  };

  const confirmManualModelDelete = async () => {
    const target = manualModelDeleteConfirm;
    if (!target) return;

    setManualModelDeleteConfirm(null);
    setManualModelDeleting(true);
    try {
      const res = await api.deleteAccountAvailableModel(
        target.accountId,
        target.modelName,
      );
      if (!res?.success) {
        toast.error(res?.message || "移除手动模型失败");
        return;
      }

      toast.success("手动模型已移除");
      if (modelModal.account && modelModal.account.id === target.accountId) {
        await loadModelModalModels(modelModal.account, {
          refreshUpstream: false,
        });
      } else {
        await load(true);
      }
    } catch (e: any) {
      toast.error(e.message || "移除手动模型失败");
    } finally {
      setManualModelDeleting(false);
    }
  };

  const handleAddManualModels = async () => {
    if (!modelModal.account || !modelModal.manualModelsInput.trim()) return;
    const modelsToAdd = modelModal.manualModelsInput
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (modelsToAdd.length === 0) return;

    setModelModal((s) => ({ ...s, addingManualModels: true }));
    try {
      const res = await api.addAccountAvailableModels(
        modelModal.account.id,
        modelsToAdd,
      );
      if (res.success) {
        toast.success("模型已手动添加");
        setModelModal((s) => ({ ...s, manualModelsInput: "" }));
        await loadModelModalModels(modelModal.account, {
          refreshUpstream: false,
        });
      } else {
        toast.error(res.message || "手动添加模型失败");
      }
    } catch (e: any) {
      toast.error(e.message || "手动添加模型失败");
    } finally {
      setModelModal((s) => ({ ...s, addingManualModels: false }));
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 14px",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    fontSize: 13,
    outline: "none",
    background: "var(--color-bg)",
    color: "var(--color-text-primary)",
  };

  const runtimeHealthMap: Record<
    string,
    {
      label: string;
      cls: string;
      dotClass: string;
      pulse: boolean;
    }
  > = {
    healthy: {
      label: "健康",
      cls: "badge-success",
      dotClass: "status-dot-success",
      pulse: true,
    },
    unhealthy: {
      label: "异常",
      cls: "badge-error",
      dotClass: "status-dot-error",
      pulse: true,
    },
    degraded: {
      label: "降级",
      cls: "badge-warning",
      dotClass: "status-dot-pending",
      pulse: true,
    },
    disabled: {
      label: "已禁用",
      cls: "badge-muted",
      dotClass: "status-dot-muted",
      pulse: false,
    },
    unknown: {
      label: "未知",
      cls: "badge-muted",
      dotClass: "status-dot-pending",
      pulse: false,
    },
  };

  const resolveRuntimeHealth = (account: any) => {
    if (account.status === "expired") {
      return {
        ...runtimeHealthMap.unhealthy,
        label: "已过期",
        reason: account.runtimeHealth?.reason || "连接凭证已过期，请更新凭证",
      };
    }
    const capabilities = resolveAccountCapabilities(account);
    const fallbackState =
      account.status === "disabled" || account.site?.status === "disabled"
        ? "disabled"
        : !capabilities.proxyOnly && account.status === "expired"
          ? "unhealthy"
          : "unknown";
    const state = account.runtimeHealth?.state || fallbackState;
    const cfg = runtimeHealthMap[state] || runtimeHealthMap.unknown;
    const reason =
      account.runtimeHealth?.reason ||
      (state === "disabled"
        ? "账号或站点已禁用"
        : state === "unhealthy"
          ? "最近健康检查失败"
          : "尚未获取运行健康信息");
    return { state, reason, ...cfg };
  };

  const resolveAccountCapabilities = (account: any) => {
    const fromServer = account?.capabilities;
    if (fromServer && typeof fromServer === "object") {
      return {
        canCheckin: !!fromServer.canCheckin,
        canRefreshBalance: !!fromServer.canRefreshBalance,
        proxyOnly: !!fromServer.proxyOnly,
      };
    }
    const hasSession =
      typeof account?.accessToken === "string" &&
      account.accessToken.trim().length > 0;
    return {
      canCheckin: hasSession,
      canRefreshBalance: hasSession,
      proxyOnly: !hasSession,
    };
  };

  const handleRefreshRuntimeHealth = async () => {
    setActionLoading((s) => ({ ...s, "health-refresh": true }));
    try {
      const res = await api.refreshAccountHealth();
      if (res?.queued) {
        toast.info(res.message || "账号状态刷新任务已提交，完成后会自动更新。");
      } else {
        toast.success(res?.message || "账号状态已刷新");
      }
      load(true);
    } catch (e: any) {
      toast.error(e.message || "刷新账号状态失败");
    } finally {
      setActionLoading((s) => ({ ...s, "health-refresh": false }));
    }
  };

  const handleToggleCheckin = async (account: any) => {
    const key = `checkin-toggle-${account.id}`;
    const nextEnabled = !account.checkinEnabled;
    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      await api.updateAccount(account.id, { checkinEnabled: nextEnabled });
      toast.success(
        nextEnabled ? "已开启签到" : "已关闭签到（全部签到会忽略此账号）",
      );
      load(true);
    } catch (e: any) {
      toast.error(e.message || "切换签到状态失败");
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
    }
  };

  const handleTogglePin = async (account: any) => {
    const key = `pin-toggle-${account.id}`;
    const nextPinned = !account.isPinned;
    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      await api.updateAccount(account.id, { isPinned: nextPinned });
      toast.success(nextPinned ? "账号已置顶" : "账号已取消置顶");
      load(true);
    } catch (e: any) {
      toast.error(e.message || "切换账号置顶失败");
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
    }
  };

  const handleMoveCustomOrder = async (
    account: any,
    direction: "up" | "down",
  ) => {
    const key = `reorder-${account.id}`;
    const updates = buildCustomReorderUpdates(accounts, account.id, direction);
    if (updates.length === 0) return;

    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      await Promise.all(
        updates.map((update) =>
          api.updateAccount(update.id, { sortOrder: update.sortOrder }),
        ),
      );
      load(true);
    } catch (e: any) {
      toast.error(e.message || "更新账号排序失败");
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
    }
  };

  const parseAccountExtraConfig = (account: any): Record<string, any> => {
    try {
      return JSON.parse(account?.extraConfig || "{}") || {};
    } catch {
      return {};
    }
  };

  const extractManagedSub2ApiAuth = (account: any) => {
    const parsed = parseAccountExtraConfig(account);
    const auth = parsed?.sub2apiAuth || {};
    return {
      refreshToken:
        typeof auth.refreshToken === "string" ? auth.refreshToken : "",
      tokenExpiresAt: auth.tokenExpiresAt ? String(auth.tokenExpiresAt) : "",
    };
  };

  const openEditPanel = (account: any) => {
    const managedAuth = extractManagedSub2ApiAuth(account);
    const parsedExtra = parseAccountExtraConfig(account);
    const proxyUrl = parsedExtra?.proxyUrl || "";
    const rawProxyId = Number(parsedExtra?.proxyId);
    const proxyId = Number.isInteger(rawProxyId) && rawProxyId > 0 ? rawProxyId : null;
    // 手动余额存的是数字，输入框要字符串；null/缺省一律显示空（= 自动获取）
    const manualBalanceUsd =
      parsedExtra?.manualBalanceUsd === undefined ||
      parsedExtra?.manualBalanceUsd === null
        ? ""
        : String(parsedExtra.manualBalanceUsd);
    closeAddPanel();
    setRebindTarget(null);
    setEditingAccount(account);
    setEditForm({
      username: account?.username || "",
      status: account?.status || "active",
      checkinEnabled: account?.checkinEnabled !== false,
      unitCost:
        account?.unitCost === null || account?.unitCost === undefined
          ? ""
          : String(account.unitCost),
      accessToken: account?.accessToken || "",
      apiToken: account?.apiToken || "",
      isPinned: !!account?.isPinned,
      refreshToken: managedAuth.refreshToken,
      tokenExpiresAt: managedAuth.tokenExpiresAt,
      proxyUrl,
      proxyId,
      useSystemProxy: parsedExtra?.useSystemProxy === true,
      manualBalanceUsd,
    });
  };

  const closeEditPanel = () => {
    setEditingAccount(null);
    setSavingEdit(false);
  };

  const saveEditPanel = async () => {
    if (!editingAccount) return;
    setSavingEdit(true);
    try {
      await api.updateAccount(editingAccount.id, {
        username: editForm.username.trim() || undefined,
        status: editForm.status,
        checkinEnabled: editForm.checkinEnabled,
        unitCost: editForm.unitCost.trim()
          ? Number(editForm.unitCost.trim())
          : null,
        accessToken: editForm.accessToken.trim(),
        apiToken: editForm.apiToken.trim() || null,
        isPinned: editForm.isPinned,
        refreshToken: editForm.refreshToken.trim() || null,
        tokenExpiresAt: editForm.tokenExpiresAt.trim()
          ? Number.parseInt(editForm.tokenExpiresAt.trim(), 10)
          : null,
        proxyUrl: editForm.proxyUrl.trim() || null,
        // 三格共存：未填的格下发 null=清除，由服务端合并进 extra_config
        proxyId: editForm.proxyId ?? null,
        useSystemProxy: editForm.useSystemProxy,
        manualBalanceUsd: editForm.manualBalanceUsd.trim() || null,
      });
      toast.success("账号已更新");
      closeEditPanel();
      load(true);
    } catch (e: any) {
      toast.error(e.message || "更新账号失败");
    } finally {
      setSavingEdit(false);
    }
  };

  const toggleAccountSelection = (accountId: number, checked: boolean) => {
    setSelectedAccountIds((current) =>
      checked
        ? Array.from(new Set([...current, accountId]))
        : current.filter((id) => id !== accountId),
    );
  };

  const toggleSelectAllVisibleAccounts = (checked: boolean) => {
    if (!checked) {
      setSelectedAccountIds((current) =>
        current.filter(
          (id) => !visibleAccounts.some((account) => account.id === id),
        ),
      );
      return;
    }
    setSelectedAccountIds((current) =>
      Array.from(
        new Set([...current, ...visibleAccounts.map((account) => account.id)]),
      ),
    );
  };

  const toggleAccountDetails = (accountId: number) => {
    setExpandedAccountIds((current) =>
      current.includes(accountId)
        ? current.filter((id) => id !== accountId)
        : [...current, accountId],
    );
  };

  const runBatchAccountAction = async (
    action: "enable" | "disable" | "delete" | "refreshBalance",
    skipDeleteConfirm = false,
  ) => {
    if (selectedAccountIds.length === 0) return;
    if (action === "delete" && !skipDeleteConfirm) {
      setDeleteConfirm({ mode: "batch", count: selectedAccountIds.length });
      return;
    }

    setBatchActionLoading(true);
    try {
      const result = await api.batchUpdateAccounts({
        ids: selectedAccountIds,
        action,
      });
      const successIds = Array.isArray(result?.successIds)
        ? result.successIds.map((id: unknown) => Number(id))
        : [];
      const failedItems = Array.isArray(result?.failedItems)
        ? result.failedItems
        : [];
      if (failedItems.length > 0) {
        toast.info(
          `批量操作完成：成功 ${successIds.length}，失败 ${failedItems.length}`,
        );
      } else {
        toast.success(`批量操作完成：成功 ${successIds.length}`);
      }
      setSelectedAccountIds(
        failedItems
          .map((item: any) => Number(item.id))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      );
      load(true);
    } catch (e: any) {
      toast.error(e.message || "批量操作失败");
    } finally {
      setBatchActionLoading(false);
    }
  };

  // 批量设置代理：与站点批量同形（四模式互斥），走 /api/accounts/batch 的 updateSettings
  const runBatchProxySettings = async () => {
    if (selectedAccountIds.length === 0) return;
    if (!batchProxyForm.applyProxy) {
      toast.info(tr('请勾选批量设置连接代理'));
      return;
    }
    if (batchProxyForm.proxyMode === 'custom') {
      const trimmed = batchProxyForm.proxyUrl.trim();
      if (!trimmed || !isValidProxyUrlValue(trimmed)) {
        toast.error(tr('请填写合法的代理地址（支持 http(s)://、socks4://、socks5://）'));
        return;
      }
    } else if (batchProxyForm.proxyMode === 'pool' && !batchProxyForm.proxyId) {
      toast.error(tr('请选择代理池中的一个代理'));
      return;
    }
    const fields = buildBatchProxyFields(batchProxyForm.proxyMode, {
      proxyUrl: batchProxyForm.proxyUrl,
      proxyId: batchProxyForm.proxyId,
    });
    setBatchActionLoading(true);
    try {
      const result = await api.batchUpdateAccounts({
        ids: selectedAccountIds,
        action: 'updateSettings',
        proxyUrl: fields.proxyUrl,
        proxyId: fields.proxyId,
        useSystemProxy: fields.useSystemProxy,
      });
      const successIds = Array.isArray(result?.successIds)
        ? result.successIds.map((id: unknown) => Number(id))
        : [];
      const failedItems = Array.isArray(result?.failedItems) ? result.failedItems : [];
      if (failedItems.length > 0) {
        toast.info(`批量设置完成：成功 ${successIds.length}，失败 ${failedItems.length}`);
        setBatchProxyOpen(true);
      } else {
        toast.success(`批量设置完成：成功 ${successIds.length}`);
        setBatchProxyOpen(false);
      }
      setSelectedAccountIds(
        failedItems
          .map((item: any) => Number(item.id))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      );
      load(true);
    } catch (e: any) {
      toast.error(e.message || "批量设置代理失败");
    } finally {
      setBatchActionLoading(false);
    }
  };

  const confirmDelete = async () => {
    const target = deleteConfirm;
    if (!target) return;

    setDeleteConfirm(null);
    if (target.mode === "single" && target.accountId) {
      await withLoading(
        `delete-${target.accountId}`,
        () => api.deleteAccount(target.accountId!),
        "已删除",
      );
      return;
    }

    await runBatchAccountAction("delete", true);
  };

  const handleAccountRowClick = (
    accountId: number,
    event: React.MouseEvent<HTMLTableRowElement>,
  ) => {
    if (shouldIgnoreRowSelectionClick(event.target)) return;
    const isSelected = selectedAccountIds.includes(accountId);
    toggleAccountSelection(accountId, !isSelected);
  };

  const extractPlatformUserId = (account: any): string => {
    const parsed = parseAccountExtraConfig(account);
    const raw = parsed?.platformUserId;
    const value = Number.parseInt(String(raw ?? ""), 10);
    if (Number.isFinite(value) && value > 0) return String(value);
    const guessed = Number.parseInt(
      String(account?.username || "").match(/(\d{3,8})$/)?.[1] || "",
      10,
    );
    return Number.isFinite(guessed) && guessed > 0 ? String(guessed) : "";
  };

  const openRebindPanel = (account: any) => {
    closeAddPanel();
    setEditingAccount(null);
    setRebindTarget(account);
    setRebindForm(createRebindForm(extractPlatformUserId(account)));
    setRebindVerifyResult(null);
  };

  const closeRebindPanel = () => {
    setRebindTarget(null);
    setRebindForm(createRebindForm());
    setRebindVerifyResult(null);
    setRebindVerifying(false);
    setRebindSaving(false);
  };

  const handleVerifyRebindToken = async () => {
    if (!rebindTarget || !rebindForm.accessToken.trim()) return;
    setRebindVerifying(true);
    setRebindVerifyResult(null);
    try {
      const result = await api.verifyToken({
        siteId: rebindTarget.siteId,
        accessToken: rebindForm.accessToken.trim(),
        platformUserId: rebindForm.platformUserId
          ? Number.parseInt(rebindForm.platformUserId, 10)
          : undefined,
        credentialMode: "session",
      });
      setRebindVerifyResult(result);
      if (result.success && result.tokenType === "session") {
        toast.success("Session Token 验证成功，可以重新绑定");
      } else if (result.success && result.tokenType !== "session") {
        toast.error("当前是 API Key，不是 Session Token");
      } else {
        toast.error(
          normalizeVerifyFailureMessage(result.message || "Token 无效"),
        );
      }
    } catch (e: any) {
      toast.error(normalizeVerifyFailureMessage(e?.message));
      setRebindVerifyResult({ success: false, message: e?.message });
    } finally {
      setRebindVerifying(false);
    }
  };

  const handleSubmitRebind = async () => {
    if (!rebindTarget || !rebindForm.accessToken.trim()) return;
    if (
      !(
        rebindVerifyResult?.success &&
        rebindVerifyResult?.tokenType === "session"
      )
    ) {
      toast.error("请先验证新的 Session Token 成功");
      return;
    }
    const isSub2ApiRebindTarget =
      (rebindTarget?.site?.platform || "").toLowerCase() === "sub2api";
    setRebindSaving(true);
    try {
      await api.rebindAccountSession(rebindTarget.id, {
        accessToken: rebindForm.accessToken.trim(),
        platformUserId: rebindForm.platformUserId
          ? Number.parseInt(rebindForm.platformUserId, 10)
          : undefined,
        refreshToken:
          isSub2ApiRebindTarget && rebindForm.refreshToken.trim()
            ? rebindForm.refreshToken.trim()
            : undefined,
        tokenExpiresAt:
          isSub2ApiRebindTarget && rebindForm.tokenExpiresAt.trim()
            ? Number.parseInt(rebindForm.tokenExpiresAt, 10)
            : undefined,
      });
      toast.success("账号重新绑定成功，状态已恢复");
      closeRebindPanel();
      load(true);
    } catch (e: any) {
      toast.error(e.message || "重新绑定失败");
    } finally {
      setRebindSaving(false);
    }
  };

  useEffect(() => {
    const { accountId, openRebind } = readFocusAccountIntent(location.search);
    if (!accountId || !loaded || activeSegment === "tokens") return;

    const target = visibleAccounts.find((account) => account.id === accountId);
    const row = rowRefs.current.get(accountId);
    const cleanedSearch = clearFocusParams(location.search);
    if (!target || !row) {
      navigate(
        { pathname: location.pathname, search: cleanedSearch },
        { replace: true },
      );
      return;
    }

    row.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightAccountId(accountId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightAccountId((current) =>
        current === accountId ? null : current,
      );
    }, 2200);

    if (
      openRebind &&
      target.status === "expired" &&
      !resolveAccountCapabilities(target).proxyOnly
    ) {
      setShowAdd(false);
      if (!rebindTarget || rebindTarget.id !== target.id) {
        openRebindPanel(target);
      }
    }

    navigate(
      { pathname: location.pathname, search: cleanedSearch },
      { replace: true },
    );
  }, [
    activeSegment,
    loaded,
    location.pathname,
    location.search,
    navigate,
    openRebindPanel,
    rebindTarget,
    visibleAccounts,
  ]);

  const canAddVerifiedConnection = Boolean(
    verifyResult?.success &&
    ((activeSegment === "apikey" && verifyResult.tokenType === "apikey") ||
      (activeSegment === "session" && verifyResult.tokenType === "session")),
  );
  const canSubmitApiKeyConnection =
    activeSegment === "apikey"
      ? isBatchApiKeyInput ||
        canAddVerifiedConnection ||
        !!tokenForm.skipModelFetch
      : canAddVerifiedConnection;

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h2 className="page-title">{tr("连接管理")}</h2>
        {activeSegment !== "tokens" && (
          <div className="page-actions accounts-page-actions">
            {isMobile ? (
              <>
                <button
                  type="button"
                  onClick={() => setShowMobileTools(true)}
                  className="btn btn-ghost"
                  style={{ border: "1px solid var(--color-border)" }}
                >
                  排序与操作
                </button>
                <button
                  type="button"
                  data-testid="accounts-mobile-select-all"
                  onClick={() =>
                    toggleSelectAllVisibleAccounts(!allVisibleAccountsSelected)
                  }
                  className="btn btn-ghost"
                  style={{ border: "1px solid var(--color-border)" }}
                >
                  {allVisibleAccountsSelected ? "取消全选" : "全选可见项"}
                </button>
              </>
            ) : (
              <>
                <div
                  className="accounts-sort-select"
                  style={{ minWidth: 156, position: "relative", zIndex: 20 }}
                >
                  <ModernSelect
                    size="sm"
                    value={sortMode}
                    onChange={(nextValue) => setSortMode(nextValue as SortMode)}
                    options={[
                      { value: "custom", label: "自定义排序" },
                      { value: "runtime-status", label: "运行状态" },
                      { value: "balance-desc", label: "余额高到低" },
                      { value: "balance-asc", label: "余额低到高" },
                    ]}
                    placeholder="自定义排序"
                  />
                </div>
                {activeSegment === "session" && (
                  <button
                    onClick={() =>
                      withLoading(
                        "checkin-all",
                        () => api.triggerCheckinAll(),
                        // 开启随机延迟后服务端会回「已按随机延迟排期 N 个账号，最迟 HH:MM 完成」；
                        // 关闭时服务端回的就是原来这句，所以旧行为不变。
                        (res) => res?.message || "已触发全部签到",
                      )
                    }
                    disabled={actionLoading["checkin-all"]}
                    className="btn btn-soft-primary"
                  >
                    {actionLoading["checkin-all"] ? (
                      <>
                        <span className="spinner spinner-sm" />
                        {tr("签到中...")}
                      </>
                    ) : (
                      tr("全部签到")
                    )}
                  </button>
                )}
                <button
                  onClick={handleRefreshRuntimeHealth}
                  disabled={actionLoading["health-refresh"]}
                  className="btn btn-soft-primary"
                >
                  {actionLoading["health-refresh"] ? (
                    <>
                      <span className="spinner spinner-sm" />
                      {tr("刷新状态中...")}
                    </>
                  ) : (
                    tr("刷新账户状态")
                  )}
                </button>
              </>
            )}
            <button
              onClick={() => {
                const nextOpen = !showAdd;
                if (!nextOpen) {
                  closeAddPanel();
                  return;
                }
                setEditingAccount(null);
                closeRebindPanel();
                setShowAdd(true);
                resetAddForms(activeAddCredentialMode);
              }}
              className="btn btn-primary"
            >
              {showAdd ? tr("取消") : tr("+ 添加连接")}
            </button>
          </div>
        )}
        {activeSegment === "tokens" && embeddedTokenActions}
      </div>

      <ResponsiveFilterPanel
        isMobile={isMobile}
        mobileOpen={showMobileTools}
        onMobileClose={() => setShowMobileTools(false)}
        mobileTitle="连接排序与操作"
        mobileContent={
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                排序方式
              </div>
              <ModernSelect
                value={sortMode}
                onChange={(nextValue) => setSortMode(nextValue as SortMode)}
                options={[
                  { value: "custom", label: "自定义排序" },
                  { value: "runtime-status", label: "运行状态" },
                  { value: "balance-desc", label: "余额高到低" },
                  { value: "balance-asc", label: "余额低到高" },
                ]}
                placeholder="自定义排序"
              />
            </div>
            {activeSegment === "session" && (
              <button
                onClick={async () => {
                  setShowMobileTools(false);
                  await withLoading(
                    "checkin-all",
                    () => api.triggerCheckinAll(),
                    // 与桌面端同一口径：优先播报服务端文案（含随机延迟的最迟完成时刻）。
                    (res) => res?.message || "已触发全部签到",
                  );
                }}
                disabled={actionLoading["checkin-all"]}
                className="btn btn-ghost"
                style={{ border: "1px solid var(--color-border)" }}
              >
                {actionLoading["checkin-all"] ? (
                  <>
                    <span className="spinner spinner-sm" />
                    {tr("签到中...")}
                  </>
                ) : (
                  tr("全部签到")
                )}
              </button>
            )}
            <button
              onClick={async () => {
                setShowMobileTools(false);
                await handleRefreshRuntimeHealth();
              }}
              disabled={actionLoading["health-refresh"]}
              className="btn btn-ghost"
              style={{ border: "1px solid var(--color-border)" }}
            >
              {actionLoading["health-refresh"] ? (
                <>
                  <span className="spinner spinner-sm" />
                  {tr("刷新状态中...")}
                </>
              ) : (
                tr("刷新账户状态")
              )}
            </button>
          </div>
        }
      />

      <div
        style={{
          display: "inline-flex",
          gap: 4,
          padding: 4,
          marginBottom: 16,
          background: "var(--color-bg-card)",
          border: "1px solid var(--color-border-light)",
          borderRadius: "var(--radius-md)",
        }}
      >
        {ACCOUNT_SEGMENTS.map((segment) => (
          <button
            key={segment.value}
            type="button"
            onClick={() => setSegment(segment.value)}
            data-tooltip={segment.tooltip}
            data-tooltip-side={segment.tooltipSide}
            data-tooltip-align={segment.tooltipAlign}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "none",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
              background:
                activeSegment === segment.value
                  ? "var(--color-bg)"
                  : "transparent",
              color:
                activeSegment === segment.value
                  ? "var(--color-primary)"
                  : "var(--color-text-secondary)",
              boxShadow:
                activeSegment === segment.value ? "var(--shadow-sm)" : "none",
              transition: "all 0.2s ease",
            }}
          >
            {segment.label}
          </button>
        ))}
      </div>

      <DeleteConfirmModal
        open={Boolean(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={confirmDelete}
        title="确认删除连接"
        confirmText="确认删除"
        loading={
          batchActionLoading ||
          (deleteConfirm?.mode === "single" &&
            !!actionLoading[`delete-${deleteConfirm?.accountId}`])
        }
        description={
          deleteConfirm?.mode === "single" ? (
            <>
              确定要删除连接{" "}
              <strong>
                {deleteConfirm.accountName || `#${deleteConfirm.accountId}`}
              </strong>{" "}
              吗？
            </>
          ) : (
            <>
              确定要删除选中的 <strong>{deleteConfirm?.count || 0}</strong>{" "}
              个连接吗？
            </>
          )
        }
      />

      {activeSegment !== "tokens" && selectedAccountIds.length > 0 && (
        <ResponsiveBatchActionBar
          isMobile={isMobile}
          info={buildBatchSelectionInfo(selectedAccountIds.length, selectedVisibleAccountIds.length, "项")}
          desktopStyle={{ marginBottom: 12 }}
          sticky
        >
          <button
            data-testid="accounts-batch-refresh-balance"
            onClick={() => runBatchAccountAction("refreshBalance")}
            disabled={batchActionLoading}
            className="btn btn-ghost"
            style={{ border: "1px solid var(--color-border)" }}
          >
            {isMobile ? tr('刷新') : tr('批量刷新余额')}
          </button>
          <button
            onClick={() => runBatchAccountAction("enable")}
            disabled={batchActionLoading}
            className="btn btn-ghost"
            style={{ border: "1px solid var(--color-border)" }}
          >
            {isMobile ? tr('启用') : tr('批量启用')}
          </button>
          <button
            onClick={() => runBatchAccountAction("disable")}
            disabled={batchActionLoading}
            className="btn btn-ghost"
            style={{ border: "1px solid var(--color-border)" }}
          >
            {isMobile ? tr('禁用') : tr('批量禁用')}
          </button>
          <button
            data-testid="accounts-batch-proxy"
            onClick={() => {
              setBatchProxyForm({ applyProxy: true, proxyMode: "clear", proxyUrl: "", proxyId: null });
              setBatchProxyOpen(true);
            }}
            disabled={batchActionLoading}
            className="btn btn-ghost"
            style={{ border: "1px solid var(--color-border)" }}
          >
            {isMobile ? tr('代理') : tr('批量设置代理')}
          </button>
          <button
            onClick={() => runBatchAccountAction("delete")}
            disabled={batchActionLoading}
            className="btn btn-link btn-link-danger"
          >
            {isMobile ? tr('删除') : tr('批量删除')}
          </button>
          {selectedAccountIds.length > selectedVisibleAccountIds.length && (
            <button
              type="button"
              data-testid="accounts-batch-keep-visible"
              onClick={() => setSelectedAccountIds((prev) => prev.filter((id) => visibleAccounts.some((account) => account.id === id)))}
              disabled={batchActionLoading}
              className="btn btn-ghost"
              style={{ border: "1px solid var(--color-border)" }}
            >
              {tr('只保留可见项')}
            </button>
          )}
        </ResponsiveBatchActionBar>
      )}

      {activeSegment === "tokens" ? (
        <TokensPanel
          embedded
          onEmbeddedActionsChange={setEmbeddedTokenActions}
        />
      ) : (
        <>
          <CenteredModal
            open={showAdd}
            onClose={closeAddPanel}
            title={
              activeSegment === "apikey"
                ? "添加 API Key 连接"
                : addMode === "login"
                  ? "账号密码登录"
                  : "添加 Session 连接"
            }
            maxWidth={860}
            bodyStyle={{ display: "flex", flexDirection: "column", gap: 12 }}
            footer={
              <button onClick={closeAddPanel} className="btn btn-ghost">
                取消
              </button>
            }
          >
            {activeSegment === "session" ? (
              <>
                <div
                  style={{
                    display: "flex",
                    gap: 0,
                    background: "var(--color-bg)",
                    borderRadius: "var(--radius-sm)",
                    padding: 3,
                    marginBottom: 16,
                  }}
                >
                  <button
                    onClick={() => {
                      setAddMode("token");
                      setVerifyResult(null);
                    }}
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: 500,
                      border: "none",
                      cursor: "pointer",
                      transition: "all 0.2s",
                      background:
                        addMode === "token"
                          ? "var(--color-bg-card)"
                          : "transparent",
                      color:
                        addMode === "token"
                          ? "var(--color-primary)"
                          : "var(--color-text-muted)",
                      boxShadow:
                        addMode === "token" ? "var(--shadow-sm)" : "none",
                    }}
                  >
                    Session Token / Cookie
                  </button>
                  <button
                    onClick={() => {
                      setAddMode("login");
                      setVerifyResult(null);
                    }}
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: 500,
                      border: "none",
                      cursor: "pointer",
                      transition: "all 0.2s",
                      background:
                        addMode === "login"
                          ? "var(--color-bg-card)"
                          : "transparent",
                      color:
                        addMode === "login"
                          ? "var(--color-primary)"
                          : "var(--color-text-muted)",
                      boxShadow:
                        addMode === "login" ? "var(--shadow-sm)" : "none",
                    }}
                  >
                    账号密码登录
                  </button>
                </div>

                {addMode === "token" ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 12,
                    }}
                  >
                    <div className="info-tip">
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: 4 }}>
                          当前分段仅创建 Session 连接
                        </div>
                        <div>
                          <strong>推荐</strong> 使用系统访问令牌（Access
                          Token）；浏览器 Cookie 仅用于兼容场景。
                        </div>
                        <div style={{ marginTop: 2 }}>
                          以 NewAPI 为例：控制台 → 个人设置 → 安全设置 →
                          生成「系统访问令牌」
                        </div>
                        <div
                          style={{
                            opacity: 0.7,
                            borderTop: "1px solid rgba(0,0,0,0.1)",
                            paddingTop: 6,
                            marginTop: 6,
                          }}
                        >
                          获取 Cookie:{" "}
                          <kbd
                            style={{
                              padding: "1px 5px",
                              background: "var(--color-bg-card)",
                              border: "1px solid var(--color-border)",
                              borderRadius: 3,
                              fontSize: 11,
                            }}
                          >
                            F12
                          </kbd>{" "}
                          → Application → Cookie
                        </div>
                        <div style={{ marginTop: 6 }}>
                          <a
                            href={SITE_DOCS_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              fontSize: 12,
                              color: "var(--color-primary)",
                              textDecoration: "underline",
                            }}
                          >
                            查看认证方式与特殊站点说明文档
                          </a>
                        </div>
                      </div>
                    </div>
                    <ModernSelect
                      value={String(tokenForm.siteId || 0)}
                      onChange={(nextValue) => {
                        const nextSiteId = Number.parseInt(nextValue, 10) || 0;
                        setTokenForm((f) => ({ ...f, siteId: nextSiteId }));
                        setVerifyResult(null);
                      }}
                      options={siteSelectOptions}
                      placeholder="选择站点"
                      searchable
                      searchPlaceholder={SITE_SELECT_SEARCH_PLACEHOLDER}
                    />
                    <input
                      placeholder="连接名称（可选）"
                      value={tokenForm.username}
                      onChange={(e) =>
                        setTokenForm((f) => ({
                          ...f,
                          username: e.target.value,
                        }))
                      }
                      style={inputStyle}
                    />
                    <textarea
                      placeholder="粘贴 Session Access Token 或浏览器 Cookie"
                      value={tokenForm.accessToken}
                      onChange={(e) => {
                        setTokenForm((f) => ({
                          ...f,
                          accessToken: e.target.value.trim(),
                        }));
                        setVerifyResult(null);
                      }}
                      style={{
                        ...inputStyle,
                        fontFamily: "var(--font-mono)",
                        height: 72,
                        resize: "none" as const,
                      }}
                    />
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      <input
                        placeholder="用户 ID（可选）"
                        value={tokenForm.platformUserId}
                        onChange={(e) => {
                          setTokenForm((f) => ({
                            ...f,
                            platformUserId: e.target.value.replace(/\D/g, ""),
                          }));
                          setVerifyResult(null);
                        }}
                        style={inputStyle}
                      />
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--color-text-muted)",
                        }}
                      >
                        若站点要求 New-Api-User / User-ID，请在这里提前填写。
                      </div>
                    </div>
                    {isSub2ApiSelected && (
                      <>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                          }}
                        >
                          <input
                            placeholder="Sub2API refresh_token（可选，用于托管自动续期）"
                            value={tokenForm.refreshToken}
                            onChange={(e) =>
                              setTokenForm((f) => ({
                                ...f,
                                refreshToken: e.target.value.trim(),
                              }))
                            }
                            style={{
                              ...inputStyle,
                              fontFamily: "var(--font-mono)",
                            }}
                          />
                          <div
                            style={{
                              fontSize: 12,
                              color: "var(--color-text-muted)",
                            }}
                          >
                            可在浏览器控制台执行{" "}
                            <code style={{ fontFamily: "var(--font-mono)" }}>
                              localStorage.getItem('refresh_token')
                            </code>{" "}
                            获取。
                          </div>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                          }}
                        >
                          <input
                            placeholder="token_expires_at（可选，毫秒时间戳）"
                            value={tokenForm.tokenExpiresAt}
                            onChange={(e) =>
                              setTokenForm((f) => ({
                                ...f,
                                tokenExpiresAt: e.target.value.replace(
                                  /\D/g,
                                  "",
                                ),
                              }))
                            }
                            style={inputStyle}
                          />
                          <div
                            style={{
                              fontSize: 12,
                              color: "var(--color-text-muted)",
                            }}
                          >
                            配置 refresh_token 后，metapi 会在 JWT 临近过期或
                            401 时自动续期并回写新 token。
                          </div>
                        </div>
                      </>
                    )}
                    {verifyResult &&
                      verifyResult.success &&
                      verifyResult.tokenType === "session" && (
                        <div className="alert alert-success animate-scale-in">
                          <div
                            className="alert-title"
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            <svg
                              width="14"
                              height="14"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                              />
                            </svg>
                            Session 凭证有效（Access Token / Cookie）
                          </div>
                          <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                            <div>
                              用户名:{" "}
                              <strong>
                                {verifyResult.userInfo?.username || "未知"}
                              </strong>
                            </div>
                            {verifyResult.balance && (
                              <div>
                                余额:{" "}
                                <strong>
                                  {formatBalanceInline(
                                    verifyResult.balance.balance,
                                    currency,
                                    getSiteRate(tokenForm.siteId),
                                  )}
                                </strong>
                              </div>
                            )}
                            <div>
                              API Key:{" "}
                              <span
                                style={{
                                  fontWeight: 500,
                                  color: verifyResult.apiToken
                                    ? "var(--color-success)"
                                    : "var(--color-text-muted)",
                                }}
                              >
                                {verifyResult.apiToken
                                  ? `已找到 (${verifyResult.apiToken.substring(0, 8)}...)`
                                  : "未找到"}
                              </span>
                            </div>
                          </div>
                        </div>
                      )}
                    {verifyResult &&
                      verifyResult.success &&
                      verifyResult.tokenType === "apikey" && (
                        <div className="alert alert-warning animate-scale-in">
                          <div className="alert-title">
                            当前分段仅接受 Session 凭证，请切到「API Key
                            连接」分段创建。
                          </div>
                        </div>
                      )}
                    {verifyResult &&
                      !verifyResult.success &&
                      verifyResult.needsUserId && (
                        <div className="alert alert-warning animate-scale-in">
                          <div className="alert-title">
                            此站点要求用户 ID，请补充后重新验证
                          </div>
                        </div>
                      )}
                    {verifyResult &&
                      !verifyResult.success &&
                      !verifyResult.needsUserId && (
                        <div className="alert alert-error animate-scale-in">
                          <div className="alert-title">
                            {normalizeVerifyFailureMessage(
                              verifyResult.message,
                            ) || "Token 无效或已过期"}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: "var(--color-text-muted)",
                              marginTop: 4,
                            }}
                          >
                            {verifyFailureHint || "请检查 Token 是否正确"}
                          </div>
                        </div>
                      )}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        onClick={handleVerifyToken}
                        disabled={
                          verifying ||
                          !tokenForm.siteId ||
                          !tokenForm.accessToken
                        }
                        className="btn btn-ghost"
                        style={{
                          border: "1px solid var(--color-border)",
                          padding: "8px 14px",
                        }}
                      >
                        {verifying ? (
                          <>
                            <span className="spinner spinner-sm" />
                            验证中...
                          </>
                        ) : (
                          "验证 Token"
                        )}
                      </button>
                      <button
                        onClick={handleTokenAdd}
                        disabled={
                          saving ||
                          !tokenForm.siteId ||
                          !tokenForm.accessToken ||
                          !canAddVerifiedConnection
                        }
                        className="btn btn-success"
                      >
                        {saving ? (
                          <>
                            <span
                              className="spinner spinner-sm"
                              style={{
                                borderTopColor: "white",
                                borderColor: "rgba(255,255,255,0.3)",
                              }}
                            />
                            添加中...
                          </>
                        ) : (
                          "添加连接"
                        )}
                      </button>
                    </div>
                    {!verifyResult?.success && (
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--color-text-muted)",
                        }}
                      >
                        {addAccountPrereqHint}
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 12,
                    }}
                  >
                    <div className="info-tip">
                      输入目标站点的账号密码，将自动登录并获取访问令牌和 API Key
                    </div>
                    <ModernSelect
                      value={String(loginForm.siteId || 0)}
                      onChange={(nextValue) => {
                        const nextSiteId = Number.parseInt(nextValue, 10) || 0;
                        setLoginForm((f) => ({ ...f, siteId: nextSiteId }));
                      }}
                      options={siteSelectOptions}
                      placeholder="选择站点"
                      searchable
                      searchPlaceholder={SITE_SELECT_SEARCH_PLACEHOLDER}
                    />
                    <input
                      placeholder="用户名"
                      value={loginForm.username}
                      onChange={(e) =>
                        setLoginForm((f) => ({
                          ...f,
                          username: e.target.value,
                        }))
                      }
                      style={inputStyle}
                    />
                    <input
                      type="password"
                      placeholder="密码"
                      value={loginForm.password}
                      onChange={(e) =>
                        setLoginForm((f) => ({
                          ...f,
                          password: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => e.key === "Enter" && handleLoginAdd()}
                      style={inputStyle}
                    />
                    <button
                      onClick={handleLoginAdd}
                      disabled={
                        saving ||
                        !loginForm.siteId ||
                        !loginForm.username ||
                        !loginForm.password
                      }
                      className="btn btn-success"
                      style={{ alignSelf: "flex-start" }}
                    >
                      {saving ? (
                        <>
                          <span
                            className="spinner spinner-sm"
                            style={{
                              borderTopColor: "white",
                              borderColor: "rgba(255,255,255,0.3)",
                            }}
                          />
                          登录并添加...
                        </>
                      ) : (
                        "登录并添加"
                      )}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <div className="info-tip">
                  API Key
                  连接只用于代理转发，不会自动派生账号令牌。系统会按站点平台能力自动引导到
                  Session 或 API Key 创建流程。
                </div>
                {createIntentPreset && (
                  <div className="alert alert-info animate-scale-in">
                    <div className="alert-title">
                      {createIntentPreset.label}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--color-text-muted)",
                        marginTop: 4,
                        lineHeight: 1.8,
                      }}
                    >
                      <div>{createIntentPreset.description}</div>
                      <div>
                        推荐模型：
                        {createIntentPreset.recommendedModels.join(" / ")}
                      </div>
                      {createIntentPreset.recommendedSkipModelFetch && (
                        <div>
                          建议直接跳过模型验证，先保存 Base URL +
                          Key，再补入推荐模型完成初始化。
                        </div>
                      )}
                    </div>
                    {createIntentPreset.recommendedModels.length > 0 && (
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          fontSize: 12,
                          cursor: "pointer",
                          marginTop: 8,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={applyCreatePresetModels}
                          onChange={(e) =>
                            setApplyCreatePresetModels(e.target.checked)
                          }
                          style={{ width: 14, height: 14 }}
                        />
                        <span>添加后自动补入推荐模型并重建路由</span>
                      </label>
                    )}
                  </div>
                )}
                <ModernSelect
                  value={String(tokenForm.siteId || 0)}
                  onChange={(nextValue) => {
                    const nextSiteId = Number.parseInt(nextValue, 10) || 0;
                    setTokenForm((f) => ({
                      ...f,
                      siteId: nextSiteId,
                      credentialMode: "apikey",
                    }));
                    setVerifyResult(null);
                    if (
                      createIntentPresetId &&
                      nextSiteId !== tokenForm.siteId
                    ) {
                      setCreateIntentPresetId(null);
                      setApplyCreatePresetModels(false);
                    }
                  }}
                  options={siteSelectOptions}
                  placeholder="选择站点"
                  searchable
                  searchPlaceholder={SITE_SELECT_SEARCH_PLACEHOLDER}
                />
                <input
                  placeholder="连接名称（可选）"
                  value={tokenForm.username}
                  onChange={(e) =>
                    setTokenForm((f) => ({
                      ...f,
                      username: e.target.value,
                      credentialMode: "apikey",
                    }))
                  }
                  style={inputStyle}
                />
                <textarea
                  placeholder="粘贴 API Key"
                  value={tokenForm.accessToken}
                  onChange={(e) => {
                    setTokenForm((f) => ({
                      ...f,
                      accessToken: e.target.value,
                      credentialMode: "apikey",
                    }));
                    setVerifyResult(null);
                  }}
                  style={{
                    ...inputStyle,
                    fontFamily: "var(--font-mono)",
                    height: 72,
                    resize: "none" as const,
                  }}
                />
                {parsedApiKeys.length > 0 && (
                  <div
                    style={{ fontSize: 12, color: "var(--color-text-muted)" }}
                  >
                    已识别 {parsedApiKeys.length} 个 API Key
                    {isBatchApiKeyInput
                      ? "，添加时会逐条创建同站点连接并参与轮询"
                      : ""}
                  </div>
                )}
                <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                  支持换行、空格、逗号批量粘贴多个 API Key。
                </div>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <input
                    placeholder="用户 ID（可选）"
                    value={tokenForm.platformUserId}
                    onChange={(e) => {
                      setTokenForm((f) => ({
                        ...f,
                        platformUserId: e.target.value.replace(/\D/g, ""),
                        credentialMode: "apikey",
                      }));
                      setVerifyResult(null);
                    }}
                    style={inputStyle}
                  />
                  <div
                    style={{ fontSize: 12, color: "var(--color-text-muted)" }}
                  >
                    若站点要求 New-Api-User / User-ID，请在这里提前填写。
                  </div>
                </div>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13,
                    cursor: "pointer",
                    alignSelf: "flex-start",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!tokenForm.skipModelFetch}
                    onChange={(e) =>
                      setTokenForm((f) => ({
                        ...f,
                        skipModelFetch: e.target.checked,
                      }))
                    }
                    style={{ width: 14, height: 14 }}
                  />
                  <span>跳过模型验证（直接添加 API Key）</span>
                </label>
                {verifyResult &&
                  verifyResult.success &&
                  verifyResult.tokenType === "apikey" && (
                    <div className="alert alert-info animate-scale-in">
                      <div
                        className="alert-title"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <svg
                          width="14"
                          height="14"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                          />
                        </svg>
                        API Key 验证成功
                      </div>
                      <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                        <div>
                          可用模型:{" "}
                          <strong>{verifyResult.modelCount} 个</strong>
                        </div>
                        {verifyResult.models && (
                          <div style={{ color: "var(--color-text-muted)" }}>
                            包含: {verifyResult.models.join(", ")}
                            {verifyResult.modelCount > 10 ? " ..." : ""}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                {verifyResult &&
                  verifyResult.success &&
                  verifyResult.tokenType === "session" && (
                    <div className="alert alert-warning animate-scale-in">
                      <div className="alert-title">
                        当前分段仅接受 API Key，请切到「Session 连接」分段创建。
                      </div>
                    </div>
                  )}
                {verifyResult &&
                  !verifyResult.success &&
                  verifyResult.needsUserId && (
                    <div className="alert alert-warning animate-scale-in">
                      <div className="alert-title">
                        此站点要求用户 ID，请补充后重新验证
                      </div>
                    </div>
                  )}
                {verifyResult &&
                  !verifyResult.success &&
                  !verifyResult.needsUserId && (
                    <div className="alert alert-error animate-scale-in">
                      <div className="alert-title">
                        {normalizeVerifyFailureMessage(verifyResult.message) ||
                          "Token 无效或已过期"}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--color-text-muted)",
                          marginTop: 4,
                        }}
                      >
                        {verifyFailureHint || "请检查 Token 是否正确"}
                      </div>
                    </div>
                  )}
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={handleVerifyToken}
                    disabled={
                      verifying ||
                      !tokenForm.siteId ||
                      !tokenForm.accessToken ||
                      isBatchApiKeyInput
                    }
                    className="btn btn-ghost"
                    style={{
                      border: "1px solid var(--color-border)",
                      padding: "8px 14px",
                    }}
                  >
                    {verifying ? (
                      <>
                        <span className="spinner spinner-sm" />
                        验证中...
                      </>
                    ) : isBatchApiKeyInput ? (
                      "批量添加时校验"
                    ) : (
                      "验证 API Key"
                    )}
                  </button>
                  <button
                    onClick={handleTokenAdd}
                    disabled={
                      saving ||
                      !tokenForm.siteId ||
                      !tokenForm.accessToken ||
                      !canSubmitApiKeyConnection
                    }
                    className="btn btn-success"
                  >
                    {saving ? (
                      <>
                        <span
                          className="spinner spinner-sm"
                          style={{
                            borderTopColor: "white",
                            borderColor: "rgba(255,255,255,0.3)",
                          }}
                        />
                        添加中...
                      </>
                    ) : isBatchApiKeyInput ? (
                      "批量添加连接"
                    ) : (
                      "添加连接"
                    )}
                  </button>
                </div>
                {!verifyResult?.success && (
                  <div
                    style={{ fontSize: 12, color: "var(--color-text-muted)" }}
                  >
                    {isBatchApiKeyInput
                      ? "批量模式下无需先点验证，提交后会逐条校验并创建。"
                      : addAccountPrereqHint}
                  </div>
                )}
              </div>
            )}
          </CenteredModal>

          {activeSegment === "session" && (
            <CenteredModal
              open={Boolean(rebindTarget)}
              onClose={closeRebindPanel}
              title="重新绑定 Session Token"
              maxWidth={820}
              bodyStyle={{ display: "flex", flexDirection: "column", gap: 12 }}
              footer={
                <button onClick={closeRebindPanel} className="btn btn-ghost">
                  取消
                </button>
              }
            >
              {activeRebindTarget ? (
                <>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--color-text-muted)",
                      marginBottom: 12,
                    }}
                  >
                    连接: {resolveAccountDisplayName(activeRebindTarget)} @{" "}
                    {activeRebindTarget.site?.name || "-"}。请粘贴新的 Session
                    Token，验证成功后再绑定。
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1fr) 220px",
                      gap: 10,
                      marginBottom: 10,
                    }}
                  >
                    <textarea
                      placeholder="粘贴新的 Session Token"
                      value={rebindForm.accessToken}
                      onChange={(e) => {
                        setRebindForm((prev) => ({
                          ...prev,
                          accessToken: e.target.value.trim(),
                        }));
                        setRebindVerifyResult(null);
                      }}
                      style={{
                        ...inputStyle,
                        fontFamily: "var(--font-mono)",
                        height: 74,
                        resize: "none" as const,
                      }}
                    />
                    <input
                      placeholder="用户 ID（可选）"
                      value={rebindForm.platformUserId}
                      onChange={(e) => {
                        setRebindForm((prev) => ({
                          ...prev,
                          platformUserId: e.target.value.replace(/\D/g, ""),
                        }));
                        setRebindVerifyResult(null);
                      }}
                      style={inputStyle}
                    />
                  </div>
                  {isRebindSub2Api && (
                    <>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(0, 1fr) 220px",
                          gap: 10,
                          marginBottom: 4,
                        }}
                      >
                        <input
                          placeholder="Sub2API refresh_token（可选）"
                          value={rebindForm.refreshToken}
                          onChange={(e) =>
                            setRebindForm((prev) => ({
                              ...prev,
                              refreshToken: e.target.value.trim(),
                            }))
                          }
                          style={{
                            ...inputStyle,
                            fontFamily: "var(--font-mono)",
                          }}
                        />
                        <input
                          placeholder="token_expires_at（可选）"
                          value={rebindForm.tokenExpiresAt}
                          onChange={(e) =>
                            setRebindForm((prev) => ({
                              ...prev,
                              tokenExpiresAt: e.target.value.replace(/\D/g, ""),
                            }))
                          }
                          style={inputStyle}
                        />
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--color-text-muted)",
                          marginBottom: 10,
                        }}
                      >
                        留空将保持原有 refresh_token
                        不变。配置后可用于托管自动续期。
                      </div>
                    </>
                  )}

                  {rebindVerifyResult &&
                    rebindVerifyResult.success &&
                    rebindVerifyResult.tokenType === "session" && (
                      <div
                        className="alert alert-success animate-scale-in"
                        style={{ marginBottom: 10 }}
                      >
                        <div className="alert-title">Session Token 有效</div>
                        <div style={{ fontSize: 12, marginTop: 4 }}>
                          用户:{" "}
                          {rebindVerifyResult.userInfo?.username || "未知"}
                          {rebindVerifyResult.apiToken
                            ? `，已识别 API Key (${String(rebindVerifyResult.apiToken).slice(0, 8)}...)`
                            : ""}
                        </div>
                      </div>
                    )}
                  {rebindVerifyResult &&
                    (!rebindVerifyResult.success ||
                      rebindVerifyResult.tokenType !== "session") && (
                      <div
                        className="alert alert-error animate-scale-in"
                        style={{ marginBottom: 10 }}
                      >
                        <div className="alert-title">
                          {rebindVerifyResult.message ||
                            "Token 无效或类型不正确"}
                        </div>
                      </div>
                    )}

                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={handleVerifyRebindToken}
                      disabled={
                        rebindVerifying || !rebindForm.accessToken.trim()
                      }
                      className="btn btn-ghost"
                      style={{ border: "1px solid var(--color-border)" }}
                    >
                      {rebindVerifying ? (
                        <>
                          <span className="spinner spinner-sm" />
                          验证中...
                        </>
                      ) : (
                        "验证 Token"
                      )}
                    </button>
                    <button
                      onClick={handleSubmitRebind}
                      disabled={
                        rebindSaving ||
                        !(
                          rebindVerifyResult?.success &&
                          rebindVerifyResult?.tokenType === "session"
                        )
                      }
                      className="btn btn-success"
                    >
                      {rebindSaving ? (
                        <>
                          <span
                            className="spinner spinner-sm"
                            style={{
                              borderTopColor: "white",
                              borderColor: "rgba(255,255,255,0.3)",
                            }}
                          />
                          绑定中...
                        </>
                      ) : (
                        "确认重新绑定"
                      )}
                    </button>
                  </div>
                </>
              ) : null}
            </CenteredModal>
          )}

          <CenteredModal
            open={Boolean(editingAccount)}
            onClose={closeEditPanel}
            title="编辑账号"
            maxWidth={860}
            bodyStyle={{ display: "flex", flexDirection: "column", gap: 12 }}
            footer={
              <>
                <button onClick={closeEditPanel} className="btn btn-ghost">
                  取消
                </button>
                <button
                  onClick={saveEditPanel}
                  disabled={savingEdit}
                  className="btn btn-primary"
                >
                  {savingEdit ? (
                    <>
                      <span
                        className="spinner spinner-sm"
                        style={{
                          borderTopColor: "white",
                          borderColor: "rgba(255,255,255,0.3)",
                        }}
                      />{" "}
                      保存中...
                    </>
                  ) : (
                    "保存修改"
                  )}
                </button>
              </>
            }
          >
            {editingAccount ? (
              <>
              <ResponsiveFormGrid>
                <input
                  placeholder="账号名称"
                  value={editForm.username}
                  onChange={(e) =>
                    setEditForm((prev) => ({
                      ...prev,
                      username: e.target.value,
                    }))
                  }
                  style={inputStyle}
                />
                <ModernSelect
                  value={editForm.status}
                  onChange={(value) =>
                    setEditForm((prev) => ({ ...prev, status: value }))
                  }
                  options={[
                    { value: "active", label: "active" },
                    { value: "disabled", label: "disabled" },
                    { value: "expired", label: "expired" },
                  ]}
                  placeholder="状态"
                />
                {/* T9.3：原文案「单位成本」既没给单位、也没说明它只是路由权重。
                    该字段不参与真实扣费（那是 catalog/observed 的口径），只影响通道排序；
                    且 valueScore 会做归一化，取到极小值后收益饱和，填 0.00001 与 0.001 几乎无差别。 */}
                <input
                  placeholder="路由成本权重（越小越优先）"
                  title="仅用于通道排序的成本权重，不是实际扣费单价。留空则按上游目录价或历史观测值排序。免费账号填 0.001 即可，再小没有额外效果。"
                  value={editForm.unitCost}
                  onChange={(e) =>
                    setEditForm((prev) => ({
                      ...prev,
                      unitCost: e.target.value,
                    }))
                  }
                  style={inputStyle}
                />
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    ...inputStyle,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={editForm.checkinEnabled}
                    onChange={(e) =>
                      setEditForm((prev) => ({
                        ...prev,
                        checkinEnabled: e.target.checked,
                      }))
                    }
                  />
                  启用签到
                </label>
                <input
                  placeholder="Access Token"
                  value={editForm.accessToken}
                  onChange={(e) =>
                    setEditForm((prev) => ({
                      ...prev,
                      accessToken: e.target.value,
                    }))
                  }
                  style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                />
                <input
                  placeholder="API Token（可选）"
                  value={editForm.apiToken}
                  onChange={(e) =>
                    setEditForm((prev) => ({
                      ...prev,
                      apiToken: e.target.value,
                    }))
                  }
                  style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                />
                {/* 手动余额与它的说明放同一格：说明是解释这个输入框的，不能按 grid 换列 */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <input
                    placeholder={`${tr("手动余额")}（USD，${tr("留空则自动获取")}）`}
                    value={editForm.manualBalanceUsd}
                    onChange={(e) =>
                      setEditForm((prev) => ({
                        ...prev,
                        manualBalanceUsd: e.target.value,
                      }))
                    }
                    inputMode="decimal"
                    style={inputStyle}
                  />
                  <div style={{ fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.6 }}>
                    {tr("上游读不到余额时，可在此填一个固定值；保存后立即生效，并停止向上游读取余额。")}
                  </div>
                </div>
                {(editingAccount?.site?.platform || "").toLowerCase() ===
                  "sub2api" && (
                  <>
                    <input
                      placeholder="Sub2API refresh_token（可选）"
                      value={editForm.refreshToken}
                      onChange={(e) =>
                        setEditForm((prev) => ({
                          ...prev,
                          refreshToken: e.target.value,
                        }))
                      }
                      style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                    />
                    <input
                      placeholder="token_expires_at（可选）"
                      value={editForm.tokenExpiresAt}
                      onChange={(e) =>
                        setEditForm((prev) => ({
                          ...prev,
                          tokenExpiresAt: e.target.value.replace(/\D/g, ""),
                        }))
                      }
                      style={inputStyle}
                    />
                  </>
                )}
              </ResponsiveFormGrid>
              {/* 代理设置独立成组（与站点编辑同款卡片），放在字段网格之后 */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  padding: 12,
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-sm)",
                  background: "color-mix(in srgb, var(--color-surface) 82%, transparent)",
                  marginTop: 12,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>{tr("代理设置")}</div>
                <div style={{ display: "grid", gap: 8 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-text-primary)" }}>
                    <input
                      type="checkbox"
                      checked={editForm.useSystemProxy}
                      onChange={(e) =>
                        setEditForm((prev) => ({ ...prev, useSystemProxy: e.target.checked }))
                      }
                    />
                    {tr("使用系统代理")}
                  </label>
                  <ModernSelect
                    data-testid="accounts-edit-proxy-pool"
                    value={editForm.proxyId ? String(editForm.proxyId) : ""}
                    onChange={(value) =>
                      setEditForm((prev) => ({ ...prev, proxyId: value ? Number(value) : null }))
                    }
                    options={[
                      { value: "", label: proxyPool.length > 0 ? tr("代理池（不选）") : tr("代理池为空，请先到设置页维护") },
                      ...proxyPool.map((entry) => ({
                        value: String(entry.id),
                        label: proxyPoolOptionLabel(entry),
                      })),
                    ]}
                  />
                  <input
                    placeholder={tr("自定义代理地址（可选，如 http://127.0.0.1:7890）")}
                    value={editForm.proxyUrl}
                    onChange={(e) =>
                      setEditForm((prev) => ({
                        ...prev,
                        proxyUrl: e.target.value,
                      }))
                    }
                    style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                  />
                </div>
                <div style={{ fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.6 }}>
                  {tr("三格可共存；生效顺序：自定义地址 > 代理池 > 系统代理勾选，全部为空则跟随所属站点。当前生效")}：
                  {describeAccountEffectiveProxy(editForm, proxyPool, editingAccount?.site)}
                </div>
              </div>
              </>
            ) : null}
          </CenteredModal>

          <div className="card">
            {visibleAccounts.length > 0 ? (
              isMobile ? (
                <div className="mobile-card-list">
                  {visibleAccounts.map((a: any) => {
                    const capabilities = resolveAccountCapabilities(a);
                    const connectionMode = resolveAccountCredentialMode(a);
                    const health = resolveRuntimeHealth(a);
                    const accountRate = getSiteRate(a.site?.id ?? a.siteId);
                    // 余额格按"是否读到过"决定显示数字还是 —（见 isBalanceNeverRead）
                    const balanceNeverRead = isBalanceNeverRead(a);
                    const isExpanded = expandedAccountIds.includes(a.id);
                    const hintMessage =
                      a.status === "expired" && !capabilities.proxyOnly
                        ? "账号已过期，请重新绑定"
                        : health.reason || "-";
                    return (
                      <MobileCard
                        key={a.id}
                        title={resolveAccountDisplayName(a)}
                        headerActions={
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            <input
                              type="checkbox"
                              aria-label={`选择账号 ${resolveAccountDisplayName(a)}`}
                              checked={selectedAccountIds.includes(a.id)}
                              onChange={(event) =>
                                toggleAccountSelection(
                                  a.id,
                                  event.target.checked,
                                )
                              }
                            />
                            <span
                              className={`badge ${connectionMode === "apikey" ? "badge-warning" : "badge-info"}`}
                              style={{ fontSize: 10 }}
                            >
                              {connectionMode === "apikey"
                                ? "API Key"
                                : "Session"}
                            </span>
                            {(() => {
                              const badge = accountProxyBadgeLabel(parseAccountExtraConfig(a), proxyPool);
                              return badge ? (
                                <span
                                  className="badge badge-purple"
                                  style={{ fontSize: 10 }}
                                >
                                  {badge}
                                </span>
                              ) : null;
                            })()}
                          </div>
                        }
                        footerActions={
                          <>
                            <button
                              type="button"
                              onClick={() => toggleAccountDetails(a.id)}
                              className="btn btn-link"
                            >
                              {isExpanded ? "收起" : "详情"}
                            </button>
                            <button
                              onClick={() => openEditPanel(a)}
                              className="btn btn-link btn-link-info"
                            >
                              编辑
                            </button>
                            <button
                              onClick={() => openModelModal(a)}
                              disabled={actionLoading[`models-${a.id}`]}
                              className="btn btn-link btn-link-info"
                            >
                              模型
                            </button>
                          </>
                        }
                      >
                        <MobileField
                          label="运行健康状态"
                          value={
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                              }}
                            >
                              <span
                                className={`badge ${health.cls}`}
                                style={{
                                  fontSize: 11,
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 4,
                                  width: "fit-content",
                                }}
                              >
                                <span
                                  className={`status-dot ${health.dotClass} ${health.pulse ? "animate-pulse-dot" : ""}`}
                                  style={{ marginRight: 0 }}
                                />
                                {health.label}
                              </span>
                              <span
                                style={{
                                  fontSize: 11,
                                  color: "var(--color-text-muted)",
                                  maxWidth: 240,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                                data-tooltip={health.reason}
                              >
                                {health.reason}
                              </span>
                            </div>
                          }
                        />
                        <MobileField
                          label="余额"
                          value={
                            <div>
                              <div
                                style={{
                                  fontWeight: 600,
                                  color: "var(--color-text-primary)",
                                }}
                              >
                                <span
                                  title={
                                    !isUnlimitedQuota(a) && balanceNeverRead && !(Number(a.balance) > 0)
                                      ? balanceUnavailableHint(a)
                                      : undefined
                                  }
                                >
                                  {formatBalanceOrDash(a.balance, { currency, cnyPerUsd: accountRate, neverRead: balanceNeverRead, unlimited: isUnlimitedQuota(a) })}
                                </span>
                              </div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color:
                                    (a.todayReward || 0) > 0
                                      ? "var(--color-success)"
                                      : "var(--color-text-muted)",
                                  fontWeight: 500,
                                }}
                              >
                                +{stripSymbol(formatBalanceInline(a.todayReward, currency, accountRate))}
                              </div>
                            </div>
                          }
                        />
                        <MobileField
                          label="已用"
                          value={
                            <div>
                              <div>{formatBalanceInline(a.balanceUsed, currency, accountRate)}</div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color:
                                    (a.todaySpend || 0) > 0
                                      ? "var(--color-danger)"
                                      : "var(--color-text-muted)",
                                  fontWeight: 500,
                                }}
                              >
                                -{stripSymbol(formatBalanceInline(a.todaySpend, currency, accountRate))}
                              </div>
                            </div>
                          }
                        />
                        {isExpanded ? (
                          <div className="mobile-card-extra">
                            <MobileField
                              label="站点"
                              value={
                                <SiteBadgeLink
                                  siteId={a.site?.id}
                                  siteName={a.site?.name}
                                  badgeStyle={{ fontSize: 11 }}
                                />
                              }
                            />
                            <MobileField
                              label="签到"
                              value={
                                capabilities.canCheckin ? (
                                  <button
                                    type="button"
                                    className={`checkin-toggle-badge ${a.checkinEnabled ? "is-on" : "is-off"}`}
                                    onClick={() => handleToggleCheckin(a)}
                                    disabled={
                                      !!actionLoading[`checkin-toggle-${a.id}`]
                                    }
                                    data-tooltip={
                                      a.checkinEnabled
                                        ? "点击关闭签到，全部签到会忽略此账号"
                                        : "点击开启签到"
                                    }
                                    aria-label={
                                      a.checkinEnabled
                                        ? "点击关闭签到，全部签到会忽略此账号"
                                        : "点击开启签到"
                                    }
                                  >
                                    {actionLoading[`checkin-toggle-${a.id}`] ? (
                                      <span className="spinner spinner-sm" />
                                    ) : a.checkinEnabled ? (
                                      "开启"
                                    ) : (
                                      "关闭"
                                    )}
                                  </button>
                                ) : (
                                  <span
                                    className="badge badge-muted"
                                    style={{ fontSize: 11 }}
                                  >
                                    不支持
                                  </span>
                                )
                              }
                            />
                            <MobileField
                              label="账号状态"
                              value={
                                a.status === "expired"
                                  ? "已过期"
                                  : a.status || "-"
                              }
                            />
                            <MobileField
                              label="提示"
                              stacked
                              value={hintMessage}
                            />
                            <div className="mobile-card-actions">
                              <button
                                onClick={() => handleTogglePin(a)}
                                disabled={!!actionLoading[`pin-toggle-${a.id}`]}
                                className={`btn btn-link ${a.isPinned ? "btn-link-warning" : "btn-link-primary"}`}
                              >
                                {actionLoading[`pin-toggle-${a.id}`] ? (
                                  <span className="spinner spinner-sm" />
                                ) : a.isPinned ? (
                                  "取消置顶"
                                ) : (
                                  "置顶"
                                )}
                              </button>
                              {sortMode === "custom" && (
                                <>
                                  <button
                                    onClick={() =>
                                      handleMoveCustomOrder(a, "up")
                                    }
                                    disabled={
                                      !!actionLoading[`reorder-${a.id}`]
                                    }
                                    className="btn btn-link btn-link-muted"
                                  >
                                    ↑ 上移
                                  </button>
                                  <button
                                    onClick={() =>
                                      handleMoveCustomOrder(a, "down")
                                    }
                                    disabled={
                                      !!actionLoading[`reorder-${a.id}`]
                                    }
                                    className="btn btn-link btn-link-muted"
                                  >
                                    ↓ 下移
                                  </button>
                                </>
                              )}
                              {capabilities.canRefreshBalance && (
                                <button
                                  onClick={() =>
                                    withLoading(
                                      `refresh-${a.id}`,
                                      () => api.refreshBalance(a.id),
                                      "余额已刷新",
                                    )
                                  }
                                  disabled={actionLoading[`refresh-${a.id}`]}
                                  className="btn btn-link btn-link-primary"
                                >
                                  {actionLoading[`refresh-${a.id}`] ? (
                                    <span className="spinner spinner-sm" />
                                  ) : (
                                    "刷新"
                                  )}
                                </button>
                              )}
                              {capabilities.canCheckin && (
                                <button
                                  onClick={() =>
                                    withLoading(
                                      `checkin-${a.id}`,
                                      () => api.triggerCheckin(a.id),
                                      "签到完成",
                                    )
                                  }
                                  disabled={actionLoading[`checkin-${a.id}`]}
                                  className="btn btn-link btn-link-warning"
                                >
                                  {actionLoading[`checkin-${a.id}`] ? (
                                    <span className="spinner spinner-sm" />
                                  ) : (
                                    "签到"
                                  )}
                                </button>
                              )}
                              {a.status === "expired" &&
                                !capabilities.proxyOnly && (
                                  <button
                                    onClick={() => openRebindPanel(a)}
                                    className="btn btn-link btn-link-warning"
                                  >
                                    重新绑定
                                  </button>
                                )}
                              <button
                                onClick={() =>
                                  setDeleteConfirm({
                                    mode: "single",
                                    accountId: a.id,
                                    accountName: resolveAccountDisplayName(a),
                                  })
                                }
                                disabled={actionLoading[`delete-${a.id}`]}
                                className="btn btn-link btn-link-danger"
                              >
                                {actionLoading[`delete-${a.id}`] ? (
                                  <span className="spinner spinner-sm" />
                                ) : (
                                  "删除"
                                )}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </MobileCard>
                    );
                  })}
                </div>
              ) : (
                <table className="data-table accounts-table">
                  <thead>
                    <tr>
                      <th style={{ width: 44 }}>
                        <input
                          type="checkbox"
                          checked={allVisibleAccountsSelected}
                          ref={(el) => {
                            if (!el) return;
                            // 三态纯可见集口径：当前分段部分勾选 → indeterminate
                            el.indeterminate = selectedVisibleAccountIds.length > 0 && !allVisibleAccountsSelected;
                          }}
                          onChange={(e) =>
                            toggleSelectAllVisibleAccounts(e.target.checked)
                          }
                        />
                      </th>
                      <th>连接名称</th>
                      <th>站点</th>
                      <th>运行健康状态</th>
                      <th>余额</th>
                      <th>已用</th>
                      <th>签到</th>
                      <th
                        className="accounts-actions-col"
                        style={{ textAlign: "right" }}
                      >
                        操作
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleAccounts.map((a: any, i: number) => {
                      const capabilities = resolveAccountCapabilities(a);
                      const connectionMode = resolveAccountCredentialMode(a);
                      const accountRate = getSiteRate(a.site?.id ?? a.siteId);
                      // 与移动端同一判据：余额读不到就画 —，不要报库里的默认 0
                      const balanceNeverRead = isBalanceNeverRead(a);
                      return (
                        <tr
                          key={a.id}
                          data-testid={`account-row-${a.id}`}
                          ref={(node) => {
                            if (node) rowRefs.current.set(a.id, node);
                            else rowRefs.current.delete(a.id);
                          }}
                          onClick={(event) =>
                            handleAccountRowClick(a.id, event)
                          }
                          className={`animate-slide-up stagger-${Math.min(i + 1, 5)} row-selectable ${selectedAccountIds.includes(a.id) ? "row-selected" : ""} ${highlightAccountId === a.id ? "row-focus-highlight" : ""}`.trim()}
                        >
                          <td>
                            <input
                              data-testid={`account-select-${a.id}`}
                              type="checkbox"
                              checked={selectedAccountIds.includes(a.id)}
                              onChange={(e) =>
                                toggleAccountSelection(a.id, e.target.checked)
                              }
                            />
                          </td>
                          <td style={{ color: "var(--color-text-primary)" }}>
                            <div style={{ fontWeight: 600 }}>
                              {resolveAccountDisplayName(a)}
                            </div>
                            <div
                              style={{ display: "flex", gap: 4, marginTop: 4 }}
                            >
                              <span
                                className={`badge ${connectionMode === "apikey" ? "badge-warning" : "badge-info"}`}
                                style={{ fontSize: 10 }}
                              >
                                {connectionMode === "apikey"
                                  ? "API Key"
                                  : "Session"}
                              </span>
                              {(() => {
                                const badge = accountProxyBadgeLabel(parseAccountExtraConfig(a), proxyPool);
                                return badge ? (
                                  <span
                                    className="badge badge-purple"
                                    style={{ fontSize: 10 }}
                                  >
                                    {badge}
                                  </span>
                                ) : null;
                              })()}
                            </div>
                          </td>
                          <td>
                            <SiteBadgeLink
                              siteId={a.site?.id}
                              siteName={a.site?.name}
                              badgeStyle={{ fontSize: 11 }}
                            />
                          </td>
                          <td>
                            {(() => {
                              const health = resolveRuntimeHealth(a);
                              return (
                                <div
                                  style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 4,
                                  }}
                                >
                                  <span
                                    className={`badge ${health.cls}`}
                                    style={{
                                      fontSize: 11,
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 4,
                                      width: "fit-content",
                                    }}
                                  >
                                    <span
                                      className={`status-dot ${health.dotClass} ${health.pulse ? "animate-pulse-dot" : ""}`}
                                      style={{ marginRight: 0 }}
                                    />
                                    {health.label}
                                  </span>
                                  <span
                                    style={{
                                      fontSize: 11,
                                      color: "var(--color-text-muted)",
                                      maxWidth: 200,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                    data-tooltip={health.reason}
                                  >
                                    {health.reason}
                                  </span>
                                </div>
                              );
                            })()}
                          </td>
                          <td style={{ fontVariantNumeric: "tabular-nums" }}>
                            <div
                              style={{
                                fontWeight: 600,
                                color: "var(--color-text-primary)",
                              }}
                            >
                              <span
                                title={
                                  !isUnlimitedQuota(a) && balanceNeverRead && !(Number(a.balance) > 0)
                                    ? balanceUnavailableHint(a)
                                    : undefined
                                }
                              >
                                {formatBalanceOrDash(a.balance, { currency, cnyPerUsd: accountRate, neverRead: balanceNeverRead, unlimited: isUnlimitedQuota(a) })}
                              </span>
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color:
                                  (a.todayReward || 0) > 0
                                    ? "var(--color-success)"
                                    : "var(--color-text-muted)",
                                fontWeight: 500,
                              }}
                            >
                              +{stripSymbol(formatBalanceInline(a.todayReward, currency, accountRate))}
                            </div>
                          </td>
                          <td
                            style={{
                              fontVariantNumeric: "tabular-nums",
                              fontSize: 12,
                            }}
                          >
                            <div>{formatBalanceInline(a.balanceUsed, currency, accountRate)}</div>
                            <div
                              style={{
                                fontSize: 11,
                                color:
                                  (a.todaySpend || 0) > 0
                                    ? "var(--color-danger)"
                                    : "var(--color-text-muted)",
                                fontWeight: 500,
                              }}
                            >
                              -{stripSymbol(formatBalanceInline(a.todaySpend, currency, accountRate))}
                            </div>
                          </td>
                          <td>
                            {capabilities.canCheckin ? (
                              <button
                                type="button"
                                className={`checkin-toggle-badge ${a.checkinEnabled ? "is-on" : "is-off"}`}
                                onClick={() => handleToggleCheckin(a)}
                                disabled={
                                  !!actionLoading[`checkin-toggle-${a.id}`]
                                }
                                data-tooltip={
                                  a.checkinEnabled
                                    ? "点击关闭签到，全部签到会忽略此账号"
                                    : "点击开启签到"
                                }
                                aria-label={
                                  a.checkinEnabled
                                    ? "点击关闭签到，全部签到会忽略此账号"
                                    : "点击开启签到"
                                }
                              >
                                {actionLoading[`checkin-toggle-${a.id}`] ? (
                                  <span className="spinner spinner-sm" />
                                ) : a.checkinEnabled ? (
                                  "开启"
                                ) : (
                                  "关闭"
                                )}
                              </button>
                            ) : (
                              <span
                                className="badge badge-muted"
                                style={{ fontSize: 11 }}
                              >
                                不支持
                              </span>
                            )}
                          </td>
                          <td
                            className="accounts-actions-cell"
                            style={{ textAlign: "right" }}
                          >
                            <div className="accounts-row-actions">
                              <button
                                onClick={() => handleTogglePin(a)}
                                disabled={!!actionLoading[`pin-toggle-${a.id}`]}
                                className={`btn btn-link ${a.isPinned ? "btn-link-warning" : "btn-link-primary"}`}
                              >
                                {actionLoading[`pin-toggle-${a.id}`] ? (
                                  <span className="spinner spinner-sm" />
                                ) : a.isPinned ? (
                                  "取消置顶"
                                ) : (
                                  "置顶"
                                )}
                              </button>
                              {sortMode === "custom" && (
                                <>
                                  <button
                                    onClick={() =>
                                      handleMoveCustomOrder(a, "up")
                                    }
                                    disabled={
                                      !!actionLoading[`reorder-${a.id}`]
                                    }
                                    className="btn btn-link btn-link-muted"
                                  >
                                    ↑
                                  </button>
                                  <button
                                    onClick={() =>
                                      handleMoveCustomOrder(a, "down")
                                    }
                                    disabled={
                                      !!actionLoading[`reorder-${a.id}`]
                                    }
                                    className="btn btn-link btn-link-muted"
                                  >
                                    ↓
                                  </button>
                                </>
                              )}
                              {capabilities.canRefreshBalance && (
                                <button
                                  onClick={() =>
                                    withLoading(
                                      `refresh-${a.id}`,
                                      () => api.refreshBalance(a.id),
                                      "余额已刷新",
                                    )
                                  }
                                  disabled={actionLoading[`refresh-${a.id}`]}
                                  className="btn btn-link btn-link-primary"
                                >
                                  {actionLoading[`refresh-${a.id}`] ? (
                                    <span className="spinner spinner-sm" />
                                  ) : (
                                    "刷新"
                                  )}
                                </button>
                              )}
                              <button
                                onClick={() => openModelModal(a)}
                                disabled={actionLoading[`models-${a.id}`]}
                                className="btn btn-link btn-link-info"
                              >
                                模型
                              </button>
                              {capabilities.canCheckin && (
                                <button
                                  onClick={() =>
                                    withLoading(
                                      `checkin-${a.id}`,
                                      () => api.triggerCheckin(a.id),
                                      "签到完成",
                                    )
                                  }
                                  disabled={actionLoading[`checkin-${a.id}`]}
                                  className="btn btn-link btn-link-warning"
                                >
                                  {actionLoading[`checkin-${a.id}`] ? (
                                    <span className="spinner spinner-sm" />
                                  ) : (
                                    "签到"
                                  )}
                                </button>
                              )}
                              {a.status === "expired" &&
                                !capabilities.proxyOnly && (
                                  <button
                                    onClick={() => openRebindPanel(a)}
                                    className="btn btn-link btn-link-warning"
                                  >
                                    重新绑定
                                  </button>
                                )}
                              <button
                                onClick={() => openEditPanel(a)}
                                className="btn btn-link btn-link-info"
                              >
                                编辑
                              </button>
                              <button
                                onClick={() =>
                                  setDeleteConfirm({
                                    mode: "single",
                                    accountId: a.id,
                                    accountName: resolveAccountDisplayName(a),
                                  })
                                }
                                disabled={actionLoading[`delete-${a.id}`]}
                                className="btn btn-link btn-link-danger"
                              >
                                {actionLoading[`delete-${a.id}`] ? (
                                  <span className="spinner spinner-sm" />
                                ) : (
                                  "删除"
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )
            ) : (
              <div className="empty-state">
                <svg
                  className="empty-state-icon"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
                <div className="empty-state-title">
                  {activeSegment === "apikey"
                    ? "暂无 API Key 连接"
                    : "暂无 Session 连接"}
                </div>
                <div className="empty-state-desc">
                  {activeSegment === "apikey"
                    ? sites.length > 0
                      ? "请为现有站点补充 API Key 连接"
                      : "请先添加站点，然后为站点补充 API Key 连接"
                    : sites.length > 0
                      ? "请为现有站点添加 Session 连接"
                      : "请先添加站点，然后添加 Session 连接"}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <AccountModelsModal
        modelModal={modelModal}
        inputStyle={inputStyle}
        onClose={closeModelModal}
        onSave={saveModelDisabled}
        onRefresh={async () => {
          if (!modelModal.account) return;
          await loadModelModalModels(modelModal.account, {
            refreshUpstream: true,
            successMessage: "模型列表已刷新",
            errorMessage: "刷新失败",
          });
        }}
        onToggleModelDisabled={toggleModelDisabled}
        onSetPendingDisabled={(pendingDisabled) =>
          setModelModal((state) => ({ ...state, pendingDisabled }))
        }
        onManualInputChange={(value) =>
          setModelModal((state) => ({ ...state, manualModelsInput: value }))
        }
        onAddManualModels={handleAddManualModels}
        onDeleteManualModel={openManualModelDeleteConfirm}
      />

      <DeleteConfirmModal
        open={Boolean(manualModelDeleteConfirm)}
        onClose={() => setManualModelDeleteConfirm(null)}
        onConfirm={confirmManualModelDelete}
        title="确认移除手动模型"
        confirmText="确认移除"
        loading={manualModelDeleting}
        description={manualModelDeleteConfirm ? (
          <>
            确定要移除此账号下的手动模型 <strong>{manualModelDeleteConfirm.modelName}</strong> 吗？
          </>
        ) : null}
      />

      <CenteredModal
        open={batchProxyOpen}
        onClose={() => setBatchProxyOpen(false)}
        title={tr("批量设置连接代理")}
        maxWidth={560}
        bodyStyle={{ display: "flex", flexDirection: "column", gap: 14 }}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setBatchProxyOpen(false)} disabled={batchActionLoading}>{tr("取消")}</button>
            <button className="btn btn-primary" onClick={() => void runBatchProxySettings()} disabled={batchActionLoading}>
              {batchActionLoading ? <><span className="spinner spinner-sm" style={{ borderTopColor: "white", borderColor: "rgba(255,255,255,0.3)" }} /> {tr("保存中")}...</> : tr("应用到所选连接")}
            </button>
          </>
        )}
      >
        <div className="info-tip" style={{ marginBottom: 0 }}>
          {tr("本次会对已选中的")} {selectedAccountIds.length} {tr("个连接批量设置代理。未勾选的项目不会改动。")}
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <input
            type="checkbox"
            aria-label={tr("启用批量设置连接代理")}
            checked={batchProxyForm.applyProxy}
            onChange={(event) => setBatchProxyForm((prev) => ({ ...prev, applyProxy: event.target.checked }))}
            style={{ marginTop: 10 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 6 }}>{tr("批量设置连接代理")}</div>
            <div style={{ marginBottom: 8 }}>
              <ModernSelect
                data-testid="accounts-batch-proxy-mode"
                value={batchProxyForm.proxyMode}
                disabled={!batchProxyForm.applyProxy}
                onChange={(value) => setBatchProxyForm((prev) => ({ ...prev, proxyMode: value as BatchProxyMode }))}
                options={[
                  { value: "clear", label: tr("跟随站点（清除账号级代理）") },
                  { value: "system", label: tr("使用系统代理") },
                  { value: "pool", label: tr("代理池") },
                  { value: "custom", label: tr("自定义代理") },
                ]}
              />
            </div>
            <input
              style={inputStyle}
              value={batchProxyForm.proxyUrl}
              onChange={(event) => setBatchProxyForm((prev) => ({ ...prev, proxyUrl: event.target.value }))}
              placeholder={tr("自定义代理地址（如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080）")}
              disabled={!batchProxyForm.applyProxy || batchProxyForm.proxyMode !== "custom"}
            />
            <div style={{ marginTop: 8 }}>
              <ModernSelect
                data-testid="accounts-batch-proxy-pool"
                value={batchProxyForm.proxyId ? String(batchProxyForm.proxyId) : ""}
                disabled={!batchProxyForm.applyProxy || batchProxyForm.proxyMode !== "pool"}
                onChange={(value) => setBatchProxyForm((prev) => ({ ...prev, proxyId: value ? Number(value) : null }))}
                options={[
                  { value: "", label: proxyPool.length > 0 ? tr("请选择代理") : tr("代理池为空，请先到设置页维护") },
                  ...proxyPool.map((entry) => ({
                    value: String(entry.id),
                    label: proxyPoolOptionLabel(entry),
                  })),
                ]}
              />
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.6 }}>
              {tr("未勾选则保持各连接现状；四种模式互斥；「跟随站点」会清空账号级的自定义地址、池引用与系统代理勾选，改由所属站点决定。")}
            </div>
          </div>
        </div>
      </CenteredModal>
    </div>
  );
}
