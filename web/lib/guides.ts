import content from "./content/reading-guides.json";

export interface GuideStep {
  title: string; year: number; issues: string; note: string;
  tier: string; milestone: string | null;
}
export interface ReadingGuide {
  slug: string; title: string; universe: string; publisher: string; tagline: string;
  description: string; tags: string[]; steps: GuideStep[];
  sources?: { title: string; url: string }[];
}
export const guides: ReadingGuide[] = content;
export function guidesForCharacter(name: string) {
  const normalized = name.toLowerCase();
  return guides.filter((g) => g.tags.some((tag) => tag.toLowerCase() === normalized));
}
