import React, {useState, useEffect, useRef, useCallback} from 'react';
import {throttle} from 'lodash';
import {IpcRendererEvent} from 'electron';
import {getFileName} from "./utils/getFileName.ts";
import {formatTime} from "./utils/date.ts";
import Progress from "./components/progress/Progress.tsx";

// --- Інтерфейси ---
interface RecentVideo {
    filePath: string;
    lastOpened: number;
    currentTime: number;
    duration?: number;
    fileName?: string;
}

// --- Глобальний інтерфейс Window ---
// declare global {
//     interface Window {
//         ipcRenderer: {
//             // Використовуємо більш гнучкі типи для invoke, send, on, off
//             invoke: (channel: string, ...args: any[]) => Promise<any>;
//             send: (channel: string, ...args: any[]) => void;
//             on: (channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void) => void;
//             off: (channel: string, listener: (...args: any[]) => void) => void;
//         }
//     }
// }

// --- Компонент App ---
function App() {
    // --- Стан відео та плеєра ---
    const [videoSrc, setVideoSrc] = useState<string | null>(null);
    const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
    const [errorMsg, setErrorMsg] = useState<string>('');
    const [seekToTime, setSeekToTime] = useState<number | null>(null);
    const [displayCurrentTime, setDisplayCurrentTime] = useState<number>(0);
    const [displayDuration, setDisplayDuration] = useState<number>(0);
    const [isPlaying, setIsPlaying] = useState<boolean>(false); // Стан для відтворення

    // --- Стан недавніх відео ---
    const [recentVideos, setRecentVideos] = useState<RecentVideo[]>([]);
    const [isLoadingRecents, setIsLoadingRecents] = useState<boolean>(true);

    // --- Стан для навігації по папці ---
    const [directoryVideos, setDirectoryVideos] = useState<string[]>([]);
    const [currentVideoIndex, setCurrentVideoIndex] = useState<number>(-1);
    const [isLoadingDirectory, setIsLoadingDirectory] = useState<boolean>(false);

    // --- Стан гучності ---
    const [volume, setVolume] = useState<number>(1); // Гучність від 0 до 1
    const [isMuted, setIsMuted] = useState<boolean>(false);

    // --- Рефи ---
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null); // Для повноекранного режиму
    const animationFrameRef = useRef<number | null>(null);
    const volumeBeforeMute = useRef<number>(1); // Зберігаємо гучність перед Mute

    // --- Оновлення часу в UI за допомогою requestAnimationFrame ---
    const updateDisplayTime = useCallback(() => {
        if (videoRef.current) {
            setDisplayCurrentTime(videoRef.current.currentTime);
            animationFrameRef.current = requestAnimationFrame(updateDisplayTime);
        }
    }, []);

    const startUpdateTimeLoop = useCallback(() => {
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = requestAnimationFrame(updateDisplayTime);
    }, [updateDisplayTime]);

    const stopUpdateTimeLoop = useCallback(() => {
        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }
        // Останнє оновлення при зупинці
        if (videoRef.current) setDisplayCurrentTime(videoRef.current.currentTime);
    }, []);

    // --- Функція відкриття відео ---
    const openVideo = useCallback(async (filePath: string, timeToSeek: number | null = null, isInitial = false) => {
        if (!filePath) return;
        if (!isInitial && filePath === currentFilePath) {
            if (timeToSeek !== null && videoRef.current) {
                videoRef.current.currentTime = timeToSeek;
                setDisplayCurrentTime(timeToSeek);
            }
            return;
        }
        console.log(`[Renderer] Opening video: ${filePath}, seek: ${timeToSeek}`);
        stopUpdateTimeLoop();
        setVideoSrc(null);
        setDisplayCurrentTime(timeToSeek ?? 0);
        setDisplayDuration(0);
        setCurrentFilePath(filePath);
        setSeekToTime(timeToSeek);
        setErrorMsg('');
        setIsLoadingDirectory(true); // Показуємо завантаження списку папки
        setDirectoryVideos([]);     // Скидаємо старий список
        setCurrentVideoIndex(-1);   // Скидаємо індекс

        const videoUrl = `local-video://${encodeURI(filePath.replace(/\\/g, '/'))}`;
        document.title = getFileName(filePath);

        // Запитуємо список відео в поточній папці
        if (window.ipcRenderer) {
            try {
                const videosInDir: string[] = await window.ipcRenderer.invoke('get-directory-videos', filePath);
                const currentIndex = videosInDir.findIndex(p => p === filePath);
                setDirectoryVideos(videosInDir);
                setCurrentVideoIndex(currentIndex);
                console.log(`[Renderer] Directory videos loaded (${videosInDir.length}), current index: ${currentIndex}`);
            } catch (err) {
                console.error("[Renderer] Error getting directory videos:", err);
                setDirectoryVideos([]);
                setCurrentVideoIndex(-1);
            } finally {
                setIsLoadingDirectory(false);
            }
        } else {
            setIsLoadingDirectory(false); // Якщо ipcRenderer недоступний
        }


        // Встановлюємо src після скидання та потенційної затримки на отримання списку папки
        requestAnimationFrame(() => {
            setVideoSrc(videoUrl);
            // Спробуємо відтворити (handleLoadedMetadata подбає про seek)
            videoRef.current?.play().catch(e => console.warn("Autoplay failed:", e));
        });


        if (!isInitial) {
            window.ipcRenderer?.invoke('get-recent-videos')
                .then(setRecentVideos)
                .catch(err => console.error("Error refreshing recent videos:", err));
        }
    }, [stopUpdateTimeLoop, currentFilePath]); // Додали залежність currentFilePath


    // --- Завантаження недавніх/початкового відео ---
    useEffect(() => {
        setErrorMsg('');
        if (!window.ipcRenderer) {
            setErrorMsg('Помилка: Не вдалося зв\'язатися з preload скриптом (ipcRenderer).');
            setIsLoadingRecents(false);
            return;
        }

        let isInitialVideoLoaded = false;

        const handleLoadInitialVideo = (_event: IpcRendererEvent, filePath: string) => {
            console.log('[Renderer] Received initial video path:', filePath);
            if (filePath && !isInitialVideoLoaded) { // Додаткова перевірка
                isInitialVideoLoaded = true;
                openVideo(filePath, null, true).finally(() => setIsLoadingRecents(false));
            }
        };
        window.ipcRenderer.on('load-initial-video', handleLoadInitialVideo);

        // Завантажуємо недавні, якщо початкове відео не було передано швидко
        const timerId = setTimeout(() => {
            if (!isInitialVideoLoaded) {
                setIsLoadingRecents(true);
                window.ipcRenderer.invoke('get-recent-videos')
                    .then((recents: RecentVideo[]) => {
                        console.log('[Renderer] Received recent videos:', recents);
                        setRecentVideos(recents);
                    })
                    .catch(err => {
                        console.error("[Renderer] Error getting recent videos:", err);
                        setErrorMsg(`Помилка завантаження історії: ${err.message}`);
                    })
                    .finally(() => {
                        setIsLoadingRecents(false);
                    });
            }
        }, 100); // Трохи збільшена затримка

        return () => {
            clearTimeout(timerId);
            if (window.ipcRenderer) {
                window.ipcRenderer.off('load-initial-video', handleLoadInitialVideo);
            }
            stopUpdateTimeLoop();
        };
    }, [openVideo, stopUpdateTimeLoop]); // Додали openVideo як залежність

    // --- Обробник кнопки "Відкрити відеофайл" ---
    const handleOpenFileClick = async () => {
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
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-expect-error
            setErrorMsg(`Помилка відкриття файлу: ${err?.message || err}`);
        }
    };

    // --- Збереження прогресу (throttle) ---
    const saveProgress = useCallback(throttle((videoElement: HTMLVideoElement, filePath: string) => {
        if (!videoElement || !filePath || !window.ipcRenderer?.invoke) return;
        const currentTime = videoElement.currentTime;
        const duration = videoElement.duration;
        if (!isNaN(duration) && duration > 5 && currentTime > 0) {
            window.ipcRenderer.invoke('save-video-progress', {filePath, currentTime, duration})
                .catch(err => console.error("[Renderer] Failed to save progress:", err));
        }
    }, 5000, {leading: false, trailing: true}), []);

    // --- Обробники подій відео ---
    const handleTimeUpdate = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
        // Оновлення часу в UI керується requestAnimationFrame (updateDisplayTime)
        // Тут залишаємо тільки збереження прогресу
        if (currentFilePath) {
            saveProgress(event.currentTarget, currentFilePath);
        }
    }, [currentFilePath, saveProgress]);

    const handlePause = useCallback((event?: React.SyntheticEvent<HTMLVideoElement>) => {
        setIsPlaying(false);
        stopUpdateTimeLoop();
        saveProgress.flush(); // Викликаємо збереження негайно
        // Додатково зберігаємо, якщо є елемент (на випадок програмної паузи)
        const videoElement = event?.currentTarget ?? videoRef.current;
        if (currentFilePath && videoElement) {
            const currentTime = videoElement.currentTime;
            const duration = videoElement.duration;
            if (!isNaN(duration) && duration > 5 && currentTime > 0 && window.ipcRenderer?.invoke) {
                console.log(`[Renderer] Saving progress on PAUSE for ${currentFilePath}: ${currentTime}`);
                window.ipcRenderer.invoke('save-video-progress', {filePath: currentFilePath, currentTime, duration})
                    .catch(err => console.error("[Renderer] Failed to save progress on PAUSE:", err));
            }
        }
    }, [currentFilePath, saveProgress, stopUpdateTimeLoop]);

    const handlePlay = useCallback(() => {
        setIsPlaying(true);
        startUpdateTimeLoop();
    }, [startUpdateTimeLoop]);

    const playNext = useCallback(() => {
        if (!isLoadingDirectory && currentVideoIndex !== -1 && currentVideoIndex < directoryVideos.length - 1) {
            openVideo(directoryVideos[currentVideoIndex + 1]);
        } else {
            console.log("[Renderer] Cannot play next video. Index:", currentVideoIndex, "Total:", directoryVideos.length, "Loading:", isLoadingDirectory);
        }
    }, [currentVideoIndex, directoryVideos, openVideo, isLoadingDirectory]);

    const playPrevious = useCallback(() => {
        if (!isLoadingDirectory && currentVideoIndex > 0 && directoryVideos.length > 0) {
            openVideo(directoryVideos[currentVideoIndex - 1]);
        } else {
            console.log("[Renderer] Cannot play previous video. Index:", currentVideoIndex, "Loading:", isLoadingDirectory);
        }
    }, [currentVideoIndex, directoryVideos, openVideo, isLoadingDirectory]);


    const handleEnded = useCallback(() => {
        console.log('[Renderer] Video ended.');
        setIsPlaying(false);
        stopUpdateTimeLoop();
        // Спробувати відтворити наступне відео
        playNext();
    }, [stopUpdateTimeLoop, playNext]);

    const handleLoadedMetadata = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
        console.log('[Renderer] Video metadata loaded.');
        const videoElement = event.currentTarget;
        const duration = videoElement.duration;
        setDisplayDuration(duration);

        // Встановлення гучності та Mute статусу з React стану
        videoElement.volume = volume;
        videoElement.muted = isMuted;

        if (seekToTime !== null) {
            console.log(`[Renderer] Seeking to ${seekToTime} seconds.`);
            videoElement.currentTime = seekToTime;
            setDisplayCurrentTime(seekToTime);
            setSeekToTime(null);
        } else {
            setDisplayCurrentTime(videoElement.currentTime);
        }

        // Збереження тривалості, якщо ще не збережена
        if (currentFilePath && window.ipcRenderer?.invoke && !isNaN(duration)) {
            window.ipcRenderer.invoke('save-video-progress', {
                filePath: currentFilePath,
                currentTime: videoElement.currentTime,
                duration
            }).catch(err => console.error("[Renderer] Failed to save initial duration:", err));
        }

        // Автоплей вже викликається в openVideo, handlePlay подбає про startUpdateTimeLoop
        if (!videoElement.paused) {
            handlePlay(); // Переконуємося, що цикл запущено, якщо відтворення почалося
        } else {
            setIsPlaying(false); // Якщо автоплей не спрацював
        }

    }, [currentFilePath, seekToTime, volume, isMuted, handlePlay]); // Додали volume, isMuted, handlePlay

    const handleVideoError = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
        stopUpdateTimeLoop();
        console.error('[Renderer] Video playback error:', event.nativeEvent);
        const error = (event.target as HTMLVideoElement).error;
        let message = 'Помилка відтворення відео.';
        if (error) {
            // ... (коди помилок як раніше)
            switch (error.code) {
                case MediaError.MEDIA_ERR_ABORTED: message += ' Завантаження перервано.'; break;
                case MediaError.MEDIA_ERR_NETWORK: message += ' Помилка мережі.'; break;
                case MediaError.MEDIA_ERR_DECODE: message += ' Помилка декодування.'; break;
                case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: message += ' Формат не підтримується.'; break;
                default: message += ' Невідома помилка.';
            }
        }
        setErrorMsg(message);
        setVideoSrc(null);
        setCurrentFilePath(null);
        setDisplayCurrentTime(0);
        setDisplayDuration(0);
        setIsPlaying(false);
        setDirectoryVideos([]);
        setCurrentVideoIndex(-1);
    }, [stopUpdateTimeLoop]);

    // --- Обробка перемотування з Progress компонента ---
    const handleSeek = useCallback((time: number) => {
        if (videoRef.current) {
            const duration = videoRef.current.duration;
            if (!isNaN(duration)) {
                const newTime = Math.max(0, Math.min(time, duration));
                videoRef.current.currentTime = newTime;
                setDisplayCurrentTime(newTime);
                // Якщо відео на паузі, все одно оновити displayTime
                if (videoRef.current.paused) {
                    setDisplayCurrentTime(newTime);
                }
            }
        }
    }, []);

    // --- Обробка подвійного кліку для повноекранного режиму ---
    const handleDoubleClick = useCallback(() => {
        if (!containerRef.current) return; // Потрібен контейнер

        if (!document.fullscreenElement) {
            containerRef.current.requestFullscreen()
                .catch(err => {
                    console.error("Error attempting full-screen:", err);
                    setErrorMsg(`Не вдалося увійти в повноекранний режим: ${err.message}`);
                });
        } else {
            document.exitFullscreen();
        }
    }, []);

    // --- Обробка зміни гучності ---
    const handleVolumeChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseFloat(event.target.value);
        setVolume(newVolume);
        if (videoRef.current) {
            videoRef.current.volume = newVolume;
            // Автоматично вимикаємо Mute, якщо гучність > 0
            if (newVolume > 0 && isMuted) {
                setIsMuted(false);
                videoRef.current.muted = false;
            } else if (newVolume === 0 && !isMuted) {
                // Якщо гучність 0, можна вважати це Mute
                setIsMuted(true);
                videoRef.current.muted = true;
            }
        }
    }, [isMuted]);

    // --- Обробка Mute/Unmute ---
    const toggleMute = useCallback(() => {
        const currentlyMuted = !isMuted;
        setIsMuted(currentlyMuted);
        if (videoRef.current) {
            videoRef.current.muted = currentlyMuted;
            if (currentlyMuted) {
                // Зберігаємо поточну гучність перед Mute, якщо вона не 0
                if (volume > 0) {
                    volumeBeforeMute.current = volume;
                }
                // Встановлюємо повзунок на 0 візуально
                setVolume(0);
            } else {
                // Відновлюємо гучність, яка була до Mute (або 0.5, якщо вона була 0)
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


    // --- Визначення іконки гучності ---
    const getVolumeIcon = () => {
        if (isMuted || volume === 0) return '🔇'; // Muted
        if (volume <= 0.5) return '🔈'; // Low volume
        return '🔊'; // High volume
    };

    // --- Рендеринг ---
    return (
        <div
            ref={containerRef} // Додаємо ref для повноекранного режиму
            className="w-screen h-screen bg-tertiary text-secondary flex flex-col items-center justify-center overflow-hidden relative" // Додано relative для позиціонування помилки
            onDoubleClick={videoSrc ? handleDoubleClick : undefined} // Подвійний клік тільки коли є відео
        >
            {/* Повідомлення про помилку */}
            {errorMsg && (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-600 p-3 rounded shadow-lg z-50 max-w-md text-center text-white">
                    <p>{errorMsg}</p>
                    <button onClick={() => setErrorMsg('')}
                            className="absolute top-0.5 right-1.5 text-white hover:text-gray-300 text-lg font-bold leading-none">×
                    </button>
                </div>
            )}

            {/* Відображення плеєра або списку недавніх */}
            {videoSrc ? (
                // --- Плеєр ---
                <div className="relative w-full h-full flex items-center justify-center group bg-black"> {/* group для hover ефектів контролів */}
                    <video
                        ref={videoRef}
                        className="w-full h-full object-contain" // object-contain для збереження пропорцій
                        src={videoSrc}
                        onClick={handleVideoClick} // Плей/пауза по кліку
                        onTimeUpdate={handleTimeUpdate}
                        onPause={handlePause}
                        onPlay={handlePlay}
                        onEnded={handleEnded}
                        onLoadedMetadata={handleLoadedMetadata}
                        onError={handleVideoError}
                        // controls={false} // Прибираємо стандартні контролзи
                        // controlsList="nodownload noremoteplayback" // Можна залишити
                    >
                        Ваш браузер не підтримує відтворення цього відео формату.
                    </video>

                    {/* Кастомні контролзи */}
                    <div
                        className="absolute bottom-0 left-0 w-full bg-gradient-to-t from-black/80 via-black/50 to-transparent pt-12 pb-3 px-4 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-300 flex flex-col items-center"
                        // Залишаємо видимим, якщо є фокус всередині (напр. на повзунку)
                    >
                        <div className="w-full max-w-4xl"> {/* Обмежуємо ширину для зручності */}
                            {/* Прогрес бар */}
                            <Progress
                                duration={displayDuration}
                                currentTime={displayCurrentTime}
                                onSeek={handleSeek}
                            />

                            {/* Рядок з кнопками та часом */}
                            <div className="flex justify-between items-center text-sm text-gray-300 mt-2 gap-4">
                                {/* Ліва частина: Play/Pause, Prev/Next, Volume */}
                                <div className="flex items-center gap-3">
                                    <button
                                        onClick={playPrevious}
                                        disabled={isLoadingDirectory || currentVideoIndex <= 0}
                                        className="px-2 py-1 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                                        title="Попереднє відео"
                                    >
                                        ⏮️
                                    </button>
                                    <button
                                        onClick={handleVideoClick}
                                        className="px-2 py-1 text-xl hover:text-white"
                                        title={isPlaying ? "Пауза" : "Відтворити"}
                                    >
                                        {isPlaying ? '⏸️' : '▶️'}
                                    </button>
                                    <button
                                        onClick={playNext}
                                        disabled={isLoadingDirectory || currentVideoIndex === -1 || currentVideoIndex >= directoryVideos.length - 1}
                                        className="px-2 py-1 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                                        title="Наступне відео"
                                    >
                                        ⏭️
                                    </button>
                                    {/* Контроль гучності */}
                                    <div className="flex items-center gap-2 volume-control">
                                        <button onClick={toggleMute} className="px-1 py-1 hover:text-white" title={isMuted ? "Увімкнути звук" : "Вимкнути звук"}>
                                            {getVolumeIcon()}
                                        </button>
                                        <input
                                            type="range"
                                            min="0"
                                            max="1"
                                            step="0.05"
                                            value={volume}
                                            onChange={handleVolumeChange}
                                            className="w-20 h-1.5 bg-gray-600 rounded-full appearance-none cursor-pointer accent-primary" // `accent-primary` для кольору повзунка в сучасних браузерах
                                            title={`Гучність: ${Math.round(volume * 100)}%`}
                                        />
                                    </div>
                                </div>

                                {/* Права частина: Час */}
                                <div className="text-xs font-mono">
                                    <span>{formatTime(displayCurrentTime)}</span> / <span>{formatTime(displayDuration)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            ) : (
                // --- Список недавніх (з невеликими змінами для прогресу) ---
                <div className="flex flex-col items-center gap-6 p-8 max-w-3xl w-full">
                    <h1 className="text-3xl font-bold text-secondary mb-2">React Video Player</h1>
                    <button
                        onClick={handleOpenFileClick}
                        className="bg-primary hover:bg-primary-dark text-white font-bold py-2 px-5 rounded transition duration-150 ease-in-out shadow hover:shadow-md" // Стилізована кнопка
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
                                        {video.duration && video.duration > 0 && typeof video.currentTime === 'number' && video.currentTime >= 0 && ( // Додано перевірку типу currentTime
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
