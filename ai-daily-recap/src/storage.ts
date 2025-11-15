import fs from "fs";
import { Storage, DailyRecap } from "./types";

/**
 * Path to the JSON storage file in the temporary directory.
 * File persists across requests but is ephemeral (resets on container restart).
 */
const STORAGE_FILE = "/tmp/ai-daily-recap-storage.json";

/**
 * Initializes the storage file with an empty structure if it doesn't exist.
 * Creates /tmp/ai-daily-recap-storage.json with { feeds: [] } structure.
 * Safe to call multiple times - won't overwrite existing file.
 */
export function initializeStorage(): void {
  if (!fs.existsSync(STORAGE_FILE)) {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify({ feeds: [] }, null, 2));
  }
}

/**
 * Reads and parses the storage JSON file.
 * Returns the parsed Storage object, or a default empty structure on error.
 * 
 * @returns Storage object with all feeds and recaps
 */
export function readStorage(): Storage {
  try {
    const data = fs.readFileSync(STORAGE_FILE, "utf-8");
    const parsed = JSON.parse(data);
    return parsed;
  } catch (e) {
    return { feeds: [] };
  }
}

/**
 * Writes the storage object to the JSON file with pretty-printing.
 * Uses 2-space indentation for human readability.
 * 
 * @param storage - The complete storage object to persist
 */
export function writeStorage(storage: Storage): void {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(storage, null, 2));
}

/**
 * Finds and returns feed recaps for a given feed URL.
 * Returns null if the feed is not found in storage.
 * 
 * @param feedUrl - The RSS feed URL to search for
 * @returns FeedRecaps object if found, null otherwise
 */
export function getDailyRecaps(feedUrl: string): DailyRecap[] | null {
  const storage = readStorage();
  return storage[feedUrl] || null;
}

/**
 * Stores or updates a recap for a specific feed and date.
 * 
 * Algorithm:
 * 1. Read current storage
 * 2. Find feed by URL, create if doesn't exist
 * 3. Check if recap for this date already exists
 * 4. Update existing recap or append new one
 * 5. Write modified storage back to file
 * 
 * @param feedUrl - The RSS feed URL this recap belongs to
 * @param recap - The DailyRecap object to store
 */
export function storeRecap(feedUrl: string, recap: DailyRecap): void {
  const storage = readStorage();
  let recaps = storage[feedUrl] || [];

  // Check if recap for this date already exists
  const existingIndex = recaps.findIndex((r) => r.date === recap.date);
  if (existingIndex >= 0) {
    // Recap already exists, update
    recaps[existingIndex] = recap;
  } else {
    // No existing recap for date, add new
    recaps.push(recap);
  }
  storage[feedUrl] = recaps;

  writeStorage(storage);
}
