import argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

/** argon2id hasher. A dummy hash is verified for unknown users so response time does not reveal existence. */
export function argonHasher(memoryCost: number, timeCost: number): PasswordHasher & { dummyHash: Promise<string> } {
  const opts = { type: argon2.argon2id, memoryCost, timeCost } as const;
  return {
    hash: (password) => argon2.hash(password, opts),
    verify: async (hash, password) => {
      try {
        return await argon2.verify(hash, password);
      } catch {
        return false;
      }
    },
    dummyHash: argon2.hash(randomBytes(16).toString("hex"), opts),
  };
}

/** Opaque refresh token: 256 random bits, base64url. Only its SHA-256 is stored. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
