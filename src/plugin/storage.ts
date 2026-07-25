import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { AccountStorageSchema } from "./types";

function getConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

export function getAccountStorageFilePath(): string {
  const oldPath = join(getConfigDir(), "antigravity-accounts.json");
  const newDir = join(getConfigDir(), "agy");
  const newPath = join(newDir, "accounts.json");
  
  if (existsSync(oldPath) && !existsSync(newPath)) {
    if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });
    renameSync(oldPath, newPath);
  }
  
  return newPath;
}

export function loadAccountStorage(): AccountStorageSchema | null {
  try {
    const filePath = getAccountStorageFilePath();
    if (!existsSync(filePath)) {
      return null;
    }

    const content = readFileSync(filePath, "utf-8");
    const data = JSON.parse(content) as AccountStorageSchema;
    if (!data || typeof data !== "object" || !Array.isArray(data.accounts)) {
      return null;
    }

    return data;
  } catch (error) {
    console.warn(`[Agy Auth] Failed to load antigravity-accounts.json: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function saveAccountStorage(storage: AccountStorageSchema): boolean {
  try {
    const filePath = getAccountStorageFilePath();
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const tmpPath = join(tmpdir(), `antigravity-accounts-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(storage, null, 2), "utf-8");

    try {
      renameSync(tmpPath, filePath);
    } catch {
      writeFileSync(filePath, readFileSync(tmpPath));
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore temporary file deletion errors
      }
    }

    return true;
  } catch (error) {
    console.warn(`[Agy Auth] Failed to save antigravity-accounts.json: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
