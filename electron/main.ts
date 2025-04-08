import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {store, VideoHistoryEntry} from "./store.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = path.join(__dirname, '..');

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron');
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST;

let win: BrowserWindow | null = null;
let initialFilePath: string | null = null; // Шлях до файлу з аргументів при першому запуску

// --- Block opening app second time ---
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('[Main Process] Another instance is already running. Quitting.');
  app.quit();
} else {
  // Handling second opened app
  app.on('second-instance', (_event, commandLine) => {
    console.log('[Main Process] Second instance requested.');
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      // Taking and sending path to file
      const filePathFromArgs = findFilePathInArgs(commandLine);
      if (filePathFromArgs && win.webContents) {
        console.log('[Main Process] Second instance opened with file:', filePathFromArgs);
        win.webContents.send('load-initial-video', filePathFromArgs);
      }
    }
  });

  // First start of the app
  initialFilePath = findFilePathInArgs(process.argv);
  if(initialFilePath) {
    console.log('[Main Process] Initial launch with file:', initialFilePath);
  }

  // Вимикаємо апаратне прискорення
  app.disableHardwareAcceleration();

  // --- Запуск додатку ---
  app.whenReady().then(() => {
    // Реєстрація власного протоколу
    protocol.registerFileProtocol('local-video', (request, callback) => {
      const url = request.url.slice('local-video://'.length);
      try {
        const decodedPath = decodeURI(url.replace(/^\//, '')); // Видаляємо слеш на початку, якщо є
        // Важливо: НЕ використовуйте тут console.log в продакшені для шляхів
        // console.log(`[Main Process] Serving file via local-video: ${decodedPath}`);
        // Потрібно переконатися, що шлях абсолютний і коректний
        return callback(path.normalize(decodedPath)); // Нормалізуємо шлях
      } catch (error) {
        console.error('[Main Process] Failed to serve file via local-video:', error);
        return callback({ error: -6 }); // net::ERR_FILE_NOT_FOUND
      }
    });

    createWindow(); // Створюємо головне вікно
  });
}


// --- Функція створення вікна ---
function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    width: 1280,
    height: 768,
    minWidth: 800, // Додамо мінімальні розміри
    minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'), // ВАЖЛИВО: Переконайтеся, що ім'я зібраного preload правильне
      sandbox: true,
      contextIsolation: true,
      // webSecurity: true - ЗАВЖДИ true, якщо використовуєте власний протокол
    },
    show: false, // Показуємо вікно після готовності
  });

  // Показуємо вікно, коли DOM готовий (краще ніж 'did-finish-load')
  win.once('ready-to-show', () => {
    win?.show();
    // Надсилаємо початковий файл, ЯКЩО він був переданий
    if (initialFilePath && win) {
      console.log('[Main Process] Sending initial file path to renderer:', initialFilePath);
      win.webContents.send('load-initial-video', initialFilePath);
      initialFilePath = null; // Очищуємо, щоб не відправляти знову
    }
  });

  // Для дебагу - відловлюємо 'did-fail-load'
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[Main Process] Failed to load page: ${errorDescription} (Code: ${errorCode})`);
  });

  // Завантажуємо URL або файл
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' }); // Відкриваємо DevTools у режимі розробки
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'));
    // Можна додати комбінацію для відкриття DevTools в продакшені
    // win.webContents.on('before-input-event', (event, input) => {
    //   if (input.key === 'F12' && input.control && input.shift) {
    //     win?.webContents.openDevTools();
    //   }
    // });
  }

  // Обробка закриття вікна
  win.on('closed', () => {
    win = null; // Дозволяємо збирачу сміття звільнити пам'ять
  });
}


// --- Стандартні обробники життєвого циклу додатку ---
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});


// --- Обробники IPC ---

// Відкрити діалог вибору файлу
ipcMain.handle('dialog:openFile', async () => {
  if (!win) return null; // Перевіряємо, чи існує вікно
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { // Передаємо батьківське вікно
    properties: ['openFile'],
    filters: [
      { name: 'Відеофайли', extensions: ['mp4', 'mkv', 'avi', 'webm', 'mov', 'wmv', 'flv', 'ogv', 'mpg', 'mpeg', '3gp'] }, // Додав ще кілька
      { name: 'Всі файли', extensions: ['*'] }
    ]
  });
  if (!canceled && filePaths.length > 0) {
    return filePaths[0];
  }
  return null;
});

// Отримати список недавніх відео
ipcMain.handle('get-recent-videos', async () => {
  try {
    const recentVideos = store.get('recentVideos', []);
    return recentVideos.sort((a, b) => b.lastOpened - a.lastOpened); // Новіші спочатку
  } catch (error) {
    console.error('[Main Process] Error getting recent videos:', error);
    return []; // Повертаємо порожній масив у разі помилки
  }
});

// Зберегти/Оновити прогрес відео
ipcMain.handle('save-video-progress', async (_event, data: { filePath: string; currentTime: number; duration?: number }) => {
  if (!data || !data.filePath || typeof data.currentTime !== 'number') {
    console.warn('[Main Process] Invalid data received for save-video-progress:', data);
    return { success: false, error: 'Invalid data provided' };
  }
  try {
    const recentVideos = store.get('recentVideos', []);
    const existingIndex = recentVideos.findIndex(v => v.filePath === data.filePath);
    const now = Date.now();
    const fileName = path.basename(data.filePath);

    let entry: VideoHistoryEntry;

    if (existingIndex > -1) {
      // Оновлюємо існуючий
      entry = recentVideos[existingIndex];
      entry.lastOpened = now;
      entry.currentTime = data.currentTime;
      if (data.duration && !isNaN(data.duration)) entry.duration = data.duration;
      // Не оновлюємо fileName, якщо він вже є
    } else {
      // Додаємо новий
      entry = {
        filePath: data.filePath,
        lastOpened: now,
        currentTime: data.currentTime,
        fileName: fileName,
      };
      if (data.duration && !isNaN(data.duration)) entry.duration = data.duration;
      recentVideos.push(entry);
    }

    // Сортуємо та обмежуємо кількість записів
    const maxRecents = 25;
    const sortedRecents = recentVideos.sort((a, b) => b.lastOpened - a.lastOpened);
    const limitedRecents = sortedRecents.slice(0, maxRecents);

    store.set('recentVideos', limitedRecents);
    // console.log('[Main Process] Video progress saved successfully for:', data.filePath);
    return { success: true };
  } catch (error: unknown) {
    console.error('[Main Process] Error saving video progress:', error);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    return { success: false, error: error?.message || 'Unknown error' };
  }
});


// --- Допоміжна функція для пошуку шляху до файлу в аргументах ---
function findFilePathInArgs(argv: string[]): string | null {
  // Шукаємо аргумент, який не є опцією (-) і схожий на шлях
  // Пропускаємо перші аргументи (electron/node, скрипт)
  const argsToCheck = VITE_DEV_SERVER_URL ? argv.slice(1) : argv.slice(1); // В режимі розробки може бути інакше

  for (const arg of argsToCheck) {
    if (!arg.startsWith('-')) {
      // Проста перевірка на наявність слешів - НЕ НАДІЙНО!
      // Краще було б перевіряти існування файлу, але це синхронно
      // або використовувати спеціалізовану бібліотеку для парсингу аргументів
      if (arg.includes(path.sep)) {
        try {
          // Спробуємо нормалізувати шлях
          const resolvedPath = path.resolve(arg);
          // Тут можна додати fs.existsSync(resolvedPath), але обережно
          console.log('[Main Process] Found potential file path argument:', resolvedPath);
          return resolvedPath;
        } catch(e) {
          console.warn('[Main Process] Could not resolve potential file path:', arg, e);
        }
      }
    }
  }
  return null;
}
