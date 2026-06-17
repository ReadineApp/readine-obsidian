import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { buildTemplateVars, renderTemplate, type TemplateVars } from "./template-engine";
import { DEFAULT_FILE_TEMPLATE } from "../constants";

const sampleArticle = {
  title: "Test Article",
  date: "2026-06-01T12:00:00Z",
  url: "https://example.com/test",
  tags: ["tech", "javascript", "testing"],
  feedName: "My Feed",
  feedId: "feed-123",
  feedItemId: "fi-abc",
  id: "art-xyz",
  notes: ["note one", "note two"],
};

const sampleText = "Hello **world**.";

describe("buildTemplateVars", () => {
  it("maps all article fields correctly", () => {
    const vars = buildTemplateVars(sampleArticle, sampleText);
    expect(vars.title).toBe("Test Article");
    expect(vars.date).toBe("2026-06-01T12:00:00Z");
    expect(vars.url).toBe("https://example.com/test");
    expect(vars.tags).toBe("[tech, javascript, testing]");
    expect(vars.feedName).toBe("My Feed");
    expect(vars.feedId).toBe("feed-123");
    expect(vars.feedItemId).toBe("fi-abc");
    expect(vars.id).toBe("art-xyz");
    expect(vars.notes).toBe("[note one, note two]");
    expect(vars.text).toBe(sampleText);
  });

  it("formats tags array as comma-separated list in brackets", () => {
    const vars = buildTemplateVars(sampleArticle, sampleText);
    expect(vars.tags).toMatch(/^\[.+\]$/);
    expect(vars.tags).toContain("tech");
    expect(vars.tags).toContain("javascript");
  });

  it("formats notes array as comma-separated list in brackets", () => {
    const article = { ...sampleArticle, notes: ["alpha", "beta", "gamma"] };
    const vars = buildTemplateVars(article, sampleText);
    expect(vars.notes).toBe("[alpha, beta, gamma]");
  });

  it("passes text through unchanged", () => {
    const markdown = "# Heading\n\nParagraph with **bold**.";
    const vars = buildTemplateVars(sampleArticle, markdown);
    expect(vars.text).toBe(markdown);
  });

  it("handles empty tags and notes arrays", () => {
    const article = { ...sampleArticle, tags: [], notes: [] };
    const vars = buildTemplateVars(article, "");
    expect(vars.tags).toBe("[]");
    expect(vars.notes).toBe("[]");
    expect(vars.text).toBe("");
  });
});

describe("renderTemplate", () => {
  const vars: TemplateVars = {
    title: "Hello",
    date: "2026-01-01",
    url: "https://x.com",
    tags: "[a, b]",
    feedName: "Feed",
    feedId: "f1",
    feedItemId: "fi-1",
    id: "art-1",
    notes: "[]",
    text: "body",
  };

  it("substitutes {{var}} with corresponding value", () => {
    const result = renderTemplate("Title: {{title}}", vars);
    expect(result).toBe("Title: Hello");
  });

  it("leaves unknown variables as-is", () => {
    const result = renderTemplate("{{unknown}}", vars);
    expect(result).toBe("{{unknown}}");
  });

  it("performs partial substitution", () => {
    const result = renderTemplate("{{title}} — {{url}}", vars);
    expect(result).toBe("Hello — https://x.com");
  });

  it("handles empty template string", () => {
    expect(renderTemplate("", vars)).toBe("");
  });

  it("substitutes all fields when template uses every variable", () => {
    const tpl = [
      "{{title}}", "{{date}}", "{{url}}", "{{tags}}",
      "{{feedName}}", "{{feedId}}", "{{feedItemId}}",
      "{{id}}", "{{notes}}", "{{text}}",
    ].join("|");
    const result = renderTemplate(tpl, vars);
    expect(result).toBe("Hello|2026-01-01|https://x.com|[a, b]|Feed|f1|fi-1|art-1|[]|body");
  });
});

describe("integration — DEFAULT_FILE_TEMPLATE", () => {
  it("produces a frontmatter-like structure with buildTemplateVars", () => {
    const article = {
      title: "Integration Test",
      date: "2026-06-01",
      url: "https://example.com/integration",
      tags: ["test"],
      feedName: "IntegrationFeed",
      feedId: "feed-int",
      feedItemId: "fi-int",
      id: "art-int",
      notes: [],
    };
    const text = "Integration body content.";
    const vars = buildTemplateVars(article, text);
    const output = renderTemplate(DEFAULT_FILE_TEMPLATE, vars);

    expect(output).toContain('title: "Integration Test"');
    expect(output).toContain("date: 2026-06-01");
    expect(output).toContain("url: https://example.com/integration");
    expect(output).toContain("tags: [test]");
    expect(output).toContain('feed: "IntegrationFeed"');
    expect(output).toContain("articleId: art-int");
    expect(output).toContain('notes: "[]"');
    expect(output).toContain("---");
    expect(output).toContain("Integration body content.");
  });
});
