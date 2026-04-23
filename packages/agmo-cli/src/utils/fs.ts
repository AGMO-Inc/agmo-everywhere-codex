import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type WriteStatus = "created" | "updated" | "unchanged";

export async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

export async function readTextFileIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) {
    return null;
  }

  return await readFile(path, "utf-8");
}

export async function writeTextFile(
  path: string,
  content: string
): Promise<{ path: string; status: WriteStatus }> {
  await mkdir(dirname(path), { recursive: true });
  const existing = await readTextFileIfExists(path);

  if (existing === content) {
    return { path, status: "unchanged" };
  }

  await writeFile(path, content, "utf-8");
  return {
    path,
    status: existing === null ? "created" : "updated"
  };
}

export async function writeJsonFile(
  path: string,
  value: unknown
): Promise<{ path: string; status: WriteStatus }> {
  return await writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
