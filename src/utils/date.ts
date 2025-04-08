export function formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const date = new Date(0);
    date.setSeconds(Math.floor(seconds)); // Беремо цілу частину секунд
    const timeString = date.toISOString();

    // Визначаємо, чи потрібні години
    if (seconds >= 3600) {
        return timeString.substr(11, 8); // ГГ:ММ:СС
    } else {
        return timeString.substr(14, 5); // ММ:СС
    }
}
