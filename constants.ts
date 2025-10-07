
import { BreathingPhase, PhaseConfig } from './types';

export const DURATION_OPTIONS = [120, 180, 300]; // 2, 3, 5 minutes in seconds
export const DEFAULT_DURATION = 120;

export const PHASES: Record<BreathingPhase, PhaseConfig> = {
  [BreathingPhase.Inhale]: { name: '吸氣…', duration: 4000, announcement: '吸氣開始' },
  [BreathingPhase.HoldIn]: { name: '閉氣…', duration: 2000, announcement: '閉氣開始' },
  [BreathingPhase.Exhale]: { name: '吐氣…', duration: 6000, announcement: '吐氣開始' },
  [BreathingPhase.HoldOut]: { name: '休息…', duration: 4000, announcement: '休息開始' },
};

export const CYCLE_DURATION = Object.values(PHASES).reduce((sum, phase) => sum + phase.duration, 0); // 16000ms
