/** Short, collision-resistant ids for client-created records. */
export function newId(prefix = ""): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
  return prefix ? `${prefix}_${time}${rand}` : `${time}${rand}`;
}
