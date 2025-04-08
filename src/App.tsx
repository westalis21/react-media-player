import React, { useState, useEffect, useRef, useCallback } from 'react';
import { throttle } from 'lodash';
import { IpcRendererEvent } from 'electron';
import {getFileName} from "./utils/getFileName.ts";
import {formatTime} from "./utils/date.ts";

// Тип для даних з electron-store
interface RecentVideo {
    filePath: string;
    lastOpened: number;
    currentTime: number;
    duration?: number;
    fileName?: string;
}

// Оголошення типу для API
declare global {
    interface Window {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-expect-error
        ipcRenderer: {
            invoke: (channel: string, ...args: never[]) => Promise<never>;
            send: (channel: string, ...args: never[]) => void;
            on: (channel: string, listener: (event: never, ...args: never[]) => void) => void;
            off: (channel: string, listener: (...args: never[]) => void) => void;
        }
    }
}

// --- Головний компонент ---
function App() {
    const [videoSrc, setVideoSrc] = useState<string | null>(null);
    const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
    const [errorMsg, setErrorMsg] = useState<string>('');
    const [recentVideos, setRecentVideos] = useState<RecentVideo[]>([]);
    const [isLoadingRecents, setIsLoadingRecents] = useState<boolean>(true);
    const [seekToTime, setSeekToTime] = useState<number | null>(null);

    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null); // Реф для контейнера

    // --- Завантаження недавніх відео або початкового файлу ---
    useEffect(() => {
        setErrorMsg(''); // Очищаємо помилки при запуску
        if (!window.ipcRenderer) {
            setErrorMsg('Помилка: Не вдалося зв\'язатися з preload скриптом (ipcRenderer).');
            setIsLoadingRecents(false);
            return;
        }

        let isInitialVideoLoaded = false; // Флаг, щоб не завантажувати недавні, якщо є початковий файл

        // Слухач для завантаження відео з аргументів командного рядка
        const handleLoadInitialVideo = (_event: IpcRendererEvent, filePath: string) => {
            console.log('[Renderer] Received initial video path:', filePath);
            if (filePath) {
                isInitialVideoLoaded = true;
                openVideo(filePath, null, true); // Відкриваємо переданий файл, вказуємо що це початковий
                setIsLoadingRecents(false); // Не будемо завантажувати недавні
            }
        };
        window.ipcRenderer.on('load-initial-video', handleLoadInitialVideo);

        // Запитуємо недавні відео ТІЛЬКИ ЯКЩО НЕ БУВ завантажений початковий файл
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
        }, 50); // Невелика затримка, щоб 'load-initial-video' мав шанс спрацювати першим

        // Прибирання
        return () => {
            clearTimeout(timerId);
            if (window.ipcRenderer) {
                window.ipcRenderer.off('load-initial-video', handleLoadInitialVideo);
            }
        };
    }, []);

    // --- Функція для відкриття відео ---
    const openVideo = (filePath: string, timeToSeek: number | null = null, isInitial = false) => {
        if (!filePath) return;
        // Перевірка, чи ми вже не відкриваємо той самий файл (крім початкового завантаження)
        if (!isInitial && filePath === currentFilePath) {
            console.log('[Renderer] Trying to open the same file, ignoring.');
            if(timeToSeek !== null && videoRef.current) {
                videoRef.current.currentTime = timeToSeek; // Просто перемотуємо
            }
            return;
        }

        const videoUrl = `local-video://${encodeURI(filePath.replace(/\\/g, '/'))}`;
        console.log('[Renderer] Setting video source to:', videoUrl);
        setVideoSrc(null); // Спочатку скидаємо src, щоб спрацював onLoadedMetadata
        setCurrentFilePath(filePath);
        setSeekToTime(timeToSeek);
        setErrorMsg('');

        // Даємо React час оновити DOM перед встановленням нового src
        requestAnimationFrame(() => {
            setVideoSrc(videoUrl);
        });

        // Опціонально: Завантажуємо недавні відео знову, щоб оновити список
        if (!isInitial) {
            window.ipcRenderer?.invoke('get-recent-videos')
                .then(setRecentVideos)
                .catch(err => console.error("Error refreshing recent videos:", err));
        }
    };

    // --- Обробник кнопки "Відкрити відеофайл" ---
    const handleOpenFileClick = async () => {
        setErrorMsg('');
        if (!window.ipcRenderer?.invoke) {
            setErrorMsg('Помилка: Функція invoke недоступна.'); return;
        }

        try {
            const filePath: string | null = await window.ipcRenderer.invoke('dialog:openFile');
            if (filePath) {
                openVideo(filePath);
            } else {
                console.log('[Renderer] File selection cancelled.');
            }
        } catch (err) {
            console.error("[Renderer] Error invoking dialog:openFile:", err);
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-expect-error
            setErrorMsg(`Помилка відкриття файлу: ${err.message || err}`);
        }
    };

    // --- Збереження прогресу (обмежене) ---
    // Використовуємо useCallback для стабільності референсу функції
    const saveProgress = useCallback(throttle((videoElement: HTMLVideoElement, filePath: string) => {
        if (!videoElement || !filePath || !window.ipcRenderer?.invoke) return;

        const currentTime = videoElement.currentTime;
        const duration = videoElement.duration;

        // Зберігаємо, якщо є тривалість, відео довше 5 сек, і час не 0
        if (!isNaN(duration) && duration > 5 && currentTime > 0) {
            // console.log(`[Renderer] Throttled save progress for ${filePath}: ${currentTime}`);
            window.ipcRenderer.invoke('save-video-progress', { filePath, currentTime, duration })
                .catch(err => console.error("[Renderer] Failed to save progress:", err));
        }
    }, 5000, { leading: false, trailing: true }), []); // Викликаємо наприкінці інтервалу

    // --- Обробники подій відео ---
    const handleTimeUpdate = (event: React.SyntheticEvent<HTMLVideoElement>) => {
        if (currentFilePath) {
            saveProgress(event.currentTarget, currentFilePath); // Викликаємо throttled функцію
        }
    };

    const handlePause = (event: React.SyntheticEvent<HTMLVideoElement>) => {
        // Примусово зберігаємо прогрес при паузі
        if (currentFilePath) {
            saveProgress.flush(); // Викликаємо збереження негайно
            // Альтернативно, можна зберегти напряму тут, якщо throttle не спрацював
            const videoElement = event.currentTarget;
            const currentTime = videoElement.currentTime;
            const duration = videoElement.duration;
            if (!isNaN(duration) && duration > 5 && currentTime > 0 && window.ipcRenderer?.invoke) {
                console.log(`[Renderer] Saving progress on PAUSE for ${currentFilePath}: ${currentTime}`);
                window.ipcRenderer.invoke('save-video-progress', { filePath: currentFilePath, currentTime, duration })
                    .catch(err => console.error("[Renderer] Failed to save progress on PAUSE:", err));
            }
        }
    };

    const handleLoadedMetadata = (event: React.SyntheticEvent<HTMLVideoElement>) => {
        console.log('[Renderer] Video metadata loaded.');
        const videoElement = event.currentTarget;
        // Перемотуємо на збережений час
        if (seekToTime !== null) {
            console.log(`[Renderer] Seeking to ${seekToTime} seconds.`);
            videoElement.currentTime = seekToTime;
            setSeekToTime(null); // Скидаємо, щоб не перемотувати знову
        }
        // Зберігаємо початкові дані (особливо тривалість), якщо файл відкритий
        if (currentFilePath && window.ipcRenderer?.invoke) {
            const duration = videoElement.duration;
            if (!isNaN(duration)) {
                window.ipcRenderer.invoke('save-video-progress', { filePath: currentFilePath, currentTime: videoElement.currentTime, duration })
                    .catch(err => console.error("[Renderer] Failed to save initial duration:", err));
            }
        }
        // Автоматичне відтворення
        videoElement.play().catch(e => console.warn("Autoplay failed:", e));
    };

    const handleVideoError = (event: React.SyntheticEvent<HTMLVideoElement>) => {
        console.error('[Renderer] Video playback error:', event.nativeEvent);
        const error = (event.target as HTMLVideoElement).error;
        let message = 'Помилка відтворення відео.';
        if(error) {
            switch (error.code) {
                case MediaError.MEDIA_ERR_ABORTED: message += ' Завантаження перервано.'; break;
                case MediaError.MEDIA_ERR_NETWORK: message += ' Помилка мережі.'; break;
                case MediaError.MEDIA_ERR_DECODE: message += ' Помилка декодування (формат може не підтримуватися).'; break;
                case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: message += ' Формат файлу не підтримується.'; break;
                default: message += ' Невідома помилка.';
            }
        }
        setErrorMsg(message);
        setVideoSrc(null); // Повертаємось до списку недавніх
        setCurrentFilePath(null);
    }

    // --- Обробник кліку на контейнер для закриття плеєра (якщо потрібно) ---
    // Наприклад, по кліку поза відео повернутись до списку
    // const handleContainerClick = (event: React.MouseEvent<HTMLDivElement>) => {
    //     if (videoRef.current && !videoRef.current.contains(event.target as Node) && videoSrc) {
    //         // Зберігаємо прогрес перед закриттям
    //         saveProgress.flush();
    //         setVideoSrc(null);
    //         setCurrentFilePath(null);
    //     }
    // }

    // --- Рендеринг ---
    return (
        <div
            ref={containerRef}
            // onClick={handleContainerClick} // Додайте, якщо потрібна логіка закриття по кліку поза відео
            className="w-screen h-screen bg-gray-900 text-white flex flex-col items-center justify-center overflow-hidden" // Додано overflow-hidden
        >
            {/* Повідомлення про помилку */}
            {errorMsg && (
                <div className="fixed top-4 left-1/2 -translate-x-1/2 bg-red-600 p-3 rounded shadow-lg z-50 max-w-md text-center">
                    <p>{errorMsg}</p>
                    <button onClick={() => setErrorMsg('')} className="absolute top-0.5 right-1.5 text-white hover:text-gray-300 text-lg font-bold">×</button>
                </div>
            )}

            {/* Відображення плеєра або списку недавніх */}
            {videoSrc ? (
                <video
                    ref={videoRef}
                    controls
                    // autoPlay // Автоплей тепер обробляється в onLoadedMetadata
                    className="w-full h-full object-contain bg-black" // object-contain краще для відео
                    src={videoSrc}
                    onTimeUpdate={handleTimeUpdate}
                    onPause={handlePause}
                    onLoadedMetadata={handleLoadedMetadata}
                    onError={handleVideoError}
                    controlsList="nodownload noremoteplayback" // Прибираємо зайві кнопки
                >
                    Ваш браузер не підтримує відтворення цього відео формату.
                </video>
            ) : (
                <div className="flex flex-col items-center gap-6 p-8 max-w-3xl w-full"> {/* Обмежуємо ширину */}
                    <h1 className="text-3xl font-bold text-gray-300 mb-4">Відео Плеєр</h1>

                    <button
                        onClick={handleOpenFileClick}
                        className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded shadow-md transition duration-150 ease-in-out transform hover:scale-105"
                    >
                        Відкрити відеофайл
                    </button>

                    {/* Секція недавніх відео */}
                    <div className="mt-8 w-full">
                        <h2 className="text-xl text-gray-400 mb-3 border-b border-gray-700 pb-1">Нещодавно відкриті:</h2>
                        {isLoadingRecents ? (
                            <p className="text-gray-500 text-center py-4">Завантаження історії...</p>
                        ) : recentVideos.length > 0 ? (
                            <ul className="space-y-2 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar"> {/* Обмеження висоти та кастомний скролбар */}
                                {recentVideos.map((video) => (
                                    <li
                                        key={video.filePath}
                                        onClick={() => openVideo(video.filePath, video.currentTime)}
                                        className="bg-gray-800 p-3 rounded hover:bg-gray-700 cursor-pointer transition duration-150 ease-in-out group flex flex-col sm:flex-row sm:items-center sm:justify-between"
                                    >
                                        {/* Інформація про файл */}
                                        <div className="flex-grow mb-2 sm:mb-0 sm:mr-4 overflow-hidden">
                                            <p className="font-medium text-gray-200 truncate group-hover:text-blue-300" title={video.filePath}>
                                                {video.fileName || getFileName(video.filePath)}
                                            </p>
                                            <p className="text-xs text-gray-500 mt-1">
                                                Останній перегляд: {new Date(video.lastOpened).toLocaleString()}
                                            </p>
                                        </div>

                                        {/* Прогрес */}
                                        {video.duration && video.duration > 0 && (
                                            <div className="flex-shrink-0 w-full sm:w-48"> {/* Фіксована ширина для прогресу */}
                                                <span className="text-xs text-gray-400 block text-right mb-1">
                                                   {formatTime(video.currentTime)} / {formatTime(video.duration)}
                                                </span>
                                                <div className="w-full bg-gray-600 rounded-full h-1.5">
                                                    <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${Math.min(100,(video.currentTime / video.duration) * 100)}%` }}></div>
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

