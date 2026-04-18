/**
 * QA-project detection logic for the qa-fold migration (#685).
 *
 * Exported as a pure function so it's unit-testable.
 *
 * Detection rules:
 * 1. Project name ends with " QA" (case-insensitive, trimmed)
 * 2. Another project exists whose name matches the prefix (everything before " QA"), case-insensitive
 * 3. The QA project is NOT already archived with archivedReason === 'qa-fold'
 */

export interface QaProjectMatch {
  qaProject: any;
  parentProject: any;
  sectionId: string;         // sec-qa-<parentId>
  sectionOwner: string;      // resolved owner for the new QA section
}

export function detectQaProjects(projects: any[]): QaProjectMatch[] {
  if (!Array.isArray(projects)) return [];

  const matches: QaProjectMatch[] = [];

  for (const p of projects) {
    const name = (p.name || '').trim();
    if (!name.toLowerCase().endsWith(' qa')) continue;

    // Already migrated — skip
    if (p.isArchived && p.archivedReason === 'qa-fold') continue;

    const prefix = name.slice(0, -3).trim(); // everything before " QA"
    if (!prefix) continue;

    const parent = projects.find(
      (other: any) =>
        other.id !== p.id &&
        (other.name || '').trim().toLowerCase() === prefix.toLowerCase()
    );
    if (!parent) continue;

    const sectionId = `sec-qa-${parent.id}`;
    const sectionOwner = p.qaOwner || p.devOwner || parent.qaOwner || '';

    matches.push({
      qaProject: p,
      parentProject: parent,
      sectionId,
      sectionOwner,
    });
  }

  return matches;
}
