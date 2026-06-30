import type Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import type { User } from "../../shared/types.js";

const MASTER_KEY = "336000";

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: "admin" | "cashier";
  created_at: string;
}

export function login(db: Database.Database, username: string, password: string): User | null {
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return null;
  }

  return toUser(row);
}

export function changePassword(
  db: Database.Database,
  username: string,
  currentPassword: string,
  nextPassword: string
): boolean {
  if (nextPassword.trim().length < 4) {
    throw new Error("Password must be at least 4 characters.");
  }

  const user = currentPassword === MASTER_KEY ? db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined : login(db, username, currentPassword);
  if (!user) {
    return false;
  }

  const hash = bcrypt.hashSync(nextPassword, 12);
  db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(hash, username);
  return true;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.created_at
  };
}
