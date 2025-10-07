import React, { useState, useEffect, useRef, useCallback, ChangeEvent } from 'react';
import { AppState, BreathingPhase } from './types';
import { DURATION_OPTIONS, DEFAULT_DURATION, PHASES, CYCLE_DURATION } from './constants';
import { usePersistentState } from './hooks/usePersistentState';
import { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion';
import { PlayIcon, PauseIcon, StopIcon, VolumeUpIcon, VolumeOffIcon, ExternalLinkIcon } from './components/Icons';

// --- Type Declarations for YouTube IFrame API ---
declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
    // FIX: Add the YT namespace to the global Window interface to inform TypeScript that the YouTube IFrame API object (YT) is available on the window object.
    YT?: typeof YT;
  }
}
declare namespace YT {
  const enum PlayerState { UNSTARTED = -1, ENDED = 0, PLAYING = 1, PAUSED = 2, BUFFERING = 3, CUED = 5 }
  interface Player {
    playVideo(): void; pauseVideo(): void; stopVideo(): void; seekTo(seconds: number, allowSeekAhead: boolean): void;
    getVolume(): number; setVolume(volume: number): void; mute(): void; unMute(): void; isMuted(): boolean;
    getPlayerState(): PlayerState; destroy(): void; getIframe(): HTMLElement;
  }
  interface PlayerOptions { height?: string | number; width?: string | number; videoId?: string; playerVars?: object; events?: { onReady?: (event: { target: Player }) => void; onStateChange?: (event: { data: PlayerState, target: Player }) => void; }; }
  const Player: { new(id: string | HTMLElement, options: PlayerOptions): Player };
}

// --- Singleton YouTube Player Instance ---
let ytPlayer: YT.Player | null = null;
let fallbackAudio: HTMLAudioElement | null = null;
let smoothVolumeInterval: number | null = null;


// --- Helper Functions ---
const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
};

const smoothSetVolume = (targetVolume: number) => {
    if (!ytPlayer || typeof ytPlayer.getVolume !== 'function') return;
    if (smoothVolumeInterval) clearInterval(smoothVolumeInterval);

    const from = ytPlayer.getVolume();
    if (typeof from !== 'number') return; // Guard against API not being ready

    const steps = 10;
    const stepDuration = 12; // 12ms per step
    const step = (targetVolume - from) / steps;
    let i = 0;

    smoothVolumeInterval = window.setInterval(() => {
        i++;
        const newVol = Math.round(from + step * i);
        if (ytPlayer && typeof ytPlayer.setVolume === 'function') {
            ytPlayer.setVolume(newVol);
        }
        if (i >= steps) {
            clearInterval(smoothVolumeInterval!);
            smoothVolumeInterval = null;
        }
    }, stepDuration);
};


// --- Constants ---
const CANON_MUSIC_URL = 'https://cdn.pixabay.com/download/audio/2022/10/18/audio_731a5598b2.mp3'; // Royalty-free "Canon in D"

// --- Sub-components ---
interface BreathingVisualizerProps {
    phase: BreathingPhase;
    isReducedMotion: boolean;
}
const BreathingVisualizer: React.FC<BreathingVisualizerProps> = ({ phase, isReducedMotion }) => {
    const phaseStyles: Record<BreathingPhase, string> = {
        [BreathingPhase.Inhale]: isReducedMotion ? 'opacity-100' : 'scale-100',
        [BreathingPhase.HoldIn]: isReducedMotion ? 'opacity-100' : 'scale-100',
        [BreathingPhase.Exhale]: isReducedMotion ? 'opacity-60' : 'scale-50',
        [BreathingPhase.HoldOut]: isReducedMotion ? 'opacity-60' : 'scale-50',
    };
    const phaseDurations: Record<BreathingPhase, string> = {
        [BreathingPhase.Inhale]: `duration-[${PHASES.inhale.duration}ms]`,
        [BreathingPhase.HoldIn]: 'duration-500',
        [BreathingPhase.Exhale]: `duration-[${PHASES.exhale.duration}ms]`,
        [BreathingPhase.HoldOut]: 'duration-500',
    };
    return (
        <div className="relative w-64 h-64 md:w-80 md:h-80 flex items-center justify-center">
            <div className={`w-full h-full rounded-full bg-cyan-400 dark:bg-cyan-600 transition-all ease-in-out ${phaseDurations[phase]} ${phaseStyles[phase]}`}></div>
        </div>
    );
};

// --- Main App Component ---
const App: React.FC = () => {
    const prefersReducedMotion = usePrefersReducedMotion();
    const [appState, setAppState] = useState<AppState>(AppState.Idle);
    const [duration, setDuration] = usePersistentState<number>('duration', DEFAULT_DURATION);
    const [reducedMotion, setReducedMotion] = usePersistentState<boolean>('reducedMotion', prefersReducedMotion);
    const [remainingTime, setRemainingTime] = useState(duration);
    const [currentPhase, setCurrentPhase] = useState<BreathingPhase>(BreathingPhase.HoldOut);
    const [ariaAnnouncement, setAriaAnnouncement] = useState('');

    // Music State
    const [isMuted, setIsMuted] = usePersistentState<boolean>('isMuted', true);
    const [volume, setVolume] = usePersistentState<number>('bgmVolume', 40);
    const [useFallback, setUseFallback] = useState(false);
    const [showYoutubeError, setShowYoutubeError] = useState(false);
    
    const fallbackTimeoutRef = useRef<number | null>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    
    const animationFrameRef = useRef<number>();
    const startTimeRef = useRef<number>(0);
    const pauseTimeRef = useRef<number>(0);
    const lastPhaseRef = useRef<BreathingPhase | null>(null);

    // Sync local reduced motion state with system preference
    useEffect(() => { setReducedMotion(prefersReducedMotion); }, [prefersReducedMotion, setReducedMotion]);
    
    // --- Music Control Logic ---
    const playMusic = useCallback(() => {
        if (useFallback) {
            fallbackAudio?.play().catch(e => console.error("Fallback audio playback failed:", e));
        } else if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
            ytPlayer.playVideo();
            // Set a timeout to detect if playback fails
            if(fallbackTimeoutRef.current) clearTimeout(fallbackTimeoutRef.current);
            fallbackTimeoutRef.current = window.setTimeout(() => {
                if (ytPlayer && typeof ytPlayer.getPlayerState === 'function' && ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING) {
                    setShowYoutubeError(true);
                    setUseFallback(true);
                    ytPlayer.stopVideo();
                    if(fallbackAudio) {
                        fallbackAudio.volume = volume / 100;
                        fallbackAudio.muted = isMuted;
                        fallbackAudio.play().catch(e => console.error("Fallback audio playback failed:", e));
                    }
                }
            }, 3000);
        }
    }, [useFallback, volume, isMuted]);

    const pauseMusic = useCallback(() => {
        if (fallbackTimeoutRef.current) clearTimeout(fallbackTimeoutRef.current);
        if (useFallback) {
            fallbackAudio?.pause();
        } else {
            ytPlayer?.pauseVideo();
        }
    }, [useFallback]);
    
    const stopMusic = useCallback(() => {
        if (fallbackTimeoutRef.current) clearTimeout(fallbackTimeoutRef.current);
        if (useFallback) {
            if (fallbackAudio) {
                fallbackAudio.pause();
                fallbackAudio.currentTime = 0;
            }
        } else if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
            ytPlayer.pauseVideo();
            ytPlayer.seekTo(0, true);
        }
    }, [useFallback]);

    // --- Timer State Handlers ---
    const handleStart = () => {
        setRemainingTime(duration);
        if (!isMuted) playMusic();
        setAppState(AppState.Active);
        startTimeRef.current = performance.now();
        pauseTimeRef.current = 0;
        lastPhaseRef.current = null;
    };

    const handlePause = () => {
        pauseMusic();
        setAppState(AppState.Paused);
        pauseTimeRef.current = performance.now();
    };

    const handleResume = () => {
        if (!isMuted) playMusic();
        const pauseDuration = performance.now() - pauseTimeRef.current;
        startTimeRef.current += pauseDuration;
        setAppState(AppState.Active);
    };

    const handleEnd = () => {
        stopMusic();
        setAppState(AppState.Idle);
    };
    
    const handleComplete = () => {
        stopMusic();
        setAppState(AppState.Complete);
        setAriaAnnouncement('練習完成');
    };

    const handleRestart = () => {
        setAppState(AppState.Idle);
        setTimeout(handleStart, 100);
    };
    
    // --- Timer Tick Logic ---
    const tick = useCallback((timestamp: number) => {
        const elapsed = timestamp - startTimeRef.current;
        const newRemainingTime = Math.max(0, duration * 1000 - elapsed);
        setRemainingTime(Math.ceil(newRemainingTime / 1000));

        if (newRemainingTime <= 0) {
            handleComplete(); return;
        }

        const elapsedInCycle = elapsed % CYCLE_DURATION;
        let cumulativeDuration = 0;
        let phase: BreathingPhase = BreathingPhase.HoldOut;

        for (const p of Object.keys(PHASES) as BreathingPhase[]) {
            cumulativeDuration += PHASES[p].duration;
            if (elapsedInCycle < cumulativeDuration) {
                phase = p; break;
            }
        }
        
        setCurrentPhase(phase);
        
        if (phase !== lastPhaseRef.current) {
            setAriaAnnouncement(PHASES[phase].announcement);
            lastPhaseRef.current = phase;
        }
        animationFrameRef.current = requestAnimationFrame(tick);
    }, [duration, handleComplete]);
    
    // --- Effects ---
    useEffect(() => {
        if (appState === AppState.Active) {
            animationFrameRef.current = requestAnimationFrame(tick);
        } else if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
        }
        return () => { if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current); };
    }, [appState, tick]);

    // YouTube Player Initialization
    useEffect(() => {
        if (audioRef.current && !fallbackAudio) {
            fallbackAudio = audioRef.current;
        }

        const initPlayer = () => {
            if (ytPlayer || !document.getElementById('yt-player')) {
                return;
            }

            ytPlayer = new YT.Player('yt-player', {
                height: 90, width: 160, videoId: 'RhQyGJfOsQ0',
                playerVars: { autoplay: 0, controls: 1, modestbranding: 1, rel: 0, playsinline: 1, loop: 1, listType: 'playlist', list: 'RDRhQyGJfOsQ0', origin: window.location.origin },
                events: {
                    onReady: (event) => {
                        event.target.setVolume(volume);
                        if (isMuted) event.target.mute(); else event.target.unMute();
                    },
                    onStateChange: (event) => {
                        if (event.data === YT.PlayerState.PLAYING && fallbackTimeoutRef.current) {
                            clearTimeout(fallbackTimeoutRef.current);
                        }
                    }
                }
            });
        };

        if (!window.YT) {
            const tag = document.createElement('script');
            tag.src = "https://www.youtube.com/iframe_api";
            window.onYouTubeIframeAPIReady = initPlayer;
            const firstScriptTag = document.getElementsByTagName('script')[0];
            firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);
        } else {
            initPlayer();
        }
    }, []);

    // Keyboard controls
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (appState === AppState.Idle && e.key === 'Enter') handleStart();
            else if (appState === AppState.Active && e.key === ' ') { e.preventDefault(); handlePause(); }
            else if (appState === AppState.Paused && e.key === ' ') { e.preventDefault(); handleResume(); }
            else if ((appState === AppState.Active || appState === AppState.Paused) && e.key === 'Escape') handleEnd();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [appState, handleEnd, handlePause, handleResume, handleStart]);

    // Handle page visibility
    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.hidden && appState === AppState.Active) handlePause();
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, [appState, handlePause]);

    // --- Music Control Handlers ---
    const handleMuteToggle = () => {
        const newMutedState = !isMuted;
        setIsMuted(newMutedState);
        if (useFallback) {
            if (fallbackAudio) fallbackAudio.muted = newMutedState;
        } else if (ytPlayer && typeof ytPlayer.mute === 'function') {
            if (newMutedState) ytPlayer.mute(); else ytPlayer.unMute();
        }
        if (!newMutedState && (appState === AppState.Active || appState === AppState.Paused)) playMusic();
        if (newMutedState) pauseMusic();
    };
    
    const handleVolumeChange = (e: ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseInt(e.target.value, 10);
        setVolume(newVolume);

        if (useFallback) {
            if (fallbackAudio) {
                fallbackAudio.volume = newVolume / 100;
                const newMutedState = newVolume === 0;
                if (fallbackAudio.muted !== newMutedState) {
                   fallbackAudio.muted = newMutedState;
                   setIsMuted(newMutedState);
                }
            }
        } else if (ytPlayer && typeof ytPlayer.getPlayerState === 'function' && ytPlayer.getPlayerState() !== YT.PlayerState.UNSTARTED) {
            smoothSetVolume(newVolume);
            
            const currentlyMuted = ytPlayer.isMuted();
            if (newVolume > 0 && currentlyMuted) {
                ytPlayer.unMute();
                setIsMuted(false);
            } 
            else if (newVolume === 0 && !currentlyMuted) {
                ytPlayer.mute();
                setIsMuted(true);
            }
        }
    };

    const renderContent = () => {
        switch (appState) {
            case AppState.Active:
            case AppState.Paused:
                return (
                    <div className="flex flex-col items-center justify-center text-center">
                        <p className="text-2xl text-slate-600 dark:text-slate-300 mb-8 font-medium w-32 h-8">{PHASES[currentPhase].name}</p>
                        <BreathingVisualizer phase={currentPhase} isReducedMotion={reducedMotion} />
                        <p className="text-5xl md:text-6xl font-mono text-slate-800 dark:text-slate-100 mt-8 w-40 h-16">{formatTime(remainingTime)}</p>
                        <div className="flex space-x-4 mt-8">
                            {appState === AppState.Active ? (
                                <button onClick={handlePause} className="p-4 rounded-full bg-slate-200 dark:bg-gray-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-gray-600 transition-colors" aria-label="暫停">
                                    <PauseIcon className="w-8 h-8"/>
                                </button>
                            ) : (
                                <button onClick={handleResume} className="p-4 rounded-full bg-slate-200 dark:bg-gray-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-gray-600 transition-colors" aria-label="繼續">
                                    <PlayIcon className="w-8 h-8"/>
                                </button>
                            )}
                             <button onClick={handleEnd} className="p-4 rounded-full bg-slate-200 dark:bg-gray-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-gray-600 transition-colors" aria-label="結束">
                                <StopIcon className="w-8 h-8"/>
                            </button>
                        </div>
                    </div>
                );
            case AppState.Complete:
                 return (
                    <div className="text-center">
                        <h2 className="text-4xl font-bold text-slate-800 dark:text-slate-100">做得好！</h2>
                        <p className="text-xl mt-2 text-slate-600 dark:text-slate-300">完成了 {formatTime(duration)} 的練習</p>
                        <div className="mt-8 flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:space-x-4">
                            <button onClick={handleRestart} className="px-8 py-4 bg-cyan-600 text-white rounded-lg font-semibold text-xl hover:bg-cyan-700 transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900">
                                再來一次
                            </button>
                            <button onClick={handleEnd} className="px-8 py-4 bg-slate-200 dark:bg-gray-700 text-slate-800 dark:text-slate-100 rounded-lg font-semibold text-xl hover:bg-slate-300 dark:hover:bg-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 dark:focus:ring-offset-gray-900">
                                回首頁
                            </button>
                        </div>
                    </div>
                );
            case AppState.Idle:
            default:
                return (
                    <div className="text-center">
                        <h1 className="text-xl md:text-2xl text-slate-600 dark:text-slate-300">兩分鐘，喘口氣。</h1>
                        <button onClick={handleStart} className="mt-6 px-12 py-6 bg-cyan-600 text-white rounded-full font-semibold text-2xl md:text-3xl hover:bg-cyan-700 transition-transform hover:scale-105 focus:outline-none focus:ring-4 focus:ring-cyan-500 focus:ring-opacity-50">
                            開始呼吸
                        </button>
                        <div className="mt-12 space-y-6">
                            <div className="flex items-center justify-center space-x-2 text-slate-700 dark:text-slate-200">
                                {DURATION_OPTIONS.map(d => (
                                    <button key={d} onClick={() => setDuration(d)} className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${duration === d ? 'bg-cyan-500 text-white' : 'bg-slate-200 dark:bg-gray-700 hover:bg-slate-300 dark:hover:bg-gray-600'}`}>
                                        {d / 60} 分
                                    </button>
                                ))}
                            </div>
                            <div className="flex items-center justify-center space-x-6 text-slate-700 dark:text-slate-200">
                                <button onClick={() => setReducedMotion(!reducedMotion)} className={`flex items-center space-x-2 px-4 py-2 rounded-full transition-colors ${reducedMotion ? 'bg-cyan-500 text-white' : 'bg-slate-200 dark:bg-gray-700 hover:bg-slate-300 dark:hover:bg-gray-600'}`} aria-label={`低動態: ${reducedMotion ? '開' : '關'}`}>
                                    <span>低動態</span>
                                </button>
                            </div>
                        </div>
                    </div>
                );
        }
    };

    return (
        <div className="flex flex-col min-h-screen text-slate-900 dark:text-slate-50 transition-colors duration-500">
             <div aria-live="polite" className="sr-only">{ariaAnnouncement}</div>
             <audio ref={audioRef} src={CANON_MUSIC_URL} loop preload="auto" />
            <main className="flex-grow flex items-center justify-center p-4">
                {renderContent()}
            </main>
            <div className="fixed bottom-4 right-4 bg-slate-100/80 dark:bg-gray-800/80 backdrop-blur-sm p-3 rounded-lg shadow-lg w-48 text-xs text-slate-600 dark:text-slate-300 z-10">
                {showYoutubeError && <p className="text-red-500 mb-2 text-xxs">YouTube無法播放，已切換為內建音樂。</p>}
                <p className="font-semibold text-slate-700 dark:text-slate-200">音樂來源：YouTube</p>
                <div id="yt-player" className="my-1 w-[160px] h-[90px] bg-black rounded" aria-label="YouTube background music"></div>
                <div className="flex items-center justify-between">
                     <p className="text-xxs">正在播放: YouTube Mix</p>
                     <a href="https://www.youtube.com/watch?v=RhQyGJfOsQ0&list=RDRhQyGJfOsQ0" target="_blank" rel="noopener noreferrer" aria-label="在新分頁開啟 YouTube" className="hover:text-cyan-500">
                        <ExternalLinkIcon className="w-4 h-4" />
                     </a>
                </div>
                <div className="flex items-center space-x-2 mt-2">
                    <button onClick={handleMuteToggle} aria-label={isMuted ? "開啟背景音樂" : "關閉背景音樂"} className="hover:text-cyan-500">
                        {isMuted ? <VolumeOffIcon className="w-6 h-6" /> : <VolumeUpIcon className="w-6 h-6" />}
                    </button>
                    <input 
                        type="range" min="0" max="100" value={volume} 
                        onInput={handleVolumeChange}
                        className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 accent-cyan-600"
                        aria-label="音量"
                    />
                </div>
            </div>
            <footer className="text-center p-4">
                <p className="text-xs text-slate-400 dark:text-gray-500">僅供一般放鬆用途，若感不適請立即停止並諮詢專業人士。</p>
            </footer>
        </div>
    );
};

export default App;