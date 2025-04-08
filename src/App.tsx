import React, {useState, useEffect, useRef, useCallback} from 'react';
import {throttle} from 'lodash';
import {IpcRendererEvent} from 'electron';
import {getFileName} from "./utils/getFileName.ts";
import {formatTime} from "./utils/date.ts";
import Progress from "./components/progress/Progress.tsx"; // Переконайтесь, що цей шлях правильний

// --- Інтерфейси ---
interface RecentVideo {
    filePath: string;
    lastOpened: number;
    currentTime: number;
    duration?: number;
    fileName?: string;
}

// --- Глобальний інтерфейс Window ---
declare global {
    interface Window {
        ipcRenderer: {
            invoke: (channel: string, ...args: any[]) => Promise<any>;
            send: (channel: string, ...args: any[]) => void;
            on: (channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void) => void;
            off: (channel: string, listener: (...args: any[]) => void) => void;
        }
    }
}

// --- Константи ---
const SEEK_SECONDS = 5;

// --- Компонент App ---
function App() {
    // --- Стан відео та плеєра ---
    const [videoSrc, setVideoSrc] = useState<string | null>(null);
    const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
    const [errorMsg, setErrorMsg] = useState<string>('');
    const [seekToTime, setSeekToTime] = useState<number | null>(null);
    const [displayCurrentTime, setDisplayCurrentTime] = useState<number>(0);
    const [displayDuration, setDisplayDuration] = useState<number>(0);
    const [isPlaying, setIsPlaying] = useState<boolean>(false);
    const [isSeeking, setIsSeeking] = useState<boolean>(false); // Відстеження активної перемотки

    // --- Стан недавніх відео ---
    const [recentVideos, setRecentVideos] = useState<RecentVideo[]>([]);
    const [isLoadingRecents, setIsLoadingRecents] = useState<boolean>(true);

    // --- Стан для навігації по папці ---
    const [directoryVideos, setDirectoryVideos] = useState<string[]>([]);
    const [currentVideoIndex, setCurrentVideoIndex] = useState<number>(-1);
    const [isLoadingDirectory, setIsLoadingDirectory] = useState<boolean>(false);

    // --- Стан гучності ---
    const [volume, setVolume] = useState<number>(1);
    const [isMuted, setIsMuted] = useState<boolean>(false);

    // --- Рефи ---
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const animationFrameRef = useRef<number | null>(null);
    const volumeBeforeMute = useRef<number>(1);

    // --- Оновлення часу в UI (спрощено) ---
    // Ця функція буде викликатись циклічно через requestAnimationFrame
    const updateDisplayTime = useCallback(() => {
        if (videoRef.current && !isSeeking) { // Не оновлюємо з відео під час перемотки
            const newTime = videoRef.current.currentTime;
            setDisplayCurrentTime(newTime);
        }
        // Плануємо наступний виклик *тільки* якщо цикл ще активний (animationFrameRef.current не null)
        if (animationFrameRef.current) {
            animationFrameRef.current = requestAnimationFrame(updateDisplayTime);
        }
    }, [isSeeking]); // Залежить від isSeeking

    // --- Запуск циклу оновлення ---
    const startUpdateTimeLoop = useCallback(() => {
        // console.log("Attempting to START update loop.");
        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
        }
        animationFrameRef.current = requestAnimationFrame(updateDisplayTime);
        // console.log("Update loop STARTED. Frame:", animationFrameRef.current);
    }, [updateDisplayTime]);

    // --- Зупинка циклу оновлення ---
    const stopUpdateTimeLoop = useCallback(() => {
        // console.log("Attempting to STOP update loop. Frame:", animationFrameRef.current);
        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
            // console.log("Update loop STOPPED.");
            // Оновлюємо час востаннє при явній зупинці
            if (videoRef.current) {
                setDisplayCurrentTime(videoRef.current.currentTime);
            }
        }
    }, []);

    // --- Ефект для керування циклом оновлення на основі isPlaying ---
    useEffect(() => {
        // console.log("isPlaying effect triggered. isPlaying:", isPlaying);
        if (isPlaying) {
            startUpdateTimeLoop();
        } else {
            stopUpdateTimeLoop();
        }
        // Функція очищення
        return () => {
            // console.log("Cleanup isPlaying effect");
            stopUpdateTimeLoop();
        };
    }, [isPlaying, startUpdateTimeLoop, stopUpdateTimeLoop]);

    // --- Збереження прогресу ---
    const saveProgress = useCallback(throttle((videoElement: HTMLVideoElement, filePath: string) => {
        if (!videoElement || !filePath || !window.ipcRenderer?.invoke || isSeeking) return; // Не зберігаємо під час перемотки
        const currentTime = videoElement.currentTime;
        const duration = videoElement.duration;
        if (!isNaN(duration) && duration > 5 && currentTime >= 0) {
            window.ipcRenderer.invoke('save-video-progress', {filePath, currentTime, duration})
                .catch(err => console.error("[Renderer] Failed to save progress:", err));
        }
    }, 5000, {leading: false, trailing: true}), [isSeeking]); // Додано isSeeking

    // --- Обробка перемотування (з компонента Progress або клавіш) ---
    const handleSeek = useCallback((time: number) => {
        if (videoRef.current) {
            const duration = videoRef.current.duration;
            if (!isNaN(duration) && duration > 0) {
                const newTime = Math.max(0, Math.min(time, duration));
                // console.log(`[Renderer] Seek initiated to: ${newTime.toFixed(2)}`);
                setIsSeeking(true); // Позначаємо початок перемотки
                // Негайно оновлюємо UI, щоб повзунок реагував одразу
                setDisplayCurrentTime(newTime);
                // Встановлюємо час відео
                videoRef.current.currentTime = newTime;

                // Зберігаємо прогрес одразу після ініціації перемотки
                if (currentFilePath && window.ipcRenderer) {
                    saveProgress.cancel(); // Скасувати попереднє заплановане збереження
                    //  console.log(`[Renderer] Saving progress immediately after seek init for ${currentFilePath}: ${newTime}`);
                    window.ipcRenderer.invoke('save-video-progress', { filePath: currentFilePath, currentTime: newTime, duration })
                        .catch(err => console.error("[Renderer] Failed to save progress on manual seek:", err));
                }
                // Скидання isSeeking тепер відбувається в handleSeeked
            }
        }
    }, [currentFilePath, saveProgress]); // Видалено isSeeking з залежностей

    // --- Обробник події onSeeked ---
    const handleSeeked = useCallback(() => {
        // console.log("Event: onSeeked - Seek completed.");
        setIsSeeking(false); // Скидаємо флаг після завершення перемотки браузером
        // Явно оновлюємо час ще раз, особливо якщо відео на паузі
        if (videoRef.current) {
            setDisplayCurrentTime(videoRef.current.currentTime);
        }
        // Якщо відео грало, цикл оновлення має продовжитись автоматично
        // завдяки isPlaying=true та скиданню isSeeking
    }, []);


    // --- Функція відкриття відео ---
    const openVideo = useCallback(async (filePath: string, timeToSeek: number | null = null, isInitial = false) => {
        if (!filePath) return;
        if (!isInitial && filePath === currentFilePath) {
            if (timeToSeek !== null) handleSeek(timeToSeek);
            return;
        }
        // console.log(`[Renderer] Opening video: ${filePath}, seek: ${timeToSeek}`);
        setIsPlaying(false); // Скидаємо стан відтворення
        setIsSeeking(false); // Скидаємо стан перемотки
        stopUpdateTimeLoop(); // Зупиняємо старий цикл
        setVideoSrc(null);
        setCurrentFilePath(filePath);
        setSeekToTime(timeToSeek);
        setDisplayCurrentTime(timeToSeek ?? 0);
        setDisplayDuration(0);
        setErrorMsg('');
        setIsLoadingDirectory(true);
        setDirectoryVideos([]);
        setCurrentVideoIndex(-1);

        const videoUrl = `local-video://${encodeURI(filePath.replace(/\\/g, '/'))}`;
        document.title = getFileName(filePath);

        // Асинхронно отримуємо список відео
        if (window.ipcRenderer) {
            window.ipcRenderer.invoke('get-directory-videos', filePath)
                .then((videosInDir: string[]) => {
                    const currentIndex = videosInDir.findIndex(p => p === filePath);
                    setDirectoryVideos(videosInDir);
                    setCurrentVideoIndex(currentIndex);
                })
                .catch(err => console.error("[Renderer] Error getting directory videos:", err))
                .finally(() => setIsLoadingDirectory(false));
        } else {
            setIsLoadingDirectory(false);
        }

        setVideoSrc(videoUrl); // Встановлюємо src

        if (!isInitial && window.ipcRenderer) {
            window.ipcRenderer.invoke('get-recent-videos')
                .then(setRecentVideos)
                .catch(err => console.error("Error refreshing recent videos:", err));
        }
    }, [currentFilePath, handleSeek, stopUpdateTimeLoop]);

    // --- Завантаження недавніх/початкового відео ---
    useEffect(() => {
        // ... (логіка не змінилась) ...
        setErrorMsg('');
        if (!window.ipcRenderer) {
            setErrorMsg('Помилка: Не вдалося зв\'язатися з preload скриптом (ipcRenderer).');
            setIsLoadingRecents(false);
            return;
        }
        let isInitialVideoLoaded = false;
        const handleLoadInitialVideo = (_event: IpcRendererEvent, filePath: string) => {
            if (filePath && !isInitialVideoLoaded) {
                isInitialVideoLoaded = true;
                openVideo(filePath, null, true);
                setIsLoadingRecents(false);
            }
        };
        window.ipcRenderer.on('load-initial-video', handleLoadInitialVideo);
        const timerId = setTimeout(() => {
            if (!isInitialVideoLoaded) {
                setIsLoadingRecents(true);
                window.ipcRenderer.invoke('get-recent-videos')
                    .then(setRecentVideos)
                    .catch(err => setErrorMsg(`Помилка завантаження історії: ${err.message}`))
                    .finally(() => setIsLoadingRecents(false));
            }
        }, 100);
        return () => {
            clearTimeout(timerId);
            if (window.ipcRenderer) {
                window.ipcRenderer.off('load-initial-video', handleLoadInitialVideo);
            }
        };
    }, [openVideo]);


    // --- Обробник кнопки "Відкрити відеофайл" ---
    const handleOpenFileClick = async () => {
        // ... (без змін) ...
        setErrorMsg('');
        if (!window.ipcRenderer?.invoke) {
            setErrorMsg('Помилка: Функція invoke недоступна.');
            return;
        }
        try {
            const filePath: string | null = await window.ipcRenderer.invoke('dialog:openFile');
            if (filePath) {
                openVideo(filePath);
            } else {
                console.log('[Renderer] File selection cancelled.');
            }
        } catch (err: unknown) {
            console.error("[Renderer] Error invoking dialog:openFile:", err);
            const error = err as Error;
            setErrorMsg(`Помилка відкриття файлу: ${error?.message || String(err)}`);
        }
    };

    // --- Обробники подій відео ---

    // Використовується тільки для throttle збереження
    const handleTimeUpdate = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
        if (currentFilePath) {
            saveProgress(event.currentTarget, currentFilePath);
        }
    }, [currentFilePath, saveProgress]);

    // Встановлює isPlaying, що запускає цикл оновлення
    const handlePlay = useCallback(() => {
        // console.log("Event: onPlay");
        setIsSeeking(false); // Переконуємось, що seek не активний при старті
        setIsPlaying(true);
    }, []);

    // Зупиняє isPlaying, що зупиняє цикл оновлення, зберігає прогрес
    const handlePause = useCallback((event?: React.SyntheticEvent<HTMLVideoElement>) => {
        // console.log("Event: onPause");
        setIsPlaying(false);
        saveProgress.flush();

        const videoElement = event?.currentTarget ?? videoRef.current;
        if (currentFilePath && videoElement && window.ipcRenderer) {
            const currentTime = videoElement.currentTime;
            const duration = videoElement.duration;
            if (!isNaN(duration) && duration > 5 && currentTime >= 0) {
                // console.log(`[Renderer] Saving progress on PAUSE event for ${currentFilePath}: ${currentTime}`);
                window.ipcRenderer.invoke('save-video-progress', {filePath: currentFilePath, currentTime, duration})
                    .catch(err => console.error("[Renderer] Failed to save progress on PAUSE event:", err));
            }
        }
    }, [currentFilePath, saveProgress]);

    const playNext = useCallback(() => {
        if (!isLoadingDirectory && currentVideoIndex !== -1 && currentVideoIndex < directoryVideos.length - 1) {
            openVideo(directoryVideos[currentVideoIndex + 1]);
        }
    }, [currentVideoIndex, directoryVideos, openVideo, isLoadingDirectory]);

    const playPrevious = useCallback(() => {
        if (!isLoadingDirectory && currentVideoIndex > 0 && directoryVideos.length > 0) {
            openVideo(directoryVideos[currentVideoIndex - 1]);
        }
    }, [currentVideoIndex, directoryVideos, openVideo, isLoadingDirectory]);

    // Зупиняє isPlaying, переходить до наступного
    const handleEnded = useCallback(() => {
        // console.log('Event: onEnded');
        setIsPlaying(false);
        if (videoRef.current) setDisplayCurrentTime(videoRef.current.duration);
        playNext();
    }, [playNext]);

    // Завантажує метадані, робить seek, пробує запустити play
    const handleLoadedMetadata = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
        // console.log('Event: onLoadedMetadata');
        const videoElement = event.currentTarget;
        const duration = videoElement.duration;
        setDisplayDuration(duration);

        videoElement.volume = volume;
        videoElement.muted = isMuted;

        let timeToStartFrom = 0;
        if (seekToTime !== null && !isNaN(duration) && duration > 0) {
            timeToStartFrom = Math.max(0, Math.min(seekToTime, duration));
            // console.log(`[Renderer] Applying seek to ${timeToStartFrom} on load.`);
            // Важливо: Встановлюємо час *до* спроби play()
            videoElement.currentTime = timeToStartFrom;
            setSeekToTime(null);
        }
        setDisplayCurrentTime(timeToStartFrom); // Оновлюємо UI

        // Зберігаємо початковий прогрес
        if (currentFilePath && window.ipcRenderer?.invoke && !isNaN(duration)) {
            window.ipcRenderer.invoke('save-video-progress', {filePath: currentFilePath, currentTime: timeToStartFrom, duration})
                .catch(err => console.error("[Renderer] Failed to save initial duration/time:", err));
        }

        // --- Спроба авто-відтворення ---
        // console.log("[Renderer] Attempting autoplay...");
        videoElement.play()
            .then(() => {
                // console.log("[Renderer] Autoplay initiated successfully.");
                // Подія onPlay встановить isPlaying=true
            })
            .catch(error => {
                // console.warn("[Renderer] Autoplay failed:", error);
                setIsPlaying(false); // Переконуємось, що стан правильний
            });

    }, [currentFilePath, seekToTime, volume, isMuted]); // Залежності

    const handleVideoError = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
        console.error('[Renderer] Video playback error:', event.nativeEvent);
        setIsPlaying(false);
        // ... решта логіки помилки ...
        const message = 'Помилка відтворення відео.';
        setErrorMsg(message);
        setVideoSrc(null);
        setCurrentFilePath(null);
        setDisplayCurrentTime(0);
        setDisplayDuration(0);
        setDirectoryVideos([]);
        setCurrentVideoIndex(-1);
    }, []);

    // --- Обробка подвійного кліку ---
    const handleDoubleClick = useCallback(() => {
        // ... (без змін) ...
        if (!containerRef.current) return;
        if (!document.fullscreenElement) {
            containerRef.current.requestFullscreen().catch(err => {
                console.error("Error attempting full-screen:", err);
                setErrorMsg(`Не вдалося увійти в повноекранний режим: ${err.message}`);
            });
        } else {
            document.exitFullscreen();
        }
    }, []);

    // --- Обробка зміни гучності ---
    const handleVolumeChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        // ... (без змін) ...
        const newVolume = parseFloat(event.target.value);
        setVolume(newVolume);
        if (videoRef.current) {
            videoRef.current.volume = newVolume;
            if (newVolume > 0 && isMuted) {
                setIsMuted(false);
                videoRef.current.muted = false;
            } else if (newVolume === 0 && !isMuted) {
                setIsMuted(true);
                videoRef.current.muted = true;
            }
        }
    }, [isMuted]);

    // --- Обробка Mute/Unmute ---
    const toggleMute = useCallback(() => {
        // ... (без змін) ...
        const currentlyMuted = !isMuted;
        setIsMuted(currentlyMuted);
        if (videoRef.current) {
            videoRef.current.muted = currentlyMuted;
            if (currentlyMuted) {
                if (volume > 0) volumeBeforeMute.current = volume;
                setVolume(0);
            } else {
                const restoreVolume = volumeBeforeMute.current > 0 ? volumeBeforeMute.current : 0.5;
                setVolume(restoreVolume);
                videoRef.current.volume = restoreVolume;
            }
        }
    }, [isMuted, volume]);

    // --- Обробка кліку на відео (плей/пауза) ---
    const handleVideoClick = useCallback(() => {
        if (videoRef.current) {
            if (videoRef.current.paused) {
                videoRef.current.play().catch(e => console.warn("Play failed on click:", e));
            } else {
                videoRef.current.pause();
            }
        }
    }, []);

    // --- Обробка натискань клавіш ---
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
            if (videoSrc && videoRef.current) {
                switch (event.code) {
                    case 'Space': event.preventDefault(); handleVideoClick(); break;
                    case 'ArrowLeft': event.preventDefault(); handleSeek(videoRef.current.currentTime - SEEK_SECONDS); break;
                    case 'ArrowRight': event.preventDefault(); handleSeek(videoRef.current.currentTime + SEEK_SECONDS); break;
                    case 'KeyF': event.preventDefault(); handleDoubleClick(); break;
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [videoSrc, handleVideoClick, handleSeek, handleDoubleClick]); // Залежності

    // --- Визначення іконки гучності ---
    const getVolumeIcon = () => {
        if (isMuted || volume === 0) return '🔇';
        if (volume <= 0.5) return '🔈';
        return '🔊';
    };

    // --- Рендеринг ---
    // console.log("App Rendering. isPlaying:", isPlaying, "isSeeking:", isSeeking, "currentTime:", displayCurrentTime.toFixed(2)); // Додатковий лог рендерингу
    return (
        <div
            ref={containerRef}
            className="w-screen h-screen bg-tertiary text-secondary flex flex-col items-center justify-center overflow-hidden relative"
        >
            {/* Повідомлення про помилку */}
            {errorMsg && (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-600 p-3 rounded shadow-lg z-50 max-w-md text-center text-white">
                    <p>{errorMsg}</p>
                    <button onClick={() => setErrorMsg('')} className="absolute top-0.5 right-1.5 text-white hover:text-gray-300 text-lg font-bold leading-none">×</button>
                </div>
            )}

            {/* Відображення плеєра або списку недавніх */}
            {videoSrc ? (
                // --- Плеєр ---
                <div
                    className="relative w-full h-full flex items-center justify-center group bg-black"
                    onDoubleClick={handleDoubleClick}
                >
                    <video
                        ref={videoRef}
                        className="w-full h-full object-contain outline-none"
                        src={videoSrc}
                        onClick={handleVideoClick}
                        onTimeUpdate={handleTimeUpdate} // Для throttle збереження
                        onPlay={handlePlay}             // Встановлює isPlaying=true
                        onPause={handlePause}           // Встановлює isPlaying=false
                        onEnded={handleEnded}           // Встановлює isPlaying=false
                        onLoadedMetadata={handleLoadedMetadata} // Завантажує дані, пробує play
                        onError={handleVideoError}      // Обробка помилок
                        onSeeked={handleSeeked}         // Скидає isSeeking=false
                    >
                        Ваш браузер не підтримує відтворення цього відео формату.
                    </video>

                    {/* Кастомні контролзи */}
                    <div
                        className="absolute bottom-0 left-0 w-full bg-gradient-to-t from-black/80 via-black/50 to-transparent pt-12 pb-3 px-4 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-300 flex flex-col items-center"
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                    >
                        <div className="w-full max-w-4xl">
                            {/* Передаємо актуальний час в Progress */}
                            <Progress
                                duration={displayDuration}
                                currentTime={displayCurrentTime}
                                onSeek={handleSeek}
                            />
                            {/* ... решта контролів без змін ... */}
                            <div className="flex justify-between items-center text-sm text-gray-300 mt-2 gap-4">
                                <div className="flex items-center gap-3">
                                    <button onClick={playPrevious} disabled={isLoadingDirectory || currentVideoIndex <= 0} className="px-2 py-1 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed" title="Попереднє відео (←)">⏮️</button>
                                    <button onClick={handleVideoClick} className="px-2 py-1 text-xl hover:text-white" title={isPlaying ? "Пауза (Пробіл)" : "Відтворити (Пробіл)"}>{isPlaying ? '⏸️' : '▶️'}</button>
                                    <button onClick={playNext} disabled={isLoadingDirectory || currentVideoIndex === -1 || currentVideoIndex >= directoryVideos.length - 1} className="px-2 py-1 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed" title="Наступне відео (→)">⏭️</button>
                                    <div className="flex items-center gap-2 volume-control">
                                        <button onClick={toggleMute} className="px-1 py-1 hover:text-white" title={isMuted ? "Увімкнути звук" : "Вимкнути звук"}>{getVolumeIcon()}</button>
                                        <input
                                            type="range" min="0" max="1" step="0.05"
                                            value={isMuted ? 0 : volume}
                                            onChange={handleVolumeChange}
                                            className="w-20 h-1.5 bg-gray-600 rounded-full appearance-none cursor-pointer accent-primary"
                                            title={`Гучність: ${Math.round(volume * 100)}%`}
                                        />
                                    </div>
                                </div>
                                <div className="text-xs font-mono">
                                    <span>{formatTime(displayCurrentTime)}</span> / <span>{formatTime(displayDuration)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            ) : (
                // --- Список недавніх ---
                <div className="flex flex-col items-center gap-6 p-8 max-w-3xl w-full">
                    {/* ... (код списку недавніх без змін) ... */}
                    <h1 className="text-3xl font-bold text-secondary mb-2">React Video Player</h1>
                    <button
                        onClick={handleOpenFileClick}
                        className="bg-primary hover:bg-primary-dark text-white font-bold py-2 px-5 rounded transition duration-150 ease-in-out shadow hover:shadow-md"
                    >
                        Відкрити відеофайл
                    </button>
                    <div className="mt-8 w-full">
                        <h2 className="text-xl text-gray-400 mb-3 border-b border-gray-700 pb-1">Нещодавно відкриті:</h2>
                        {isLoadingRecents ? (
                            <p className="text-gray-500 text-center py-4">Завантаження історії...</p>
                        ) : recentVideos.length > 0 ? (
                            <ul className="space-y-2 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
                                {recentVideos.map((video) => (
                                    <li
                                        key={video.filePath}
                                        onClick={() => openVideo(video.filePath, video.currentTime)}
                                        className="bg-gray-800 p-3 rounded hover:bg-gray-700 cursor-pointer transition duration-150 ease-in-out group flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
                                    >
                                        <div className="flex-grow overflow-hidden">
                                            <p className="font-medium text-gray-200 truncate group-hover:text-primary" title={video.filePath}>
                                                {video.fileName || getFileName(video.filePath)}
                                            </p>
                                            <p className="text-xs text-gray-500 mt-1">
                                                Останній перегляд: {new Date(video.lastOpened).toLocaleString()}
                                            </p>
                                        </div>
                                        {video.duration && video.duration > 0 && typeof video.currentTime === 'number' && video.currentTime >= 0 && (
                                            <div className="flex-shrink-0 w-full sm:w-48">
                                                <span className="text-xs text-gray-400 block text-right mb-1">
                                                    {formatTime(video.currentTime)} / {formatTime(video.duration)}
                                                </span>
                                                <div className="w-full bg-gray-600 rounded-full h-1.5 dark:bg-gray-700">
                                                    <div
                                                        className="bg-primary h-1.5 rounded-full"
                                                        style={{ width: `${Math.min(100, Math.max(0, (video.currentTime / video.duration) * 100))}%` }}
                                                    ></div>
                                                </div>
                                            </div>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-gray-500 text-center py-4">Історія переглядів порожня.</p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export default App;
