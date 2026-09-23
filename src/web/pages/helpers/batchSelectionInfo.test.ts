import { describe, expect, it } from 'vitest';
import { buildBatchSelectionInfo } from './batchSelectionInfo.js';

// 运行语言为中文（runtimeLanguage 默认 'zh'），tr 原样返回，故断言即最终中文串。
describe('buildBatchSelectionInfo', () => {
  it('无隐藏项：仅基础文案', () => {
    expect(buildBatchSelectionInfo(3, 3, '项')).toBe('已选 3 项');
  });

  it('有隐藏项：追加后缀', () => {
    expect(buildBatchSelectionInfo(5, 2, '项')).toBe('已选 5 项（其中 3 项不在当前筛选内）');
  });

  it('全隐藏：后缀数量等于总数', () => {
    expect(buildBatchSelectionInfo(4, 0, '个密钥')).toBe('已选 4 个密钥（其中 4 项不在当前筛选内）');
  });

  it('零选中：基础文案无后缀', () => {
    expect(buildBatchSelectionInfo(0, 0, '项')).toBe('已选 0 项');
  });
});
