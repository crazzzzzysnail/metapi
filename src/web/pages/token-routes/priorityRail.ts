import type { CSSProperties } from 'react';
import type { PriorityRailDragTarget, PriorityRailSection } from './types.js';
import { getPriorityTagStyle } from './utils.js';

type PriorityRailChannelLike = {
  id: number;
  priority: number;
};

type BuildPriorityRailDragTargetsOptions = {
  activeChannelId: number;
  hoveredPriority: number | null;
  showNewLayerTarget: boolean;
};

export const PRIORITY_RAIL_NEW_LAYER_PREFIX = 'priority-rail:new-layer:';
export const PRIORITY_RAIL_NEW_TOP_LAYER_ID = 'priority-rail:new-top-layer';

export type PriorityRailBatchAction = 'set_p0' | 'move_down_one_layer';

export function createPriorityRailNewLayerId(priority: number): string {
  return `${PRIORITY_RAIL_NEW_LAYER_PREFIX}${priority}`;
}

export function isPriorityRailNewLayerId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PRIORITY_RAIL_NEW_LAYER_PREFIX);
}

export function isPriorityRailNewTopLayerId(value: unknown): value is string {
  return value === PRIORITY_RAIL_NEW_TOP_LAYER_ID;
}

function parsePriorityRailNewLayerPriority(value: string): number | null {
  const raw = value.slice(PRIORITY_RAIL_NEW_LAYER_PREFIX.length);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildPriorityRailSections(channels: PriorityRailChannelLike[]): PriorityRailSection[] {
  const grouped = new Map<number, number[]>();

  for (const channel of channels || []) {
    const priority = Number.isFinite(channel.priority) ? channel.priority : 0;
    if (!grouped.has(priority)) grouped.set(priority, []);
    grouped.get(priority)!.push(channel.id);
  }

  return Array.from(grouped.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([priority, channelIds]) => ({
      priority,
      channelCount: channelIds.length,
      channelIds,
    }));
}

function normalizePriorityRailChannels<T extends PriorityRailChannelLike>(channels: T[]): T[] {
  return [...(channels || [])].sort((a, b) => {
    const priorityA = Number.isFinite(a.priority) ? a.priority : 0;
    const priorityB = Number.isFinite(b.priority) ? b.priority : 0;
    if (priorityA === priorityB) return a.id - b.id;
    return priorityA - priorityB;
  });
}

function denseNormalizePriorityRailChannels<T extends PriorityRailChannelLike>(channels: T[]): T[] {
  const normalized = normalizePriorityRailChannels(channels);
  const priorityMap = new Map<number, number>();
  let nextPriority = 0;

  return normalized.map((channel) => {
    const priority = Number.isFinite(channel.priority) ? channel.priority : 0;
    if (!priorityMap.has(priority)) {
      priorityMap.set(priority, nextPriority);
      nextPriority += 1;
    }
    return {
      ...channel,
      priority: priorityMap.get(priority)!,
    };
  });
}

function collectPriorityChannels<T extends PriorityRailChannelLike>(channels: T[]): Array<{ priority: number; channels: T[] }> {
  const grouped = new Map<number, T[]>();
  for (const channel of normalizePriorityRailChannels(channels)) {
    const priority = Number.isFinite(channel.priority) ? channel.priority : 0;
    if (!grouped.has(priority)) grouped.set(priority, []);
    grouped.get(priority)!.push(channel);
  }
  return Array.from(grouped.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([priority, priorityChannels]) => ({ priority, channels: priorityChannels }));
}

export function buildPriorityRailDragTargets(
  sections: PriorityRailSection[],
  options: BuildPriorityRailDragTargetsOptions,
): PriorityRailDragTarget[] {
  const targets: PriorityRailDragTarget[] = [];

  if (options.showNewLayerTarget) {
    targets.push({
      kind: 'new_top_layer',
      priority: 0,
      highlighted: options.hoveredPriority === -1,
    });
  }

  targets.push(...sections.map((section) => ({
    kind: 'existing_layer' as const,
    priority: section.priority,
    highlighted: section.priority === options.hoveredPriority,
  })));

  if (options.showNewLayerTarget) {
    const highestPriority = sections.reduce((max, section) => Math.max(max, section.priority), -1);
    targets.push({
      kind: 'new_layer',
      priority: highestPriority + 1,
      highlighted: false,
    });
  }

  return targets;
}

export function applyPriorityRailDrop<T extends PriorityRailChannelLike>(
  channels: T[],
  activeId: number,
  overId: number | string,
): T[] {
  const normalized = normalizePriorityRailChannels(channels);
  const activeChannel = normalized.find((channel) => channel.id === activeId);
  if (!activeChannel) return normalized;

  if (isPriorityRailNewTopLayerId(overId)) {
    return denseNormalizePriorityRailChannels(
      normalized.map((channel) => {
        const priority = Number.isFinite(channel.priority) ? channel.priority : 0;
        if (channel.id === activeId) return { ...channel, priority: 0 };
        return { ...channel, priority: priority + 1 };
      }),
    );
  }

  if (isPriorityRailNewLayerId(overId)) {
    const afterPriority = parsePriorityRailNewLayerPriority(overId);
    if (afterPriority == null) return normalized;
    const targetPriority = afterPriority + 1;

    return denseNormalizePriorityRailChannels(
      normalized.map((channel) => {
        const priority = Number.isFinite(channel.priority) ? channel.priority : 0;
        if (channel.id === activeId) return { ...channel, priority: targetPriority };
        if (channel.id !== activeId && priority > afterPriority) {
          return { ...channel, priority: priority + 1 };
        }
        return channel;
      }),
    );
  }

  const targetChannel = normalized.find((channel) => channel.id === Number(overId));
  if (!targetChannel || targetChannel.id === activeId) return normalized;

  const targetPriority = Number.isFinite(targetChannel.priority) ? targetChannel.priority : 0;

  return normalizePriorityRailChannels(
    normalized.map((channel) => (
      channel.id === activeId
        ? { ...channel, priority: targetPriority }
        : channel
    )),
  );
}

export function applyPriorityRailBatchAction<T extends PriorityRailChannelLike>(
  channels: T[],
  selectedIds: number[],
  action: PriorityRailBatchAction,
): T[] {
  const sorted = normalizePriorityRailChannels(channels);
  const selectedIdSet = new Set(selectedIds.filter((id) => Number.isFinite(id)));
  if (sorted.length === 0 || selectedIdSet.size === 0) return sorted;

  const selectedChannels = sorted.filter((channel) => selectedIdSet.has(channel.id));
  if (selectedChannels.length === 0) return sorted;

  const normalized = denseNormalizePriorityRailChannels(sorted);

  if (action === 'set_p0') {
    return denseNormalizePriorityRailChannels(
      normalized.map((channel) => {
        const priority = Number.isFinite(channel.priority) ? channel.priority : 0;
        if (selectedIdSet.has(channel.id)) return { ...channel, priority: 0 };
        return { ...channel, priority: priority + 1 };
      }),
    );
  }

  const groups = collectPriorityChannels(normalized);
  const shiftedUnselectedPriority = new Map<number, number>();

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const selectedCount = group.channels.filter((channel) => selectedIdSet.has(channel.id)).length;
    if (selectedCount !== group.channels.length) continue;

    const runStartPriority = group.priority;
    let runEndIndex = index;
    while (runEndIndex + 1 < groups.length) {
      const nextGroup = groups[runEndIndex + 1]!;
      const nextSelectedCount = nextGroup.channels.filter((channel) => selectedIdSet.has(channel.id)).length;
      if (nextSelectedCount !== nextGroup.channels.length) break;
      runEndIndex += 1;
    }

    const nextGroup = groups[runEndIndex + 1];
    if (nextGroup) {
      shiftedUnselectedPriority.set(nextGroup.priority, runStartPriority);
    }
    index = runEndIndex;
  }

  return denseNormalizePriorityRailChannels(
    normalized.map((channel) => {
      const priority = Number.isFinite(channel.priority) ? channel.priority : 0;
      if (selectedIdSet.has(channel.id)) return { ...channel, priority: priority + 1 };
      const shiftedPriority = shiftedUnselectedPriority.get(priority);
      return shiftedPriority == null ? channel : { ...channel, priority: shiftedPriority };
    }),
  );
}

export function buildPriorityRailNodeStyle(priority: number, highlighted: boolean): CSSProperties {
  const tone = getPriorityTagStyle(priority);

  return {
    border: `1px solid ${highlighted ? 'var(--color-primary)' : 'color-mix(in srgb, currentColor 24%, transparent)'}`,
    background: highlighted
      ? `color-mix(in srgb, ${tone.background} 78%, var(--color-bg))`
      : tone.background,
    color: highlighted ? 'var(--color-primary)' : tone.color,
  };
}
