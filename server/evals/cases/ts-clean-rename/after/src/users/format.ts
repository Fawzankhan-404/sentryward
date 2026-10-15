export interface UserName {
  first: string;
  last: string | null;
}

export function displayName(user: UserName): string {
  return user.last ? `${user.first} ${user.last}` : user.first;
}
