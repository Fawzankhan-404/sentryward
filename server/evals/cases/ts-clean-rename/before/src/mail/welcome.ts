import { fmtName, type UserName } from "../users/format.ts";

export function welcomeSubject(user: UserName): string {
  return `Welcome, ${fmtName(user)}!`;
}
