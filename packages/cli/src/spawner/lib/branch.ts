export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '') // drop non-ascii (emoji, accents)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return slug || 'task';
}

export function buildBranchName(
  prefix: string,
  title: string,
  id: string,
): string {
  return `${prefix}${slugify(title)}-${id}`;
}

/**
 * The Todoist task id at the end of a branch `buildBranchName` made, or null.
 * A slug word is lowercase, so a real id shows an uppercase letter (16-char v1
 * id) or is 10+ digits (legacy numeric id). That keeps `fix-login-2` id-less.
 * The prefix needs no stripping: the id is always the last segment.
 */
export function parseTaskId(branch: string): string | null {
  const id = /-([A-Za-z0-9]+)$/.exec(branch)?.[1];
  if (!id) return null;
  return /^(?=.*[A-Z])[A-Za-z0-9]{16}$/.test(id) || /^\d{10,}$/.test(id)
    ? id
    : null;
}
