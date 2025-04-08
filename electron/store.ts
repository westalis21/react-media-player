import Store from 'electron-store';

// --- Store types ---
export interface VideoHistoryEntry {
    filePath: string;
    lastOpened: number;
    currentTime: number;
    duration?: number;
    fileName?: string;
}
export interface StoreSchema {
    recentVideos: VideoHistoryEntry[];
}

// --- Init electron-store ---
export const store = new Store<StoreSchema>({
    defaults: { recentVideos: [] },
});
