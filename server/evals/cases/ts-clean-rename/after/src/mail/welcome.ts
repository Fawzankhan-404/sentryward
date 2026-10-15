import { displayName, type UserName } from "../users/format.ts";

export function welcomeSubject(user: UserName): string {
  return `Welcome, ${displayName(user)}!`;
}
