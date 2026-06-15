export interface TemplateVars {
  title: string;
  date: string;
  url: string;
  tags: string;
  feedName: string;
  feedId: string;
  feedItemId: string;
  id: string;
  notes: string;
  text: string;
}

export function buildTemplateVars(
  article: { title: string; date: string; url: string; tags: string[]; feedName: string; feedId: string; feedItemId: string; id: string; notes: string[] },
  text: string,
): TemplateVars {
  return {
    title: article.title,
    date: article.date,
    url: article.url,
    tags: `[${article.tags.join(", ")}]`,
    feedName: article.feedName,
    feedId: article.feedId,
    feedItemId: article.feedItemId,
    id: article.id,
    notes: `[${article.notes.join(", ")}]`,
    text,
  };
}

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const val = (vars as unknown as Record<string, string>)[key];
    return val !== undefined ? val : match;
  });
}
