import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Message } from "./agent.ts";

export interface Chat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Full model conversation (user, assistant, tool messages), excluding the system prompt. */
  messages: Message[];
}

export type ChatSummary = Pick<Chat, "id" | "title" | "createdAt" | "updatedAt">;

const ID_RE = /^[0-9a-f-]{36}$/;
const DEFAULT_TITLE = "New chat";

/** Stores each chat as one JSON file: <dir>/<id>.json. */
export class ChatStore {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private file(id: string): string {
    if (!ID_RE.test(id)) throw new Error("Invalid chat id");
    return path.join(this.dir, `${id}.json`);
  }

  async list(): Promise<ChatSummary[]> {
    const names = (await fs.readdir(this.dir)).filter((n) => n.endsWith(".json"));
    const chats = await Promise.all(
      names.map(async (name): Promise<ChatSummary | null> => {
        try {
          const { id, title, createdAt, updatedAt } = JSON.parse(
            await fs.readFile(path.join(this.dir, name), "utf8"),
          ) as Chat;
          return { id, title, createdAt, updatedAt };
        } catch {
          return null; // skip unreadable files rather than failing the whole list
        }
      }),
    );
    return chats
      .filter((c): c is ChatSummary => c !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Chat | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(id), "utf8")) as Chat;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async create(): Promise<Chat> {
    const now = new Date().toISOString();
    const chat: Chat = { id: randomUUID(), title: DEFAULT_TITLE, createdAt: now, updatedAt: now, messages: [] };
    await this.save(chat);
    return chat;
  }

  async save(chat: Chat): Promise<void> {
    chat.updatedAt = new Date().toISOString();
    if (chat.title === DEFAULT_TITLE) {
      const firstUser = chat.messages.find((m) => m.role === "user");
      if (firstUser && typeof firstUser.content === "string") chat.title = makeTitle(firstUser.content);
    }
    // Write-then-rename so a crash mid-write never leaves a corrupt chat file.
    const target = this.file(chat.id);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(chat, null, 1), "utf8");
    await fs.rename(tmp, target);
  }

  async rename(id: string, title: string): Promise<Chat | null> {
    const chat = await this.get(id);
    if (!chat) return null;
    chat.title = title.trim().slice(0, 120) || DEFAULT_TITLE;
    await this.save(chat);
    return chat;
  }

  async delete(id: string): Promise<boolean> {
    try {
      await fs.unlink(this.file(id));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}

function makeTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}
