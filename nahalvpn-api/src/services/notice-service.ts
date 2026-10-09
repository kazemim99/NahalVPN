import { audit, type Db } from "../db.js";

/** The outage notice every app shows as a modal while it is on (vpn-client-app "Service notice"). */
export interface Notice {
  active: boolean;
  message: string;
  updatedAt: number;
}

export const DEFAULT_NOTICE_MESSAGE = "ارتباط قطع شده است و در حال بررسی هستیم. لطفاً صبور باشید.";

export class NoticeService {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  get(): Notice {
    const row = this.db.prepare("SELECT active, message, updated_at FROM app_notice WHERE id = 1").get() as
      | { active: number; message: string; updated_at: number }
      | undefined;
    if (!row) return { active: false, message: DEFAULT_NOTICE_MESSAGE, updatedAt: 0 };
    return { active: row.active === 1, message: row.message, updatedAt: row.updated_at };
  }

  /** Turns the notice on or off. An empty or missing message keeps the previous one (or the default). */
  set(actor: string, active: boolean, message?: string): Notice {
    const now = this.now();
    const text = message?.trim() || this.get().message;
    this.db
      .prepare(
        `INSERT INTO app_notice (id, active, message, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET active = excluded.active, message = excluded.message,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(active ? 1 : 0, text, now, actor);
    audit(this.db, now, actor, active ? "notice.on" : "notice.off", { message: text });
    return this.get();
  }
}
