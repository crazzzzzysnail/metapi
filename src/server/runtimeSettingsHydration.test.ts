import { afterEach, describe, expect, it } from 'vitest';

import { config } from './config.js';
import { applyRuntimeSettings } from './runtimeSettingsHydration.js';

const originalConfig = structuredClone(config);

afterEach(() => {
  Object.assign(config, structuredClone(originalConfig));
});

describe('applyRuntimeSettings', () => {
  it('hydrates persisted runtime settings that should survive restarts', () => {
    config.disableCrossProtocolFallback = false;
    config.responsesCompactFallbackToResponsesEnabled = false;
    config.webhookEnabled = true;
    config.barkEnabled = true;
    config.serverChanEnabled = true;
    config.globalAllowedModels = [];

    applyRuntimeSettings(new Map([
      ['disable_cross_protocol_fallback', JSON.stringify(true)],
      ['responses_compact_fallback_to_responses_enabled', JSON.stringify(true)],
      ['webhook_enabled', JSON.stringify(false)],
      ['bark_enabled', JSON.stringify(false)],
      ['serverchan_enabled', JSON.stringify(false)],
      ['global_allowed_models', JSON.stringify(['gpt-5.4', ' claude-3.7-sonnet '])],
    ]));

    expect(config.disableCrossProtocolFallback).toBe(true);
    expect(config.responsesCompactFallbackToResponsesEnabled).toBe(true);
    expect(config.webhookEnabled).toBe(false);
    expect(config.barkEnabled).toBe(false);
    expect(config.serverChanEnabled).toBe(false);
    expect(config.globalAllowedModels).toEqual(['gpt-5.4', 'claude-3.7-sonnet']);
  });

  it('normalizes smtpPort to a positive integer during hydration', () => {
    config.smtpPort = 587;

    applyRuntimeSettings(new Map([
      ['smtp_port', JSON.stringify(587.9)],
    ]));

    expect(config.smtpPort).toBe(587);
  });

  it('hydrates legacy double-encoded global model allowlist values', () => {
    config.globalAllowedModels = [];

    applyRuntimeSettings(new Map([
      ['global_allowed_models', JSON.stringify(JSON.stringify(['model-alpha', ' model-beta ', 'model-gamma']))],
    ]));

    expect(config.globalAllowedModels).toEqual(['model-alpha', 'model-beta', 'model-gamma']);
  });

  // 签到随机延迟的四键只影响设置页回显（真正的合法性在 shared/checkinDelayPolicy 读取时判定），
  // 但回显必须原样，否则用户存的「6 小时」会在下次打开设置页变回默认值。
  it('hydrates checkin random delay settings as raw value plus unit', () => {
    config.checkinDelayEnabled = false;
    config.checkinDelayMin = 0;
    config.checkinDelayMax = 360;
    config.checkinDelayUnit = 'minute';

    applyRuntimeSettings(new Map([
      ['checkin_delay_enabled', JSON.stringify(true)],
      ['checkin_delay_min', JSON.stringify(1)],
      ['checkin_delay_max', JSON.stringify(6)],
      ['checkin_delay_unit', JSON.stringify('hour')],
    ]));

    expect(config.checkinDelayEnabled).toBe(true);
    expect(config.checkinDelayMin).toBe(1);
    expect(config.checkinDelayMax).toBe(6);
    expect(config.checkinDelayUnit).toBe('hour');
  });

  it('ignores malformed checkin delay values instead of adopting them', () => {
    config.checkinDelayEnabled = true;
    config.checkinDelayMin = 15;
    config.checkinDelayMax = 6;
    config.checkinDelayUnit = 'hour';

    applyRuntimeSettings(new Map([
      ['checkin_delay_enabled', JSON.stringify('yes')],
      ['checkin_delay_min', JSON.stringify(-5)],
      ['checkin_delay_max', JSON.stringify('six')],
      ['checkin_delay_unit', JSON.stringify('second')],
    ]));

    expect(config.checkinDelayEnabled).toBe(true);
    expect(config.checkinDelayMin).toBe(15);
    expect(config.checkinDelayMax).toBe(6);
    expect(config.checkinDelayUnit).toBe('hour');
  });
});
