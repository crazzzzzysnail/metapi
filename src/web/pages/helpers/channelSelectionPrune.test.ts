import { describe, expect, it } from 'vitest';
import { pruneStaleChannelSelections } from './channelSelectionPrune.js';

describe('pruneStaleChannelSelections', () => {
  it('未加载通道的路由：选择集原样保留且不算变更', () => {
    const { next, changed } = pruneStaleChannelSelections(
      { 1: [11, 12] },
      {},   // 该路由通道尚未加载
    );
    expect(next).toEqual({ 1: [11, 12] });
    expect(changed).toBe(false);
  });

  it('现存集合仍含全部所选 id → 无收缩', () => {
    const { next, changed } = pruneStaleChannelSelections(
      { 1: [11, 12] },
      { 1: [{ id: 11 }, { id: 12 }, { id: 13 }] },
    );
    expect(next).toEqual({ 1: [11, 12] });
    expect(changed).toBe(false);
  });

  it('部分 id 消失 → 收缩并 changed=true', () => {
    const { next, changed } = pruneStaleChannelSelections(
      { 1: [11, 12, 13] },
      { 1: [{ id: 11 }, { id: 13 }] },   // 12 已被删除/重建
    );
    expect(next).toEqual({ 1: [11, 13] });
    expect(changed).toBe(true);
  });

  it('全部 id 消失 → 清空该路由选择并 changed=true', () => {
    const { next, changed } = pruneStaleChannelSelections(
      { 1: [11], 2: [21] },
      { 1: [], 2: [{ id: 21 }] },   // 路由 1 通道清空、路由 2 仍存活
    );
    expect(next).toEqual({ 1: [], 2: [21] });
    expect(changed).toBe(true);
  });

  it('空选择集 → 幂等无变更', () => {
    const { next, changed } = pruneStaleChannelSelections(
      {},
      { 1: [{ id: 11 }] },
    );
    expect(next).toEqual({});
    expect(changed).toBe(false);
  });
});
