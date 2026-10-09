import { readFileSync } from "node:fs";
import type { Admin } from "../config.js";

/**
 * Read-only view of the existing reseller panel's admins (task 2.8). The panel stores dynamic admins in
 * admin-roles.json as { name: { prefixes: string[] | null, readonly?: boolean } }; `prefixes: null` sees every
 * client (super), anything else is a reseller. The built-in panel `admin` is a read-only super admin.
 * The file is re-read on every lookup so panel changes apply immediately; it is never written.
 */
export class PanelDirectory {
  private static readonly BUILTIN: Record<string, { prefixes: null; readonly: true }> = {
    admin: { prefixes: null, readonly: true },
  };

  constructor(private readonly rolesFile: string, private readonly read: (path: string) => string = (p) => readFileSync(p, "utf8")) {}

  resolve(name: string): Admin | null {
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(name)) return null;
    let roles: Record<string, { prefixes?: unknown; readonly?: unknown }> = {};
    try {
      roles = JSON.parse(this.read(this.rolesFile));
    } catch {
      roles = {};
    }
    const cfg = Object.hasOwn(PanelDirectory.BUILTIN, name) ? PanelDirectory.BUILTIN[name] : Object.hasOwn(roles, name) ? roles[name] : undefined;
    if (!cfg || typeof cfg !== "object") return null;
    return { name, role: cfg.prefixes === null ? "super" : "reseller", readonly: cfg.readonly === true };
  }
}
