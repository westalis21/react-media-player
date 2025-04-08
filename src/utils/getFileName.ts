import path from "path-browserify";

export function getFileName(filePath: string | null): string {
    if (!filePath) return 'Невідомий файл';
    try {
        return path.basename(filePath); // Використовуємо path-browserify
    } catch (e) {
        console.error("Error getting basename:", e);
        // Пробуємо простий split як запасний варіант
        const parts = filePath.replace(/\\/g, '/').split('/');
        return parts[parts.length - 1] || filePath;
    }
}
