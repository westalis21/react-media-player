import React, {useState, useEffect, useRef, useCallback} from 'react';
import {throttle} from 'lodash';
import {IpcRendererEvent} from 'electron';
import {getFileName} from "./utils/getFileName.ts";
import {formatTime} from "./utils/date.ts";
import Progress from "./components/progress/Progress.tsx";

// ... (інтерфейси та declare global залишаються без змін) ...
interface RecentVideo {
    filePath: string;
    lastOpened: number;
    currentTime: number;
    duration?: number;
    fileName?: string;
}

declare global {
    interface Window {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-expect-error
        ipcRenderer: {
            invoke: (channel: string, ...args: never[]) => Promise<never>; // Оновимо типи для гнучкості
            send: (channel: string, ...args: never[]) => void;
            on: (channel: string, listener: (event: IpcRendererEvent, ...args: never[]) => void) => void;
            off: (channel: string, listener: (...args: never[]) => void) => void;
        }
    }
}


function App() {
    const [videoSrc, setVideoSrc] = useState<string | null>(null);
    const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
    const [errorMsg, setErrorMsg] = useState<string>('');
    const [recentVideos, setRecentVideos] = useState<RecentVideo[]>([]);
    const [isLoadingRecents, setIsLoadingRecents] = useState<boolean>(true);
    const [seekToTime, setSeekToTime] = useState<number | null>(null);
    // --- Новий стан для поточного часу, що передається в Progress ---
    const [displayCurrentTime, setDisplayCurrentTime] = useState<number>(0);
    const [displayDuration, setDisplayDuration] = useState<number>(0); // Стан для тривалості

    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const animationFrameRef = useRef<number | null>(null); // Реф для requestAnimationFrame

    // --- Функція для оновлення часу в UI ---
    const updateDisplayTime = useCallback(() => {
        if (videoRef.current) {
            setDisplayCurrentTime(videoRef.current.currentTime);
            // Запланувати наступне оновлення
            animationFrameRef.current = requestAnimationFrame(updateDisplayTime);
        }
    }, []); // Залежностей немає, бо використовує ref

    // --- Запуск/зупинка оновлення часу ---
    const startUpdateTimeLoop = useCallback(() => {
        // Зупиняємо попередній цикл, якщо він є
        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
        }
        // Запускаємо новий цикл
        animationFrameRef.current = requestAnimationFrame(updateDisplayTime);
    }, [updateDisplayTime]);

    const stopUpdateTimeLoop = useCallback(() => {
        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }
        // Оновлюємо час востаннє при зупинці
        if (videoRef.current) {
            setDisplayCurrentTime(videoRef.current.currentTime);
        }
    }, []);

    // --- Завантаження недавніх відео або початкового файлу (залишається схожим) ---
    useEffect(() => {
        // ... (логіка завантаження недавніх/початкових, як і раніше) ...
        setErrorMsg('');
        if (!window.ipcRenderer) {
            setErrorMsg('Помилка: Не вдалося зв\'язатися з preload скриптом (ipcRenderer).');
            setIsLoadingRecents(false);
            return;
        }

        let isInitialVideoLoaded = false;

        const handleLoadInitialVideo = (_event: IpcRendererEvent, filePath: string) => {
            console.log('[Renderer] Received initial video path:', filePath);
            if (filePath) {
                isInitialVideoLoaded = true;
                openVideo(filePath, null, true);
                setIsLoadingRecents(false);
            }
        };
        window.ipcRenderer.on('load-initial-video', handleLoadInitialVideo);

        const timerId = setTimeout(() => {
            if (!isInitialVideoLoaded) {
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
        }, 50);

        return () => {
            clearTimeout(timerId);
            if (window.ipcRenderer) {
                window.ipcRenderer.off('load-initial-video', handleLoadInitialVideo);
            }
            stopUpdateTimeLoop(); // Зупиняємо цикл оновлення при розмонтуванні
        };
        // Додаємо stopUpdateTimeLoop до залежностей, щоб ESLint не скаржився
    }, [stopUpdateTimeLoop]); // Додано залежність

    // --- Функція для відкриття відео (змінено очищення стану часу) ---
    const openVideo = (filePath: string, timeToSeek: number | null = null, isInitial = false) => {
        if (!filePath) return;
        if (!isInitial && filePath === currentFilePath) {
            // ... (логіка для вже відкритого файлу) ...
            if (timeToSeek !== null && videoRef.current) {
                videoRef.current.currentTime = timeToSeek;
                setDisplayCurrentTime(timeToSeek); // Оновлюємо і відображуваний час
            }
            return;
        }
        stopUpdateTimeLoop(); // Зупиняємо цикл перед зміною відео
        setVideoSrc(null); // Спочатку скидаємо src
        setDisplayCurrentTime(timeToSeek ?? 0); // Скидаємо/встановлюємо відображуваний час
        setDisplayDuration(0); // Скидаємо тривалість
        setCurrentFilePath(filePath);
        setSeekToTime(timeToSeek);
        setErrorMsg('');

        const videoUrl = `local-video://${encodeURI(filePath.replace(/\\/g, '/'))}`;
        console.log('[Renderer] Setting video source to:', videoUrl);

        document.title = getFileName(filePath);

        requestAnimationFrame(() => {
            setVideoSrc(videoUrl);
        });

        if (!isInitial) {
            window.ipcRenderer?.invoke('get-recent-videos')
                .then(setRecentVideos)
                .catch(err => console.error("Error refreshing recent videos:", err));
        }
    };

    // --- Обробник кнопки "Відкрити відеофайл" (без змін) ---
    const handleOpenFileClick = async () => {
        // ... (як і раніше) ...
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
        } catch (err: unknown) { // Явно вказуємо тип помилки
            console.error("[Renderer] Error invoking dialog:openFile:", err);
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-expect-error
            setErrorMsg(`Помилка відкриття файлу: ${err?.message || err}`);
        }
    };

    // --- Збереження прогресу (обмежене, без змін) ---
    const saveProgress = useCallback(throttle((videoElement: HTMLVideoElement, filePath: string) => {
        // ... (як і раніше) ...
        if (!videoElement || !filePath || !window.ipcRenderer?.invoke) return;
        const currentTime = videoElement.currentTime;
        const duration = videoElement.duration;
        if (!isNaN(duration) && duration > 5 && currentTime > 0) {
            // console.log(`[Renderer] Throttled save progress for ${filePath}: ${currentTime}`);
            window.ipcRenderer.invoke('save-video-progress', {filePath, currentTime, duration})
                .catch(err => console.error("[Renderer] Failed to save progress:", err));
        }
    }, 5000, {leading: false, trailing: true}), []);

    // --- Обробники подій відео (оновлено) ---
    const handleTimeUpdate = (event: React.SyntheticEvent<HTMLVideoElement>) => {
        // Використовуємо requestAnimationFrame для оновлення UI,
        // а onTimeUpdate залишаємо для збереження прогресу (throttle)
        if (currentFilePath) {
            saveProgress(event.currentTarget, currentFilePath);
        }
        // Оновлення displayCurrentTime тепер відбувається в updateDisplayTime через requestAnimationFrame
    };

    const handlePause = (event: React.SyntheticEvent<HTMLVideoElement>) => {
        stopUpdateTimeLoop(); // Зупиняємо цикл оновлення UI
        if (currentFilePath) {
            saveProgress.flush(); // Викликаємо збереження негайно
            const videoElement = event.currentTarget;
            const currentTime = videoElement.currentTime;
            const duration = videoElement.duration;
            if (!isNaN(duration) && duration > 5 && currentTime > 0 && window.ipcRenderer?.invoke) {
                console.log(`[Renderer] Saving progress on PAUSE for ${currentFilePath}: ${currentTime}`);
                window.ipcRenderer.invoke('save-video-progress', {filePath: currentFilePath, currentTime, duration})
                    .catch(err => console.error("[Renderer] Failed to save progress on PAUSE:", err));
            }
        }
    };

    const handlePlay = () => {
        startUpdateTimeLoop(); // Запускаємо цикл оновлення UI при відтворенні/продовженні
    };

    const handleEnded = () => {
        stopUpdateTimeLoop(); // Зупиняємо цикл коли відео закінчилось
        // Можна додати логіку для переходу до наступного відео або повернення до списку
    };

    const handleLoadedMetadata = (event: React.SyntheticEvent<HTMLVideoElement>) => {
        console.log('[Renderer] Video metadata loaded.');
        const videoElement = event.currentTarget;
        const duration = videoElement.duration;
        setDisplayDuration(duration); // Встановлюємо тривалість в стан

        if (seekToTime !== null) {
            console.log(`[Renderer] Seeking to ${seekToTime} seconds.`);
            videoElement.currentTime = seekToTime;
            setDisplayCurrentTime(seekToTime); // Оновлюємо відображуваний час
            setSeekToTime(null);
        } else {
            // Встановлюємо початковий час для відображення
            setDisplayCurrentTime(videoElement.currentTime);
        }

        if (currentFilePath && window.ipcRenderer?.invoke) {
            if (!isNaN(duration)) {
                window.ipcRenderer.invoke('save-video-progress', {
                    filePath: currentFilePath,
                    currentTime: videoElement.currentTime,
                    duration
                })
                    .catch(err => console.error("[Renderer] Failed to save initial duration:", err));
            }
        }

        // Не викликаємо startUpdateTimeLoop тут, бо є автоплей
        // videoElement.play() спрацює і викличе handlePlay
        videoElement.play().catch(e => {
            console.warn("Autoplay failed:", e);
            // Якщо автоплей не спрацював, а відео на паузі, цикл не запуститься.
            // Можливо, варто запустити його тут, якщо відео не на паузі?
            if (!videoElement.paused) {
                startUpdateTimeLoop();
            }
        });
    };

    const handleVideoError = (event: React.SyntheticEvent<HTMLVideoElement>) => {
        // ... (як і раніше) ...
        stopUpdateTimeLoop(); // Зупиняємо цикл при помилці
        console.error('[Renderer] Video playback error:', event.nativeEvent);
        const error = (event.target as HTMLVideoElement).error;
        let message = 'Помилка відтворення відео.';
        if (error) {
            switch (error.code) {
                case MediaError.MEDIA_ERR_ABORTED:
                    message += ' Завантаження перервано.';
                    break;
                case MediaError.MEDIA_ERR_NETWORK:
                    message += ' Помилка мережі.';
                    break;
                case MediaError.MEDIA_ERR_DECODE:
                    message += ' Помилка декодування.';
                    break;
                case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                    message += ' Формат не підтримується.';
                    break;
                default:
                    message += ' Невідома помилка.';
            }
        }
        setErrorMsg(message);
        setVideoSrc(null);
        setCurrentFilePath(null);
        setDisplayCurrentTime(0);
        setDisplayDuration(0);
    }

    // --- Функція для обробки перемотування з компонента Progress ---
    const handleSeek = useCallback((time: number) => {
        if (videoRef.current) {
            const newTime = Math.max(0, Math.min(time, videoRef.current.duration)); // Обмежуємо час
            videoRef.current.currentTime = newTime;
            setDisplayCurrentTime(newTime); // Негайно оновлюємо UI
        }
    }, []); // Залежностей немає, бо використовує ref

    // --- Рендеринг ---
    return (
        <div
            ref={containerRef}
            className="w-screen h-screen bg-tertiary text-secondary flex flex-col items-center justify-center overflow-hidden"
        >
            {/* Повідомлення про помилку (без змін) */}
            {errorMsg && (
                <div
                    className="fixed top-4 left-1/2 -translate-x-1/2 bg-red-600 p-3 rounded shadow-lg z-50 max-w-md text-center">
                    <p>{errorMsg}</p>
                    <button onClick={() => setErrorMsg('')}
                            className="absolute top-0.5 right-1.5 text-white hover:text-gray-300 text-lg font-bold">×
                    </button>
                </div>
            )}

            {/* Відображення плеєра або списку недавніх */}
            {videoSrc ? (
                // --- Оновлений блок плеєра ---
                <div className="relative w-full h-full flex items-center justify-center group cursor-pointer"> {/* Центруємо відео */}
                    <video
                        ref={videoRef}
                        controls={false} // Приховуємо стандартні контролзи, якщо використовуємо свої
                        className="w-full h-full object-contain bg-black" // object-contain для збереження пропорцій
                        src={videoSrc}
                        onTimeUpdate={handleTimeUpdate} // Все ще потрібен для saveProgress
                        onPause={handlePause}
                        onPlay={handlePlay} // Додано
                        onEnded={handleEnded} // Додано
                        onLoadedMetadata={handleLoadedMetadata}
                        onError={handleVideoError}
                        onClick={() => videoRef.current?.paused ? videoRef.current?.play() : videoRef.current?.pause()} // Пауза/плей по кліку на відео
                        // controlsList="nodownload noremoteplayback" // Не потрібен, якщо controls=false
                    >
                        Ваш браузер не підтримує відтворення цього відео формату.
                    </video>

                    {/* Контейнер для кастомних контролів */}
                    <div
                        className="absolute bottom-0 left-0 w-full bg-gradient-to-t from-black/70 via-black/40 to-transparent pt-10 pb-4 px-4 opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity duration-300" // З'являється при наведенні на контейнер (треба додати group до батька)
                        style={{'--controls-opacity': 1} as React.CSSProperties} // Тимчасово завжди видимо
                    >
                        <div className="flex flex-col gap-2"> {/* Обмежуємо ширину контролів */}
                            {/* Компонент прогресу */}
                            <Progress
                                duration={displayDuration}
                                currentTime={displayCurrentTime}
                                onSeek={handleSeek} // Передаємо обробник перемотування
                            />
                            {/* Інші контролзи (кнопки плей/пауза, гучність, повний екран тощо) */}
                            <div className="flex justify-between items-center text-sm text-gray-300">
                                <div>
                                    {/* Кнопка Play/Pause (приклад) */}
                                    <button
                                        onClick={() => videoRef.current?.paused ? videoRef.current?.play() : videoRef.current?.pause()}
                                        className="px-2 py-1 hover:text-white">
                                        {videoRef.current?.paused ? '▶️ Play' : '⏸️ Pause'}
                                    </button>
                                    {/* Додайте інші кнопки тут: гучність, повний екран... */}
                                </div>
                                <span>
                                    {formatTime(displayCurrentTime)} / {formatTime(displayDuration)}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            ) : (
                // --- Список недавніх (без суттєвих змін, тільки форматування прогресу) ---
                <div className="flex flex-col items-center gap-6 p-8 max-w-3xl w-full">
                    <h1 className="text-3xl font-bold text-secondary mb-2">React Video Player</h1>
                    <button
                        onClick={handleOpenFileClick}
                        className=""
                    >
                        Відкрити відеофайл
                    </button>
                    <div className="mt-8 w-full">
                        <h2 className="text-xl text-gray-400 mb-3 border-b border-gray-700 pb-1">Нещодавно
                            відкриті:</h2>
                        {isLoadingRecents ? (
                            <p className="text-gray-500 text-center py-4">Завантаження історії...</p>
                        ) : recentVideos.length > 0 ? (
                            <ul className="space-y-2 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
                                {recentVideos.map((video) => (
                                    <li
                                        key={video.filePath}
                                        onClick={() => openVideo(video.filePath, video.currentTime)}
                                        className="bg-gray-800 p-3 rounded hover:bg-gray-700 cursor-pointer transition duration-150 ease-in-out group flex flex-col sm:flex-row sm:items-center sm:justify-between"
                                    >
                                        <div className="flex-grow mb-2 sm:mb-0 sm:mr-4 overflow-hidden">
                                            <p className="font-medium text-gray-200 truncate group-hover:text-blue-300"
                                               title={video.filePath}>
                                                {video.fileName || getFileName(video.filePath)}
                                            </p>
                                            <p className="text-xs text-gray-500 mt-1">
                                                Останній перегляд: {new Date(video.lastOpened).toLocaleString()}
                                            </p>
                                        </div>
                                        {video.duration && video.duration > 0 && video.currentTime >= 0 && ( // Додано перевірку currentTime >= 0
                                            <div className="flex-shrink-0 w-full sm:w-48">
                                                <span className="text-xs text-gray-400 block text-right mb-1">
                                                   {formatTime(video.currentTime)} / {formatTime(video.duration)}
                                                </span>
                                                <div className="w-full bg-gray-600 rounded-full h-1.5">
                                                    {/* Використовуємо Math.max(0, ...) щоб уникнути від'ємного відсотка */}
                                                    <div
                                                        className="bg-primary h-1.5 rounded-full"
                                                        style={{width: `${Math.min(100, Math.max(0, (video.currentTime / video.duration) * 100))}%`}}
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
