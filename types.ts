
export enum AppState {
  Idle,
  Active,
  Paused,
  Complete,
}

export enum BreathingPhase {
  Inhale = 'inhale',
  HoldIn = 'holdIn',
  Exhale = 'exhale',
  HoldOut = 'holdOut',
}

export interface PhaseConfig {
  name: string;
  duration: number;
  announcement: string;
}
