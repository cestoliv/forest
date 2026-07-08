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
